import { providerReady } from './env.js';
import { workflowModels } from './workflowModels.js';
import { modelPricing, generationCreditCost } from './modelPricing.js';
export { generationCreditCosts, generationCreditCost } from './modelPricing.js';
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
    provider: 'higgsfield',
    generationType: model.generationType || 'Video',
    pricingStatus: modelPricing[model.id]?.status || 'unconfigured',
    supportedInputTypes: [
      'text',
      ...new Set(
        Object.values(modes).flatMap((caps) => (caps.references || []).map((ref) => ref.type)),
      ),
    ],
    creditCosts: Object.fromEntries(
      [...new Set(Object.values(modes).flatMap((mode) => mode.durations || []))].map((duration) => [
        duration,
        model.id === 'kling' ? generationCreditCost(duration) : null,
      ]),
    ),
    inputs: {
      image:
        !!modes.IMAGE_TO_VIDEO ||
        Object.values(modes).some((m) => m.references?.some((r) => r.type === 'image')),
      video: Object.values(modes).some((m) => m.references?.some((r) => r.type === 'video')),
    },
    available: model.enabled && providerReady(),
    modes: Object.fromEntries(
      Object.entries(modes).map(([key, { endpoint, fixed, qualityField, ...values }]) => [
        key,
        {
          ...values,
          workflowId: endpoint,
          documentationUrl: `https://open.higgsfield.ai/models/${endpoint}/api-reference`,
          references: (values.references || []).map(({ apiField, array, ...ref }) => ref),
        },
      ]),
    ),
  }));
}

// Enrich the legacy models without changing Professional's supported options.
for (const config of modelConfigs) {
  for (const [name, caps] of Object.entries(config.modes)) {
    caps.method = 'POST';
    caps.references =
      name === 'IMAGE_TO_VIDEO'
        ? [
            {
              role: 'image',
              label: 'Изображение',
              type: 'image',
              min: 1,
              max: 1,
              apiField: 'image_url',
              mimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
              maxBytes: 10 * 1024 * 1024,
            },
          ]
        : [];
    caps.parameters = {};
    caps.promptMin = 1;
    caps.defaults = { duration: 5, quality: caps.qualities[0], aspectRatio: caps.aspectRatios[0] };
  }
}
modelConfigs.push(...workflowModels);
