import { createHash } from 'node:crypto';
import { z } from 'zod';
import { prisma } from '../config/prisma.js';
import { env, providerReady } from '../config/env.js';
import { modelConfigs, generationCreditCost } from '../config/models.js';
import { AppError } from '../middleware/errors.js';
import { r2 } from './r2.service.js';
export const generationSchema = z
  .object({
    model: z.string().max(80),
    prompt: z.string().trim().min(1).max(2000),
    mode: z.enum(['TEXT_TO_VIDEO', 'IMAGE_TO_VIDEO']),
    aspectRatio: z.enum(['16:9', '9:16', '1:1', 'source']),
    duration: z.number().int(),
    quality: z.string().max(20),
    sourceImageId: z.string().uuid().optional(),
  })
  .strict();
export const listSchema = z
  .object({ page: z.coerce.number().int().min(1).max(10000).default(1) })
  .strict();
export function validateGeneration(body) {
  if (!body.prompt?.trim() || body.prompt.length > 2000)
    throw new AppError(400, 'Требуется непустой промпт до 2000 символов');
  const config = modelConfigs.find((item) => item.id === body.model);
  if (!config?.enabled) throw new AppError(400, 'Эта модель пока недоступна');
  const mode = config.modes[body.mode];
  if (
    !mode ||
    !mode.aspectRatios.includes(body.aspectRatio) ||
    !mode.durations.includes(body.duration) ||
    !mode.qualities.includes(body.quality)
  )
    throw new AppError(400, 'Выбранные параметры не поддерживаются моделью');
  if (body.mode === 'IMAGE_TO_VIDEO' && !body.sourceImageId)
    throw new AppError(400, 'Для этого режима требуется изображение');
  if (body.mode === 'TEXT_TO_VIDEO' && body.sourceImageId)
    throw new AppError(400, 'Изображение не поддерживается текстовым режимом');
  if (
    body.mode === 'REFERENCE_TO_VIDEO' &&
    (!body.trendId ||
      !body.sourceImageIds?.length ||
      body.sourceImageIds.length > (mode.maxPhotos || 1))
  )
    throw new AppError(400, 'Некорректные фотографии для выбранной модели');
  const creditCost = generationCreditCost(body.duration);
  if (!Number.isInteger(creditCost)) throw new AppError(400, 'Стоимость генерации не настроена');
  return creditCost;
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
  errorMessage,
  createdAt,
  updatedAt,
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
  errorMessage,
  createdAt,
  updatedAt,
});
export async function presentGeneration(row) {
  const value = publicGeneration(row);
  if (row.resultVideoKey) value.resultVideoUrl = await r2.signRead(row.resultVideoKey, 3600);
  return value;
}
export async function createGeneration(userId, body, idempotencyKey) {
  z.string().uuid().parse(idempotencyKey);
  const requestedCost = validateGeneration(body);
  const payloadHash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
  const existing = await prisma.generation.findUnique({
    where: { userId_idempotencyKey: { userId, idempotencyKey } },
  });
  if (existing) {
    if (existing.payloadHash !== payloadHash)
      throw new AppError(409, 'Идентификатор запроса уже использован с другими параметрами');
    return existing;
  }
  if (!providerReady()) throw new AppError(503, 'Higgsfield API ещё не подключён');
  try {
    return await prisma.$transaction(async (tx) => {
      // Lock the account before reading its role, debiting credits or checking active jobs.
      const locked = await tx.user.updateMany({
        where: { id: userId },
        data: { updatedAt: new Date() },
      });
      if (!locked.count) throw new AppError(401, 'Аккаунт не найден');
      const user = await tx.user.findUnique({ where: { id: userId }, select: { isAdmin: true } });
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
          userId,
          idempotencyKey,
          payloadHash,
          quotaCost,
          sourceImageUrl: body.sourceImageId ? `/api/uploads/${body.sourceImageId}` : null,
        },
      });
    });
  } catch (error) {
    if (error.code === 'P2002' || [402, 429].includes(error.status)) {
      const found = await prisma.generation.findUnique({
        where: { userId_idempotencyKey: { userId, idempotencyKey } },
      });
      if (found && found.payloadHash === payloadHash) return found;
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
