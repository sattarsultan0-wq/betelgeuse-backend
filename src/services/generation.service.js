import { createHash } from 'node:crypto';
import { z } from 'zod';
import { prisma } from '../config/prisma.js';
import { env, providerReady, r2Ready } from '../config/env.js';
import { validateModelInput } from './model-validation.service.js';
import { estimateCredits, estimateProviderCost } from './pricing.service.js';
import { AppError } from '../middleware/errors.js';
import { r2 } from './r2.service.js';
export const generationSchema = z
  .object({
    model: z.string().max(80),
    prompt: z.string().trim().min(1).max(2000),
    mode: z.enum([
      'TEXT_TO_VIDEO',
      'IMAGE_TO_VIDEO',
      'TEXT_TO_IMAGE',
      'IMAGE_TO_IMAGE',
      'VIDEO_TO_VIDEO',
      'FIRST_LAST_FRAME',
      'MOTION_CONTROL',
    ]),
    aspectRatio: z.string().max(20).optional(),
    duration: z.number().int().min(1).max(30).optional(),
    quality: z.string().max(20).optional(),
    parameters: z
      .record(z.union([z.string().max(80), z.boolean(), z.number().finite()]))
      .optional(),
    references: z
      .array(z.object({ role: z.string().min(1).max(30), uploadId: z.string().uuid() }).strict())
      .max(8)
      .optional(),
    sourceImageId: z.string().uuid().optional(),
  })
  .strict();
export const estimateSchema = generationSchema.omit({
  prompt: true,
  sourceImageId: true,
  references: true,
});
export const listSchema = z
  .object({ page: z.coerce.number().int().min(1).max(10000).default(1) })
  .strict();
export function validateGeneration(body, user = {}) {
  const { caps: mode } = validateModelInput(body);
  if (
    body.mode === 'REFERENCE_TO_VIDEO' &&
    (!body.trendId ||
      !body.sourceImageIds?.length ||
      body.sourceImageIds.length > (mode.maxPhotos || 1))
  )
    throw new AppError(400, 'Некорректные фотографии для выбранной модели');
  const quote = estimateCredits(body, user);
  if (!['configured', 'admin_test'].includes(quote.status))
    throw new AppError(400, 'Стоимость генерации не настроена', 'PRICING_UNCONFIGURED');
  return quote.credits;
}
export const publicGeneration = ({
  id,
  model,
  prompt,
  mode,
  status,
  aspectRatio,
  duration,
  quality,
  trendId,
  submissionAttemptedAt,
  quotaRefunded,
  sourceImageUrl,
  resultVideoUrl,
  resultImageUrls,
  generationType,
  errorMessage,
  createdAt,
  updatedAt,
  adminTest,
  costEstimate,
}) => ({
  id,
  model,
  prompt,
  mode,
  status,
  aspectRatio,
  duration,
  quality,
  trendId,
  requiresReview: status === 'failed' && !!submissionAttemptedAt && !quotaRefunded,
  sourceImageUrl,
  resultVideoUrl,
  resultImageUrls: resultImageUrls || [],
  generationType: generationType || 'Video',
  errorMessage,
  createdAt,
  updatedAt,
  adminTest: adminTest === true,
  costEstimate,
});
export async function presentGeneration(row) {
  const value = publicGeneration(row);
  if (row.resultVideoKey) value.resultVideoUrl = await r2.signRead(row.resultVideoKey, 3600);
  if (row.resultImageKeys?.length)
    value.resultImageUrls = await Promise.all(
      row.resultImageKeys.map((key) => r2.signRead(key, 3600)),
    );
  return value;
}
// Object key order has no meaning in JSON; reference array order does.
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value;
export async function createGeneration(userId, body, idempotencyKey) {
  const account = await prisma.user.findUnique({
    where: { id: userId },
    select: { isAdmin: true },
  });
  if (!account) throw new AppError(401, 'Аккаунт не найден');
  if (!account.isAdmin)
    throw new AppError(403, 'Генерация доступна только администратору', 'ADMIN_REQUIRED');
  z.string().uuid().parse(idempotencyKey);
  validateModelInput(body);
  const payloadHash = createHash('sha256')
    .update(JSON.stringify(canonical(body)))
    .digest('hex');
  const legacyHash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
  const samePayload = (row) => row.payloadHash === payloadHash || row.payloadHash === legacyHash;
  const existing = await prisma.generation.findUnique({
    where: { userId_idempotencyKey: { userId, idempotencyKey } },
  });
  if (existing) {
    if (!samePayload(existing))
      throw new AppError(409, 'Идентификатор запроса уже использован с другими параметрами');
    return existing;
  }
  validateGeneration(body, account);
  if (!providerReady()) throw new AppError(503, 'Higgsfield API ещё не подключён');
  if (!r2Ready())
    throw new AppError(503, 'Настройте R2 для сохранения результатов', 'STORAGE_UNAVAILABLE');
  try {
    return await prisma.$transaction(async (tx) => {
      // Lock the account before reading its role, debiting credits or checking active jobs.
      const locked = await tx.user.updateMany({
        where: { id: userId },
        data: { updatedAt: new Date() },
      });
      if (!locked.count) throw new AppError(401, 'Аккаунт не найден');
      const user = await tx.user.findUnique({ where: { id: userId }, select: { isAdmin: true } });
      if (!user.isAdmin)
        throw new AppError(403, 'Генерация доступна только администратору', 'ADMIN_REQUIRED');
      const requestedCost = validateGeneration(body, user);
      const quotaCost = user.isAdmin ? 0 : requestedCost;
      if (quotaCost) {
        const debit = await tx.user.updateMany({
          where: { id: userId, generationCredits: { gte: quotaCost } },
          data: { generationCredits: { decrement: quotaCost } },
        });
        if (!debit.count)
          throw new AppError(402, 'Недостаточно квоты. Доступ выдаётся администратором.');
      }
      const active = await tx.generation.count({
        where: { userId, status: { in: ['queued', 'processing'] } },
      });
      if (active >= env.MAX_ACTIVE_GENERATIONS)
        throw new AppError(429, 'Дождитесь завершения активных генераций');
      if (body.sourceImageId) {
        const image = await tx.storedImage.findFirst({ where: { id: body.sourceImageId, userId } });
        if (!image) throw new AppError(404, 'Изображение не найдено');
        if (!image.mimeType.startsWith('image/')) throw new AppError(400, 'Требуется изображение');
      }
      const { model, caps } = validateModelInput(body);
      let referenceDuration;
      if (body.references?.length) {
        const inputs = await tx.storedImage.findMany({
          where: { id: { in: body.references.map((ref) => ref.uploadId) }, userId },
        });
        for (const ref of body.references) {
          const stored = inputs.find((item) => item.id === ref.uploadId);
          const rule = caps.references.find((item) => item.role === ref.role);
          if (!stored) throw new AppError(404, 'Референс не найден');
          if (!rule.mimeTypes.includes(stored.mimeType) || stored.size > rule.maxBytes)
            throw new AppError(400, 'Формат или размер референса не поддерживается');
          if (rule.type === 'video') referenceDuration = stored.durationSeconds;
        }
      }
      if (body.trendId) {
        const count = await tx.storedImage.count({
          where: { id: { in: body.sourceImageIds }, userId, storageKind: 'r2' },
        });
        if (count !== body.sourceImageIds.length) throw new AppError(404, 'Фотографии не найдены');
      }
      return tx.generation.create({
        data: {
          ...body,
          duration: body.duration ?? 0,
          quality: body.quality ?? '',
          aspectRatio: body.aspectRatio ?? '',
          generationType: model.generationType || 'Video',
          userId,
          idempotencyKey,
          payloadHash,
          quotaCost,
          adminTest: true,
          costEstimate: {
            ...estimateProviderCost(body, referenceDuration),
            baseCredits: estimateCredits(body).baseCredits,
            chargedCredits: 0,
          },
          sourceImageUrl: body.sourceImageId ? `/api/uploads/${body.sourceImageId}` : null,
        },
      });
    });
  } catch (error) {
    if (error.code === 'P2002' || [402, 429].includes(error.status)) {
      const found = await prisma.generation.findUnique({
        where: { userId_idempotencyKey: { userId, idempotencyKey } },
      });
      if (found && samePayload(found)) return found;
      if (error.code === 'P2002') throw new AppError(409, 'Конфликт параметров повторного запроса');
    }
    throw error;
  }
}
export async function listGenerations(userId, page) {
  const [generations, total] = await prisma.$transaction([
    prisma.generation.findMany({
      where: { userId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * 20,
      take: 20,
    }),
    prisma.generation.count({ where: { userId } }),
  ]);
  return {
    generations: await Promise.all(generations.map(presentGeneration)),
    total,
    page,
    pageSize: 20,
  };
}
export async function ownedGeneration(userId, id) {
  z.string().uuid().parse(id);
  const generation = await prisma.generation.findFirst({ where: { id, userId } });
  if (!generation) throw new AppError(404, 'Генерация не найдена');
  return generation;
}
