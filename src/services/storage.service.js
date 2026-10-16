import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { fileTypeFromBuffer } from 'file-type';
import { AppError } from '../middleware/errors.js';
const directory = fileURLToPath(new URL('../../uploads/', import.meta.url));
// MP4 movie header duration, for estimating video-reference usage without transcoding.
export function mp4Duration(buffer) {
  function find(start, end, wanted) {
    for (let offset = start; offset + 8 <= end;) {
      let size = buffer.readUInt32BE(offset),
        header = 8;
      const type = buffer.toString('ascii', offset + 4, offset + 8);
      if (size === 1) {
        if (offset + 16 > end) return null;
        const large = buffer.readBigUInt64BE(offset + 8);
        if (large > BigInt(Number.MAX_SAFE_INTEGER)) return null;
        size = Number(large);
        header = 16;
      } else if (!size) size = end - offset;
      if (size < header || offset + size > end) return null;
      if (type === wanted) return { start: offset + header, end: offset + size };
      offset += size;
    }
    return null;
  }
  const moov = find(0, buffer.length, 'moov');
  const mvhd = moov && find(moov.start, moov.end, 'mvhd');
  if (!mvhd) throw new AppError(400, 'MP4 должен содержать длительность видео');
  const version = buffer[mvhd.start];
  const offset = mvhd.start + (version === 1 ? 20 : 12);
  if (![0, 1].includes(version) || offset + (version === 1 ? 12 : 8) > mvhd.end)
    throw new AppError(400, 'Повреждён заголовок MP4');
  const scale = buffer.readUInt32BE(offset);
  const duration =
    version === 1 ? Number(buffer.readBigUInt64BE(offset + 4)) : buffer.readUInt32BE(offset + 4);
  const seconds = duration / scale;
  if (!Number.isFinite(seconds) || seconds <= 0)
    throw new AppError(400, 'Не удалось определить длительность MP4');
  return seconds;
}
export const storage = {
  async saveReference(file) {
    if (file.mimetype !== 'video/mp4') return this.saveImage(file);
    const type = await fileTypeFromBuffer(file.buffer);
    if (type?.mime !== 'video/mp4')
      throw new AppError(400, 'Содержимое файла не соответствует MP4');
    if (file.size > 50 * 1024 * 1024) throw new AppError(400, 'Видео превышает 50 МБ');
    const filename = `${randomUUID()}.mp4`;
    const durationSeconds = mp4Duration(file.buffer);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, filename), file.buffer, { flag: 'wx' });
    return { filename, mimeType: 'video/mp4', size: file.buffer.length, durationSeconds };
  },
  async saveImage(file) {
    if (file.buffer.length > 10 * 1024 * 1024)
      throw new AppError(400, 'Изображение превышает 10 МБ');
    const type = await fileTypeFromBuffer(file.buffer);
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (!type || !allowed.includes(type.mime) || type.mime !== file.mimetype)
      throw new AppError(400, 'Содержимое файла не соответствует JPEG, PNG или WebP');
    let buffer;
    try {
      buffer = await sharp(file.buffer, { limitInputPixels: 25000000, animated: false })
        .rotate()
        .webp({ quality: 90 })
        .toBuffer();
    } catch {
      throw new AppError(400, 'Изображение повреждено или превышает 25 мегапикселей');
    }
    const filename = `${randomUUID()}.webp`;
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, filename), buffer, { flag: 'wx' });
    return { filename, mimeType: 'image/webp', size: buffer.length };
  },
  resolve(filename) {
    if (!/^[0-9a-f-]{36}\.(webp|mp4)$/.test(filename))
      throw new AppError(400, 'Недопустимое имя файла');
    return path.join(directory, filename);
  },
  async read(filename) {
    return fs.readFile(this.resolve(filename));
  },
  async remove(filename) {
    await fs.unlink(this.resolve(filename)).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  },
};
