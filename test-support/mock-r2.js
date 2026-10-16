import { Readable } from 'node:stream';

// No network: usable by HTTP/Prisma and worker integration tests.
export function mockR2(env, r2) {
  const originalEnv = { ...env },
    originalStore = { ...r2 };
  const objects = new Map();
  Object.assign(env, {
    R2_ACCOUNT_ID: 'a'.repeat(32),
    R2_ACCESS_KEY_ID: 'fixture',
    R2_SECRET_ACCESS_KEY: 'fixture',
  });
  Object.assign(r2, {
    put: async (key, buffer, type) => objects.set(key, { buffer, type }),
    remove: async (key) => objects.delete(key),
    signRead: async (key) => `https://storage.example.test/${key}?signed=fixture`,
    open: async (key) => ({
      Body: Readable.from([objects.get(key).buffer]),
      ContentType: objects.get(key).type,
    }),
    saveImageResult: async (row, url, index) => {
      const key = `results/${row.userId}/${row.id}/${index}.png`;
      objects.set(key, { buffer: Buffer.from('mock-image-bytes'), type: 'image/png' });
      return key;
    },
    saveResult: async (row) => {
      const key = `results/${row.userId}/${row.id}.mp4`;
      objects.set(key, { buffer: Buffer.from('mock-video-bytes'), type: 'video/mp4' });
      return key;
    },
  });
  return () => {
    Object.assign(env, originalEnv);
    Object.assign(r2, originalStore);
  };
}
