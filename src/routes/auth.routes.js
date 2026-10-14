import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import * as controller from '../controllers/auth.controller.js';
import { authenticate } from '../middleware/auth.js';
import { issueCsrf } from '../middleware/csrf.js';
import { validate } from '../middleware/validate.js';
import * as oauth from '../controllers/oauth.controller.js';
const router = Router();
const email = z
  .string()
  .trim()
  .toLowerCase()
  .email()
  .max(254)
  .refine((value) => !value.endsWith('@telegram.invalid'), 'Этот домен зарезервирован');
const password = z
  .string()
  .min(10)
  .max(72)
  .refine(
    (value) => Buffer.byteLength(value, 'utf8') <= 72,
    'Пароль должен занимать не более 72 байт',
  );
const limit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { code: 'RATE_LIMIT', message: 'Слишком много попыток входа. Попробуйте позже.' },
});
router.get('/csrf', issueCsrf);
router.get('/providers', oauth.providers);
router.post(
  '/oauth/:provider/start',
  limit,
  validate(z.object({}).strict().default({})),
  oauth.start,
);
router.post(
  '/register',
  limit,
  validate(z.object({ email, password, name: z.string().trim().min(2).max(80) }).strict()),
  controller.register,
);
router.post(
  '/login',
  limit,
  validate(z.object({ email, password: z.string().min(1).max(72) }).strict()),
  controller.login,
);
router.post(
  '/telegram',
  limit,
  validate(z.object({ initData: z.string().min(1).max(8192) }).strict()),
  controller.telegram,
);
router.get('/me', authenticate, controller.me);
router.post('/logout', controller.logout);
export default router;
