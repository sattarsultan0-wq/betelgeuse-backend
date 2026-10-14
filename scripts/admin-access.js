import { z } from 'zod';
import { prisma } from '../src/config/prisma.js';
import '../src/config/env.js';

try {
  const email = z.string().trim().toLowerCase().email().parse(process.argv[2]);
  const action = z.enum(['grant', 'revoke']).parse(process.argv[3] || 'grant');
  const user = await prisma.user.update({
    where: { email },
    data: { isAdmin: action === 'grant' },
    select: { id: true, email: true, isAdmin: true },
  });
  console.log(JSON.stringify(user));
} catch (error) {
  console.error(
    error.code === 'P2025'
      ? 'Account not found. Register the account first.'
      : 'Usage: npm run admin:access -- user@example.com grant|revoke. Database migrations must be applied.',
  );
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
