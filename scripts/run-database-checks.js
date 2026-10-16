import fs from 'node:fs/promises';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';

// Run checks in an isolated throwaway cluster, leaving the developer's database intact.
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'betelgeuse-tests-'));
const resolved = path.resolve(directory);
if (
  path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
  !path.basename(resolved).startsWith('betelgeuse-tests-')
)
  throw new Error('Unexpected test cluster path');
const port = await new Promise((resolve, reject) => {
  const server = net.createServer();
  server.on('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const selected = server.address().port;
    server.close(() => resolve(selected));
  });
});
const password = randomUUID();
const pg = new EmbeddedPostgres({
  databaseDir: resolved,
  user: 'qa',
  password,
  port,
  // Windows may briefly retain process handles after stop; clean up with retries below.
  persistent: true,
  authMethod: 'scram-sha-256',
  initdbFlags: ['--encoding=UTF8', '--locale=C'],
  postgresFlags: ['-h', '127.0.0.1'],
  createPostgresUser: false,
  onLog: () => {},
  onError: () => {},
});
const backendDir = fileURLToPath(new URL('../', import.meta.url));
const url = `postgresql://qa:${password}@127.0.0.1:${port}/betelgeuse_test`;
const childEnv = {
  ...process.env,
  DATABASE_URL: url,
  DIRECT_URL: url,
  TEST_DATABASE_URL: url,
  NODE_ENV: 'test',
  HIGGSFIELD_ENABLED: 'false',
  HIGGSFIELD_API_KEY_ID: '',
  HIGGSFIELD_API_KEY_SECRET: '',
  R2_ACCOUNT_ID: '',
  R2_ACCESS_KEY_ID: '',
  R2_SECRET_ACCESS_KEY: '',
};
function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: backendDir,
      env: childEnv,
      stdio: 'inherit',
      windowsHide: true,
    });
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 1));
  });
}
try {
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('betelgeuse_test');
  const migrated = await run(['node_modules/prisma/build/index.js', 'migrate', 'deploy']);
  process.exitCode = migrated || (await run(['--test']));
} finally {
  await pg.stop();
  // `resolved` was verified above to be a dedicated test cluster inside os.tmpdir().
  await fs.rm(resolved, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
}
// embedded-postgres can leave inherited pipe handles on Windows after taskkill.
// Tests and cluster cleanup are complete; preserve their exit code explicitly.
process.exit(process.exitCode || 0);
