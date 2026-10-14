import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import request from 'supertest';

// All database operations used here are stubbed. Never load a real database target.
process.env.NODE_ENV = 'production';
process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:1/not_connected';
process.env.JWT_SECRET = 'test-only-production-secret-not-a-real-credential';
process.env.CORS_ORIGINS = 'https://betelgeuse-ai.vercel.app';
process.env.FRONTEND_URL = 'https://betelgeuse-ai.vercel.app';
process.env.COOKIE_CROSS_SITE = 'true';
process.env.TRUST_PROXY = '1';
process.env.GOOGLE_CLIENT_ID = 'test-google-client';
process.env.GOOGLE_CLIENT_SECRET = 'test-only-client-secret';
process.env.GOOGLE_REDIRECT_URI = 'https://backend.example.test/api/auth/oauth/google/callback';
const { app } = await import('../src/app.js');
const { prisma } = await import('../src/config/prisma.js');
const { oauthReturnUrl } = await import('../src/services/oauth.service.js');
after(() => prisma.$disconnect());
const origin = process.env.FRONTEND_URL;

test('production CORS allows credentialed Vercel requests and preflights, rejects other origins', async () => {
  const response = await request(app).options('/api/generations')
    .set('Origin', origin).set('Access-Control-Request-Method', 'POST')
    .set('Access-Control-Request-Headers', 'content-type,x-csrf-token,idempotency-key').expect(204);
  assert.equal(response.headers['access-control-allow-origin'], origin);
  assert.equal(response.headers['access-control-allow-credentials'], 'true');
  assert.ok(response.headers['access-control-allow-headers'].includes('X-CSRF-Token'));
  for (const denied of ['https://evil.example.test', 'https://betelgeuse-ai.vercel.app.evil.test', 'http://localhost:5173'])
    await request(app).get('/api/models').set('Origin', denied).expect(403);
});

test('production login, session and logout retain HttpOnly Secure cookies and CSRF checks', async () => {
  const user = { id: 'test-user', email: 'test@example.test', name: 'Test', generationCredits: 0,
    passwordHash: await bcrypt.hash('test-password', 4) };
  const findUnique = prisma.user.findUnique;
  prisma.user.findUnique = async () => user;
  try {
    const csrf = await request(app).get('/api/auth/csrf').set('Origin', origin).expect(200);
    const csrfCookie = csrf.headers['set-cookie'][0];
    assert.match(csrfCookie, /HttpOnly/);
    assert.match(csrfCookie, /Secure/);
    assert.match(csrfCookie, /SameSite=None/);
    await request(app).post('/api/auth/login').set('Origin', origin)
      .send({ email: user.email, password: 'test-password' }).expect(403);
    const loggedIn = await request(app).post('/api/auth/login').set('Origin', origin)
      .set('Cookie', csrfCookie.split(';')[0]).set('X-CSRF-Token', csrf.body.token)
      .send({ email: user.email, password: 'test-password' }).expect(200);
    const session = loggedIn.headers['set-cookie'].find((cookie) => cookie.startsWith('btlgs_session='));
    assert.match(session, /HttpOnly/);
    assert.match(session, /Secure/);
    assert.match(session, /SameSite=None/);
    const profile = await request(app).get('/api/auth/me').set('Origin', origin)
      .set('Cookie', session.split(';')[0]).expect(200);
    assert.equal(profile.body.user.id, user.id);
    const out = await request(app).post('/api/auth/logout').set('Origin', origin)
      .set('Cookie', [session.split(';')[0], csrfCookie.split(';')[0]])
      .set('X-CSRF-Token', csrf.body.token).expect(200);
    assert.match(out.headers['set-cookie'][0], /btlgs_session=;/);
    assert.match(out.headers['set-cookie'][0], /SameSite=None/);
  } finally {
    prisma.user.findUnique = findUnique;
  }
});

test('Google OAuth uses configured backend callback and a frontend return from the allowlist', async () => {
  const remove = prisma.oAuthAttempt.deleteMany, create = prisma.oAuthAttempt.create;
  let saved;
  prisma.oAuthAttempt.deleteMany = async () => ({ count: 0 });
  prisma.oAuthAttempt.create = async ({ data }) => { saved = data; return data; };
  try {
    const csrf = await request(app).get('/api/auth/csrf').set('Origin', origin).expect(200);
    const started = await request(app).post('/api/auth/oauth/google/start').set('Origin', origin)
      .set('Cookie', csrf.headers['set-cookie'][0].split(';')[0])
      .set('X-CSRF-Token', csrf.body.token).expect(200);
    const authorize = new URL(started.body.authorizationUrl);
    assert.equal(authorize.searchParams.get('redirect_uri'), process.env.GOOGLE_REDIRECT_URI);
    assert.equal(saved.frontendOrigin, origin);
    assert.match(started.headers['set-cookie'][0], /HttpOnly.*Secure.*SameSite=None/);
    assert.equal(oauthReturnUrl(origin, 'success'), `${origin}/?auth_result=success`);
    assert.equal(new URL(oauthReturnUrl('https://evil.example.test', 'failed')).origin, origin);
  } finally {
    prisma.oAuthAttempt.deleteMany = remove;
    prisma.oAuthAttempt.create = create;
  }
});
