import { providerReady } from './env.js';
// Existing internal quota; this is not a provider price or a payment tariff.
export const generationCreditCosts = { 5: 1, 10: 2 };
export const generationCreditCost = (duration) => generationCreditCosts[duration];
export const modelConfigs = [
  {
    id: 'kling',
    name: 'Kling 3.0',
    subtitle: 'Standard · через Higgsfield API',
    enabled: true,
    modes: {
      TEXT_TO_VIDEO: {
        endpoint: 'kling-video/v3.0/std/text-to-video',
        aspectRatios: ['16:9', '9:16', '1:1'],
        durations: [5, 10],
        qualities: ['standard'],
      },
      IMAGE_TO_VIDEO: {
        endpoint: 'kling-video/v3.0/std/image-to-video',
        aspectRatios: ['source'],
        durations: [5, 10],
        qualities: ['standard'],
        maxPhotos: 1,
      },
    },
  },
  {
    id: 'higgsfield',
    name: 'Seedance 2.0',
    subtitle: 'Seedance 2.0 · через Higgsfield API',
    enabled: false,
    modes: {
      TEXT_TO_VIDEO: {
        endpoint: 'bytedance/seedance-2.0/text-to-video',
        aspectRatios: ['16:9', '9:16', '1:1'],
        durations: [5, 10],
        qualities: ['480p', '720p', '1080p'],
      },
      IMAGE_TO_VIDEO: {
        endpoint: 'bytedance/seedance-2.0/image-to-video',
        aspectRatios: ['source'],
        durations: [5, 10],
        qualities: ['480p', '720p', '1080p'],
      },
      REFERENCE_TO_VIDEO: {
        endpoint: 'bytedance/seedance-2.0/reference-to-video',
        aspectRatios: ['16:9', '9:16', '1:1'],
        durations: [5, 10],
        qualities: ['480p', '720p', '1080p'],
        maxPhotos: 4,
      },
    },
  },
  { id: 'veo', name: 'Veo', subtitle: 'Скоро на платформе', enabled: false, modes: {} },
];
export function publicModels() {
  return modelConfigs.map(({ modes, ...model }) => ({
    ...model,
    generationType: 'Video',
    creditCosts: Object.fromEntries(
      [...new Set(Object.values(modes).flatMap((mode) => mode.durations || []))].map((duration) => [
        duration,
        generationCreditCost(duration),
      ]),
    ),
    inputs: { image: !!modes.IMAGE_TO_VIDEO, video: false },
    available: model.enabled && providerReady(),
    modes: Object.fromEntries(
      Object.entries(modes).map(([key, { endpoint, ...values }]) => [key, values]),
    ),
  }));
}
