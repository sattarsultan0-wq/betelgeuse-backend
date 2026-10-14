import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { AppError } from './errors.js';
export function authenticate(req, res, next) {
  try {
    const token = req.cookies.btlgs_session;
    if (!token) throw new Error();
    const payload = jwt.verify(token, env.JWT_SECRET, {
      algorithms: ['HS256'],
      issuer: 'betelgeuse',
      audience: 'betelgeuse-web',
    });
    if (typeof payload.sub !== 'string') throw new Error();
    req.userId = payload.sub;
    next();
  } catch {
    next(new AppError(401, 'Войдите в аккаунт', 'UNAUTHORIZED'));
  }
}
export const cookieOptions = {
  httpOnly: true,
  secure: env.NODE_ENV === 'production',
  sameSite: env.COOKIE_CROSS_SITE ? 'none' : 'lax',
  path: '/api',
};
export function setSession(res, user) {
  const token = jwt.sign({}, env.JWT_SECRET, {
    algorithm: 'HS256',
    subject: user.id,
    issuer: 'betelgeuse',
    audience: 'betelgeuse-web',
    expiresIn: '7d',
  });
  res.cookie('btlgs_session', token, { ...cookieOptions, maxAge: 7 * 24 * 60 * 60 * 1000 });
}
