import { prisma } from '../src/config/prisma.js';
import '../src/config/env.js';
import { z } from 'zod';
try {
  const email = z.string().email().parse(process.argv[2]?.toLowerCase());
  const amount = z.coerce.number().int().min(1).max(10000).parse(process.argv[3]);
  const user = await prisma.user.update({
    where: { email },
    data: { generationCredits: { increment: amount } },
    select: { email: true, generationCredits: true },
  });
  console.log(`Quota granted: ${user.email}, available=${user.generationCredits}`);
} catch (error) {
  console.error(
    'Usage: npm run quota:grant -- user@example.com 5. User must exist.',
    error.code || 'Invalid arguments',
  );
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
