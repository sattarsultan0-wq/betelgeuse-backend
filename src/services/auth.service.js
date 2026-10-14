import bcrypt from 'bcryptjs';
import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import { prisma } from '../config/prisma.js';
import { env } from '../config/env.js';
import { AppError } from '../middleware/errors.js';
export const publicUser = (user) => ({
  id: user.id,
  email: user.email,
  name: user.name,
  telegramId: user.telegramId,
  createdAt: user.createdAt,
  generationCredits: user.generationCredits,
  isAdmin: user.isAdmin === true,
});
export async function register({ email, password, name }) {
  const passwordHash = await bcrypt.hash(password, 12);
  try {
    return await prisma.user.create({
      data: { email, name, passwordHash, generationCredits: env.REGISTRATION_QUOTA },
    });
  } catch (error) {
    if (error.code === 'P2002') throw new AppError(409, 'Этот email уже зарегистрирован');
    throw error;
  }
}
// A fixed valid bcrypt hash keeps nonexistent-user login work comparable to known-user work.
const dummyHash = await bcrypt.hash(randomBytes(32).toString('hex'), 12);
export async function login({ email, password }) {
  const user = await prisma.user.findUnique({ where: { email } });
  const valid = await bcrypt.compare(password, user?.passwordHash || dummyHash);
  if (!user || !valid) throw new AppError(401, 'Неверный email или пароль');
  return user;
}
export function verifyTelegramData(initData, botToken = env.TELEGRAM_BOT_TOKEN, now = Date.now()) {
  if (!botToken) throw new AppError(503, 'Telegram-вход ещё не настроен');
  const params = new URLSearchParams(initData);
  const keys = [...params.keys()];
  if (new Set(keys).size !== keys.length) throw new AppError(401, 'Некорректные данные Telegram');
  const hash = params.get('hash');
  params.delete('hash');
  if (!hash || !/^[a-f0-9]{64}$/.test(hash))
    throw new AppError(401, 'Некорректная подпись Telegram');
  const data = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = createHmac('sha256', secret).update(data).digest();
  if (!timingSafeEqual(expected, Buffer.from(hash, 'hex')))
    throw new AppError(401, 'Недействительная подпись Telegram');
  const authDate = Number(params.get('auth_date'));
  if (!Number.isFinite(authDate) || authDate > now / 1000 + 30 || now / 1000 - authDate > 300)
    throw new AppError(401, 'Данные Telegram устарели. Откройте приложение заново.');
  let user;
  try {
    user = JSON.parse(params.get('user'));
  } catch {
    throw new AppError(401, 'Некорректный пользователь Telegram');
  }
  if (!Number.isSafeInteger(user?.id) || user.id <= 0 || typeof user.first_name !== 'string')
    throw new AppError(401, 'Некорректный пользователь Telegram');
  return user;
}
export async function telegramLogin(initData) {
  const data = verifyTelegramData(initData);
  const telegramId = String(data.id);
  const passwordHash = await bcrypt.hash(randomBytes(32).toString('hex'), 12);
  return prisma.user.upsert({
    where: { telegramId },
    update: {},
    create: {
      telegramId,
      email: `telegram-${telegramId}@telegram.invalid`,
      name: [data.first_name, data.last_name].filter(Boolean).join(' ').slice(0, 80),
      passwordHash,
      generationCredits: env.REGISTRATION_QUOTA,
    },
  });
}
