import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-only-secret-not-a-real-credential-123456789';
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL || 'postgresql://test:test@127.0.0.1:1/test';
const { app } = await import('../src/app.js');
const { prisma } = await import('../src/config/prisma.js');
const { env } = await import('../src/config/env.js');
const { r2 } = await import('../src/services/r2.service.js');
const { mockR2 } = await import('../test-support/mock-r2.js');
const { mockPricing, setModelTestPrice } = await import('../test-support/mock-pricing.js');
const { createGeneration, publicGeneration } =
  await import('../src/services/generation.service.js');
const { processGeneration } = await import('../src/jobs/generation.worker.js');
const { ProviderError } = await import('../src/services/higgsfield.service.js');
const { priceGeneration } = await import('../src/services/pricing.service.js');
after(() => prisma.$disconnect());
function assertPrivate(value) {
  const forbidden = [
    'costEstimate',
    'providerCostUSD',
    'retailUSD',
    'markup',
    'creditValueUSD',
    'prices',
  ];
  if (value && typeof value === 'object')
    for (const [key, child] of Object.entries(value)) {
      assert.ok(!forbidden.includes(key), key);
      assertPrivate(child);
    }
}
test('subscription offerings are public but financial coefficients are private', async () => {
  const response = await request(app).get('/api/pricing/plans').expect(200);
  assert.deepEqual(
    response.body.plans.map((p) => p.id),
    ['free', 'basic', 'creator', 'pro'],
  );
  assertPrivate(response.body);
});
test(
  'PostgreSQL: subscription estimates, confirmed debits, plan changes, concurrency and exact refunds',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const oldEnv = { ...env },
      restoreR2 = mockR2(env, r2),
      restorePricing = mockPricing(null);
    const planIds = [];
    let userId;
    try {
      Object.assign(env, {
        HIGGSFIELD_ENABLED: true,
        HIGGSFIELD_API_KEY_ID: 'fixture',
        HIGGSFIELD_API_KEY_SECRET: 'fixture',
      });
      setModelTestPrice('kling', '0.01');
      setModelTestPrice('qwen-image-3', '0.05');
      const agent = request.agent(app),
        csrf = (await agent.get('/api/auth/csrf')).body.token;
      const registration = await agent
        .post('/api/auth/register')
        .set('X-CSRF-Token', csrf)
        .send({
          name: 'Subscription QA',
          email: `subscription-${randomUUID()}@example.com`,
          password: 'safe-password-123',
        })
        .expect(201);
      userId = registration.body.user.id;
      const plans = {};
      for (const [name, price] of [
        ['Free', 0],
        ['Basic', 4990],
        ['Creator', 14990],
        ['Pro', 26990],
      ]) {
        const plan = await prisma.plan.create({ data: { name, price } });
        plans[name] = plan.id;
        planIds.push(plan.id);
      }
      const body = {
        model: 'kling',
        mode: 'TEXT_TO_VIDEO',
        prompt: 'Test paid generation',
        duration: 5,
        quality: 'standard',
        aspectRatio: '16:9',
      };
      const { prompt, ...estimate } = body;
      const post = (path, data) => agent.post(path).set('X-CSRF-Token', csrf).send(data);
      const balance = async () =>
        (await prisma.user.findUnique({ where: { id: userId } })).generationCredits;
      const fund = (credits) =>
        prisma.user.update({ where: { id: userId }, data: { generationCredits: credits } });
      const complete = () =>
        prisma.generation.updateMany({ where: { userId }, data: { status: 'completed' } });
      const missingConfirmation = await post('/api/generations', body)
        .set('Idempotency-Key', randomUUID())
        .expect(409);
      assert.equal(missingConfirmation.body.code, 'PRICE_CHANGED');
      assertPrivate(missingConfirmation.body);
      for (const [tier, expected] of [
        ['Free', 9],
        ['Basic', 8],
        ['Creator', 7],
        ['Pro', 6],
      ]) {
        await prisma.subscription.deleteMany({ where: { userId } });
        await prisma.subscription.create({
          data: { userId, planId: plans[tier], expiresAt: new Date(Date.now() + 86400000) },
        });
        await fund(100);
        const quote = (await post('/api/generations/estimate', estimate).expect(200)).body;
        assert.equal(quote.credits, expected);
        assert.equal(quote.baseCredits, 9);
        assert.equal(quote.subscriptionPlan, tier.toLowerCase());
        assert.equal(quote.canGenerate, true);
        assertPrivate(quote);
        const row = await createGeneration(
          userId,
          { ...body, priceConfirmation: quote.priceConfirmation },
          randomUUID(),
        );
        assert.equal(row.quotaCost, expected);
        assert.equal(await balance(), 100 - expected);
        assert.equal(row.adminTest, false);
        assert.equal(row.costEstimate.subscriptionPlan, tier.toLowerCase());
        assertPrivate(publicGeneration(row));
        // Image and video use the same subscription module.
        const image = await priceGeneration(
          { model: 'qwen-image-3', mode: 'TEXT_TO_IMAGE', quality: '1k', aspectRatio: '1:1' },
          userId,
        );
        assert.equal(image.credits, expected);
        await complete();
      }
      const subscription = await prisma.subscription.findFirst({ where: { userId } });
      for (const data of [
        { status: 'expired', expiresAt: null },
        { status: 'canceled', expiresAt: null },
        { status: 'active', expiresAt: new Date(Date.now() - 1) },
      ]) {
        await prisma.subscription.update({ where: { id: subscription.id }, data });
        assert.equal((await priceGeneration(estimate, userId)).credits, 9);
      }
      await prisma.subscription.deleteMany({ where: { userId } });
      assert.equal((await priceGeneration(estimate, userId)).credits, 9);
      const active = await prisma.subscription.create({ data: { userId, planId: plans.Pro } });
      const beforeChange = await priceGeneration(estimate, userId);
      await prisma.subscription.update({ where: { id: active.id }, data: { planId: plans.Basic } });
      const rejected = await post('/api/generations', {
        ...body,
        priceConfirmation: beforeChange.priceConfirmation,
      })
        .set('Idempotency-Key', randomUUID())
        .expect(409);
      assert.equal(rejected.body.currentQuote.credits, 8);
      assertPrivate(rejected.body);
      const afterChange = await priceGeneration(estimate, userId);
      await fund(100);
      const key = randomUUID();
      const saved = await createGeneration(
        userId,
        { ...body, priceConfirmation: afterChange.priceConfirmation },
        key,
      );
      await complete();
      setModelTestPrice('kling', '0.02');
      const priceChanged = await post('/api/generations', {
        ...body,
        priceConfirmation: afterChange.priceConfirmation,
      })
        .set('Idempotency-Key', randomUUID())
        .expect(409);
      assert.equal(priceChanged.body.currentQuote.credits, 16);
      assertPrivate(priceChanged.body);
      // Frozen jobs survive tariff removal, expiry and changed/missing confirmations.
      setModelTestPrice('kling', null);
      await prisma.subscription.update({ where: { id: active.id }, data: { status: 'canceled' } });
      const replay = await createGeneration(userId, body, key);
      assert.equal(replay.id, saved.id);
      assert.deepEqual(replay.costEstimate, saved.costEstimate);
      assert.equal(await balance(), 92);
      setModelTestPrice('kling', '0.01');
      const quote = await priceGeneration(estimate, userId);
      const confirmed = { ...body, priceConfirmation: quote.priceConfirmation };
      await fund(8);
      assert.equal(
        (await post('/api/generations/estimate', estimate).expect(200)).body.canGenerate,
        false,
      );
      await assert.rejects(
        createGeneration(userId, confirmed, randomUUID()),
        (e) => e.status === 402,
      );
      assert.equal(await balance(), 8);
      await fund(9);
      const race = await Promise.allSettled([
        createGeneration(userId, confirmed, randomUUID()),
        createGeneration(userId, confirmed, randomUUID()),
      ]);
      assert.equal(race.filter((r) => r.status === 'fulfilled').length, 1);
      assert.equal(race.find((r) => r.status === 'rejected').reason.status, 402);
      assert.equal(await balance(), 0);
      await complete();
      await fund(9);
      const repeatedKey = randomUUID();
      const receipts = await Promise.all([
        createGeneration(userId, confirmed, repeatedKey),
        createGeneration(userId, confirmed, repeatedKey),
      ]);
      assert.equal(receipts[0].id, receipts[1].id);
      assert.equal(await balance(), 0);
      // A safe provider failure returns the exact charged amount once, even if the
      // subscription changes after creation and a worker tries the old lease again.
      let row = await prisma.generation.update({
        where: { id: receipts[0].id },
        data: { leaseToken: 'refund-test' },
      });
      await prisma.subscription.update({
        where: { id: active.id },
        data: { status: 'active', planId: plans.Pro },
      });
      const provider = {
        submit: async () => {
          throw new ProviderError('Safe failure', { refundSafe: true });
        },
      };
      await processGeneration({ ...row }, { provider });
      await processGeneration({ ...row }, { provider });
      assert.equal(await balance(), 9);
      row = await prisma.generation.findUnique({ where: { id: row.id } });
      assert.equal(row.quotaRefunded, true);
      assert.equal(row.status, 'failed');
      // A change from ADMIN zero charge to normal paid usage requires confirmation.
      await prisma.user.update({ where: { id: userId }, data: { isAdmin: true } });
      const adminQuote = await priceGeneration(estimate, userId);
      await prisma.user.update({ where: { id: userId }, data: { isAdmin: false } });
      await assert.rejects(
        createGeneration(
          userId,
          { ...body, priceConfirmation: adminQuote.priceConfirmation },
          randomUUID(),
        ),
        (e) => e.code === 'PRICE_CHANGED',
      );
      assert.equal(await balance(), 9);
    } finally {
      if (userId) await prisma.user.delete({ where: { id: userId } });
      await prisma.plan.deleteMany({ where: { id: { in: planIds } } });
      restorePricing();
      restoreR2();
      Object.assign(env, oldEnv);
    }
  },
);
