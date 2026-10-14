import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import EmbeddedPostgres from 'embedded-postgres';

const backendDir = fileURLToPath(new URL('../', import.meta.url));
config({ path: path.join(backendDir, '.env') });

// Development-only PostgreSQL. Credentials come from the existing ignored .env;
// API keys and JWT configuration are never changed or printed.
async function start() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('db:start предназначен для локальной разработки.');
  }

  let url;
  try {
    url = new URL(process.env.DATABASE_URL);
  } catch {
    throw new Error('Укажите корректный DATABASE_URL в backend/.env.');
  }
  if (
    !['postgresql:', 'postgres:'].includes(url.protocol) ||
    !['127.0.0.1', 'localhost'].includes(url.hostname)
  ) {
    throw new Error('db:start поддерживает только локальный DATABASE_URL.');
  }

  const port = Number(url.port || 5432);
  const user = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  const databaseName = decodeURIComponent(url.pathname.slice(1));
  if (!user || !password || !databaseName || /[\r\n]/.test(password)) {
    throw new Error('DATABASE_URL должен содержать пользователя, пароль и имя базы.');
  }

  // Fail before touching data when another database already uses this port.
  await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', () =>
      reject(
        new Error(
          `Порт ${port} уже занят. Если PostgreSQL запущен, выполняйте db:migrate в другом терминале.`,
        ),
      ),
    );
    probe.listen(port, '127.0.0.1', () => probe.close(resolve));
  });

  const databaseDir = path.join(backendDir, '.local', 'postgres');
  const database = new EmbeddedPostgres({
    databaseDir,
    user,
    password,
    port,
    persistent: true,
    authMethod: 'scram-sha-256',
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    postgresFlags: ['-h', '127.0.0.1'],
    createPostgresUser: false,
    onLog: () => {},
    onError: () => {},
  });

  const initialized = await fs
    .access(path.join(databaseDir, 'PG_VERSION'))
    .then(() => true)
    .catch(() => false);
  if (!initialized) {
    console.log('Создаём локальное хранилище PostgreSQL (UTF8)…');
    await fs.mkdir(path.dirname(databaseDir), { recursive: true });
    await database.initialise();
  }

  await database.start();
  const client = database.getPgClient('postgres', '127.0.0.1');
  try {
    await client.connect();
    const existing = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [
      databaseName,
    ]);
    if (!existing.rowCount) {
      await client.query(
        `CREATE DATABASE ${client.escapeIdentifier(databaseName)} ENCODING 'UTF8' TEMPLATE template0`,
      );
    }
  } catch {
    await database.stop();
    throw new Error(
      'Не удалось подключиться к локальному PostgreSQL. Проверьте данные DATABASE_URL; для существующего хранилища нужны исходные учётные данные.',
    );
  } finally {
    await client.end().catch(() => {});
  }

  console.log(`PostgreSQL готов: 127.0.0.1:${port}, база ${databaseName}.`);
  console.log('Теперь в другом терминале: npm run db:migrate, затем npm run dev.');
  console.log(
    'Оставьте этот терминал открытым. Ctrl+C остановит сервер; данные сохранятся в backend/.local/postgres.',
  );
  // embedded-postgres installs shutdown hooks; persistent:true preserves the cluster.
  setInterval(() => {}, 60000);
}

start().catch((error) => {
  console.error(error?.message || 'Не удалось запустить PostgreSQL.');
  process.exitCode = 1;
});
