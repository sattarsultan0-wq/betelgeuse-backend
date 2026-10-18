import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import sharp from 'sharp';
import { fileTypeFromBuffer } from 'file-type';
import { prisma } from '../config/prisma.js';
import { configuredTrend } from '../config/trends.js';
import { r2Ready } from '../config/env.js';
import { AppError } from '../middleware/errors.js';
import { r2, PHOTO_TYPES, MAX_PHOTO_BYTES, UPLOAD_TTL_SECONDS } from './r2.service.js';
import { createGeneration } from './generation.service.js';

export const presignSchema = z
  .object({
    trendId: z.string().min(1).max(80),
    files: z
      .array(
        z
          .object({
            mimeType: z.enum(PHOTO_TYPES),
            size: z.number().int().min(1).max(MAX_PHOTO_BYTES),
          })
          .strict(),
      )
      .min(1)
      .max(4),
  })
  .strict();
export const completeSchema = z.object({ uploadId: z.string().uuid() }).strict();
export const trendGenerationSchema = z
  .object({
    trendId: z.string().min(1).max(80),
    photoKeys: z.array(z.string().min(1).max(250)).min(1).max(4),
    priceConfirmation: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();

export async function presignPhotos(userId, body, { db = prisma, store = r2 } = {}) {
  const trend = configuredTrend(body.trendId);
  if (!r2Ready()) throw new AppError(503, 'Хранилище фотографий ещё не подключено');
  if (body.files.length > trend.maxPhotos)
    throw new AppError(400, 'Слишком много фотографий для этого тренда');
  const expiresAt = new Date(Date.now() + UPLOAD_TTL_SECONDS * 1000);
  const uploads = await db.$transaction(async (tx) => {
    // Serialize upload reservations per user so concurrent batches cannot bypass the cap.
    await tx.user.update({ where: { id: userId }, data: { updatedAt: new Date() } });
    const count = await tx.directUpload.count({
      where: { userId, createdAt: { gte: new Date(Date.now() - 3600000) } },
    });
    if (count + body.files.length > 40) throw new AppError(429, 'Лимит загрузок за час исчерпан');
    const rows = [];
    for (const file of body.files) {
      const id = randomUUID();
      const row = await tx.directUpload.create({
        data: {
          ...file,
          id,
          userId,
          trendId: body.trendId,
          objectKey: `pending/${userId}/${id}`,
          expiresAt,
        },
      });
      rows.push(row);
    }
    return rows;
  });
  return Promise.all(
    uploads.map(async (row) => ({
      uploadId: row.id,
      uploadUrl: await store.signUpload(row.objectKey, row.mimeType, row.size),
      headers: { 'Content-Type': row.mimeType },
      expiresAt,
    })),
  );
}

export async function completePhoto(userId, uploadId, { db = prisma, store = r2 } = {}) {
  const row = await db.directUpload.findFirst({ where: { id: uploadId, userId } });
  if (!row) throw new AppError(404, 'Загрузка не найдена');
  if (row.imageId) return db.storedImage.findFirst({ where: { id: row.imageId, userId } });
  if (row.expiresAt < new Date())
    throw new AppError(410, 'Срок загрузки истёк. Выберите фотографию снова.');
  const head = await store.head(row.objectKey);
  if (
    head.ContentLength !== row.size ||
    head.ContentLength > MAX_PHOTO_BYTES ||
    head.ContentType !== row.mimeType
  )
    throw new AppError(400, 'Размер или тип загруженного файла не совпадает с заявленным');
  const buffer = await store.read(row.objectKey, MAX_PHOTO_BYTES);
  const type = await fileTypeFromBuffer(buffer);
  if (
    buffer.length !== row.size ||
    type?.mime !== row.mimeType ||
    !PHOTO_TYPES.includes(type?.mime)
  )
    throw new AppError(400, 'Содержимое фотографии не соответствует JPEG, PNG или WebP');
  let normalized;
  try {
    normalized = await sharp(buffer, { limitInputPixels: 25000000, animated: false })
      .rotate()
      .jpeg({ quality: 90 })
      .toBuffer();
  } catch {
    throw new AppError(400, 'Изображение повреждено или превышает 25 мегапикселей');
  }
  if (normalized.length > MAX_PHOTO_BYTES)
    throw new AppError(400, 'Обработанная фотография превышает 10 МБ');
  const id = randomUUID(),
    key = `images/${userId}/${id}.jpg`;
  // The browser can still reuse its PUT link. Copy validated bytes to a different, server-only key.
  await store.put(key, normalized, 'image/jpeg');
  let image;
  try {
    image = await db.$transaction(async (tx) => {
      const won = await tx.directUpload.updateMany({
        where: { id: uploadId, userId, imageId: null },
        data: { imageId: id },
      });
      if (!won.count) return null;
      return tx.storedImage.create({
        data: {
          id,
          userId,
          filename: key,
          mimeType: 'image/jpeg',
          size: normalized.length,
          storageKind: 'r2',
        },
      });
    });
  } catch (error) {
    await store.remove(key).catch(() => {});
    throw error;
  }
  if (!image) {
    await store.remove(key);
    const completed = await db.directUpload.findFirst({ where: { id: uploadId, userId } });
    image = await db.storedImage.findFirst({ where: { id: completed.imageId, userId } });
  }
  await store.remove(row.objectKey).catch(() => {});
  return image;
}

export async function createTrendGeneration(
  userId,
  body,
  key,
  { db = prisma, create = createGeneration } = {},
) {
  const trend = configuredTrend(body.trendId);
  if (!r2Ready()) throw new AppError(503, 'Хранилище фотографий ещё не подключено');
  if (
    new Set(body.photoKeys).size !== body.photoKeys.length ||
    body.photoKeys.length < trend.minPhotos ||
    body.photoKeys.length > trend.maxPhotos
  )
    throw new AppError(
      400,
      `Для этого тренда требуется от ${trend.minPhotos} до ${trend.maxPhotos} разных фотографий`,
    );
  const images = await db.storedImage.findMany({
    where: { userId, storageKind: 'r2', filename: { in: body.photoKeys } },
  });
  if (images.length !== body.photoKeys.length)
    throw new AppError(404, 'Фотографии не найдены или ещё не проверены');
  const ids = body.photoKeys.map((name) => images.find((image) => image.filename === name).id);
  return create(
    userId,
    {
      trendId: body.trendId,
      model: trend.model,
      prompt: trend.prompt,
      mode: trend.mode,
      aspectRatio: trend.aspectRatio,
      duration: trend.duration,
      quality: trend.quality,
      sourceImageId: ids[0],
      sourceImageIds: ids,
      ...(body.priceConfirmation ? { priceConfirmation: body.priceConfirmation } : {}),
    },
    key,
  );
}
