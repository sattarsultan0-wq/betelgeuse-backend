import { prisma } from '../config/prisma.js';
import { AppError } from './errors.js';

export async function requireAdmin(req, res, next) {
  const user = await prisma.user.findUnique({
    where: { id: req.userId },
    select: { isAdmin: true },
  });
  if (!user?.isAdmin) throw new AppError(403, 'Требуется доступ администратора', 'ADMIN_REQUIRED');
  next();
}
