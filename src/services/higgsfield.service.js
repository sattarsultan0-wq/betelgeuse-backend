import { z } from 'zod';
import { env, providerReady } from '../config/env.js';
import { modelConfigs } from '../config/models.js';
import { requestMedia, validateMediaUrl } from './safe-http.service.js';
import { storage } from './storage.service.js';
import { r2 } from './r2.service.js';
import { AppError } from '../middleware/errors.js';
import { validateModelInput } from './model-validation.service.js';
const base = 'https://api.higgsfield.ai';
const responseSchema = z.object({
  request_id: z.string().uuid(),
  status: z.enum(['queued', 'in_progress', 'completed', 'failed', 'nsfw', 'canceled']),
  status_url: z.string().url().optional(),
  video: z.object({ url: z.string().url() }).optional(),
  images: z.array(z.object({ url: z.string().url() })).optional(),
});
export class ProviderError extends Error {
  constructor(message, { retryable = false, refundSafe = false } = {}) {
    super(message);
    this.retryable = retryable;
    this.refundSafe = refundSafe;
  }
}
export function validateStatusUrl(value, id) {
  const url = new URL(value);
  if (
    url.origin !== base ||
    url.pathname !== `/requests/${id}/status` ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new ProviderError('Некорректный адрес статуса провайдера');
  return url.toString();
}
export function providerPayload(generation) {
  if (!['kling', 'higgsfield'].includes(generation.model)) {
    let caps;
    try {
      ({ caps } = validateModelInput(generation));
    } catch (error) {
      throw new ProviderError(error.message, { refundSafe: true });
    }
    const body = { ...caps.fixed, prompt: generation.prompt };
    if (caps.durations.length) body.duration = generation.duration;
    if (caps.qualities.length) body[caps.qualityField] = generation.quality;
    if (caps.aspectRatios.length) body.aspect_ratio = generation.aspectRatio;
    for (const [key, definition] of Object.entries(caps.parameters))
      body[key] = generation.parameters?.[key] ?? definition.default;
    for (const rule of caps.references) {
      const inputs = (generation.providerReferences || []).filter((ref) => ref.role === rule.role);
      if (inputs.length < rule.min || inputs.length > rule.max || inputs.some((ref) => !ref.url))
        throw new ProviderError('Референсы не загружены', { refundSafe: true });
      if (inputs.length)
        body[rule.apiField] = rule.array ? inputs.map((ref) => ref.url) : inputs[0].url;
    }
    return { endpoint: caps.endpoint, body };
  }
  if (!generation.prompt?.trim())
    throw new ProviderError('Промпт не настроен', { refundSafe: true });
  const config = modelConfigs.find((model) => model.id === generation.model && model.enabled);
  const capabilities = config?.modes[generation.mode];
  if (
    !capabilities ||
    !capabilities.durations.includes(generation.duration) ||
    !capabilities.qualities.includes(generation.quality) ||
    !capabilities.aspectRatios.includes(generation.aspectRatio)
  )
    throw new ProviderError('Параметры модели не поддерживаются', { refundSafe: true });
  const body = {
    prompt: generation.prompt,
    duration: generation.duration,
  };
  if (config.id === 'kling')
    Object.assign(body, { sound: 'off', cfg_scale: 0.5, multi_shots: false });
  else Object.assign(body, { resolution: generation.quality, generate_audio: false });
  if (generation.mode === 'TEXT_TO_VIDEO') body.aspect_ratio = generation.aspectRatio;
  else if (generation.mode === 'REFERENCE_TO_VIDEO') {
    if (
      !generation.providerImageUrls?.length ||
      generation.providerImageUrls.length > capabilities.maxPhotos
    )
      throw new ProviderError('Некорректное количество фотографий', { refundSafe: true });
    body.image_urls = generation.providerImageUrls;
    body.aspect_ratio = generation.aspectRatio;
  } else {
    if (config.id === 'kling' && (generation.providerImageUrls?.length || 1) > 1)
      throw new ProviderError('Kling 3.0 Standard принимает одно исходное фото', {
        refundSafe: true,
      });
    const imageUrl =
      generation.providerImageUrl ||
      generation.providerReferences?.find((ref) => ref.role === 'image')?.url;
    if (!imageUrl) throw new ProviderError('Нет загруженного изображения', { refundSafe: true });
    body.image_url = imageUrl;
  }
  return { endpoint: capabilities.endpoint, body };
}
async function providerRequest(path, { method = 'GET', body, idempotencyKey } = {}) {
  if (!providerReady()) throw new ProviderError('Higgsfield API не настроен', { retryable: true });
  let response;
  try {
    response = await fetch(`${base}/${path}`, {
      method,
      redirect: 'error',
      headers: {
        Authorization: `Key ${env.HIGGSFIELD_API_KEY_ID}:${env.HIGGSFIELD_API_KEY_SECRET}`,
        'Content-Type': 'application/json',
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw new ProviderError('Временная ошибка связи с Higgsfield', { retryable: true });
  }
  if (!response.ok) {
    const retryable = [408, 423, 429, 500, 502, 503, 504].includes(response.status);
    const messages = {
      401: 'Проверьте ключи Higgsfield на сервере',
      403: 'Недостаточно средств у провайдера',
      404: 'Модель или задача недоступна аккаунту',
      422: 'Провайдер отклонил параметры генерации',
    };
    await response.body?.cancel();
    throw new ProviderError(messages[response.status] || `Ошибка Higgsfield (${response.status})`, {
      retryable,
      refundSafe: !retryable && response.status < 500,
    });
  }
  try {
    return await response.json();
  } catch {
    throw new ProviderError('Некорректный ответ Higgsfield', { retryable: true });
  }
}
export const higgsfield = {
  async uploadImage(image) {
    if (image.storageKind === 'r2')
      return r2.signRead(image.filename, env.R2_INPUT_URL_TTL_SECONDS);
    const data = await providerRequest('files/generate-upload-url', {
      method: 'POST',
      body: { content_type: image.mimeType },
    });
    const parsed = z
      .object({
        public_url: z.string().url(),
        upload_url: z.string().url(),
        upload_headers: z.record(z.string()),
      })
      .safeParse(data);
    if (!parsed.success)
      throw new ProviderError('Некорректный ответ загрузки Higgsfield', { retryable: true });
    const { public_url, upload_url, upload_headers } = parsed.data;
    validateMediaUrl(public_url);
    const buffer = await storage.read(image.filename);
    const result = await requestMedia(upload_url, {
      method: 'PUT',
      headers: upload_headers,
      body: buffer,
      maxBytes: 1024 * 1024,
    });
    for await (const chunk of result) {
      /* Drain storage response without logging signed URLs. */
    }
    return public_url;
  },
  async submit(generation) {
    const { endpoint, body } = providerPayload(generation);
    const raw = await providerRequest(endpoint, {
      method: 'POST',
      body,
      idempotencyKey: generation.id,
    });
    const parsed = responseSchema.safeParse(raw);
    if (!parsed.success || !parsed.data.status_url)
      throw new ProviderError('Не удалось подтвердить принятие задачи провайдером', {
        retryable: true,
      });
    const data = parsed.data;
    return { ...data, status_url: validateStatusUrl(data.status_url, data.request_id) };
  },
  async status(generation) {
    const url = validateStatusUrl(generation.providerStatusUrl, generation.providerRequestId);
    const raw = await providerRequest(url.slice(base.length + 1));
    const parsed = responseSchema.safeParse(raw);
    if (!parsed.success || parsed.data.request_id !== generation.providerRequestId)
      throw new ProviderError('Некорректный ответ статуса Higgsfield', { retryable: true });
    return parsed.data;
  },
};
