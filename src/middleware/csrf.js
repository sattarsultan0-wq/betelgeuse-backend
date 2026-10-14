import { randomBytes, timingSafeEqual } from 'node:crypto';
import { origins } from '../config/env.js';
import { cookieOptions } from './auth.js';
import { AppError } from './errors.js';
export function issueCsrf(req, res) {
  // Keep a valid browser token stable across tabs and refresh its cookie lifetime.
  const existing = req.cookies.btlgs_csrf;
  const token =
    typeof existing === 'string' && /^[a-f0-9]{64}$/.test(existing)
      ? existing
      : randomBytes(32).toString('hex');
  res.cookie('btlgs_csrf', token, { ...cookieOptions, maxAge: 86400000 });
  res.set('Cache-Control', 'no-store').json({ token });
}
function csrfError(req, reason) {
  const error = new AppError(403, 'Обновите страницу для защищённого соединения', 'CSRF');
  error.reason = reason;
  // No tokens, cookies, email, or credentials in diagnostics.
  console.warn(
    JSON.stringify({ event: 'csrf_rejected', reason, requestId: req.requestId }),
  );
  return error;
}
function validateCsrf(req) {
  if (req.headers.origin && !origins.includes(req.headers.origin))
    return csrfError(req, 'ORIGIN');
  const cookie = req.cookies.btlgs_csrf,
    token = req.get('X-CSRF-Token');
  if (typeof cookie !== 'string') return csrfError(req, 'COOKIE_MISSING');
  if (!/^[a-f0-9]{64}$/.test(cookie)) return csrfError(req, 'COOKIE_INVALID');
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token))
    return csrfError(req, 'TOKEN_MISSING');
  if (!timingSafeEqual(Buffer.from(cookie), Buffer.from(token)))
    return csrfError(req, 'TOKEN_MISMATCH');
  return null;
}
export function checkCsrf(req, res, next) {
  const error = validateCsrf(req);
  if (error) return next(error);
  res.set('Cache-Control', 'no-store').json({ ok: true });
}
export function csrfProtection(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const error = validateCsrf(req);
  if (error) return next(error);
  next();
}
