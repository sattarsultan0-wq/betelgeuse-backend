import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { Readable } from 'node:stream';
import request from 'supertest';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-only-secret-not-a-real-credential-123456789';
process.env.DATABASE_URL ||= 'postgresql://test:test@127.0.0.1:5432/test';
const { app } = await import('../src/app.js');
const { prisma } = await import('../src/config/prisma.js');
const { publicIPv4, validateMediaUrl, boundedMediaStream } =
  await import('../src/services/safe-http.service.js');
const { verifyTelegramData } = await import('../src/services/auth.service.js');
const { validateGeneration } = await import('../src/services/generation.service.js');
const { providerPayload, validateStatusUrl } =
  await import('../src/services/higgsfield.service.js');
after(() => prisma.$disconnect());
test('media download preserves every byte and stops oversized streams', async () => {
  const source = Readable.from([Buffer.from('abc'), Buffer.from('def')]);
  const stream = boundedMediaStream(source, 6);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString(), 'abcdef');
  await assert.rejects(async () => {
    const oversized = boundedMediaStream(Readable.from([Buffer.alloc(10)]), 5);
    for await (const chunk of oversized) {
      /* Must reject before accepting oversized data. */
    }
  }, /превышает/);
});
test('private API denies unauthenticated access', async () => {
  for (const path of [
    '/api/auth/me',
    '/api/generations',
    '/api/users/me/generations',
    '/api/uploads/123',
  ])
    await request(app).get(path).expect(401);
});
test('mutation requires CSRF token before reaching database', async () => {
  await request(app)
    .post('/api/auth/login')
    .send({ email: 'test@example.com', password: 'anything' })
    .expect(403);
});
test('disallowed CORS origin is denied', async () => {
  await request(app).get('/api/models').set('Origin', 'https://evil.example').expect(403);
});
test('models expose capabilities without provider endpoints or secrets', async () => {
  const { body } = await request(app).get('/api/models').expect(200);
  assert.equal(body.models.length, 11);
  assert.ok(body.models.every((model) => model.enabled));
  assert.equal(body.models[0].id, 'kling');
  assert.equal(body.models[0].enabled, true);
  assert.deepEqual(body.models[0].modes.IMAGE_TO_VIDEO.qualities, ['standard']);
  assert.deepEqual(body.models[0].modes.IMAGE_TO_VIDEO.aspectRatios, ['source']);
  assert.ok(!JSON.stringify(body).includes('endpoint'));
});
test('SSRF filters local networks, credentials, ports and deceptive hosts', () => {
  for (const ip of [
    '127.0.0.1',
    '10.2.3.4',
    '172.16.3.2',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '::1',
    '224.0.0.1',
  ])
    assert.equal(publicIPv4(ip), false, ip);
  assert.equal(publicIPv4('8.8.8.8'), true);
  for (const url of [
    'http://videos.higgs.ai/test.mp4',
    'https://videos.higgs.ai.evil.test/test.mp4',
    'https://user:password@videos.higgs.ai/test.mp4',
    'https://videos.higgs.ai:8443/file.mp4',
    'https://127.0.0.1/test.mp4',
  ])
    assert.throws(() => validateMediaUrl(url));
  assert.equal(validateMediaUrl('https://videos.higgs.ai/file.mp4').hostname, 'videos.higgs.ai');
});
test('provider status URL must match both fixed host and exact request ID', () => {
  const id = 'c54a3d83-f411-4b4c-b10f-652c52a8fb53';
  assert.ok(validateStatusUrl(`https://api.higgsfield.ai/requests/${id}/status`, id));
  assert.throws(() => validateStatusUrl(`https://evil.test/requests/${id}/status`, id));
  assert.throws(() =>
    validateStatusUrl(`https://api.higgsfield.ai/requests/${id}/status?token=x`, id),
  );
});
test('unsupported model and options fail before any paid request', () => {
  assert.throws(() => validateGeneration({ model: 'veo', prompt: 'Test' }));
  assert.throws(() =>
    validateGeneration({
      model: 'kling',
      prompt: 'Test unsupported duration',
      mode: 'TEXT_TO_VIDEO',
      aspectRatio: '16:9',
      duration: 20,
      quality: 'standard',
    }),
  );
  const body = {
    model: 'kling',
    mode: 'IMAGE_TO_VIDEO',
    prompt: 'A scene',
    duration: 5,
    quality: 'standard',
    aspectRatio: 'source',
    sourceImageId: 'image',
    providerImageUrl: 'https://images.higgs.ai/input.webp',
  };
  assert.equal(validateGeneration(body), 1);
  const mapped = providerPayload(body);
  assert.equal(mapped.body.image_url, body.providerImageUrl);
  assert.ok(!('aspect_ratio' in mapped.body));
  assert.equal(mapped.body.sound, 'off');
  assert.equal(mapped.body.cfg_scale, 0.5);
  assert.equal(mapped.body.multi_shots, false);
  assert.ok(!('resolution' in mapped.body));
  assert.ok(!('generate_audio' in mapped.body));
  assert.throws(() => validateGeneration({ ...body, model: 'higgsfield', quality: '720p' }));
  assert.throws(() => validateGeneration({ ...body, quality: '720p' }));
});
test('Telegram signature validation rejects altered and expired initData', () => {
  const bot = '123456:test-token',
    now = Date.now();
  const params = new URLSearchParams({
    auth_date: String(Math.floor(now / 1000)),
    query_id: 'query',
    user: JSON.stringify({ id: 123, first_name: 'Test' }),
  });
  function sign(p) {
    const secret = createHmac('sha256', 'WebAppData').update(bot).digest();
    const text = [...p.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
    p.set('hash', createHmac('sha256', secret).update(text).digest('hex'));
    return p.toString();
  }
  const valid = sign(params);
  assert.equal(verifyTelegramData(valid, bot, now).id, 123);
  assert.throws(() => verifyTelegramData(valid.replace('query', 'other'), bot, now));
  assert.throws(() => verifyTelegramData(valid, bot, now + 360000));
  assert.throws(() => verifyTelegramData(valid + '&auth_date=0', bot, now));
});
