import { mockPricing } from '../test-support/mock-pricing.js';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import request from 'supertest';
import sharp from 'sharp';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-only-secret-not-a-real-credential-123456789';
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.DATABASE_URL ||= 'postgresql://test:test@127.0.0.1:5432/test';
// No worker is started and every external operation is replaced below.
process.env.HIGGSFIELD_ENABLED = 'false';
const { app } = await import('../src/app.js');
const { prisma } = await import('../src/config/prisma.js');
const { env } = await import('../src/config/env.js');
const { modelConfigs } = await import('../src/config/models.js');
const { trends, configuredTrend, publicTrends } = await import('../src/config/trends.js');
const { showcaseMedia } = await import('../src/config/showcase-media.js');
const { presignSchema, trendGenerationSchema, completePhoto } =
  await import('../src/services/trend.service.js');
const { r2, boundedBuffer, MAX_PHOTO_BYTES } = await import('../src/services/r2.service.js');
const { higgsfield, providerPayload, ProviderError } =
  await import('../src/services/higgsfield.service.js');
const { processGeneration } = await import('../src/jobs/generation.worker.js');
const ids = [];
if (process.env.TEST_DATABASE_URL) {
  const restorePricing = mockPricing();
  after(restorePricing);
}

after(async () => {
  if (ids.length) await prisma.user.deleteMany({ where: { id: { in: ids } } });
  await prisma.$disconnect();
});

test('trend endpoints require auth and CSRF; public config hides prompts and credentials', async () => {
  const { body } = await request(app).get('/api/trends').expect(200);
  assert.equal(body.trends.length, 6);
  assert.ok(body.trends.every((trend) => !trend.available));
  assert.ok(!JSON.stringify(body).includes('prompt'));
  assert.deepEqual(
    body.trends.map((trend) => trend.id),
    showcaseMedia.map((item) => item.trendId || item.id),
  );
  for (const item of showcaseMedia) {
    const trend = body.trends.find((row) => row.id === (item.trendId || item.id));
    assert.equal(trend.videoUrl, item.src);
    assert.equal(trend.posterUrl, item.poster || null);
    assert.equal(trend.title, item.title);
  }
  assert.ok(!JSON.stringify(body).includes('sourceVideo'));
  await request(app).post('/api/trends/uploads/presign').send({}).expect(403);
  const agent = request.agent(app),
    token = (await agent.get('/api/auth/csrf')).body.token;
  for (const route of ['/uploads/presign', '/uploads/complete', '/generations'])
    await agent.post(`/api/trends${route}`).set('X-CSRF-Token', token).send({}).expect(401);
});

test('empty prompts, unsupported models, excessive photos and client provider parameters are rejected', () => {
  assert.throws(() => configuredTrend('litvin'), /не настроен/);
  assert.throws(() => configuredTrend('__proto__'), /не найден/);
  const original = trends.litvin;
  try {
    trends.litvin = { ...original, prompt: 'Test scene', maxPhotos: 4 };
    assert.throws(() => configuredTrend('litvin'), /не поддерживаются/);
    trends.litvin = { ...original, prompt: 'Test scene', model: 'higgsfield', quality: '720p' };
    assert.throws(() => configuredTrend('litvin'), /не поддерживаются/);
    trends.litvin = { ...original, prompt: 'Test scene' };
    assert.equal(configuredTrend('litvin').model, 'kling');
    assert.equal(configuredTrend('litvin').maxPhotos, 1);
    assert.ok(!('prompt' in publicTrends()[0]));
  } finally {
    trends.litvin = original;
  }
  const file = { mimeType: 'image/png', size: 100 };
  assert.equal(presignSchema.safeParse({ trendId: 'litvin', files: [file] }).success, true);
  for (const body of [
    { trendId: 'litvin', files: [{ ...file, size: MAX_PHOTO_BYTES + 1 }] },
    { trendId: 'litvin', files: Array(5).fill(file) },
    { trendId: 'litvin', files: [{ mimeType: 'image/svg+xml', size: 100 }] },
    { trendId: 'litvin', files: [file], key: 'images/another-user/photo.jpg' },
  ])
    assert.equal(presignSchema.safeParse(body).success, false);
  assert.equal(
    trendGenerationSchema.safeParse({
      trendId: 'litvin',
      photoKeys: ['photo'],
      prompt: 'injected',
      model: 'injected',
    }).success,
    false,
  );
});

test('provider maps documented single/multiple image fields and never uses showcase example video', () => {
  const single = {
    model: 'kling',
    prompt: 'Server prompt',
    mode: 'IMAGE_TO_VIDEO',
    duration: 5,
    quality: 'standard',
    aspectRatio: 'source',
    providerImageUrl: 'https://private.example/photo.jpg',
    videoUrl: 'https://example.com/trend.mp4',
  };
  const mapped = providerPayload(single);
  assert.equal(mapped.endpoint, 'kling-video/v3.0/std/image-to-video');
  assert.equal(mapped.body.image_url, single.providerImageUrl);
  assert.ok(!('video_url' in mapped.body));
  const urls = ['https://private.example/1.jpg', 'https://private.example/2.jpg'];
  assert.throws(() =>
    providerPayload({
      ...single,
      mode: 'REFERENCE_TO_VIDEO',
      aspectRatio: '9:16',
      providerImageUrls: urls,
    }),
  );
  // Keep the documented legacy mapping available for an explicit future opt-in.
  const legacy = modelConfigs.find((model) => model.id === 'higgsfield');
  try {
    legacy.enabled = true;
    const reference = providerPayload({
      ...single,
      model: 'higgsfield',
      quality: '720p',
      mode: 'REFERENCE_TO_VIDEO',
      aspectRatio: '9:16',
      providerImageUrls: urls,
    });
    assert.equal(reference.endpoint, 'bytedance/seedance-2.0/reference-to-video');
    assert.deepEqual(reference.body.image_urls, urls);
    assert.ok(!('image_url' in reference.body));
    assert.ok(!('video_urls' in reference.body));
  } finally {
    legacy.enabled = false;
  }
  assert.throws(() => providerPayload({ ...single, prompt: '  ' }));
  assert.throws(
    () => providerPayload({ ...single, providerImageUrls: urls }),
    /одно исходное фото/,
  );
});

test('Kling text-to-video sends its own schema without Seedance resolution/audio fields', () => {
  const input = {
    model: 'kling',
    prompt: 'A scene',
    mode: 'TEXT_TO_VIDEO',
    duration: 5,
    quality: 'standard',
    aspectRatio: '9:16',
  };
  const mapped = providerPayload(input);
  assert.equal(mapped.endpoint, 'kling-video/v3.0/std/text-to-video');
  assert.deepEqual(mapped.body, {
    prompt: 'A scene',
    duration: 5,
    sound: 'off',
    cfg_scale: 0.5,
    multi_shots: false,
    aspect_ratio: '9:16',
  });
  assert.throws(() => providerPayload({ ...input, quality: '720p' }));
  assert.throws(() => providerPayload({ ...input, model: 'higgsfield', quality: '720p' }));
});

test('Higgsfield adapter uses existing credential names and records a validated receipt without retries', async () => {
  const original = { ...env },
    originalFetch = globalThis.fetch;
  let calls = 0;
  try {
    Object.assign(env, {
      HIGGSFIELD_ENABLED: true,
      HIGGSFIELD_API_KEY_ID: 'test-key-id',
      HIGGSFIELD_API_KEY_SECRET: 'test-secret',
    });
    const id = randomUUID(),
      requestId = randomUUID();
    globalThis.fetch = async (url, options) => {
      calls++;
      assert.equal(url, 'https://api.higgsfield.ai/kling-video/v3.0/std/image-to-video');
      assert.equal(options.headers.Authorization, 'Key test-key-id:test-secret');
      assert.equal(options.headers['Idempotency-Key'], id);
      assert.equal(options.redirect, 'error');
      assert.equal(JSON.parse(options.body).image_url, 'https://private.example/input.jpg');
      assert.equal(JSON.parse(options.body).sound, 'off');
      assert.ok(!('resolution' in JSON.parse(options.body)));
      return new Response(
        JSON.stringify({
          status: 'queued',
          request_id: requestId,
          status_url: `https://api.higgsfield.ai/requests/${requestId}/status`,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    };
    const receipt = await higgsfield.submit({
      id,
      model: 'kling',
      prompt: 'Server prompt',
      mode: 'IMAGE_TO_VIDEO',
      duration: 5,
      quality: 'standard',
      aspectRatio: 'source',
      providerImageUrl: 'https://private.example/input.jpg',
    });
    assert.equal(receipt.request_id, requestId);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    Object.assign(env, original);
  }
});

test('completion checks ownership, size, real content and bounded reads before accepting photos', async () => {
  await assert.rejects(
    completePhoto('user', randomUUID(), {
      db: { directUpload: { findFirst: async () => null } },
      store: {},
    }),
    /не найдена/,
  );
  const row = {
    objectKey: 'pending/user/id',
    mimeType: 'image/png',
    size: 4,
    expiresAt: new Date(Date.now() + 60000),
  };
  const db = { directUpload: { findFirst: async () => row } };
  await assert.rejects(
    completePhoto('user', randomUUID(), {
      db,
      store: { head: async () => ({ ContentLength: 5, ContentType: row.mimeType }) },
    }),
    /не совпадает/,
  );
  await assert.rejects(
    completePhoto('user', randomUUID(), {
      db,
      store: {
        head: async () => ({ ContentLength: 4, ContentType: row.mimeType }),
        read: async () => Buffer.from('fake'),
      },
    }),
    /не соответствует/,
  );
  await assert.rejects(boundedBuffer(Readable.from([Buffer.alloc(6)]), 5), /размер/);
});

test('R2 PUT signature binds type and length; GET uses private S3 endpoint and configurable expiry', async () => {
  const original = { ...env };
  try {
    Object.assign(env, {
      R2_ACCOUNT_ID: 'a'.repeat(32),
      R2_ACCESS_KEY_ID: 'test-only',
      R2_SECRET_ACCESS_KEY: 'test-only',
      R2_BUCKET_NAME: 'betelgeuse-uploads',
    });
    const signed = new URL(await r2.signUpload('pending/user/photo', 'image/png', 123));
    assert.equal(signed.protocol, 'https:');
    assert.ok(signed.hostname.endsWith('.r2.cloudflarestorage.com'));
    assert.ok(signed.searchParams.get('X-Amz-SignedHeaders').includes('content-type'));
    assert.ok(signed.searchParams.get('X-Amz-SignedHeaders').includes('content-length'));
    assert.equal(signed.searchParams.get('X-Amz-Expires'), '600');
    const read = new URL(await r2.signRead('images/user/photo.jpg', 86400));
    assert.equal(read.searchParams.get('X-Amz-Expires'), '86400');
    assert.ok(!read.hostname.endsWith('r2.dev'));
  } finally {
    Object.assign(env, original);
  }
});

function workerDb(row) {
  const updates = [];
  const db = {
    generation: {
      updateMany: async ({ data }) => {
        updates.push(data);
        return { count: 1 };
      },
    },
    storedImage: {
      findMany: async () =>
        row.sourceImageIds.map((id) => ({
          id,
          userId: row.userId,
          storageKind: 'r2',
          filename: `images/${id}.jpg`,
        })),
    },
    user: { update: async () => {}, findUnique: async () => ({ isAdmin: true }) },
  };
  db.$transaction = (fn) => fn(db);
  return { db, updates };
}
function trendRow() {
  return {
    id: randomUUID(),
    userId: randomUUID(),
    trendId: 'litvin',
    sourceImageIds: [randomUUID()],
    mode: 'IMAGE_TO_VIDEO',
    status: 'queued',
    leaseToken: 'test',
    createdAt: new Date(),
    attempts: 0,
    quotaCost: 1,
  };
}
test('ambiguous submission and restart cannot trigger another paid submission', async () => {
  for (const alreadyAttempted of [false, true]) {
    const row = trendRow();
    if (alreadyAttempted) row.submissionAttemptedAt = new Date();
    const { db, updates } = workerDb(row);
    let submits = 0;
    await processGeneration(row, {
      db,
      provider: {
        uploadImage: async () => 'https://private.example/input.jpg',
        submit: async () => {
          submits++;
          throw new ProviderError('Timeout', { retryable: true });
        },
      },
    });
    assert.equal(submits, alreadyAttempted ? 0 : 1);
    assert.equal(updates.at(-1).status, 'failed');
    assert.ok(!updates.at(-1).quotaRefunded);
  }
});
test('result persistence retries only status/download, never generation submission', async () => {
  const row = { ...trendRow(), providerRequestId: randomUUID(), providerStatusUrl: 'stored' };
  const { db, updates } = workerDb(row);
  let submits = 0,
    saves = 0;
  const provider = {
    submit: async () => {
      submits++;
    },
    status: async () => ({
      status: 'completed',
      video: { url: 'https://videos.higgs.ai/output.mp4' },
    }),
  };
  await processGeneration(row, {
    db,
    provider,
    resultStore: {
      saveResult: async () => {
        saves++;
        throw new Error('Storage unavailable');
      },
    },
  });
  assert.equal(submits, 0);
  assert.equal(saves, 1);
  assert.equal(updates.at(-1).attempts.increment, 1);
  await processGeneration(row, {
    db,
    provider,
    resultStore: { saveResult: async () => 'results/user/id.mp4' },
  });
  assert.equal(submits, 0);
  assert.equal(updates.at(-1).status, 'completed');
  assert.equal(updates.at(-1).resultVideoKey, 'results/user/id.mp4');
});

test('unknown result CDN reports the configuration error and never submits again', async () => {
  const row = { ...trendRow(), providerRequestId: randomUUID(), providerStatusUrl: 'stored' };
  const { db, updates } = workerDb(row);
  let submits = 0;
  await processGeneration(row, {
    db,
    provider: {
      submit: async () => {
        submits++;
      },
      status: async () => ({
        status: 'completed',
        video: { url: 'https://unapproved.example/result.mp4' },
      }),
    },
  });
  assert.equal(submits, 0);
  assert.equal(updates.at(-1).status, 'failed');
  assert.match(updates.at(-1).errorMessage, /Домен медиа провайдера не разрешён/);
});

test(
  'PostgreSQL trend lifecycle: reservation, verified private photos, ownership, single debit, polling, stored result and download',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const originalEnv = { ...env },
      originalTrend = trends.litvin,
      originalR2 = { ...r2 };
    const objects = new Map();
    try {
      Object.assign(env, {
        HIGGSFIELD_ENABLED: true,
        HIGGSFIELD_API_KEY_ID: 'test',
        HIGGSFIELD_API_KEY_SECRET: 'test',
        R2_ACCOUNT_ID: 'a'.repeat(32),
        R2_ACCESS_KEY_ID: 'test',
        R2_SECRET_ACCESS_KEY: 'test',
      });
      trends.litvin = {
        ...originalTrend,
        prompt: 'Server-controlled test scene',
        mode: 'IMAGE_TO_VIDEO',
        minPhotos: 1,
        maxPhotos: 1,
        aspectRatio: 'source',
      };
      Object.assign(r2, {
        signUpload: async (key) => `https://r2.test/${key}`,
        signRead: async (key) => `https://r2.test/${key}?temporary=true`,
        head: async (key) => {
          const item = objects.get(key);
          if (!item) throw new Error('Missing PUT');
          return { ContentLength: item.buffer.length, ContentType: item.type };
        },
        read: async (key) => objects.get(key).buffer,
        put: async (key, buffer, type) => {
          objects.set(key, { buffer, type });
        },
        remove: async (key) => {
          objects.delete(key);
        },
        open: async (key) => ({
          Body: Readable.from([objects.get(key).buffer]),
          ContentType: objects.get(key).type,
        }),
      });
      const a = request.agent(app),
        b = request.agent(app);
      const token = (await a.get('/api/auth/csrf')).body.token,
        tokenB = (await b.get('/api/auth/csrf')).body.token;
      for (const [agent, csrf] of [
        [a, token],
        [b, tokenB],
      ]) {
        const { body } = await agent
          .post('/api/auth/register')
          .set('X-CSRF-Token', csrf)
          .send({
            email: `trend-${randomUUID()}@example.com`,
            name: 'Trend test',
            password: 'test-password-123',
          })
          .expect(201);
        ids.push(body.user.id);
      }
      const userId = ids[0];
      const png = await sharp({
        create: { width: 64, height: 64, channels: 3, background: '#ccc' },
      })
        .png()
        .toBuffer();
      const { body: reserved } = await a
        .post('/api/trends/uploads/presign')
        .set('X-CSRF-Token', token)
        .send({
          trendId: 'litvin',
          files: Array(1).fill({ mimeType: 'image/png', size: png.length }),
        })
        .expect(201);
      const photoKeys = [];
      for (const upload of reserved.uploads) {
        const reservation = await prisma.directUpload.findUnique({
          where: { id: upload.uploadId },
        });
        objects.set(reservation.objectKey, { buffer: png, type: 'image/png' });
        await b
          .post('/api/trends/uploads/complete')
          .set('X-CSRF-Token', tokenB)
          .send({ uploadId: upload.uploadId })
          .expect(404);
        const { body } = await a
          .post('/api/trends/uploads/complete')
          .set('X-CSRF-Token', token)
          .send({ uploadId: upload.uploadId })
          .expect(200);
        photoKeys.push(body.image.key);
        assert.ok(!body.image.key.startsWith('pending/'));
        assert.equal(body.image.mimeType, 'image/jpeg');
        const again = await a
          .post('/api/trends/uploads/complete')
          .set('X-CSRF-Token', token)
          .send({ uploadId: upload.uploadId })
          .expect(200);
        assert.equal(again.body.image.key, body.image.key);
      }
      await b
        .post('/api/trends/generations')
        .set('X-CSRF-Token', tokenB)
        .set('Idempotency-Key', randomUUID())
        .send({ trendId: 'litvin', photoKeys })
        .expect(404);
      await a
        .post('/api/trends/generations')
        .set('X-CSRF-Token', token)
        .set('Idempotency-Key', randomUUID())
        .send({ trendId: 'litvin', photoKeys: [photoKeys[0], photoKeys[0]] })
        .expect(400);
      await a
        .post('/api/trends/generations')
        .set('X-CSRF-Token', token)
        .set('Idempotency-Key', randomUUID())
        .send({ trendId: 'litvin', photoKeys })
        .expect(409);
      await prisma.user.update({
        where: { id: userId },
        data: { isAdmin: true, generationCredits: 1 },
      });
      const key = randomUUID(),
        body = { trendId: 'litvin', photoKeys };
      const responses = await Promise.all(
        [1, 2].map(() =>
          a
            .post('/api/trends/generations')
            .set('X-CSRF-Token', token)
            .set('Idempotency-Key', key)
            .send(body),
        ),
      );
      assert.ok(
        responses.every((response) => response.status === 202),
        JSON.stringify(responses.map((r) => r.body)),
      );
      const generationId = responses[0].body.generation.id;
      assert.equal(generationId, responses[1].body.generation.id);
      assert.equal((await prisma.user.findUnique({ where: { id: userId } })).generationCredits, 1);
      let row = await prisma.generation.update({
        where: { id: generationId },
        data: { leaseToken: 'test' },
      });
      let submits = 0;
      const receipt = randomUUID();
      const provider = {
        uploadImage: async (image) => r2.signRead(image.filename, 86400),
        submit: async (generation) => {
          submits++;
          const mapped = providerPayload(generation);
          assert.ok(mapped.body.image_url.includes(photoKeys[0]));
          assert.equal(mapped.endpoint, 'kling-video/v3.0/std/image-to-video');
          assert.equal(mapped.body.sound, 'off');
          assert.equal(mapped.body.prompt, trends.litvin.prompt);
          return {
            request_id: receipt,
            status_url: `https://api.higgsfield.ai/requests/${receipt}/status`,
            status: 'in_progress',
          };
        },
        status: async () => ({
          request_id: receipt,
          status: 'completed',
          video: { url: 'https://videos.higgs.ai/generated.mp4' },
        }),
      };
      await processGeneration(row, { provider });
      row = await prisma.generation.update({
        where: { id: generationId },
        data: { leaseToken: 'test-2' },
      });
      assert.equal(row.status, 'processing');
      const resultKey = `results/${userId}/${generationId}.mp4`;
      await processGeneration(row, {
        provider,
        resultStore: {
          saveResult: async () => {
            objects.set(resultKey, {
              buffer: Buffer.from('test-video-download'),
              type: 'video/mp4',
            });
            return resultKey;
          },
        },
      });
      assert.equal(submits, 1);
      const output = await a.get(`/api/generations/${generationId}`).expect(200);
      assert.equal(output.body.generation.status, 'completed');
      assert.ok(output.body.generation.resultVideoUrl.includes('temporary=true'));
      assert.ok(!('resultVideoKey' in output.body.generation));
      const history = await a.get('/api/users/me/generations').expect(200);
      assert.equal(history.body.generations[0].trendId, 'litvin');
      await a
        .get(`/api/generations/${generationId}/download`)
        .expect(200)
        .expect('Content-Type', /video\/mp4/);
      await b.get(`/api/generations/${generationId}/download`).expect(404);
    } finally {
      Object.assign(env, originalEnv);
      Object.assign(r2, originalR2);
      trends.litvin = originalTrend;
    }
  },
);
