import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { fileTypeFromBuffer } from 'file-type';
import { AppError } from '../middleware/errors.js';
const directory = fileURLToPath(new URL('../../uploads/', import.meta.url));
export const storage = {
  async saveReference(file) {
    if (file.mimetype !== 'video/mp4') return this.saveImage(file);
    const type = await fileTypeFromBuffer(file.buffer);
    if (type?.mime !== 'video/mp4')
      throw new AppError(400, 'Содержимое файла не соответствует MP4');
    if (file.size > 50 * 1024 * 1024) throw new AppError(400, 'Видео превышает 50 МБ');
    const filename = `${randomUUID()}.mp4`;
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, filename), file.buffer, { flag: 'wx' });
    return { filename, mimeType: 'video/mp4', size: file.buffer.length };
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
