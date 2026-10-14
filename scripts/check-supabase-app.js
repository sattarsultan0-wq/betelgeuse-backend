// Production-mode smoke check against the real Supabase database, without a worker or writes.
import { connectionTargets, appTables } from './check-supabase-db.js';
await connectionTargets();
process.env.NODE_ENV = 'production';
// A test-only HTTPS CORS origin; the saved .env is not changed.
process.env.CORS_ORIGINS = 'https://betelgeuse-check.example';
process.env.FRONTEND_URL = 'https://betelgeuse-check.example';
const { app } = await import('../src/app.js');
const { prisma } = await import('../src/config/prisma.js');
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
try {
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(30000) });
  const health = await response.json();
  if (response.status !== 200 || health.database !== 'connected') throw new Error('Express health check did not report a connected database');
  const counts = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
    const result = {};
    for (const table of appTables) {
      const model = table[0].toLowerCase() + table.slice(1);
      result[table] = await tx[model].count();
    }
    return result;
  }, { timeout: 60000, maxWait: 20000 });
  const privateRoutes = {};
  for (const route of ['/api/auth/me', '/api/users/me', '/api/users/me/billing', '/api/users/me/images', '/api/generations']) {
    const check = await fetch(`${base}${route}`, { signal: AbortSignal.timeout(10000) });
    privateRoutes[route] = check.status;
    await check.body?.cancel();
    if (check.status !== 401) throw new Error(`Anonymous access was not rejected: ${route}`);
  }
  console.log(JSON.stringify({ productionExpressHealth: response.status, database: health.database, prismaClientReads: 'ok', tableCounts: counts, anonymousPrivateRoutes: privateRoutes, workerStarted: false, dataWritten: false }));
} catch (error) {
  console.error(error.constructor === Error ? error.message : `Application check failed (${error.code || error.name}); credentials were not printed.`);
  process.exitCode = 1;
} finally {
  server.closeIdleConnections();
  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
}
