import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { publicTrends } from '../config/trends.js';
import { configuredTrend } from '../config/trends.js';
import { generationEstimate } from '../services/pricing.service.js';
import { z } from 'zod';
import { presentGeneration } from '../services/generation.service.js';
import {
  presignSchema,
  completeSchema,
  trendGenerationSchema,
  presignPhotos,
  completePhoto,
  createTrendGeneration,
} from '../services/trend.service.js';

const router = Router();
router.get('/', (req, res) => res.json({ trends: publicTrends() }));
router.use(authenticate);
router.use(
  rateLimit({
    windowMs: 60000,
    limit: 30,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => req.userId,
    message: { message: 'Слишком много запросов. Попробуйте позже.' },
  }),
);
router.post('/uploads/presign', validate(presignSchema), async (req, res) => {
  res.status(201).json({ uploads: await presignPhotos(req.userId, req.validatedBody) });
});
router.post(
  '/estimate',
  validate(z.object({ trendId: z.string().min(1).max(80) }).strict()),
  async (req, res) => {
    const trend = configuredTrend(req.validatedBody.trendId);
    const { model, mode, duration, quality, aspectRatio } = trend;
    res.json(await generationEstimate({ model, mode, duration, quality, aspectRatio }, req.userId));
  },
);
router.post('/uploads/complete', validate(completeSchema), async (req, res) => {
  const image = await completePhoto(req.userId, req.validatedBody.uploadId);
  res.json({
    image: { id: image.id, key: image.filename, mimeType: image.mimeType, size: image.size },
  });
});
router.post(
  '/generations',
  rateLimit({
    windowMs: 60000,
    limit: 5,
    keyGenerator: (req) => req.userId,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { message: 'Слишком много запросов генерации' },
  }),
  validate(trendGenerationSchema),
  async (req, res) => {
    const row = await createTrendGeneration(
      req.userId,
      req.validatedBody,
      req.get('Idempotency-Key'),
    );
    res.status(202).json({ generation: await presentGeneration(row) });
  },
);
export default router;
