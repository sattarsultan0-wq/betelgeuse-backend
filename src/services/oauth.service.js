import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { createRemoteJWKSet, importPKCS8, jwtVerify, SignJWT } from 'jose';
import { z } from 'zod';
import { isIP } from 'node:net';
import { prisma } from '../config/prisma.js';
import { env, origins } from '../config/env.js';
import { AppError } from '../middleware/errors.js';

const keys = {
  google: createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'), {
    timeoutDuration: 10000,
  }),
  apple: createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys'), {
    timeoutDuration: 10000,
  }),
};
export const oauthHash = (value) => createHash('sha256').update(value).digest('hex');
export const oauthCookieName = (provider) => `btlgs_oauth_${provider}`;
const maxAge = 10 * 60 * 1000;

function validRedirect(value, provider) {
  try {
    const url = new URL(value);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== `/api/auth/oauth/${provider}/callback`
    )
      return false;
    if (provider === 'apple')
      return url.protocol === 'https:' && url.hostname !== 'localhost' && !isIP(url.hostname);
    return (
      url.protocol === 'https:' ||
      (env.NODE_ENV !== 'production' &&
        url.protocol === 'http:' &&
        ['127.0.0.1', 'localhost'].includes(url.hostname))
    );
  } catch {
    return false;
  }
}

export function oauthProvider(provider) {
  if (provider === 'google')
    return {
      provider,
      name: 'Google',
      clientId: env.GOOGLE_CLIENT_ID,
      redirectUri: env.GOOGLE_REDIRECT_URI,
      authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      issuer: ['https://accounts.google.com', 'accounts.google.com'],
      scope: 'openid email profile',
      available: !!(
        env.GOOGLE_CLIENT_ID &&
        env.GOOGLE_CLIENT_SECRET &&
        validRedirect(env.GOOGLE_REDIRECT_URI, provider)
      ),
    };
  if (provider === 'apple')
    return {
      provider,
      name: 'Apple',
      clientId: env.APPLE_CLIENT_ID,
      redirectUri: env.APPLE_REDIRECT_URI,
      authorizeUrl: 'https://appleid.apple.com/auth/authorize',
      tokenUrl: 'https://appleid.apple.com/auth/token',
      issuer: 'https://appleid.apple.com',
      scope: 'name email',
      available: !!(
        env.APPLE_CLIENT_ID &&
        env.APPLE_TEAM_ID &&
        env.APPLE_KEY_ID &&
        env.APPLE_PRIVATE_KEY &&
        validRedirect(env.APPLE_REDIRECT_URI, provider)
      ),
    };
  throw new AppError(400, 'Способ входа не поддерживается', 'OAUTH_PROVIDER');
}
export function publicAuthProviders() {
  return Object.fromEntries(
    ['google', 'apple'].map((provider) => {
      const config = oauthProvider(provider);
      return [provider, { name: config.name, available: config.available }];
    }),
  );
}
export function oauthCookieOptions(provider, redirectUri) {
  return {
    httpOnly: true,
    secure: new URL(redirectUri).protocol === 'https:' || env.NODE_ENV === 'production',
    sameSite: provider === 'apple' || env.COOKIE_CROSS_SITE ? 'none' : 'lax',
    path: '/api/auth/oauth',
    maxAge,
  };
}
export function oauthReturnUrl(frontendOrigin, result) {
  const origin = origins.includes(frontendOrigin) ? frontendOrigin : new URL(env.FRONTEND_URL).origin;
  const url = new URL('/', origin);
  url.searchParams.set('auth_result', result);
  return url.toString();
}

export async function beginOAuth(provider, frontendOrigin, { db = prisma } = {}) {
  const config = oauthProvider(provider);
  if (!config.available)
    throw new AppError(
      503,
      `Вход через ${config.name} скоро появится. Пока используй email.`,
      'OAUTH_NOT_CONFIGURED',
    );
  if (!origins.includes(frontendOrigin)) throw new AppError(403, 'Origin не разрешён');
  const state = randomBytes(32).toString('base64url'),
    binding = randomBytes(32).toString('base64url'),
    nonce = randomBytes(32).toString('base64url');
  const codeVerifier = provider === 'google' ? randomBytes(48).toString('base64url') : null;
  await db.oAuthAttempt.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  await db.oAuthAttempt.create({
    data: {
      provider,
      stateHash: oauthHash(state),
      bindingHash: oauthHash(binding),
      nonceHash: oauthHash(nonce),
      codeVerifier,
      frontendOrigin,
      redirectUri: config.redirectUri,
      expiresAt: new Date(Date.now() + maxAge),
    },
  });
  const url = new URL(config.authorizeUrl);
  const params = {
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: config.scope,
    state,
    nonce,
  };
  if (provider === 'apple') params.response_mode = 'form_post';
  else {
    params.code_challenge = createHash('sha256').update(codeVerifier).digest('base64url');
    params.code_challenge_method = 'S256';
    params.prompt = 'select_account';
  }
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return {
    authorizationUrl: url.toString(),
    binding,
    cookieOptions: oauthCookieOptions(provider, config.redirectUri),
  };
}

export async function consumeOAuthAttempt(
  provider,
  state,
  binding,
  { db = prisma, now = Date.now() } = {},
) {
  if (
    typeof state !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(state) ||
    typeof binding !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(binding)
  )
    throw new AppError(401, 'Сессия входа недействительна. Попробуй ещё раз.', 'OAUTH_STATE');
  const attempt = await db.oAuthAttempt.findUnique({ where: { stateHash: oauthHash(state) } });
  if (
    !attempt ||
    attempt.provider !== provider ||
    attempt.consumedAt ||
    attempt.expiresAt.getTime() <= now ||
    !timingSafeEqual(
      Buffer.from(attempt.bindingHash, 'hex'),
      Buffer.from(oauthHash(binding), 'hex'),
    )
  )
    throw new AppError(401, 'Сессия входа истекла или недействительна.', 'OAUTH_STATE');
  const claimed = await db.oAuthAttempt.updateMany({
    where: { id: attempt.id, consumedAt: null, expiresAt: { gt: new Date(now) } },
    data: { consumedAt: new Date(now) },
  });
  if (!claimed.count) throw new AppError(401, 'Этот запрос входа уже использован.', 'OAUTH_STATE');
  return attempt;
}

export async function appleClientSecret() {
  const key = await importPKCS8(env.APPLE_PRIVATE_KEY.replace(/\\n/g, '\n'), 'ES256');
  return new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: env.APPLE_KEY_ID })
    .setIssuer(env.APPLE_TEAM_ID)
    .setSubject(env.APPLE_CLIENT_ID)
    .setAudience('https://appleid.apple.com')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(key);
}

export async function exchangeOAuthCode(provider, code, attempt, { request = fetch } = {}) {
  const config = oauthProvider(provider);
  const secret = provider === 'google' ? env.GOOGLE_CLIENT_SECRET : await appleClientSecret();
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: config.clientId,
    client_secret: secret,
    redirect_uri: attempt.redirectUri,
  });
  if (provider === 'google') body.set('code_verifier', attempt.codeVerifier);
  let response;
  try {
    response = await request(config.tokenUrl, {
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new AppError(
      502,
      'Сервис входа временно недоступен. Попробуй ещё раз.',
      'OAUTH_PROVIDER_ERROR',
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new AppError(
      401,
      'Не удалось подтвердить вход. Попробуй ещё раз.',
      'OAUTH_PROVIDER_ERROR',
    );
  }
  const data = await response.json().catch(() => null);
  if (typeof data?.id_token !== 'string')
    throw new AppError(401, 'Сервис входа вернул некорректный ответ.', 'OAUTH_TOKEN');
  return data.id_token;
}

export async function verifyOAuthToken(provider, token, attempt, { keySet = keys[provider] } = {}) {
  const config = oauthProvider(provider);
  let payload;
  try {
    ({ payload } = await jwtVerify(token, keySet, {
      issuer: config.issuer,
      audience: config.clientId,
      algorithms: ['RS256'],
      requiredClaims: ['sub', 'iat', 'exp', 'nonce'],
      clockTolerance: 5,
      maxTokenAge: '10m',
    }));
  } catch {
    throw new AppError(401, 'Не удалось проверить подлинность аккаунта.', 'OAUTH_TOKEN');
  }
  if (
    typeof payload.nonce !== 'string' ||
    oauthHash(payload.nonce) !== attempt.nonceHash ||
    typeof payload.sub !== 'string' ||
    !payload.sub.length ||
    payload.sub.length > 255
  )
    throw new AppError(401, 'Недействительный токен входа.', 'OAUTH_TOKEN');
  return {
    provider,
    subject: payload.sub,
    email: typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : null,
    emailVerified: payload.email_verified === true || payload.email_verified === 'true',
    name: typeof payload.name === 'string' ? payload.name.trim().slice(0, 80) : '',
  };
}

export async function socialAccount(profile, { db = prisma } = {}) {
  const key = { provider: profile.provider, subject: profile.subject };
  const identity = await db.authIdentity.findUnique({
    where: { provider_subject: key },
    include: { user: true },
  });
  if (identity) return identity.user;
  const email = z.string().email().max(254).safeParse(profile.email);
  if (!email.success || !profile.emailVerified || email.data.endsWith('@telegram.invalid'))
    throw new AppError(401, 'Для создания аккаунта нужен подтверждённый email.', 'OAUTH_EMAIL');
  // Existing password accounts are not auto-linked by email: local emails are not verified.
  if (await db.user.findUnique({ where: { email: email.data } }))
    throw new AppError(
      409,
      'Этот email уже зарегистрирован. Войди с паролем.',
      'OAUTH_ACCOUNT_EXISTS',
    );
  const passwordHash = await bcrypt.hash(randomBytes(32).toString('hex'), 12);
  try {
    return await db.user.create({
      data: {
        email: email.data,
        name: profile.name || email.data.split('@')[0].slice(0, 80),
        passwordHash,
        generationCredits: env.REGISTRATION_QUOTA,
        identities: { create: key },
      },
    });
  } catch (error) {
    if (error.code === 'P2002') {
      const existing = await db.authIdentity.findUnique({
        where: { provider_subject: key },
        include: { user: true },
      });
      if (existing) return existing.user;
      throw new AppError(
        409,
        'Этот email уже зарегистрирован. Войди с паролем.',
        'OAUTH_ACCOUNT_EXISTS',
      );
    }
    throw error;
  }
}
