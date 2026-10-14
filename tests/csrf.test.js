import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';

process.env.NODE_ENV = 'production';
process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:1/not_connected';
process.env.JWT_SECRET = 'test-only-first-party-secret-not-a-real-credential';
process.env.CORS_ORIGINS = 'https://betelgeuse-ai.vercel.app';
process.env.FRONTEND_URL = process.env.CORS_ORIGINS;
process.env.COOKIE_CROSS_SITE = 'false';
process.env.TRUST_PROXY = '1';
const { app } = await import('../src/app.js');
const { prisma } = await import('../src/config/prisma.js');
const { cookieOptions } = await import('../src/middleware/auth.js');
const { oauthCookieOptions } = await import('../src/services/oauth.service.js');
after(() => prisma.$disconnect());
const origin = process.env.FRONTEND_URL;

test('first-party production cookies remain HttpOnly Secure host-only and scoped to API', async () => {
  const issued = await request(app)
    .get('/api/auth/csrf')
    .set('Origin', origin)
    .expect(200);
  const cookie = issued.headers['set-cookie'][0];
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Path=\/api;/);
  assert.doesNotMatch(cookie, /Domain=/i);
  assert.equal(cookieOptions.domain, undefined);
  assert.equal(cookieOptions.httpOnly, true);
  assert.equal(cookieOptions.secure, true);
  assert.equal(
    oauthCookieOptions('google', `${origin}/api/auth/oauth/google/callback`).sameSite,
    'lax',
  );
  assert.equal(
    oauthCookieOptions('google', `${origin}/api/auth/oauth/google/callback`).path,
    '/api/auth/oauth',
  );
});

test('csrf GET reuses a valid cookie across tabs, refreshes lifetime and replaces malformed cookies', async () => {
  const first = await request(app).get('/api/auth/csrf').expect(200);
  const cookie = first.headers['set-cookie'][0].split(';')[0];
  const tabs = await Promise.all(
    [1, 2].map(() =>
      request(app).get('/api/auth/csrf').set('Cookie', cookie).expect(200),
    ),
  );
  assert.ok(tabs.every((response) => response.body.token === first.body.token));
  assert.match(tabs[0].headers['set-cookie'][0], /Max-Age=86400/);
  const repaired = await request(app)
    .get('/api/auth/csrf')
    .set('Cookie', 'btlgs_csrf=malformed')
    .expect(200);
  assert.match(repaired.body.token, /^[a-f0-9]{64}$/);
});

test('cookie verification reports missing, malformed or mismatched values without disclosing tokens', async () => {
  const token = 'a'.repeat(64);
  for (const [cookie, header, reason] of [
    ['', token, 'COOKIE_MISSING'],
    ['btlgs_csrf=bad', token, 'COOKIE_INVALID'],
    [`btlgs_csrf=${token}`, '', 'TOKEN_MISSING'],
    [`btlgs_csrf=${token}`, 'b'.repeat(64), 'TOKEN_MISMATCH'],
  ]) {
    const res = await request(app)
      .get('/api/auth/csrf/check')
      .set('Origin', origin)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', header)
      .expect(403);
    assert.deepEqual(Object.keys(res.body).sort(), ['code', 'message', 'reason']);
    assert.equal(res.body.code, 'CSRF');
    assert.equal(res.body.reason, reason);
    assert.ok(!JSON.stringify(res.body).includes(token));
  }
  await request(app)
    .get('/api/auth/csrf/check')
    .set('Origin', origin)
    .set('Cookie', `btlgs_csrf=${token}`)
    .set('X-CSRF-Token', token)
    .expect(200, { ok: true });
});

test('CSRF rejection occurs before authentication reads and never allows header-only login', async () => {
  const original = prisma.user.findUnique;
  let reads = 0;
  prisma.user.findUnique = async () => {
    reads++;
    return null;
  };
  const token = 'a'.repeat(64);
  try {
    const missing = await request(app)
      .post('/api/auth/login')
      .set('Origin', origin)
      .set('X-CSRF-Token', token)
      .send({ email: 'test@example.test', password: 'test-only' })
      .expect(403);
    assert.equal(missing.body.reason, 'COOKIE_MISSING');
    const mismatch = await request(app)
      .post('/api/auth/login')
      .set('Origin', origin)
      .set('Cookie', `btlgs_csrf=${token}`)
      .set('X-CSRF-Token', 'b'.repeat(64))
      .send({ email: 'test@example.test', password: 'test-only' })
      .expect(403);
    assert.equal(mismatch.body.reason, 'TOKEN_MISMATCH');
    assert.equal(reads, 0);
    await request(app)
      .post('/api/auth/login')
      .set('Origin', origin)
      .set('Cookie', `btlgs_csrf=${token}`)
      .set('X-CSRF-Token', token)
      .send({ email: 'test@example.test', password: 'test-only' })
      .expect(401);
    assert.equal(reads, 1);
  } finally {
    prisma.user.findUnique = original;
  }
});

test('untrusted origins cannot acquire or verify CSRF and all API responses prohibit CDN caching', async () => {
  for (const route of ['/api/auth/csrf', '/api/auth/csrf/check'])
    await request(app).get(route).set('Origin', 'https://evil.test').expect(403);
  const response = await request(app)
    .get('/api/auth/oauth/google/callback')
    .query({ state: 'invalid' })
    .expect(303);
  assert.equal(response.headers['cdn-cache-control'], 'no-store');
  assert.equal(response.headers['vercel-cdn-cache-control'], 'no-store');
  assert.ok(response.headers['cache-control'].includes('no-store'));
});
