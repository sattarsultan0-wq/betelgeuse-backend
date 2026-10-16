import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

test(
  'backend starts with the migrated database and exposes health and models',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 20000 },
  async () => {
    const port = await new Promise((resolve, reject) => {
      const probe = net.createServer();
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', () => {
        const port = probe.address().port;
        probe.close(() => resolve(port));
      });
    });
    const child = spawn(process.execPath, ['server.js'], {
      cwd: fileURLToPath(new URL('../', import.meta.url)),
      windowsHide: true,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        PORT: String(port),
        DATABASE_URL: process.env.TEST_DATABASE_URL,
        JWT_SECRET: 'server-smoke-test-only-secret-123456789012345',
        HIGGSFIELD_ENABLED: 'false',
        HIGGSFIELD_API_KEY_ID: '',
        HIGGSFIELD_API_KEY_SECRET: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exited = once(child, 'exit');
    child.stderr.resume();
    try {
      await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', () => reject(new Error('Backend exited before listening')));
        child.stdout.on('data', (chunk) => {
          if (chunk.toString().includes('Betelgeuse API:')) resolve();
        });
      });
      const health = await fetch(`http://127.0.0.1:${port}/api/health`);
      assert.equal(health.status, 200);
      assert.equal((await health.json()).provider, 'not_configured');
      const catalog = await (await fetch(`http://127.0.0.1:${port}/api/models`)).json();
      assert.equal(catalog.models.filter((model) => model.enabled).length, 11);
    } finally {
      child.kill();
      await exited;
    }
  },
);
