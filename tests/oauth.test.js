import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { exportPKCS8, generateKeyPair, jwtVerify, SignJWT } from 'jose';
import request from 'supertest';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-only-secret-not-a-real-credential-123456789';
process.env.GOOGLE_CLIENT_ID = '';
process.env.GOOGLE_CLIENT_SECRET = '';
process.env.APPLE_CLIENT_ID = '';
process.env.APPLE_PRIVATE_KEY = '';
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
const { app } = await import('../src/app.js');
const { env, origins } = await import('../src/config/env.js');
const { prisma } = await import('../src/config/prisma.js');
const {
  appleClientSecret,
  beginOAuth,
  consumeOAuthAttempt,
  exchangeOAuthCode,
  oauthHash,
  oauthProvider,
  oauthReturnUrl,
  publicAuthProviders,
  socialAccount,
  verifyOAuthToken,
} = await import('../src/services/oauth.service.js');
after(() => prisma.$disconnect());
const google = () => {
  env.GOOGLE_CLIENT_ID = 'test-google-client';
  env.GOOGLE_CLIENT_SECRET = 'test-only-client-secret';
};

test('social auth availability is public and never exposes credentials', async () => {
  const response = await request(app).get('/api/auth/providers').expect(200);
  assert.equal(response.body.providers.google.available, false);
  assert.equal(response.body.providers.apple.available, false);
  assert.deepEqual(Object.keys(response.body.providers.google).sort(), ['available', 'name']);
  const agent = request.agent(app),
    csrf = (await agent.get('/api/auth/csrf')).body.token;
  await agent.post('/api/auth/oauth/google/start').set('X-CSRF-Token', csrf).expect(503);
});
test('only exact provider callbacks bypass app CSRF and CORS checks', async () => {
  await request(app).post('/api/auth/oauth/google/start').expect(403);
  const response = await request(app)
    .post('/api/auth/oauth/apple/callback')
    .set('Origin', 'https://appleid.apple.com')
    .type('form')
    .send({ state: 'invalid' })
    .expect(303);
  assert.equal(new URL(response.headers.location).searchParams.get('auth_result'), 'expired');
  await request(app)
    .post('/api/auth/login')
    .set('Origin', 'https://appleid.apple.com')
    .send({ email: 'a@example.com', password: 'password' })
    .expect(403);
});
test('OAuth start creates PKCE, nonce, a browser binding and a fixed redirect', async () => {
  google();
  let saved;
  const db = {
    oAuthAttempt: {
      deleteMany: async () => {},
      create: async ({ data }) => {
        saved = data;
      },
    },
  };
  const result = await beginOAuth('google', origins[0], { db });
  const url = new URL(result.authorizationUrl);
  assert.equal(url.origin, 'https://accounts.google.com');
  assert.equal(saved.stateHash, oauthHash(url.searchParams.get('state')));
  assert.equal(saved.bindingHash, oauthHash(result.binding));
  assert.equal(saved.nonceHash, oauthHash(url.searchParams.get('nonce')));
  assert.equal(
    url.searchParams.get('code_challenge'),
    createHash('sha256').update(saved.codeVerifier).digest('base64url'),
  );
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(result.cookieOptions.httpOnly, true);
  await assert.rejects(
    beginOAuth('google', 'https://evil.test', { db }),
    (error) => error.status === 403,
  );
  assert.equal(new URL(oauthReturnUrl('https://evil.test', 'failed')).origin, origins[0]);
});
test('state validation rejects missing binding, wrong provider, expiry and replay', async () => {
  const state = randomBytes(32).toString('base64url'),
    binding = randomBytes(32).toString('base64url');
  const row = {
    id: 'attempt',
    provider: 'google',
    stateHash: oauthHash(state),
    bindingHash: oauthHash(binding),
    expiresAt: new Date(Date.now() + 60000),
    consumedAt: null,
  };
  const db = {
    oAuthAttempt: {
      findUnique: async () => row,
      updateMany: async ({ data }) => {
        if (row.consumedAt) return { count: 0 };
        row.consumedAt = data.consumedAt;
        return { count: 1 };
      },
    },
  };
  await assert.rejects(consumeOAuthAttempt('google', state, undefined, { db }));
  await assert.rejects(
    consumeOAuthAttempt('google', state, randomBytes(32).toString('base64url'), { db }),
  );
  await assert.rejects(consumeOAuthAttempt('apple', state, binding, { db }));
  await assert.rejects(
    consumeOAuthAttempt('google', state, binding, { db, now: Date.now() + 120000 }),
  );
  assert.equal((await consumeOAuthAttempt('google', state, binding, { db })).id, row.id);
  await assert.rejects(consumeOAuthAttempt('google', state, binding, { db }));
});
test('signed identity tokens require matching issuer, audience, expiry and nonce', async () => {
  google();
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const nonce = randomBytes(32).toString('base64url'),
    attempt = { nonceHash: oauthHash(nonce) };
  const sign = (claims = {}, audience = env.GOOGLE_CLIENT_ID, expiry = '5m') =>
    new SignJWT({
      nonce,
      email: 'test@example.com',
      email_verified: true,
      name: 'Test Author',
      ...claims,
    })
      .setProtectedHeader({ alg: 'RS256' })
      .setSubject('test-provider-subject')
      .setIssuer('https://accounts.google.com')
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime(expiry)
      .sign(privateKey);
  const profile = await verifyOAuthToken('google', await sign(), attempt, { keySet: publicKey });
  assert.equal(profile.emailVerified, true);
  assert.equal(profile.subject, 'test-provider-subject');
  await assert.rejects(
    verifyOAuthToken('google', await sign({ nonce: 'changed' }), attempt, { keySet: publicKey }),
  );
  await assert.rejects(
    verifyOAuthToken('google', await sign({}, 'wrong-client'), attempt, { keySet: publicKey }),
  );
  await assert.rejects(
    verifyOAuthToken('google', await sign({}, env.GOOGLE_CLIENT_ID, '-1m'), attempt, {
      keySet: publicKey,
    }),
  );
  const other = await generateKeyPair('RS256');
  await assert.rejects(
    verifyOAuthToken('google', await sign(), attempt, { keySet: other.publicKey }),
  );
});
test('code exchange submits PKCE and server credentials only to the fixed token endpoint', async () => {
  google();
  let captured;
  const token = await exchangeOAuthCode(
    'google',
    'test-code',
    { redirectUri: env.GOOGLE_REDIRECT_URI, codeVerifier: 'test-verifier' },
    {
      request: async (url, options) => {
        captured = { url, options };
        return { ok: true, json: async () => ({ id_token: 'test-token' }) };
      },
    },
  );
  assert.equal(token, 'test-token');
  assert.equal(captured.url, 'https://oauth2.googleapis.com/token');
  assert.equal(captured.options.body.get('code_verifier'), 'test-verifier');
  assert.equal(captured.options.body.get('client_secret'), env.GOOGLE_CLIENT_SECRET);
  assert.equal(captured.options.redirect, 'error');
});
test('Apple creates a short-lived ES256 client secret and requires a public HTTPS callback', async () => {
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
  env.APPLE_CLIENT_ID = 'test.apple.service';
  env.APPLE_TEAM_ID = 'TESTTEAM';
  env.APPLE_KEY_ID = 'TESTKEY';
  env.APPLE_PRIVATE_KEY = (await exportPKCS8(privateKey)).replace(/\n/g, '\\n');
  env.APPLE_REDIRECT_URI = 'http://localhost:5173/api/auth/oauth/apple/callback';
  assert.equal(oauthProvider('apple').available, false);
  env.APPLE_REDIRECT_URI = 'https://127.0.0.1/api/auth/oauth/apple/callback';
  assert.equal(oauthProvider('apple').available, false);
  env.APPLE_REDIRECT_URI = 'https://api.example.test/api/auth/oauth/apple/callback';
  assert.equal(oauthProvider('apple').available, true);
  const { payload, protectedHeader } = await jwtVerify(await appleClientSecret(), publicKey, {
    issuer: env.APPLE_TEAM_ID,
    audience: 'https://appleid.apple.com',
    algorithms: ['ES256'],
  });
  assert.equal(payload.sub, env.APPLE_CLIENT_ID);
  assert.equal(protectedHeader.kid, env.APPLE_KEY_ID);
  assert.ok(payload.exp - payload.iat <= 300);
});
test(
  'PostgreSQL OAuth: persisted state is one-use and provider subjects own accounts',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    google();
    const users = [],
      states = [];
    try {
      const started = await beginOAuth('google', origins[0]);
      const state = new URL(started.authorizationUrl).searchParams.get('state');
      states.push(oauthHash(state));
      const results = await Promise.allSettled(
        [1, 2].map(() => consumeOAuthAttempt('google', state, started.binding)),
      );
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
      const subject = randomUUID(),
        email = `oauth-${subject}@example.com`;
      const profile = {
        provider: 'google',
        subject,
        email,
        emailVerified: true,
        name: 'OAuth Author',
      };
      const user = await socialAccount(profile);
      users.push(user.id);
      assert.equal(user.email, email);
      assert.equal(user.generationCredits, 0);
      assert.equal((await socialAccount({ ...profile, email: 'changed@example.com' })).id, user.id);
      await assert.rejects(
        socialAccount({ ...profile, provider: 'apple', subject: randomUUID() }),
        (error) => error.code === 'OAUTH_ACCOUNT_EXISTS',
      );
      await assert.rejects(
        socialAccount({
          ...profile,
          subject: randomUUID(),
          email: 'unverified@example.com',
          emailVerified: false,
        }),
        (error) => error.code === 'OAUTH_EMAIL',
      );
      assert.equal(await prisma.authIdentity.count({ where: { userId: user.id } }), 1);
    } finally {
      await prisma.oAuthAttempt.deleteMany({ where: { stateHash: { in: states } } });
      await prisma.user.deleteMany({ where: { id: { in: users } } });
    }
  },
);
