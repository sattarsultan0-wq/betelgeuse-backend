import 'dotenv/config';
import { z } from 'zod';
const production = process.env.NODE_ENV === 'production';
const frontendUrl = production ? 'https://betelgeuse-ai.vercel.app' : 'http://127.0.0.1:5173';
const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  DATABASE_URL: z.string().startsWith('postgresql://'),
  JWT_SECRET: z.string().min(32),
  CORS_ORIGINS: z.string().default(production ? frontendUrl : 'http://127.0.0.1:5173,http://localhost:5173'),
  FRONTEND_URL: z.string().url().default(frontendUrl),
  COOKIE_CROSS_SITE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  TRUST_PROXY: z.coerce.number().int().min(0).max(1).default(0),
  HIGGSFIELD_API_KEY_ID: z.string().default(''),
  HIGGSFIELD_API_KEY_SECRET: z.string().default(''),
  R2_ACCOUNT_ID: z
    .string()
    .regex(/^([a-f0-9]{32})?$/)
    .default(''),
  R2_ACCESS_KEY_ID: z.string().default(''),
  R2_SECRET_ACCESS_KEY: z.string().default(''),
  R2_BUCKET_NAME: z.string().default('betelgeuse-uploads'),
  R2_INPUT_URL_TTL_SECONDS: z.coerce.number().int().min(3600).max(604800).default(86400),
  HIGGSFIELD_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  REGISTRATION_QUOTA: z.coerce.number().int().min(0).max(100).default(0),
  MAX_ACTIVE_GENERATIONS: z.coerce.number().int().min(1).max(10).default(2),
  WORKER_INTERVAL_MS: z.coerce.number().int().min(1000).default(5000),
  GENERATION_TIMEOUT_MS: z.coerce.number().int().min(60000).default(1200000),
  TELEGRAM_BOT_TOKEN: z.string().default(''),
  GOOGLE_CLIENT_ID: z.string().default(''),
  GOOGLE_CLIENT_SECRET: z.string().default(''),
  // Production must explicitly configure the real Render callback; do not guess its domain.
  GOOGLE_REDIRECT_URI: z.string().default(production ? '' : 'http://127.0.0.1:5173/api/auth/oauth/google/callback'),
  APPLE_CLIENT_ID: z.string().default(''),
  APPLE_TEAM_ID: z.string().default(''),
  APPLE_KEY_ID: z.string().default(''),
  APPLE_PRIVATE_KEY: z.string().default(''),
  APPLE_REDIRECT_URI: z.string().default(''),
  PROVIDER_MEDIA_HOSTS: z.string().default('images.higgs.ai,videos.higgs.ai,cdn.higgsfield.ai'),
});
const result = schema.safeParse(process.env);
if (!result.success) {
  console.error(
    'Invalid environment. Configure backend/.env:',
    result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
  );
  process.exit(1);
}
export const env = result.data;
export const origins = env.CORS_ORIGINS.split(',')
  .map((v) => v.trim())
  .filter(Boolean);
for (const origin of origins) {
  const url = new URL(origin);
  if (url.origin !== origin)
    throw new Error('CORS_ORIGINS must contain exact origins without trailing slashes');
}
const frontend = new URL(env.FRONTEND_URL);
if (
  !['http:', 'https:'].includes(frontend.protocol) ||
  frontend.username || frontend.password || frontend.search || frontend.hash ||
  frontend.pathname !== '/' || !origins.includes(frontend.origin)
)
  throw new Error('FRONTEND_URL must be an allowed frontend origin without a path, query or credentials');
if (env.NODE_ENV === 'production' && origins.some((origin) => !origin.startsWith('https://')))
  throw new Error('Production origins require HTTPS');
if (env.COOKIE_CROSS_SITE && env.NODE_ENV !== 'production')
  throw new Error('Cross-site cookies require production HTTPS');
export const providerReady = () =>
  env.HIGGSFIELD_ENABLED && !!env.HIGGSFIELD_API_KEY_ID && !!env.HIGGSFIELD_API_KEY_SECRET;
export const r2Ready = () =>
  !!env.R2_ACCOUNT_ID &&
  !!env.R2_ACCESS_KEY_ID &&
  !!env.R2_SECRET_ACCESS_KEY &&
  !!env.R2_BUCKET_NAME;
