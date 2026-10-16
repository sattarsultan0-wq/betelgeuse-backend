import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import sharp from 'sharp';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-only-secret-not-a-real-credential-123456789';
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
const { app } = await import('../src/app.js');
const { prisma } = await import('../src/config/prisma.js');
const { env } = await import('../src/config/env.js');
const { storage } = await import('../src/services/storage.service.js');
const { processGeneration } = await import('../src/jobs/generation.worker.js');
const { ProviderError } = await import('../src/services/higgsfield.service.js');
const { r2 } = await import('../src/services/r2.service.js');
const { mockR2 } = await import('../test-support/mock-r2.js');
const ids = [],
  files = [];
after(async () => {
  if (ids.length) await prisma.user.deleteMany({ where: { id: { in: ids } } });
  for (const file of files) {
    if (!file.includes('/')) await storage.remove(file);
  }
  await prisma.$disconnect();
});
test(
  'PostgreSQL: auth, ownership, upload, quota, idempotency, retries and refunds',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const restoreR2 = mockR2(env, r2);
    try {
      const suffix = randomUUID();
      const a = request.agent(app),
        b = request.agent(app);
      const csrfA = (await a.get('/api/auth/csrf')).body.token,
        csrfB = (await b.get('/api/auth/csrf')).body.token;
      const registerA = await a
        .post('/api/auth/register')
        .set('X-CSRF-Token', csrfA)
        .send({ email: `a-${suffix}@example.com`, name: 'Alpha', password: 'safe-password-123' })
        .expect(201);
      ids.push(registerA.body.user.id);
      const registerB = await b
        .post('/api/auth/register')
        .set('X-CSRF-Token', csrfB)
        .send({ email: `b-${suffix}@example.com`, name: 'Beta', password: 'safe-password-123' })
        .expect(201);
      ids.push(registerB.body.user.id);
      assert.ok(registerA.headers['set-cookie'].some((cookie) => cookie.includes('HttpOnly')));
      await a
        .post('/api/auth/login')
        .set('X-CSRF-Token', csrfA)
        .send({ email: registerA.body.user.email, password: 'wrong-password' })
        .expect(401);
      await a
        .post('/api/auth/login')
        .set('X-CSRF-Token', csrfA)
        .send({ email: registerA.body.user.email, password: 'safe-password-123' })
        .expect(200);
      assert.equal((await a.get('/api/auth/me').expect(200)).body.user.id, ids[0]);
      const storedUser = await prisma.user.findUnique({ where: { id: ids[0] } });
      assert.notEqual(storedUser.passwordHash, 'safe-password-123');
      env.HIGGSFIELD_ENABLED = true;
      env.HIGGSFIELD_API_KEY_ID = 'test-only';
      env.HIGGSFIELD_API_KEY_SECRET = 'test-only';
      const body = {
        model: 'kling',
        prompt: 'Integration test scene',
        mode: 'TEXT_TO_VIDEO',
        aspectRatio: '16:9',
        duration: 5,
        quality: 'standard',
      };
      await a
        .post('/api/generations')
        .set('X-CSRF-Token', csrfA)
        .set('Idempotency-Key', randomUUID())
        .send(body)
        .expect(403);
      await prisma.user.update({
        where: { id: ids[0] },
        data: { isAdmin: true, generationCredits: 1 },
      });
      const key = randomUUID();
      const requests = await Promise.all(
        [1, 2].map(() =>
          a
            .post('/api/generations')
            .set('X-CSRF-Token', csrfA)
            .set('Idempotency-Key', key)
            .send(body),
        ),
      );
      assert.ok(
        requests.every((response) => response.status === 202),
        JSON.stringify(requests.map((r) => r.body)),
      );
      assert.equal(requests[0].body.generation.id, requests[1].body.generation.id);
      const generationId = requests[0].body.generation.id;
      assert.equal((await prisma.user.findUnique({ where: { id: ids[0] } })).generationCredits, 1);
      await b.get(`/api/generations/${generationId}`).expect(404);
      await b.get(`/api/generations/${generationId}/download`).expect(404);
      assert.equal((await b.get('/api/generations').expect(200)).body.total, 0);
      await a
        .post('/api/generations')
        .set('X-CSRF-Token', csrfA)
        .set('Idempotency-Key', key)
        .send({ ...body, prompt: 'Different' })
        .expect(409);
      const imageBuffer = await sharp({
        create: { width: 32, height: 32, channels: 3, background: '#111' },
      })
        .png()
        .toBuffer();
      const upload = await a
        .post('/api/uploads')
        .set('X-CSRF-Token', csrfA)
        .attach('image', imageBuffer, { filename: 'test.png', contentType: 'image/png' })
        .expect(201);
      const image = await prisma.storedImage.findUnique({ where: { id: upload.body.image.id } });
      files.push(image.filename);
      await b.get(`/api/uploads/${image.id}`).expect(404);
      await a.get(`/api/uploads/${image.id}`).expect(200);
      await a
        .post('/api/uploads')
        .set('X-CSRF-Token', csrfA)
        .attach('image', Buffer.from('not an image'), {
          filename: 'fake.png',
          contentType: 'image/png',
        })
        .expect(400);
      let row = await prisma.generation.update({
        where: { id: generationId },
        data: { leaseToken: 'test-lease' },
      });
      await processGeneration(row, {
        provider: {
          submit: async () => {
            throw new ProviderError('Transient test', { retryable: true });
          },
        },
      });
      row = await prisma.generation.findUnique({ where: { id: generationId } });
      assert.equal(row.status, 'failed');
      assert.ok(row.submissionAttemptedAt);
      assert.equal(row.attempts, 0);
      assert.equal(row.quotaRefunded, false);
      // The provider is a local mock. Explicitly reconcile its known non-acceptance
      // before exercising the accepted receipt and refund paths below.
      row = await prisma.generation.update({
        where: { id: generationId },
        data: { leaseToken: 'test-lease-2', status: 'queued', submissionAttemptedAt: null },
      });
      const requestId = randomUUID();
      await processGeneration(row, {
        provider: {
          submit: async () => ({
            request_id: requestId,
            status_url: `https://api.higgsfield.ai/requests/${requestId}/status`,
            status: 'in_progress',
          }),
        },
      });
      row = await prisma.generation.findUnique({ where: { id: generationId } });
      assert.equal(row.providerRequestId, requestId);
      assert.equal(row.status, 'processing');
      row = await prisma.generation.update({
        where: { id: generationId },
        data: { leaseToken: 'test-lease-3' },
      });
      // Exercise refunds for a historical public job charged before the admin-only rollout.
      await prisma.user.update({ where: { id: ids[0] }, data: { generationCredits: 0 } });
      row = await prisma.generation.update({
        where: { id: generationId },
        data: { quotaCost: 1, adminTest: false },
      });
      await processGeneration(row, {
        provider: { status: async () => ({ request_id: requestId, status: 'failed' }) },
      });
      assert.equal(
        (await prisma.generation.findUnique({ where: { id: generationId } })).quotaRefunded,
        true,
      );
      assert.equal((await prisma.user.findUnique({ where: { id: ids[0] } })).generationCredits, 1);
      await processGeneration(row, {
        provider: { status: async () => ({ request_id: requestId, status: 'failed' }) },
      });
      assert.equal((await prisma.user.findUnique({ where: { id: ids[0] } })).generationCredits, 1);
      const list = await a.get('/api/users/me/generations').expect(200);
      assert.equal(list.body.total, 1);
      assert.equal(list.body.generations[0].status, 'failed');
      assert.ok(!('providerRequestId' in list.body.generations[0]));
      await a.post('/api/auth/logout').set('X-CSRF-Token', csrfA).expect(200);
      await a.get('/api/auth/me').expect(401);
    } finally {
      restoreR2();
    }
  },
);
