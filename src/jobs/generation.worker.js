import { randomUUID } from 'node:crypto';
import { prisma } from '../config/prisma.js';
import { env, providerReady } from '../config/env.js';
import { higgsfield, ProviderError } from '../services/higgsfield.service.js';
import { validateMediaUrl } from '../services/safe-http.service.js';
import { r2 } from '../services/r2.service.js';
import { AppError } from '../middleware/errors.js';
const active = ['queued', 'processing'];
// Exported with injectable dependencies so retries/leases/refunds can be tested without a paid API.
export async function processGeneration(
  row,
  { db = prisma, provider = higgsfield, resultStore = r2, now = Date.now } = {},
) {
  const owner = { id: row.id, leaseToken: row.leaseToken, status: { in: active } };
  let submissionStarted = !!row.providerRequestId || !!row.submissionAttemptedAt;
  async function update(data) {
    const result = await db.generation.updateMany({ where: owner, data });
    if (!result.count) throw new Error('LEASE_LOST');
  }
  async function finish(
    status,
    errorMessage,
    {
      url = null,
      resultVideoKey = null,
      resultImageUrls = [],
      resultImageKeys = [],
      refund = false,
    } = {},
  ) {
    await db.$transaction(async (tx) => {
      const changed = await tx.generation.updateMany({
        where: owner,
        data: {
          status,
          errorMessage,
          resultVideoUrl: url,
          resultVideoKey,
          resultImageUrls,
          resultImageKeys,
          leaseToken: null,
          lockedUntil: null,
          ...(refund ? { quotaRefunded: true } : {}),
        },
      });
      if (changed.count && refund && !row.quotaRefunded && row.quotaCost > 0)
        await tx.user.update({
          where: { id: row.userId },
          data: { generationCredits: { increment: row.quotaCost } },
        });
    });
  }
  try {
    if (row.submissionAttemptedAt && !row.providerRequestId) {
      await finish(
        'failed',
        'Отправка провайдеру не подтверждена. Повторный запуск остановлен; требуется сверка задачи и квоты администратором.',
      );
      return;
    }
    if (now() - new Date(row.createdAt).getTime() > env.GENERATION_TIMEOUT_MS) {
      await finish(
        'failed',
        submissionStarted
          ? 'Превышено время ожидания. Квота сохранена до сверки с провайдером.'
          : 'Превышено время ожидания до отправки.',
        { refund: !submissionStarted },
      );
      return;
    }
    if (!submissionStarted) {
      const user = await db.user.findUnique({
        where: { id: row.userId },
        select: { isAdmin: true },
      });
      if (!user?.isAdmin)
        throw new ProviderError('Генерация доступна только администратору', { refundSafe: true });
    }
    if (row.references?.length && !row.providerRequestId) {
      const images = await db.storedImage.findMany({
        where: { id: { in: row.references.map((ref) => ref.uploadId) }, userId: row.userId },
      });
      row.providerReferences = [];
      for (const ref of row.references) {
        const input = images.find((item) => item.id === ref.uploadId);
        if (!input) throw new ProviderError('Исходный референс недоступен', { refundSafe: true });
        row.providerReferences.push({ role: ref.role, url: await provider.uploadImage(input) });
      }
    } else if (row.trendId && !row.providerRequestId) {
      const ids = row.sourceImageIds;
      const images = await db.storedImage.findMany({
        where: { id: { in: ids }, userId: row.userId, storageKind: 'r2' },
      });
      if (images.length !== ids.length)
        throw new ProviderError('Исходные фотографии недоступны', { refundSafe: true });
      row.providerImageUrls = [];
      for (const id of ids)
        row.providerImageUrls.push(
          await provider.uploadImage(images.find((image) => image.id === id)),
        );
      row.providerImageUrl = row.providerImageUrls[0];
    } else if (row.mode === 'IMAGE_TO_VIDEO' && !row.providerImageUrl && !row.providerRequestId) {
      const image = await db.storedImage.findUnique({ where: { id: row.sourceImageId } });
      if (!image) throw new ProviderError('Исходное изображение недоступно', { refundSafe: true });
      row.providerImageUrl = await provider.uploadImage(image);
      await update({ providerImageUrl: row.providerImageUrl });
    }
    let result;
    if (!row.providerRequestId) {
      row.submissionAttemptedAt = new Date(now());
      await update({ submissionAttemptedAt: row.submissionAttemptedAt });
      submissionStarted = true;
      result = await provider.submit(row);
      row.providerRequestId = result.request_id;
      row.providerStatusUrl = result.status_url;
      await update({
        providerRequestId: row.providerRequestId,
        providerStatusUrl: row.providerStatusUrl,
        attempts: 0,
      });
    } else result = await provider.status(row);
    if (result.status === 'completed') {
      if (row.generationType === 'Image') {
        if (!result.images?.length)
          throw new ProviderError('В ответе отсутствует изображение', { retryable: true });
        const urls = result.images.map((image) => {
          validateMediaUrl(image.url);
          return image.url;
        });
        let resultImageKeys;
        try {
          resultImageKeys = await Promise.all(
            urls.map((url, index) => resultStore.saveImageResult(row, url, index)),
          );
        } catch {
          throw new ProviderError('Не удалось сохранить изображение в R2. Повторяем сохранение.', {
            retryable: true,
          });
        }
        await finish('completed', null, { resultImageKeys });
        return;
      }
      if (!result.video?.url)
        throw new ProviderError('В ответе провайдера отсутствует видео', { retryable: true });
      validateMediaUrl(result.video.url);
      {
        let resultVideoKey;
        try {
          resultVideoKey = await resultStore.saveResult(row, result.video.url);
        } catch {
          throw new ProviderError('Не удалось сохранить готовое видео. Повторяем сохранение.', {
            retryable: true,
          });
        }
        await finish('completed', null, { resultVideoKey });
      }
    } else if (['failed', 'nsfw', 'canceled'].includes(result.status))
      await finish(
        'failed',
        result.status === 'nsfw'
          ? 'Материал отклонён модерацией'
          : result.status === 'canceled'
            ? 'Задача отменена провайдером'
            : 'Провайдер не смог завершить генерацию',
        { refund: true },
      );
    else
      await update({
        status: result.status === 'in_progress' ? 'processing' : 'queued',
        nextPollAt: new Date(now() + 10000 + Math.random() * 2000),
        attempts: 0,
        errorMessage: null,
        leaseToken: null,
        lockedUntil: null,
      });
  } catch (error) {
    if (error.message === 'LEASE_LOST') return;
    console.error(
      JSON.stringify({
        event: 'generation_error',
        generationId: row.id,
        providerRequestId: row.providerRequestId || null,
        name: error.name,
        retryable: !!error.retryable,
      }),
    );
    if (submissionStarted && !row.providerRequestId) {
      await finish(
        'failed',
        error.refundSafe
          ? error.message
          : `${error.message}. Ответ на отправку не подтверждён. Требуется сверка с Higgsfield; автоматический повтор отключён.`,
        { refund: !!error.refundSafe },
      );
    } else if (error.retryable && row.attempts < 7) {
      await update({
        attempts: { increment: 1 },
        nextPollAt: new Date(
          now() + Math.min(120000, 5000 * 2 ** row.attempts) + Math.random() * 1500,
        ),
        leaseToken: null,
        lockedUntil: null,
      });
    } else
      await finish(
        'failed',
        error instanceof ProviderError || error instanceof AppError
          ? error.message
          : 'Не удалось обработать задачу. Требуется проверка администратором.',
        { refund: (!submissionStarted || !!error.refundSafe) && !row.providerRequestId },
      );
  }
}
export function startWorker() {
  let timer,
    inFlight,
    stopping = false;
  async function tick() {
    if (stopping) return;
    try {
      if (providerReady()) {
        const current = new Date();
        const rows = await prisma.generation.findMany({
          where: {
            status: { in: active },
            nextPollAt: { lte: current },
            OR: [{ lockedUntil: null }, { lockedUntil: { lt: current } }],
          },
          orderBy: { nextPollAt: 'asc' },
          take: 4,
        });
        for (const row of rows) {
          if (stopping) break;
          const leaseToken = randomUUID();
          const claimed = await prisma.generation.updateMany({
            where: {
              id: row.id,
              status: { in: active },
              OR: [{ lockedUntil: null }, { lockedUntil: { lt: current } }],
            },
            data: { leaseToken, lockedUntil: new Date(Date.now() + 180000) },
          });
          if (claimed.count) {
            // Another worker may have updated the candidate before our claim. Read its persisted receipt under our new lease.
            const claimedRow = await prisma.generation.findUnique({ where: { id: row.id } });
            if (claimedRow?.leaseToken === leaseToken) await processGeneration(claimedRow);
          }
        }
      }
    } catch (error) {
      console.error(
        JSON.stringify({ event: 'worker_error', name: error.name, code: error.code || null }),
      );
    } finally {
      if (!stopping)
        timer = setTimeout(() => {
          inFlight = tick();
        }, env.WORKER_INTERVAL_MS);
    }
  }
  inFlight = tick();
  return {
    async stop() {
      stopping = true;
      clearTimeout(timer);
      await inFlight;
    },
  };
}
