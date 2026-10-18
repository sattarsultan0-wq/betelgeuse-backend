import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { mockPricing } from '../test-support/mock-pricing.js';
const restorePricing = mockPricing(null);
after(restorePricing);

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-only-secret-not-a-real-credential-123456789';
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.DATABASE_URL ||= 'postgresql://test:test@127.0.0.1:5432/test';
const { app } = await import('../src/app.js');
const { prisma } = await import('../src/config/prisma.js');

const { validateGeneration } = await import('../src/services/generation.service.js');
after(() => prisma.$disconnect());

test('workspace data routes reject anonymous requests and invalid pagination', async () => {
  for (const path of [
    '/api/users/me/billing',
    '/api/users/me/images',
    '/api/users/me/images?page=0',
  ])
    await request(app).get(path).expect(401);
});

test('public costs match server validation and never enable unsupported models', async () => {
  const { body } = await request(app).get('/api/models').expect(200);
  const kling = body.models.find((model) => model.id === 'kling');
  assert.equal(kling.pricing.status, 'PRICE_UNAVAILABLE');
  assert.equal(kling.pricing.credits, null);
  assert.deepEqual(kling.inputs, { image: true, video: false });
  for (const duration of [5, 10]) {
    assert.throws(
      () =>
        validateGeneration({
          model: 'kling',
          prompt: 'A test scene',
          mode: 'TEXT_TO_VIDEO',
          aspectRatio: '16:9',
          duration,
          quality: 'standard',
        }),
      { code: 'PRICE_UNAVAILABLE' },
    );
  }
  assert.throws(() =>
    validateGeneration({
      model: 'nano-banana',
      prompt: 'A test scene',
      mode: 'TEXT_TO_VIDEO',
      aspectRatio: '16:9',
      duration: 5,
      quality: 'standard',
    }),
  );
});

test(
  'PostgreSQL workspace: billing and images belong to the session user; expired subscriptions are excluded',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const users = [],
      plans = [];
    const agents = [];
    try {
      for (let index = 0; index < 2; index++) {
        const agent = request.agent(app),
          token = (await agent.get('/api/auth/csrf')).body.token;
        const { body } = await agent
          .post('/api/auth/register')
          .set('X-CSRF-Token', token)
          .send({
            name: 'Workspace Test',
            email: `workspace-${randomUUID()}@example.com`,
            password: 'test-workspace-password-123',
          })
          .expect(201);
        users.push(body.user.id);
        agents.push(agent);
      }
      await prisma.user.update({ where: { id: users[0] }, data: { generationCredits: 7 } });
      const plan = await prisma.plan.create({
        data: { name: `workspace-plan-${randomUUID()}`, generationLimit: 40 },
      });
      plans.push(plan.id);
      await prisma.subscription.create({
        data: {
          userId: users[0],
          planId: plan.id,
          status: 'active',
          expiresAt: new Date(Date.now() + 86400000),
        },
      });
      await prisma.subscription.create({
        data: {
          userId: users[1],
          planId: plan.id,
          status: 'active',
          expiresAt: new Date(Date.now() - 86400000),
        },
      });
      const image = await prisma.storedImage.create({
        data: {
          userId: users[0],
          filename: `${randomUUID()}.webp`,
          mimeType: 'image/webp',
          size: 256,
        },
      });
      const a = (await agents[0].get('/api/users/me/billing').expect(200)).body;
      const b = (await agents[1].get('/api/users/me/billing').expect(200)).body;
      assert.equal(a.generationCredits, 7);
      assert.equal(a.subscription.plan.name, plan.name);
      assert.equal(a.paymentsAvailable, false);
      assert.equal(b.subscription, null);
      const aImages = (await agents[0].get('/api/users/me/images').expect(200)).body;
      const bImages = (await agents[1].get('/api/users/me/images').expect(200)).body;
      assert.equal(aImages.images[0].id, image.id);
      assert.ok(!JSON.stringify(aImages).includes('filename'));
      assert.equal(bImages.total, 0);
      await agents[0].get('/api/users/me/images?page=0').expect(400);
    } finally {
      await prisma.user.deleteMany({ where: { id: { in: users } } });
      await prisma.plan.deleteMany({ where: { id: { in: plans } } });
    }
  },
);
