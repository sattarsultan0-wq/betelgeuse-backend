import { app } from './src/app.js';
import { env } from './src/config/env.js';
import { prisma } from './src/config/prisma.js';
import { startWorker } from './src/jobs/generation.worker.js';
const server = app.listen(env.PORT, '0.0.0.0', () =>
  console.log(`Betelgeuse API: http://127.0.0.1:${env.PORT}`),
);
server.requestTimeout = 30000;
server.headersTimeout = 10000;
const worker = startWorker();
let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`Graceful shutdown: ${signal}`);
  const force = setTimeout(() => process.exit(1), 15000);
  force.unref();
  server.closeIdleConnections();
  await Promise.all([new Promise((resolve) => server.close(resolve)), worker.stop()]);
  await prisma.$disconnect();
  clearTimeout(force);
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', () => {
  console.error('Unhandled rejection');
  shutdown('unhandledRejection');
});
