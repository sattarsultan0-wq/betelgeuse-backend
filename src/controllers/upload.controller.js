import { prisma } from '../config/prisma.js';
import { storage } from '../services/storage.service.js';
import { AppError } from '../middleware/errors.js';
import { z } from 'zod';
import { r2 } from '../services/r2.service.js';
import { pipeline } from 'node:stream/promises';
import { r2Ready } from '../config/env.js';
export async function upload(req, res) {
  if (!req.file) throw new AppError(400, 'Добавьте изображение');
  let stored =
    req.path === '/references'
      ? await storage.saveReference(req.file)
      : await storage.saveImage(req.file);
  if (r2Ready()) {
    const key = `references/${req.userId}/${stored.filename}`;
    try {
      await r2.put(key, await storage.read(stored.filename), stored.mimeType);
    } finally {
      await storage.remove(stored.filename);
    }
    stored = { ...stored, filename: key, storageKind: 'r2' };
  }
  try {
    const image = await prisma.storedImage.create({ data: { ...stored, userId: req.userId } });
    res.status(201).json({
      image: {
        id: image.id,
        url: `/api/uploads/${image.id}`,
        mimeType: image.mimeType,
        size: image.size,
      },
    });
  } catch (error) {
    if (stored.storageKind === 'r2') await r2.remove(stored.filename);
    else await storage.remove(stored.filename);
    throw error;
  }
}
export async function getImage(req, res) {
  const id = z.string().uuid().parse(req.params.id);
  const image = await prisma.storedImage.findFirst({ where: { id, userId: req.userId } });
  if (!image) throw new AppError(404, 'Изображение не найдено');
  res.set('Cache-Control', 'private, no-store');
  if (image.storageKind === 'r2') {
    const stored = await r2.open(image.filename);
    res.type(image.mimeType);
    res.on('close', () => stored.Body.destroy());
    await pipeline(stored.Body, res);
    return;
  }
  res.type(image.mimeType).sendFile(storage.resolve(image.filename));
}
