import fs from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
try {
  await fs.access('.env');
  console.log('.env already exists; preserved.');
} catch {
  const example = await fs.readFile('.env.example', 'utf8');
  await fs.writeFile(
    '.env',
    example.replace('JWT_SECRET=\n', `JWT_SECRET=${randomBytes(48).toString('hex')}\n`),
    { flag: 'wx' },
  );
  console.log(
    'Created ignored local .env with a random JWT secret. Set DATABASE_URL and provider keys as needed.',
  );
}
