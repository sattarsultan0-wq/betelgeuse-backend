import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { fileTypeFromBuffer } from 'file-type';
import { env, r2Ready } from '../config/env.js';
import { AppError } from '../middleware/errors.js';
import { requestMedia } from './safe-http.service.js';

export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
export const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
export const UPLOAD_TTL_SECONDS = 600;
let client;
function s3() {
  if (!r2Ready()) throw new AppError(503, 'Хранилище фотографий ещё не подключено');
  return (client ||= new S3Client({
    region: 'auto',
    endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  }));
}
const object = (Key) => ({ Bucket: env.R2_BUCKET_NAME, Key });
export async function boundedBuffer(stream, maxBytes) {
  const chunks = [];
  let bytes = 0;
  try {
    for await (const chunk of stream) {
      bytes += chunk.length;
      if (bytes > maxBytes) throw new AppError(400, 'Файл превышает допустимый размер');
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  } finally {
    stream.destroy?.();
  }
}
export const r2 = {
  async signUpload(key, mimeType, size) {
    return getSignedUrl(
      s3(),
      new PutObjectCommand({ ...object(key), ContentType: mimeType, ContentLength: size }),
      {
        expiresIn: UPLOAD_TTL_SECONDS,
        signableHeaders: new Set(['content-type', 'content-length']),
      },
    );
  },
  async signRead(key, expiresIn = 3600) {
    return getSignedUrl(s3(), new GetObjectCommand(object(key)), { expiresIn });
  },
  async head(key) {
    try {
      return await s3().send(new HeadObjectCommand(object(key)), {
        abortSignal: AbortSignal.timeout(60000),
      });
    } catch (error) {
      if (error.$metadata?.httpStatusCode === 404)
        throw new AppError(409, 'Фотография ещё не загружена');
      throw error;
    }
  },
  async open(key) {
    return s3().send(new GetObjectCommand(object(key)), {
      abortSignal: AbortSignal.timeout(60000),
    });
  },
  async read(key, maxBytes) {
    const response = await this.open(key);
    if (response.ContentLength > maxBytes) {
      response.Body.destroy();
      throw new AppError(400, 'Файл превышает допустимый размер');
    }
    return boundedBuffer(response.Body, maxBytes);
  },
  async put(key, buffer, mimeType) {
    await s3().send(
      new PutObjectCommand({
        ...object(key),
        Body: buffer,
        ContentType: mimeType,
        ContentLength: buffer.length,
      }),
      { abortSignal: AbortSignal.timeout(60000) },
    );
  },
  async remove(key) {
    await s3().send(new DeleteObjectCommand(object(key)), {
      abortSignal: AbortSignal.timeout(60000),
    });
  },
  async saveResult(generation, url) {
    const key = `results/${generation.userId}/${generation.id}.mp4`;
    const stream = await requestMedia(url, { maxBytes: 200 * 1024 * 1024 });
    const buffer = await boundedBuffer(stream, 200 * 1024 * 1024);
    const type = await fileTypeFromBuffer(buffer);
    if (type?.mime !== 'video/mp4') throw new AppError(502, 'Провайдер вернул файл неверного типа');
    await this.put(key, buffer, 'video/mp4');
    return key;
  },
  async saveImageResult(generation, url, index) {
    const stream = await requestMedia(url, { maxBytes: 25 * 1024 * 1024 });
    const buffer = await boundedBuffer(stream, 25 * 1024 * 1024);
    const type = await fileTypeFromBuffer(buffer);
    if (!PHOTO_TYPES.includes(type?.mime))
      throw new AppError(502, 'Провайдер вернул файл неверного типа');
    const key = `results/${generation.userId}/${generation.id}/${index}.${type.ext}`;
    await this.put(key, buffer, type.mime);
    return key;
  },
};
