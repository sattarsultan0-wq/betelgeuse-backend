import { prisma } from '../config/prisma.js';
import { setSession, cookieOptions } from '../middleware/auth.js';
import { AppError } from '../middleware/errors.js';
import * as service from '../services/auth.service.js';
export async function register(req, res) {
  const user = await service.register(req.validatedBody);
  setSession(res, user);
  res.status(201).json({ user: service.publicUser(user) });
}
export async function login(req, res) {
  const user = await service.login(req.validatedBody);
  setSession(res, user);
  res.json({ user: service.publicUser(user) });
}
export async function me(req, res) {
  const user = await prisma.user.findUnique({ where: { id: req.userId } });
  if (!user) throw new AppError(401, 'Аккаунт не найден');
  res.json({ user: service.publicUser(user) });
}
export function logout(req, res) {
  res.clearCookie('btlgs_session', cookieOptions);
  res.json({ ok: true });
}
export async function telegram(req, res) {
  const user = await service.telegramLogin(req.validatedBody.initData);
  setSession(res, user);
  res.json({ user: service.publicUser(user) });
}
