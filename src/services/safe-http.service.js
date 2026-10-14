import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Transform } from 'node:stream';
import { env } from '../config/env.js';
import { AppError } from '../middleware/errors.js';
export const mediaHosts = () =>
  env.PROVIDER_MEDIA_HOSTS.split(',')
    .map((host) => host.trim())
    .filter(Boolean);
export function validateMediaUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new AppError(502, 'Провайдер вернул некорректную ссылку');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (url.port && url.port !== '443') ||
    !mediaHosts().includes(url.hostname) ||
    isIP(url.hostname)
  )
    throw new AppError(502, 'Домен медиа провайдера не разрешён. Требуется настройка сервера.');
  return url;
}
export function publicIPv4(address) {
  if (isIP(address) !== 4) return false;
  const [a, b, c] = address.split('.').map(Number);
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || b === 0 || b === 2)) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113)
  );
}
export function boundedMediaStream(source, maxBytes) {
  let bytes = 0;
  const bounded = new Transform({
    transform(chunk, encoding, callback) {
      bytes += chunk.length;
      if (bytes > maxBytes) return callback(new AppError(502, 'Видео превышает допустимый размер'));
      callback(null, chunk);
    },
  });
  bounded.headers = source.headers || {};
  source.on('error', (error) => bounded.destroy(error));
  bounded.on('close', () => source.destroy());
  source.pipe(bounded);
  return bounded;
}
// Pin the DNS result in the socket lookup. Redirects are never followed.
export async function requestMedia(
  value,
  { method = 'GET', headers = {}, body, timeoutMs = 60000, maxBytes = 200 * 1024 * 1024 } = {},
) {
  const url = validateMediaUrl(value);
  const addresses = await lookup(url.hostname, { family: 4, all: true });
  if (!addresses.length || addresses.some(({ address }) => !publicIPv4(address)))
    throw new AppError(502, 'Небезопасный адрес медиа провайдера');
  return new Promise((resolve, reject) => {
    let output;
    const request = https.request(
      url,
      {
        method,
        headers,
        lookup: (hostname, options, callback) => {
          const found = addresses[0];
          if (options?.all) callback(null, [{ address: found.address, family: 4 }]);
          else callback(null, found.address, 4);
        },
      },
      (response) => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          response.resume();
          reject(new AppError(502, 'Не удалось получить медиа провайдера'));
          return;
        }
        const length = Number(response.headers['content-length']);
        if (length > maxBytes) {
          response.destroy();
          reject(new AppError(502, 'Видео превышает допустимый размер'));
          return;
        }
        output = boundedMediaStream(response, maxBytes);
        resolve(output);
      },
    );
    const deadline = setTimeout(
      () => request.destroy(new AppError(504, 'Истекло время передачи медиа')),
      timeoutMs,
    );
    request.on('close', () => clearTimeout(deadline));
    request.on('error', (error) => {
      if (output) output.destroy(error);
      else reject(error);
    });
    request.setTimeout(timeoutMs, () =>
      request.destroy(new AppError(504, 'Истекло время ожидания медиа')),
    );
    if (body) request.write(body);
    request.end();
  });
}
