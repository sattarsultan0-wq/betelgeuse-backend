import { z } from 'zod';
import { modelConfigs } from './models.js';
import { providerReady, r2Ready } from './env.js';
import { AppError } from '../middleware/errors.js';
import { showcaseMedia } from './showcase-media.js';
import { estimateCredits } from '../services/pricing.service.js';

// Server-only prompts. Fill in prompt and choose an enabled model from models.js.
// Kling 3.0 Standard IMAGE_TO_VIDEO takes exactly one photo.
// Multiple references require an explicitly enabled model with documented support.
// Showcase videoUrl is an example only; it is never sent to Higgsfield.
const defaults = {
  prompt: '',
  model: 'kling',
  mode: 'IMAGE_TO_VIDEO',
  minPhotos: 1,
  maxPhotos: 1,
  duration: 5,
  quality: 'standard',
  aspectRatio: 'source',
};
// Server-only generation settings keyed by trendId. Empty prompts keep paid requests disabled.
const generationOverrides = {};
export const trends = Object.fromEntries(
  showcaseMedia.map((item) => {
    const id = item.trendId || item.id;
    return [
      id,
      {
        ...defaults,
        title: item.title,
        videoUrl: item.src,
        posterUrl: item.poster,
        previewUrl: item.previewUrl,
        displayModel: item.model,
        mediaAspectRatio: item.mediaAspectRatio,
        ...generationOverrides[id],
      },
    ];
  }),
);
const schema = z
  .object({
    title: z.string().min(1),
    videoUrl: z.string().min(1),
    posterUrl: z.string().optional(),
    previewUrl: z.string().url().optional(),
    displayModel: z.string().optional(),
    mediaAspectRatio: z
      .string()
      .regex(/^\d+(?:\.\d+)?\s*\/\s*\d+(?:\.\d+)?$/)
      .optional(),
    prompt: z.string().trim().min(1).max(2000),
    model: z.string(),
    mode: z.enum(['IMAGE_TO_VIDEO', 'REFERENCE_TO_VIDEO']),
    minPhotos: z.number().int().min(1).max(4),
    maxPhotos: z.number().int().min(1).max(4),
    duration: z.number().int(),
    quality: z.string(),
    aspectRatio: z.string(),
  })
  .strict();
export function configuredTrend(id) {
  const value = trends[id];
  if (!value || !Object.hasOwn(trends, id)) throw new AppError(404, 'Тренд не найден');
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new AppError(503, 'Этот тренд ещё не настроен для генерации');
  const trend = parsed.data;
  const model = modelConfigs.find((item) => item.id === trend.model && item.enabled);
  const mode = model?.modes[trend.mode];
  if (
    !mode ||
    trend.minPhotos > trend.maxPhotos ||
    trend.maxPhotos > (mode.maxPhotos || 1) ||
    !mode.durations.includes(trend.duration) ||
    !mode.qualities.includes(trend.quality) ||
    !mode.aspectRatios.includes(trend.aspectRatio)
  )
    throw new AppError(503, 'Настройки тренда не поддерживаются выбранной моделью');
  return trend;
}
export function publicTrends() {
  return Object.entries(trends).map(([id, value]) => {
    let configured = false;
    try {
      configuredTrend(id);
      configured = true;
    } catch {
      /* Disabled until configured. */
    }
    return {
      id,
      title: value.title,
      videoUrl: value.videoUrl,
      posterUrl: value.posterUrl || null,
      previewUrl: value.previewUrl || null,
      displayModel: value.displayModel || 'Авторский концепт',
      mediaAspectRatio: value.mediaAspectRatio || null,
      minPhotos: value.minPhotos,
      maxPhotos: value.maxPhotos,
      available:
        configured && estimateCredits(value).status === 'AVAILABLE' && providerReady() && r2Ready(),
      unavailableReason: !configured
        ? 'Этот тренд скоро станет доступен для генерации.'
        : !r2Ready() || !providerReady()
          ? 'Генерация временно недоступна.'
          : estimateCredits(value).status !== 'AVAILABLE'
            ? 'Цена не указана'
            : null,
      quotaCost: estimateCredits(value).credits,
      pricing: (() => {
        const { status, credits, tariffVersion } = estimateCredits(value);
        return { status, credits, tariffVersion };
      })(),
    };
  });
}
