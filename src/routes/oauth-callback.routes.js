import { Router, urlencoded } from 'express';
import { rateLimit } from 'express-rate-limit';
import { callback } from '../controllers/oauth.controller.js';
const router = Router();
const limit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 40,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { message: 'Слишком много попыток входа' },
});
// Provider callbacks use a one-time state + HttpOnly browser-binding cookie instead
// of application CSRF. Apple's form_post has a provider Origin and needs this exact route.
router.get('/google/callback', limit, callback('google'));
router.post(
  '/apple/callback',
  limit,
  urlencoded({ extended: false, limit: '16kb', parameterLimit: 10 }),
  callback('apple'),
);
export default router;
