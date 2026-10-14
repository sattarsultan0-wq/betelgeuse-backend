import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { rateLimit } from 'express-rate-limit';
import { randomUUID } from 'node:crypto';
import { env, origins, providerReady } from './config/env.js';
import { prisma } from './config/prisma.js';
import { publicModels } from './config/models.js';
import { AppError, errorHandler } from './middleware/errors.js';
import { csrfProtection } from './middleware/csrf.js';
import authRoutes from './routes/auth.routes.js';
import generationRoutes from './routes/generation.routes.js';
import userRoutes from './routes/user.routes.js';
import uploadRoutes from './routes/upload.routes.js';
import oauthCallbacks from './routes/oauth-callback.routes.js';
import trendRoutes from './routes/trend.routes.js';
import adminRoutes from './routes/admin.routes.js';
export const app = express();
app.disable('x-powered-by');
if (env.TRUST_PROXY) app.set('trust proxy', env.TRUST_PROXY);
app.use((req, res, next) => {
  req.requestId = randomUUID();
  res.set('X-Request-Id', req.requestId);
  next();
});
app.use(helmet());
app.use(cookieParser());
app.use('/api/auth/oauth', oauthCallbacks);
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || origins.includes(origin)) callback(null, true);
      else callback(new AppError(403, 'Origin не разрешён'));
    },
    credentials: true,
    allowedHeaders: ['Content-Type', 'X-CSRF-Token', 'Idempotency-Key'],
    methods: ['GET', 'POST', 'OPTIONS'],
  }),
);
app.use(
  '/api',
  rateLimit({
    windowMs: 60000,
    limit: 150,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { code: 'RATE_LIMIT', message: 'Слишком много запросов' },
  }),
);
app.use(express.json({ limit: '32kb' }));
app.use('/api', csrfProtection);
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
app.get('/api/health', async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({
      status: 'ok',
      database: 'connected',
      provider: providerReady() ? 'configured' : 'not_configured',
    });
  } catch {
    res.status(503).json({
      status: 'degraded',
      database: 'unavailable',
      provider: providerReady() ? 'configured' : 'not_configured',
    });
  }
});
app.get('/api/models', (req, res) => res.json({ models: publicModels() }));
app.use('/api/auth', authRoutes);
app.use('/api/generations', generationRoutes);
app.use('/api/users', userRoutes);
app.use('/api/uploads', uploadRoutes);
app.use('/api/trends', trendRoutes);
app.use('/api/admin', adminRoutes);
app.use((req, res, next) => next(new AppError(404, 'Маршрут не найден')));
app.use(errorHandler);
