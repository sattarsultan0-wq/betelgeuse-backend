import { prisma } from '../config/prisma.js';
import { AppError } from '../middleware/errors.js';

export async function billing(req, res) {
  const user = await prisma.user.findUnique({
    where: { id: req.userId },
    select: {
      generationCredits: true,
      isAdmin: true,
      subscriptions: {
        where: { status: 'active', OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
        include: { plan: true },
        orderBy: [{ expiresAt: 'desc' }, { id: 'asc' }],
        take: 1,
      },
    },
  });
  if (!user) throw new AppError(401, 'Аккаунт не найден');
  const subscription = user.subscriptions[0];
  res.json({
    generationCredits: user.generationCredits,
    isAdmin: user.isAdmin,
    subscription: subscription
      ? {
          id: subscription.id,
          status: subscription.status,
          expiresAt: subscription.expiresAt,
          plan: {
            id: subscription.plan.id,
            name: subscription.plan.name,
            price: subscription.plan.price?.toString() ?? null,
            generationLimit: subscription.plan.generationLimit,
          },
        }
      : null,
    paymentsAvailable: false,
  });
}

export async function images(req, res) {
  const page = req.validatedQuery.page;
  const where = { userId: req.userId, mimeType: { startsWith: 'image/' } };
  const [rows, total] = await Promise.all([
    prisma.storedImage.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      skip: (page - 1) * 20,
      take: 20,
      select: { id: true, mimeType: true, size: true, createdAt: true },
    }),
    prisma.storedImage.count({ where }),
  ]);
  // Serve through the existing ownership-checked upload route; never expose storage keys.
  res.json({ images: rows.map((row) => ({ ...row, name: 'Исходное изображение' })), total, page });
}
