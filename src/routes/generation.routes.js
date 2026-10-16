import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { generationSchema, estimateSchema, listSchema } from '../services/generation.service.js';
import * as controller from '../controllers/generation.controller.js';
const router = Router();
router.use(authenticate);
router.post('/estimate', validate(estimateSchema), controller.estimate);
router.post(
  '/',
  rateLimit({
    windowMs: 60000,
    limit: 5,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { message: 'Слишком много запросов генерации' },
  }),
  validate(generationSchema),
  controller.create,
);
router.get('/', validate(listSchema, 'query'), controller.list);
router.get('/:id/download', controller.download);
router.get('/:id', controller.get);
export default router;
