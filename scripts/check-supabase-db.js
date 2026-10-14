// Read-only checks. Never prints connection URLs, credentials, or application rows.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import dotenv from 'dotenv';
import { Prisma, PrismaClient } from '@prisma/client';

const backendDir = fileURLToPath(new URL('../', import.meta.url));
export const appTables = ['User', 'Generation', 'StoredImage', 'Plan', 'Subscription', 'AuthIdentity', 'OAuthAttempt', 'DirectUpload'];
const fail = (message) => { throw new Error(message); };
export async function connectionTargets() {
  const source = await fs.readFile(path.join(backendDir, '.env'), 'utf8').catch((error) => { if (error.code === 'ENOENT') return ''; throw error; });
  const values = dotenv.parse(source), urls = {};
  for (const name of ['DATABASE_URL', 'DIRECT_URL']) {
    const count = source.split(/\r?\n/).filter((line) => new RegExp(`^\\s*${name}\\s*=`).test(line)).length;
    if (count > 1) fail(`${name}: duplicate definitions in .env`);
    const value = process.env[name] || values[name];
    if (!value) fail(`${name} is missing`);
    let url;
    try { url = new URL(value); } catch { fail(`${name}: invalid URL`); }
    if (url.protocol !== 'postgresql:' || !url.password || /YOUR.PASSWORD|change-me|URL_ENCODED_PASSWORD/i.test(decodeURIComponent(url.password))) fail(`${name}: configure a valid PostgreSQL URL and password`);
    if (url.username.endsWith('.PROJECT_REF')) fail(`${name}: configure the actual project reference`);
    const pooler = url.hostname.endsWith('.pooler.supabase.com');
    const direct = url.hostname.match(/^db\.([a-z0-9]+)\.supabase\.co$/);
    const project = pooler ? decodeURIComponent(url.username).match(/\.([a-z0-9]+)$/)?.[1] : direct?.[1];
    if (!project) fail(`${name}: target is not a recognized Supabase connection`);
    urls[name] = { url, project, schema: url.searchParams.get('schema') || 'public', kind: pooler ? 'pooler' : 'direct' };
    // Match Prisma CLI's env precedence and allow application imports in the check process.
    process.env[name] = value;
  }
  const app = urls.DATABASE_URL, migration = urls.DIRECT_URL;
  if (app.project !== migration.project || app.url.pathname !== migration.url.pathname || app.schema !== migration.schema) fail('CONFLICT: DATABASE_URL and DIRECT_URL target different projects/databases/schemas');
  if ((migration.url.port || '5432') !== '5432' || migration.url.searchParams.get('pgbouncer') === 'true') fail('DIRECT_URL must use the direct connection or session pooler on port 5432');
  if (app.url.searchParams.get('sslmode') !== 'require' || migration.url.searchParams.get('sslmode') !== 'require') fail('Both Supabase URLs must include sslmode=require');
  dotenv.config({ path: path.join(backendDir, '.env') });
  return urls;
}
export function readClient(target) {
  const url = new URL(target.url);
  url.searchParams.set('connection_limit', '1');
  url.searchParams.set('connect_timeout', '15');
  url.searchParams.set('pool_timeout', '15');
  return new PrismaClient({ datasources: { db: { url: url.toString() } }, log: [] });
}
async function catalog(db, schema) {
  return db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
    const identity = (await tx.$queryRawUnsafe(`SELECT current_database() AS database, current_user AS role, inet_server_addr()::text AS server_address, current_setting('server_version') AS version`))[0];
    const tables = await tx.$queryRawUnsafe(`SELECT c.relname AS name, c.relkind AS kind, c.relrowsecurity AS rls FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind IN ('r','p','v','m','f') ORDER BY c.relname`, schema);
    const enums = await tx.$queryRawUnsafe(`SELECT t.typname AS name, e.enumlabel AS value FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace JOIN pg_enum e ON e.enumtypid=t.oid WHERE n.nspname=$1 ORDER BY t.typname, e.enumsortorder`, schema);
    const columns = await tx.$queryRawUnsafe(`SELECT table_name AS table, column_name AS name, is_nullable AS nullable, data_type AS type, udt_name AS native_type FROM information_schema.columns WHERE table_schema=$1 ORDER BY table_name, ordinal_position`, schema);
    const indexes = await tx.$queryRawUnsafe(`SELECT t.relname AS table, i.relname AS name, x.indisvalid AS valid, x.indisready AS ready, x.indisunique AS unique, pg_get_indexdef(i.oid) AS definition FROM pg_index x JOIN pg_class t ON t.oid=x.indrelid JOIN pg_class i ON i.oid=x.indexrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname=$1 ORDER BY t.relname,i.relname`, schema);
    const constraints = await tx.$queryRawUnsafe(`SELECT t.relname AS table, c.conname AS name, c.contype AS type, c.convalidated AS valid, pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname=$1 ORDER BY t.relname,c.conname`, schema);
    const grants = await tx.$queryRawUnsafe(`SELECT table_name AS table, grantee AS role, privilege_type AS privilege FROM information_schema.role_table_grants WHERE table_schema=$1 AND grantee IN ('anon','authenticated','PUBLIC') ORDER BY table_name,grantee,privilege_type`, schema);
    const hasHistory = tables.some((table) => table.name === '_prisma_migrations');
    const history = hasHistory ? await tx.$queryRawUnsafe(`SELECT migration_name AS name, checksum, finished_at, rolled_back_at FROM "${schema.replaceAll('"', '""')}"."_prisma_migrations" ORDER BY started_at`) : [];
    return { identity, tables, enums, columns, indexes, constraints, grants, history };
  }, { timeout: 60000, maxWait: 20000 });
}
async function localMigrations() {
  const root = path.join(backendDir, 'prisma/migrations');
  const dirs = (await fs.readdir(root, { withFileTypes: true })).filter((item) => item.isDirectory()).map((item) => item.name).sort();
  return Promise.all(dirs.map(async (name) => {
    const sql = await fs.readFile(path.join(root, name, 'migration.sql'), 'utf8');
    const variants = [sql, sql.replace(/\r\n/g, '\n'), sql.replace(/\r?\n/g, '\r\n')];
    return { name, sql, hashes: variants.map((value) => createHash('sha256').update(value).digest('hex')) };
  }));
}
function checkHistory(history, migrations) {
  for (const row of history) {
    const local = migrations.find((item) => item.name === row.name);
    if (!local || !local.hashes.includes(row.checksum)) fail(`CONFLICT: migration history/checksum differs for ${row.name}`);
    if (!row.finished_at && !row.rolled_back_at) fail(`CONFLICT: unfinished migration ${row.name}`);
  }
}
function verifySchema(state, migrations) {
  for (const model of Prisma.dmmf.datamodel.models) {
    const table = model.dbName || model.name;
    if (!state.tables.some((item) => item.name === table)) fail(`Missing table ${table}`);
    const expected = model.fields.filter((field) => field.kind !== 'object');
    const actual = state.columns.filter((column) => column.table === table);
    if (expected.length !== actual.length) fail(`Column count differs for ${table}`);
    for (const field of expected) {
      const column = actual.find((item) => item.name === (field.dbName || field.name));
      if (!column || (column.nullable === 'YES') !== !field.isRequired) fail(`Missing column or incorrect nullability: ${table}.${field.name}`);
    }
  }
  const expectedIndexes = new Set(), expectedConstraints = new Set();
  for (const migration of migrations) {
    for (const match of migration.sql.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+"([^"]+)"/gi)) expectedIndexes.add(match[1]);
    for (const match of migration.sql.matchAll(/\bCONSTRAINT\s+"([^"]+)"/gi)) expectedConstraints.add(match[1]);
    for (const match of migration.sql.matchAll(/DROP\s+CONSTRAINT\s+"([^"]+)"/gi)) expectedConstraints.delete(match[1]);
  }
  for (const name of expectedConstraints) {
    const constraint = state.constraints.find((item) => item.name === name);
    if (!constraint?.valid) fail(`Missing or unvalidated constraint ${name}`);
    if (constraint.type === 'p') expectedIndexes.add(name);
  }
  for (const name of expectedIndexes) if (!state.indexes.some((item) => item.name === name && item.valid && item.ready)) fail(`Missing/invalid index ${name}`);
  const expectedEnums = { GenerationStatus: ['queued','processing','completed','failed'], GenerationMode: ['TEXT_TO_VIDEO','IMAGE_TO_VIDEO','REFERENCE_TO_VIDEO'], SubscriptionStatus: ['active','expired','canceled'], AuthProvider: ['google','apple'] };
  for (const [name, values] of Object.entries(expectedEnums)) if (JSON.stringify(state.enums.filter((item) => item.name === name).map((item) => item.value)) !== JSON.stringify(values)) fail(`Enum differs: ${name}`);
  const applied = state.history.filter((row) => row.finished_at && !row.rolled_back_at);
  if (applied.length !== migrations.length || migrations.some((local) => !applied.some((row) => row.name === local.name))) fail('Not all local migrations have been applied');
  return { applicationTables: appTables.length, applicationIndexes: state.indexes.filter((item) => appTables.includes(item.table)).length, foreignKeys: state.constraints.filter((item) => appTables.includes(item.table) && item.type === 'f').length, checkConstraints: state.constraints.filter((item) => appTables.includes(item.table) && item.type === 'c').length, enums: Object.keys(expectedEnums).length, appliedMigrations: applied.length };
}
async function main() {
  const mode = process.argv[2] || '--preflight';
  if (!['--preflight', '--verify'].includes(mode)) fail('Usage: node scripts/check-supabase-db.js --preflight|--verify');
  const targets = await connectionTargets(), migrations = await localMigrations();
  const app = readClient(targets.DATABASE_URL), direct = readClient(targets.DIRECT_URL);
  try {
    const [runtime, state] = await Promise.all([catalog(app, targets.DATABASE_URL.schema), catalog(direct, targets.DIRECT_URL.schema)]);
    if (runtime.identity.database !== state.identity.database || runtime.identity.server_address !== state.identity.server_address || JSON.stringify(runtime.tables.map((table) => table.name)) !== JSON.stringify(state.tables.map((table) => table.name))) fail('CONFLICT: connections do not report the same database/catalog');
    checkHistory(state.history, migrations);
    if (mode === '--preflight') {
      const existing = state.tables.filter((table) => table.name !== '_prisma_migrations');
      if (existing.length || state.enums.length || state.history.length) fail(`CONFLICT: target schema is not empty (${existing.length} objects, ${state.history.length} migration records). No migration was run.`);
      console.log(JSON.stringify({ phase: 'preflight', sameSupabaseProject: true, runtimeConnection: 'ok', migrationConnection: 'ok', schema: targets.DIRECT_URL.schema, existingTables: 0, existingMigrations: 0, pendingMigrations: migrations.map((item) => item.name), safeToDeploy: true }));
    } else {
      const verified = verifySchema(state, migrations);
      const exposed = appTables.filter((table) => !state.tables.find((item) => item.name === table)?.rls && state.grants.some((grant) => grant.table === table));
      console.log(JSON.stringify({ phase: 'verify', sameSupabaseProject: true, runtimeConnection: 'ok', migrationConnection: 'ok', ...verified, dataApiTablesWithoutRls: exposed }));
    }
  } finally { await Promise.all([app.$disconnect(), direct.$disconnect()]); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    // Only our own messages and error codes are printed; Prisma errors may contain DSNs.
    console.error(error.constructor === Error ? error.message : `Database check failed (${error.code || error.name}); credentials were not printed.`);
    process.exitCode = 1;
  });
}
