import { randomBytes, timingSafeEqual } from 'node:crypto';
import { origins } from '../config/env.js';
import { cookieOptions } from './auth.js';
import { AppError } from './errors.js';
export function issueCsrf(req, res) {
  const token = randomBytes(32).toString('hex');
  res.cookie('btlgs_csrf', token, { ...cookieOptions, maxAge: 86400000 });
  res.set('Cache-Control', 'no-store').json({ token });
}
export function csrfProtection(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.headers.origin && !origins.includes(req.headers.origin))
    return next(new AppError(403, 'Origin не разрешён', 'CSRF'));
  const cookie = req.cookies.btlgs_csrf,
    token = req.get('X-CSRF-Token');
  if (
    typeof cookie !== 'string' ||
    typeof token !== 'string' ||
    !/^[a-f0-9]{64}$/.test(cookie) ||
    cookie.length !== token.length ||
    !timingSafeEqual(Buffer.from(cookie), Buffer.from(token))
  )
    return next(new AppError(403, 'Обновите страницу для защищённого соединения', 'CSRF'));
  next();
}
