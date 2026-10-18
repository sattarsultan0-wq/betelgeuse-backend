import { providerReady } from './env.js';
import { modelConfigs } from './modelCatalog.js';
import { modelPriceSummary } from '../pricing/pricing-engine.js';
export { modelConfigs } from './modelCatalog.js';
export function publicModels() {
  return modelConfigs
    .filter((model) => model.enabled)
    .map(({ modes, ...model }) => ({
      ...model,
      provider: 'higgsfield',
      generationType: model.generationType || 'Video',
      pricing: modelPriceSummary({ ...model, modes }),
      supportedInputTypes: [
        'text',
        ...new Set(
          Object.values(modes).flatMap((caps) => (caps.references || []).map((ref) => ref.type)),
        ),
      ],
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
