import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/admin.js';
import { env, providerReady, r2Ready } from '../config/env.js';
import { prisma } from '../config/prisma.js';
const router = Router();
router.use(authenticate, requireAdmin);
router.get('/status', async (req, res) => {
  const activeGenerations = await prisma.generation.count({
    where: { userId: req.userId, status: { in: ['queued', 'processing'] } },
  });
  res.json({
    providerConfigured: providerReady(),
    storageConfigured: r2Ready(),
    creditExempt: true,
    activeGenerations,
    maxActiveGenerations: env.MAX_ACTIVE_GENERATIONS,
  });
});
export default router;
