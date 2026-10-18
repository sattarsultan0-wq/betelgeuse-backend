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
const { r2 } = await import('../src/services/r2.service.js');
const { mockR2 } = await import('../test-support/mock-r2.js');
const { mockPricing, setModelTestPrice } = await import('../test-support/mock-pricing.js');
const { higgsfieldPricing } = await import('../src/pricing/pricing-engine.js');
const { publicGeneration } = await import('../src/services/generation.service.js');
const restoreDefaultPricing = mockPricing(null);
after(restoreDefaultPricing);
after(() => prisma.$disconnect());

function assertPrivate(value) {
  const forbidden = [
    'costEstimate',
    'providerCostUSD',
    'retailUSD',
    'amountUsd',
    'unitRateUsd',
    'markup',
    'creditValueUSD',
    'prices',
    'fixed',
  ];
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      assert.ok(!forbidden.includes(key), `Private field leaked: ${key}`);
      assertPrivate(child);
    }
  }
}
test('public model API and legacy generation serialization never leak provider costs', async () => {
  const restore = mockPricing();
  try {
    const result = await request(app).get('/api/models').expect(200);
    assertPrivate(result.body);
    assert.ok(
      result.body.models.every(
        (model) => model.pricing.credits > 0 || model.pricing.status === 'PRICE_UNAVAILABLE',
      ),
    );
    const legacy = publicGeneration({
      quotaCost: 1,
      costEstimate: { amountUsd: 0.42, unitRateUsd: 0.084, markup: 0.4 },
    });
    assertPrivate(legacy);
    assert.equal(legacy.chargedCredits, 1);
    assert.equal(legacy.pricing.status, 'PRICE_UNAVAILABLE');
  } finally {
    restore();
  }
});

test('historical v1 snapshots keep their original credits and tariffVersion after optimization', () => {
  const snapshot = {
    status: 'AVAILABLE',
    credits: 73,
    tariffVersion: 'higgsfield-v1:before-ratio-optimization',
    providerCostUSD: '0.52',
    retailUSD: '0.728',
    chargedCredits: 0,
  };
  const row = { quotaCost: 0, adminTest: true, costEstimate: snapshot };
  const presented = publicGeneration(row);
  assert.deepEqual(presented.pricing, {
    status: 'AVAILABLE',
    credits: 73,
    tariffVersion: snapshot.tariffVersion,
  });
  assertPrivate(presented);
  assert.equal(row.costEstimate, snapshot);
});

test(
  'PostgreSQL pricing: null blocks ADMIN, quotes are private, stored cost/version survive tariff changes',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const oldEnv = { ...env };
    const restoreR2 = mockR2(env, r2);
    const original = structuredClone(higgsfieldPricing.models);
    let userId;
    try {
      const agent = request.agent(app);
      const csrf = (await agent.get('/api/auth/csrf')).body.token;
      const registered = await agent
        .post('/api/auth/register')
        .set('X-CSRF-Token', csrf)
        .send({
          name: 'Pricing QA',
          email: `pricing-${randomUUID()}@example.com`,
          password: 'safe-password-123',
        })
        .expect(201);
      userId = registered.body.user.id;
      await prisma.user.update({
        where: { id: userId },
        data: { isAdmin: true, generationCredits: 50 },
      });
      Object.assign(env, {
        HIGGSFIELD_ENABLED: true,
        HIGGSFIELD_API_KEY_ID: 'fixture',
        HIGGSFIELD_API_KEY_SECRET: 'fixture',
      });
      const body = {
        model: 'kling',
        mode: 'TEXT_TO_VIDEO',
        prompt: 'Test scene',
        quality: 'standard',
        duration: 5,
        aspectRatio: '16:9',
      };
      const { prompt, ...estimate } = body;
      const post = (path, payload) => agent.post(path).set('X-CSRF-Token', csrf).send(payload);
      let quote = (await post('/api/generations/estimate', estimate).expect(200)).body;
      assert.equal(quote.status, 'PRICE_UNAVAILABLE');
      assert.equal(quote.credits, null);
      assert.equal(quote.canGenerate, false);
      const unavailable = await post('/api/generations', body)
        .set('Idempotency-Key', randomUUID())
        .expect(400);
      assert.equal(unavailable.body.code, 'PRICE_UNAVAILABLE');
      assert.equal(await prisma.generation.count({ where: { userId } }), 0);
      setModelTestPrice('kling', '0.01');
      quote = (await post('/api/generations/estimate', estimate).expect(200)).body;
      assert.equal(quote.credits, 9);
      assert.equal(quote.chargedCredits, 0);
      assert.equal(quote.canGenerate, true);
      assertPrivate(quote);
      const parallelInputs = [
        [{ ...estimate, aspectRatio: '16:9' }, 9],
        [{ ...estimate, aspectRatio: '9:16' }, 9],
        [{ ...estimate, aspectRatio: '1:1' }, 9],
        [{ ...estimate, duration: 10, aspectRatio: '9:16' }, 18],
        [{ ...estimate, duration: 10, aspectRatio: '1:1' }, 18],
        [{ ...estimate, duration: 6 }, null],
      ];
      const parallel = await Promise.all(
        parallelInputs.map(async ([body, credits]) => {
          const response = (await post('/api/generations/estimate', body).expect(200)).body;
          assertPrivate(response);
          assert.equal(response.credits, credits);
          assert.equal(response.status, credits === null ? 'PRICE_UNAVAILABLE' : 'AVAILABLE');
          if (credits !== null) assert.equal(response.tariffVersion, quote.tariffVersion);
          return response;
        }),
      );
      assert.equal(parallel.length, 6);
      const bad = (
        await post('/api/generations/estimate', { ...estimate, duration: 6 }).expect(200)
      ).body;
      assert.equal(bad.status, 'PRICE_UNAVAILABLE');
      await post('/api/generations', { ...body, credits: 1 })
        .set('Idempotency-Key', randomUUID())
        .expect(400);
      const key = randomUUID();
      const accepted = (
        await post('/api/generations', body).set('Idempotency-Key', key).expect(202)
      ).body.generation;
      assertPrivate(accepted);
      assert.equal(accepted.pricing.credits, 9);
      const stored = await prisma.generation.findUnique({ where: { id: accepted.id } });
      assert.equal(stored.costEstimate.providerCostUSD, '0.05');
      assert.equal(stored.costEstimate.credits, 9);
      setModelTestPrice('kling', '0.02');
      const changed = (await post('/api/generations/estimate', estimate).expect(200)).body;
      assert.equal(changed.credits, 18);
      assert.notEqual(changed.tariffVersion, accepted.pricing.tariffVersion);
      setModelTestPrice('kling', null);
      const retry = (await post('/api/generations', body).set('Idempotency-Key', key).expect(202))
        .body.generation;
      assert.equal(retry.id, accepted.id);
      assert.deepEqual(retry.pricing, accepted.pricing);
      for (const path of [
        `/api/generations/${accepted.id}`,
        '/api/generations',
        '/api/users/me/generations',
      ]) {
        const response = (await agent.get(path).expect(200)).body;
        assertPrivate(response);
        const row = response.generation || response.generations[0];
        assert.deepEqual(row.pricing, accepted.pricing);
      }
      assert.equal((await prisma.user.findUnique({ where: { id: userId } })).generationCredits, 50);
      assert.deepEqual(
        (await prisma.generation.findUnique({ where: { id: accepted.id } })).costEstimate,
        stored.costEstimate,
      );
      setModelTestPrice('kling-3-motion', '0.02');
      const video = await prisma.storedImage.create({
        data: {
          userId,
          filename: `references/${randomUUID()}.mp4`,
          mimeType: 'video/mp4',
          size: 100,
          durationSeconds: 6.25,
        },
      });
      const motion = {
        model: 'kling-3-motion',
        mode: 'MOTION_CONTROL',
        parameters: {},
        references: [{ role: 'video', uploadId: video.id }],
      };
      const referenceQuote = (await post('/api/generations/estimate', motion).expect(200)).body;
      assert.equal(referenceQuote.credits, 23);
      assertPrivate(referenceQuote);
      await post('/api/generations/estimate', { ...motion, referenceDuration: 1 }).expect(400);
      await post('/api/generations/estimate', {
        ...motion,
        references: [{ role: 'video', uploadId: randomUUID() }],
      }).expect(404);
    } finally {
      if (userId) await prisma.user.delete({ where: { id: userId } });
      higgsfieldPricing.models = original;
      restoreR2();
      Object.assign(env, oldEnv);
    }
  },
);
