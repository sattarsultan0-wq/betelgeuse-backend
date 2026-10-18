import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import fs from 'node:fs/promises';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-only-secret-not-a-real-credential-123456789';
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.DATABASE_URL ||= 'postgresql://test:test@127.0.0.1:5432/test';
process.env.HIGGSFIELD_ENABLED = 'false';
const { modelConfigs, publicModels } = await import('../src/config/models.js');
const { higgsfieldPricing } = await import('../src/pricing/pricing-engine.js');
const { setModelTestPrice, mockPricing } = await import('../test-support/mock-pricing.js');
const restorePricing = mockPricing(null);
after(restorePricing);
const { validateModelInput } = await import('../src/services/model-validation.service.js');
const { estimateCredits } = await import('../src/services/pricing.service.js');
const { generationSchema } = await import('../src/services/generation.service.js');
const { providerPayload, higgsfield, ProviderError } =
  await import('../src/services/higgsfield.service.js');
const { processGeneration } = await import('../src/jobs/generation.worker.js');
const { prisma } = await import('../src/config/prisma.js');
const { env } = await import('../src/config/env.js');
const { app } = await import('../src/app.js');
const { storage } = await import('../src/services/storage.service.js');
const { r2 } = await import('../src/services/r2.service.js');
const { mockR2 } = await import('../test-support/mock-r2.js');
after(() => prisma.$disconnect());

test('reference uploads validate actual content and restrict local filenames', async () => {
  await assert.rejects(() =>
    storage.saveReference({ mimetype: 'video/mp4', buffer: Buffer.from('not an MP4'), size: 10 }),
  );
  await assert.rejects(() =>
    storage.saveReference({ mimetype: 'image/png', buffer: Buffer.from('not a PNG'), size: 10 }),
  );
  assert.throws(() => storage.resolve('../outside.mp4'));
});

test('worker resolves owned image/video references and maps roles to the verified Motion Control schema', async () => {
  const caps = modelConfigs.find((m) => m.id === 'kling-3-motion').modes.MOTION_CONTROL;
  const row = {
    ...input('kling-3-motion', 'MOTION_CONTROL', caps),
    id: randomUUID(),
    userId: randomUUID(),
    createdAt: new Date(),
    status: 'queued',
    leaseToken: 'lease',
    attempts: 0,
  };
  let payload;
  await processGeneration(row, {
    db: {
      user: { findUnique: async () => ({ isAdmin: true }) },
      storedImage: {
        findMany: async ({ where }) => {
          assert.equal(where.userId, row.userId);
          return row.references.map((ref) => ({
            id: ref.uploadId,
            filename: ref.role === 'video' ? 'motion.mp4' : 'character.webp',
          }));
        },
      },
      generation: { updateMany: async () => ({ count: 1 }) },
    },
    provider: {
      uploadImage: async (file) => `https://images.higgs.ai/${file.filename}`,
      submit: async (value) => {
        payload = providerPayload(value);
        return { request_id: randomUUID(), status_url: 'stored', status: 'queued' };
      },
    },
  });
  assert.equal(payload.body.video_url, 'https://images.higgs.ai/motion.mp4');
  assert.equal(payload.body.image_url, 'https://images.higgs.ai/character.webp');
  assert.ok(!('duration' in payload.body));
  assert.ok(!('resolution' in payload.body));
});

test(
  'PostgreSQL: MP4 reference upload remains private and is excluded from the image library',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const client = request.agent(app);
    const csrf = (await client.get('/api/auth/csrf')).body.token;
    const user = (
      await client
        .post('/api/auth/register')
        .set('X-CSRF-Token', csrf)
        .send({
          name: 'Upload QA',
          email: `upload-${randomUUID()}@example.com`,
          password: 'safe-password-123',
        })
        .expect(201)
    ).body.user;
    let stored;
    try {
      const video = await fs.readFile(
        new URL('../../frontend/public/videos/hero.mp4', import.meta.url),
      );
      const response = await client
        .post('/api/uploads/references')
        .set('X-CSRF-Token', csrf)
        .attach('file', video, { filename: 'motion.mp4', contentType: 'video/mp4' })
        .expect(201);
      stored = await prisma.storedImage.findUnique({ where: { id: response.body.image.id } });
      assert.equal(stored.mimeType, 'video/mp4');
      await client
        .get(`/api/uploads/${stored.id}`)
        .expect(200)
        .expect('Content-Type', /video\/mp4/);
      await request(app).get(`/api/uploads/${stored.id}`).expect(401);
      assert.equal((await client.get('/api/users/me/images').expect(200)).body.total, 0);
      await client
        .post('/api/uploads/references')
        .set('X-CSRF-Token', csrf)
        .attach('file', Buffer.from('fake'), { filename: 'fake.mp4', contentType: 'video/mp4' })
        .expect(400);
    } finally {
      await prisma.user.delete({ where: { id: user.id } });
      if (stored) await storage.remove(stored.filename);
    }
  },
);

function input(model, mode, caps) {
  return {
    model,
    mode,
    prompt: 'A test scene',
    ...caps.defaults,
    parameters: Object.fromEntries(
      Object.entries(caps.parameters).map(([key, value]) => [key, value.default]),
    ),
    references: caps.references.flatMap((rule) =>
      Array.from({ length: rule.min }, () => ({ role: rule.role, uploadId: randomUUID() })),
    ),
  };
}
test('all eleven requested model families expose verified workflows with valid schemas', async () => {
  const models = publicModels().filter((model) => model.enabled);
  assert.equal(models.length, 11);
  for (const model of models) {
    for (const [mode, publicCaps] of Object.entries(model.modes)) {
      const caps = modelConfigs.find((m) => m.id === model.id).modes[mode];
      const body = input(model.id, mode, caps);
      assert.equal(generationSchema.safeParse(body).success, true, `${model.id}/${mode}`);
      validateModelInput(body);
      const { endpoint, body: payload } = providerPayload({
        ...body,
        providerImageUrl: 'https://images.higgs.ai/source.webp',
        providerReferences: body.references.map((ref) => ({
          role: ref.role,
          url: 'https://images.higgs.ai/source.webp',
        })),
      });
      assert.equal(endpoint, publicCaps.workflowId);
      assert.equal(payload.prompt, body.prompt);
      assert.equal('duration' in payload, caps.durations.length > 0);
      assert.equal(estimateCredits(body).status, 'PRICE_UNAVAILABLE');
    }
  }
  await request(app).get('/api/models/kling-o3').expect(200);
  await request(app).get('/api/models/missing').expect(404);
  await request(app).post('/api/generations/estimate').send({}).expect(403);
});

test('unsupported fields, parameters, references and client prices fail before debit', () => {
  const caps = modelConfigs.find((m) => m.id === 'qwen-image-3').modes.IMAGE_TO_IMAGE;
  const body = input('qwen-image-3', 'IMAGE_TO_IMAGE', caps);
  assert.throws(() => validateModelInput({ ...body, duration: 5 }));
  assert.throws(() => validateModelInput({ ...body, quality: '4k' }));
  assert.throws(() => validateModelInput({ ...body, parameters: { generate_audio: true } }));
  assert.throws(
    () => validateModelInput({ ...body, parameters: { constructor: 'invalid' } }),
    (error) => error.status === 400,
  );
  assert.throws(() => validateModelInput({ ...body, references: [] }));
  assert.throws(() =>
    validateModelInput({ ...body, references: Array(4).fill(body.references[0]) }),
  );
  assert.throws(() =>
    validateModelInput({ ...body, references: [body.references[0], body.references[0]] }),
  );
  assert.throws(() =>
    validateModelInput({ ...body, references: [{ ...body.references[0], role: 'video' }] }),
  );
  assert.equal(generationSchema.safeParse({ ...body, credits: 0 }).success, false);
  assert.equal(
    generationSchema.safeParse({ ...body, provider_url: 'https://evil.test' }).success,
    false,
  );
  const o3 = modelConfigs.find((m) => m.id === 'kling-o3').modes.VIDEO_TO_VIDEO;
  const edited = input('kling-o3', 'VIDEO_TO_VIDEO', o3);
  const mapped = providerPayload({
    ...edited,
    providerReferences: [{ role: 'video', url: 'https://videos.higgs.ai/input.mp4' }],
  });
  assert.deepEqual(mapped.body.video_urls, ['https://videos.higgs.ai/input.mp4']);
  assert.ok(!('video_url' in mapped.body));
  assert.ok(!('duration' in mapped.body));
});

test('unconfigured pricing never grants ADMIN a free generation bypass', () => {
  const body = input(
    'soul-v2',
    'TEXT_TO_IMAGE',
    modelConfigs.find((m) => m.id === 'soul-v2').modes.TEXT_TO_IMAGE,
  );
  assert.equal(estimateCredits(body).status, 'PRICE_UNAVAILABLE');
  assert.equal(estimateCredits(body, { isAdmin: true }).credits, null);
});

test('image result normalization and submission failures never trigger paid retries or duplicate refunds', async () => {
  const row = {
    id: randomUUID(),
    userId: randomUUID(),
    model: 'qwen-image-3',
    generationType: 'Image',
    quotaCost: 3,
    quotaRefunded: false,
    status: 'processing',
    providerRequestId: randomUUID(),
    createdAt: new Date(),
    leaseToken: 'lease',
    attempts: 0,
  };
  let credits = 0,
    updates = [];
  const db = {
    generation: {
      updateMany: async ({ data }) => {
        updates.push(data);
        if (['completed', 'failed'].includes(row.status)) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
    },
    user: {
      findUnique: async () => ({ isAdmin: true }),
      update: async ({ data }) => {
        credits += data.generationCredits.increment;
      },
    },
    $transaction: async (fn) => fn(db),
  };
  await processGeneration(
    { ...row },
    {
      db,
      resultStore: { saveImageResult: async () => 'results/mock.png' },
      provider: {
        status: async () => ({
          status: 'completed',
          images: [{ url: 'https://images.higgs.ai/result.png' }],
        }),
      },
    },
  );
  assert.deepEqual(updates.at(-1).resultImageKeys, ['results/mock.png']);
  assert.equal(credits, 0);
  Object.assign(row, { status: 'processing', leaseToken: 'lease-2' });
  const failed = { status: async () => ({ status: 'failed' }) };
  await processGeneration({ ...row }, { db, provider: failed });
  await processGeneration({ ...row }, { db, provider: failed });
  assert.equal(credits, 3);
  Object.assign(row, {
    status: 'queued',
    providerRequestId: null,
    submissionAttemptedAt: null,
    leaseToken: 'lease-3',
  });
  let calls = 0;
  const uncertain = {
    submit: async () => {
      calls++;
      throw new ProviderError('timeout', { retryable: true });
    },
  };
  await processGeneration({ ...row }, { db, provider: uncertain });
  assert.equal(row.status, 'failed');
  assert.ok(row.submissionAttemptedAt);
  Object.assign(row, { status: 'queued', leaseToken: 'lease-4' });
  await processGeneration({ ...row }, { db, provider: uncertain });
  assert.equal(calls, 1);
});

test('Higgsfield accepts image-array responses using the existing polling lifecycle', async () => {
  const original = {
    fetch: globalThis.fetch,
    enabled: env.HIGGSFIELD_ENABLED,
    key: env.HIGGSFIELD_API_KEY_ID,
    secret: env.HIGGSFIELD_API_KEY_SECRET,
  };
  const requestId = randomUUID();
  try {
    env.HIGGSFIELD_ENABLED = true;
    env.HIGGSFIELD_API_KEY_ID = 'fixture';
    env.HIGGSFIELD_API_KEY_SECRET = 'fixture';
    globalThis.fetch = async () =>
      Response.json({
        request_id: requestId,
        status: 'completed',
        images: [{ url: 'https://images.higgs.ai/test.png' }],
      });
    const result = await higgsfield.status({
      providerRequestId: requestId,
      providerStatusUrl: `https://api.higgsfield.ai/requests/${requestId}/status`,
    });
    assert.equal(result.images.length, 1);
  } finally {
    globalThis.fetch = original.fetch;
    env.HIGGSFIELD_ENABLED = original.enabled;
    env.HIGGSFIELD_API_KEY_ID = original.key;
    env.HIGGSFIELD_API_KEY_SECRET = original.secret;
  }
});

test(
  'PostgreSQL: estimates, new references, ownership, idempotency, insufficient funds and image completion',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const oldPricing = structuredClone(higgsfieldPricing.models['qwen-image-3']);
    const restoreR2 = mockR2(env, r2);
    const originalEnabled = env.HIGGSFIELD_ENABLED;
    const originalKey = env.HIGGSFIELD_API_KEY_ID,
      originalSecret = env.HIGGSFIELD_API_KEY_SECRET;
    const userIds = [];
    try {
      const agent = request.agent(app),
        other = request.agent(app);
      const csrf = (await agent.get('/api/auth/csrf')).body.token;
      const csrfOther = (await other.get('/api/auth/csrf')).body.token;
      for (const [client, token] of [
        [agent, csrf],
        [other, csrfOther],
      ]) {
        const { body } = await client
          .post('/api/auth/register')
          .set('X-CSRF-Token', token)
          .send({
            name: 'QA',
            email: `workflow-${randomUUID()}@example.com`,
            password: 'safe-password-123',
          })
          .expect(201);
        userIds.push(body.user.id);
      }
      const caps = modelConfigs.find((m) => m.id === 'qwen-image-3').modes.IMAGE_TO_IMAGE;
      const body = input('qwen-image-3', 'IMAGE_TO_IMAGE', caps);
      const { prompt, references, ...estimate } = body;
      const post = (path, data) => agent.post(path).set('X-CSRF-Token', csrf).send(data);
      assert.equal(
        (await post('/api/generations/estimate', estimate).expect(200)).body.status,
        'PRICE_UNAVAILABLE',
      );
      setModelTestPrice('qwen-image-3', '0.02');
      assert.equal(
        (await post('/api/generations/estimate', estimate).expect(200)).body.sufficientBalance,
        false,
      );
      await prisma.user.update({ where: { id: userIds[0] }, data: { generationCredits: 3 } });
      env.HIGGSFIELD_ENABLED = true;
      env.HIGGSFIELD_API_KEY_ID = 'fixture';
      env.HIGGSFIELD_API_KEY_SECRET = 'fixture';
      // A paid request must confirm its server estimate before it can debit.
      await agent
        .post('/api/generations')
        .set('X-CSRF-Token', csrf)
        .set('Idempotency-Key', randomUUID())
        .send(body)
        .expect(409);
      await prisma.user.update({ where: { id: userIds[0] }, data: { isAdmin: true } });
      const image = await prisma.storedImage.create({
        data: {
          userId: userIds[1],
          filename: `${randomUUID()}.webp`,
          mimeType: 'image/webp',
          size: 100,
        },
      });
      body.references = [{ role: 'image', uploadId: image.id }];
      env.HIGGSFIELD_ENABLED = true;
      env.HIGGSFIELD_API_KEY_ID = 'fixture';
      env.HIGGSFIELD_API_KEY_SECRET = 'fixture';
      const key = randomUUID();
      await agent
        .post('/api/generations')
        .set('X-CSRF-Token', csrf)
        .set('Idempotency-Key', key)
        .send(body)
        .expect(404);
      assert.equal(
        (await prisma.user.findUnique({ where: { id: userIds[0] } })).generationCredits,
        3,
      );
      await prisma.storedImage.update({ where: { id: image.id }, data: { userId: userIds[0] } });
      const receipts = await Promise.all(
        [1, 2].map(() =>
          agent
            .post('/api/generations')
            .set('X-CSRF-Token', csrf)
            .set('Idempotency-Key', key)
            .send(body)
            .expect(202),
        ),
      );
      assert.equal(receipts[0].body.generation.id, receipts[1].body.generation.id);
      assert.equal(
        (await prisma.user.findUnique({ where: { id: userIds[0] } })).generationCredits,
        3,
      );
      // A tariff change cannot turn a retry of an accepted request into a second debit.
      setModelTestPrice('qwen-image-3', null);
      await agent
        .post('/api/generations')
        .set('X-CSRF-Token', csrf)
        .set('Idempotency-Key', key)
        .send(body)
        .expect(202);
      await other.get(`/api/generations/${receipts[0].body.generation.id}`).expect(404);
      const row = await prisma.generation.update({
        where: { id: receipts[0].body.generation.id },
        data: {
          leaseToken: 'image-qa',
          providerRequestId: randomUUID(),
          providerStatusUrl: 'https://example.test',
        },
      });
      await processGeneration(row, {
        provider: {
          status: async () => ({
            status: 'completed',
            images: [{ url: 'https://images.higgs.ai/result.png' }],
          }),
        },
      });
      const result = (await agent.get(`/api/generations/${row.id}`).expect(200)).body.generation;
      assert.equal(result.generationType, 'Image');
      assert.equal(result.resultImageUrls.length, 1);
      await prisma.user.update({ where: { id: userIds[0] }, data: { isAdmin: true } });
      setModelTestPrice('qwen-image-3', '0.02');
      assert.equal(
        (await post('/api/generations/estimate', estimate).expect(200)).body.chargedCredits,
        0,
      );
    } finally {
      restoreR2();
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      higgsfieldPricing.models['qwen-image-3'] = oldPricing;
      env.HIGGSFIELD_ENABLED = originalEnabled;
      env.HIGGSFIELD_API_KEY_ID = originalKey;
      env.HIGGSFIELD_API_KEY_SECRET = originalSecret;
    }
  },
);
