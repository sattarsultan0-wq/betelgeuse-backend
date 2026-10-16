import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-only-secret-not-a-real-credential-123456789';
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.DATABASE_URL ||= 'postgresql://test:test@127.0.0.1:5432/test';
process.env.HIGGSFIELD_ENABLED = 'false';
const { app } = await import('../src/app.js');
const { prisma } = await import('../src/config/prisma.js');
const { env } = await import('../src/config/env.js');
const { createGeneration } = await import('../src/services/generation.service.js');
const { processGeneration } = await import('../src/jobs/generation.worker.js');
const ids = [];
const { r2 } = await import('../src/services/r2.service.js');
const { mockR2 } = await import('../test-support/mock-r2.js');
after(async () => {
  if (ids.length) await prisma.user.deleteMany({ where: { id: { in: ids } } });
  await prisma.$disconnect();
});

test('admin endpoint requires authenticated access', async () => {
  await request(app).get('/api/admin/status').expect(401);
});

test(
  'PostgreSQL admin: display name cannot grant access, zero-credit generation is role-based, revocation applies immediately',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const originalEnv = { ...env };
    const restoreR2 = mockR2(env, r2);
    try {
      const agent = request.agent(app),
        token = (await agent.get('/api/auth/csrf')).body.token;
      const credentials = {
        email: `admin-${randomUUID()}@example.com`,
        name: 'Sultan',
        password: 'test-password-123',
      };
      await agent
        .post('/api/auth/register')
        .set('X-CSRF-Token', token)
        .send({ ...credentials, isAdmin: true })
        .expect(400);
      const registered = await agent
        .post('/api/auth/register')
        .set('X-CSRF-Token', token)
        .send(credentials)
        .expect(201);
      const userId = registered.body.user.id;
      ids.push(userId);
      assert.equal(registered.body.user.isAdmin, false);
      await agent.get('/api/admin/status').expect(403);
      Object.assign(env, {
        HIGGSFIELD_ENABLED: true,
        HIGGSFIELD_API_KEY_ID: 'test',
        HIGGSFIELD_API_KEY_SECRET: 'test',
      });
      const body = {
        model: 'kling',
        prompt: 'Server test scene',
        mode: 'TEXT_TO_VIDEO',
        duration: 5,
        quality: 'standard',
        aspectRatio: '16:9',
      };
      await prisma.user.update({ where: { id: userId }, data: { generationCredits: 50 } });
      await assert.rejects(createGeneration(userId, body, randomUUID()), {
        status: 403,
        code: 'ADMIN_REQUIRED',
      });
      await prisma.user.update({ where: { id: userId }, data: { generationCredits: 0 } });
      await prisma.user.update({ where: { id: userId }, data: { isAdmin: true } });
      assert.equal((await agent.get('/api/auth/me').expect(200)).body.user.isAdmin, true);
      const status = await agent.get('/api/admin/status').expect(200);
      assert.equal(status.body.creditExempt, true);
      assert.ok(!JSON.stringify(status.body).includes('test-secret'));
      const key = randomUUID();
      const [first, repeat] = await Promise.all([
        createGeneration(userId, body, key),
        createGeneration(userId, body, key),
      ]);
      assert.equal(first.id, repeat.id);
      assert.equal(first.quotaCost, 0);
      assert.equal(first.adminTest, true);
      assert.equal(first.costEstimate.amountUsd, 0.42);
      assert.equal((await prisma.user.findUnique({ where: { id: userId } })).generationCredits, 0);
      const receipt = randomUUID();
      const row = await prisma.generation.update({
        where: { id: first.id },
        data: {
          leaseToken: 'test',
          providerRequestId: receipt,
          providerStatusUrl: `https://api.higgsfield.ai/requests/${receipt}/status`,
        },
      });
      await processGeneration(row, {
        provider: { status: async () => ({ request_id: receipt, status: 'failed' }) },
      });
      assert.equal(
        (await prisma.user.findUnique({ where: { id: userId } })).generationCredits,
        0,
        'Failed free generation must not mint credits',
      );
      for (let i = 0; i < env.MAX_ACTIVE_GENERATIONS; i++)
        await createGeneration(userId, body, randomUUID());
      await assert.rejects(createGeneration(userId, body, randomUUID()), { status: 429 });
      await prisma.user.update({ where: { id: userId }, data: { isAdmin: false } });
      await agent.get('/api/admin/status').expect(403);
      assert.equal((await agent.get('/api/auth/me').expect(200)).body.user.isAdmin, false);
      await assert.rejects(createGeneration(userId, body, randomUUID()), { status: 403 });
      await assert.rejects(createGeneration(userId, body, key), { status: 403 });
    } finally {
      restoreR2();
      Object.assign(env, originalEnv);
    }
  },
);
