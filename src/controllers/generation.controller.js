import { pipeline } from 'node:stream/promises';
import * as service from '../services/generation.service.js';
import { requestMedia } from '../services/safe-http.service.js';
import { AppError } from '../middleware/errors.js';
import { r2 } from '../services/r2.service.js';
import { prisma } from '../config/prisma.js';
import { validateModelInput } from '../services/model-validation.service.js';
import { estimateCredits } from '../services/pricing.service.js';
import { providerReady, r2Ready } from '../config/env.js';
export async function estimate(req, res) {
  const body = req.validatedBody;
  validateModelInput(body, { estimate: true });
  const user = await prisma.user.findUnique({
    where: { id: req.userId },
    select: { isAdmin: true, generationCredits: true },
  });
  if (!user) throw new AppError(401, 'Аккаунт не найден');
  const quote = estimateCredits(body, user);
  res.json({
    ...quote,
    providerAvailable: providerReady(),
    storageAvailable: r2Ready(),
    canGenerate: user.isAdmin && providerReady() && r2Ready(),
    adminTest: user.isAdmin,
    sufficientBalance:
      quote.credits !== null && (user.isAdmin || user.generationCredits >= quote.credits),
  });
}
export async function create(req, res) {
  const generation = await service.createGeneration(
    req.userId,
    req.validatedBody,
    req.get('Idempotency-Key'),
  );
  res.status(202).json({ generation: await service.presentGeneration(generation) });
}
export async function list(req, res) {
  res.json(await service.listGenerations(req.userId, req.validatedQuery.page));
}
export async function get(req, res) {
  res.json({
    generation: await service.presentGeneration(
      await service.ownedGeneration(req.userId, req.params.id),
    ),
  });
}
export async function download(req, res) {
  const generation = await service.ownedGeneration(req.userId, req.params.id);
  if (
    generation.status !== 'completed' ||
    (!generation.resultVideoUrl && !generation.resultVideoKey)
  )
    throw new AppError(409, 'Видео ещё не готово');
  const stored = generation.resultVideoKey ? await r2.open(generation.resultVideoKey) : null;
  const stream = stored ? stored.Body : await requestMedia(generation.resultVideoUrl);
  const contentType = stored ? stored.ContentType || '' : stream.headers['content-type'] || '';
  if (!contentType.startsWith('video/') && !contentType.startsWith('application/octet-stream')) {
    stream.destroy();
    throw new AppError(502, 'Провайдер вернул файл неверного типа');
  }
  res.type('video/mp4');
  res.set('Content-Disposition', `attachment; filename="betelgeuse-${generation.id}.mp4"`);
  res.on('close', () => stream.destroy());
  await pipeline(stream, res);
}
