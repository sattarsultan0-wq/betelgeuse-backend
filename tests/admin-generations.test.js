import { mockPricing } from '../test-support/mock-pricing.js';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import request from 'supertest';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-only-secret-not-a-real-credential-123456789';
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL || 'postgresql://test:test@127.0.0.1:1/test';
process.env.HIGGSFIELD_ENABLED = 'false';
const { app } = await import('../src/app.js');
const { env } = await import('../src/config/env.js');
const { prisma } = await import('../src/config/prisma.js');
const { modelConfigs } = await import('../src/config/models.js');
const { createGeneration } = await import('../src/services/generation.service.js');
const { higgsfield } = await import('../src/services/higgsfield.service.js');
const { processGeneration } = await import('../src/jobs/generation.worker.js');
const { mp4Duration } = await import('../src/services/storage.service.js');
const { r2 } = await import('../src/services/r2.service.js');
const { mockR2 } = await import('../test-support/mock-r2.js');
if (process.env.TEST_DATABASE_URL) {
  const restorePricing = mockPricing();
  after(restorePricing);
}

after(() => prisma.$disconnect());

test('MP4 duration uses real movie metadata and rejects missing or truncated headers', async () => {
  const buffer = await fs.readFile(
    new URL('../../frontend/public/videos/hero.mp4', import.meta.url),
  );
  assert.ok(mp4Duration(buffer) > 0);
  assert.throws(() => mp4Duration(Buffer.from('not a video')));
  assert.throws(() => mp4Duration(buffer.subarray(0, 32)));
});

test(
  'PostgreSQL: all 11 MVP models and every mode complete through real adapters with mocked HTTP/R2',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const oldFetch = globalThis.fetch;
    const restore = mockR2(env, r2);
    const originalEnv = { ...env };
    let userId;
    const jobs = new Map();
    try {
      Object.assign(env, {
        HIGGSFIELD_ENABLED: true,
        HIGGSFIELD_API_KEY_ID: 'fixture',
        HIGGSFIELD_API_KEY_SECRET: 'fixture',
      });
      // Every outbound fetch is intercepted. An unexpected URL fails the test.
      globalThis.fetch = async (url, options) => {
        const parsed = new URL(url);
        assert.equal(parsed.origin, 'https://api.higgsfield.ai');
        assert.equal(options.headers.Authorization, 'Key fixture:fixture');
        if (options.method === 'POST') {
          const body = JSON.parse(options.body);
          const id = randomUUID();
          assert.ok(options.headers['Idempotency-Key']);
          assert.ok(body.prompt);
          assert.ok(
            modelConfigs.some(
              (model) =>
                model.enabled &&
                Object.values(model.modes).some((mode) => `/${mode.endpoint}` === parsed.pathname),
            ),
          );
          jobs.set(id, {
            path: parsed.pathname,
            key: options.headers['Idempotency-Key'],
            polls: 0,
          });
          return Response.json({
            request_id: id,
            status: 'queued',
            status_url: `https://api.higgsfield.ai/requests/${id}/status`,
          });
        }
        assert.equal(options.method, 'GET');
        const id = parsed.pathname.split('/')[2],
          job = jobs.get(id);
        assert.ok(job);
        job.polls++;
        return Response.json({
          request_id: id,
          status: job.polls === 1 ? 'in_progress' : 'completed',
          ...(job.polls === 1
            ? {}
            : job.image
              ? { images: [{ url: 'https://images.higgs.ai/mock.png' }] }
              : { video: { url: 'https://videos.higgs.ai/mock.mp4' } }),
        });
      };
      const agent = request.agent(app),
        csrf = (await agent.get('/api/auth/csrf')).body.token;
      const registered = await agent
        .post('/api/auth/register')
        .set('X-CSRF-Token', csrf)
        .send({
          name: 'QA',
          email: `all-models-${randomUUID()}@example.com`,
          password: 'safe-password-123',
        })
        .expect(201);
      userId = registered.body.user.id;
      await prisma.user.update({ where: { id: userId }, data: { isAdmin: true } });
      let count = 0;
      for (const model of modelConfigs.filter((item) => item.enabled)) {
        for (const [mode, caps] of Object.entries(model.modes)) {
          const references = [];
          for (const rule of caps.references) {
            const input = await prisma.storedImage.create({
              data: {
                userId,
                filename: `references/${userId}/${randomUUID()}`,
                storageKind: 'r2',
                mimeType: rule.type === 'video' ? 'video/mp4' : 'image/webp',
                size: 100,
                durationSeconds: rule.type === 'video' ? 6.25 : null,
              },
            });
            references.push({ role: rule.role, uploadId: input.id });
          }
          const body = {
            model: model.id,
            mode,
            prompt: 'A scene for a mocked generation',
            ...caps.defaults,
            parameters: Object.fromEntries(
              Object.entries(caps.parameters).map(([key, rule]) => [key, rule.default]),
            ),
            references,
          };
          const { prompt, ...estimate } = body;
          const quote = (
            await agent
              .post('/api/generations/estimate')
              .set('X-CSRF-Token', csrf)
              .send(estimate)
              .expect(200)
          ).body;
          assert.equal(quote.canGenerate, true);
          assert.ok(quote.credits > 0);
          assert.equal(quote.chargedCredits, 0);
          const key = randomUUID();
          let row;
          // Exercise the existing HTTP creation route for both image and video, then service for the other modes.
          if (
            (model.id === 'qwen-image-3' && mode === 'TEXT_TO_IMAGE') ||
            (model.id === 'kling' && mode === 'TEXT_TO_VIDEO')
          ) {
            const response = await agent
              .post('/api/generations')
              .set('X-CSRF-Token', csrf)
              .set('Idempotency-Key', key)
              .send(body)
              .expect(202);
            row = await prisma.generation.findUnique({
              where: { id: response.body.generation.id },
            });
          } else row = await createGeneration(userId, body, key);
          assert.equal(row.adminTest, true);
          assert.equal(row.quotaCost, 0);
          assert.ok(Number(row.costEstimate.providerCostUSD) > 0);
          assert.equal((await createGeneration(userId, body, key)).id, row.id);
          for (let step = 0; step < 3; step++) {
            row = await prisma.generation.update({
              where: { id: row.id },
              data: { leaseToken: randomUUID() },
            });
            await processGeneration(row);
            row = await prisma.generation.findUnique({ where: { id: row.id } });
            if (!step) jobs.get(row.providerRequestId).image = model.generationType === 'Image';
            assert.equal(row.status, ['queued', 'processing', 'completed'][step]);
          }
          assert.equal(jobs.get(row.providerRequestId).key, row.id);
          assert.equal(
            model.generationType === 'Image' ? row.resultImageKeys.length : !!row.resultVideoKey,
            model.generationType === 'Image' ? 1 : true,
          );
          const presented = (await agent.get(`/api/generations/${row.id}`).expect(200)).body
            .generation;
          const url =
            model.generationType === 'Image'
              ? presented.resultImageUrls[0]
              : presented.resultVideoUrl;
          assert.ok(url.startsWith('https://storage.example.test/results/'));
          if (model.generationType !== 'Image') {
            const download = await agent.get(`/api/generations/${row.id}/download`).expect(200);
            assert.equal(download.body.toString(), 'mock-video-bytes');
          }
          assert.equal(
            (await prisma.user.findUnique({ where: { id: userId } })).generationCredits,
            0,
          );
          count++;
        }
      }
      assert.equal(
        jobs.size,
        count,
        'One paid POST per generation across all polling and repeated creation calls',
      );
      assert.ok(count > 11);
      assert.equal((await agent.get('/api/users/me/generations').expect(200)).body.total, count);
    } finally {
      globalThis.fetch = oldFetch;
      Object.assign(env, originalEnv);
      restore();
      if (userId) await prisma.user.delete({ where: { id: userId } });
    }
  },
);

function memoryDb(row, isAdmin = true) {
  const db = {
    user: { findUnique: async () => ({ isAdmin }) },
    generation: {
      updateMany: async ({ data }) => {
        if (['failed', 'completed'].includes(row.status)) return { count: 0 };
        Object.assign(
          row,
          data,
          data.attempts?.increment ? { attempts: row.attempts + data.attempts.increment } : {},
        );
        return { count: 1 };
      },
    },
  };
  db.$transaction = (fn) => fn(db);
  return db;
}
function queuedRow() {
  return {
    id: randomUUID(),
    userId: randomUUID(),
    model: 'kling',
    mode: 'TEXT_TO_VIDEO',
    prompt: 'Mock scene',
    duration: 5,
    quality: 'standard',
    aspectRatio: '16:9',
    status: 'queued',
    createdAt: new Date(),
    attempts: 0,
    leaseToken: 'test',
    quotaCost: 0,
    adminTest: true,
  };
}
test('provider auth, balance, model, validation, timeout and connection errors never repeat paid POST', async () => {
  const oldFetch = globalThis.fetch,
    originalEnv = { ...env };
  try {
    Object.assign(env, {
      HIGGSFIELD_ENABLED: true,
      HIGGSFIELD_API_KEY_ID: 'fixture',
      HIGGSFIELD_API_KEY_SECRET: 'fixture',
    });
    for (const code of [
      400,
      401,
      402,
      403,
      404,
      422,
      423,
      429,
      500,
      503,
      'network',
      'timeout',
      'invalid-json',
    ]) {
      let calls = 0;
      globalThis.fetch = async () => {
        calls++;
        if (code === 'network') throw new Error('connection lost');
        if (code === 'timeout') throw new DOMException('deadline exceeded', 'TimeoutError');
        if (code === 'invalid-json') return new Response('invalid');
        return new Response('{}', { status: code });
      };
      const row = queuedRow(),
        db = memoryDb(row);
      await processGeneration({ ...row }, { db, provider: higgsfield });
      assert.equal(row.status, 'failed', String(code));
      assert.ok(row.errorMessage);
      if (code === 401) assert.match(row.errorMessage, /ключи/);
      if (code === 403) assert.match(row.errorMessage, /средств/);
      if (code === 422) assert.match(row.errorMessage, /параметры/);
      // Even a stale worker must stop at the persisted submission marker.
      await processGeneration({ ...row, status: 'queued' }, { db, provider: higgsfield });
      assert.equal(calls, 1, String(code));
    }
    let calls = 0;
    const provider = {
      submit: async () => {
        calls++;
        throw new Error('must not submit');
      },
    };
    const revoked = queuedRow();
    await processGeneration({ ...revoked }, { db: memoryDb(revoked, false), provider });
    assert.equal(revoked.status, 'failed');
    assert.match(revoked.errorMessage, /ADMIN/);
    const expired = queuedRow();
    await processGeneration(
      { ...expired },
      { db: memoryDb(expired), provider, now: () => Date.now() + env.GENERATION_TIMEOUT_MS + 1000 },
    );
    assert.equal(expired.status, 'failed');
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = oldFetch;
    Object.assign(env, originalEnv);
  }
});

test('transient polling and image storage failures retry only GET and R2 persistence', async () => {
  const oldFetch = globalThis.fetch,
    originalEnv = { ...env };
  try {
    Object.assign(env, {
      HIGGSFIELD_ENABLED: true,
      HIGGSFIELD_API_KEY_ID: 'fixture',
      HIGGSFIELD_API_KEY_SECRET: 'fixture',
    });
    const receipt = randomUUID();
    const row = {
      ...queuedRow(),
      generationType: 'Image',
      status: 'processing',
      providerRequestId: receipt,
      providerStatusUrl: `https://api.higgsfield.ai/requests/${receipt}/status`,
    };
    const db = memoryDb(row);
    let polls = 0,
      saves = 0;
    globalThis.fetch = async (url, options) => {
      assert.equal(options.method, 'GET');
      assert.ok(url.endsWith(`/requests/${receipt}/status`));
      if (++polls === 1) return new Response('{}', { status: 503 });
      return Response.json({
        request_id: receipt,
        status: 'completed',
        images: [{ url: 'https://images.higgs.ai/mock.png' }],
      });
    };
    const resultStore = {
      saveImageResult: async () => {
        if (++saves === 1) throw new Error('R2 disconnected');
        return 'results/mock.png';
      },
    };
    await processGeneration({ ...row }, { db, resultStore });
    assert.equal(row.attempts, 1);
    await processGeneration({ ...row }, { db, resultStore });
    assert.equal(row.attempts, 2);
    await processGeneration({ ...row }, { db, resultStore });
    assert.equal(row.status, 'completed');
    assert.deepEqual(row.resultImageKeys, ['results/mock.png']);
    assert.equal(polls, 3);
    assert.equal(saves, 2);
  } finally {
    globalThis.fetch = oldFetch;
    Object.assign(env, originalEnv);
  }
});
