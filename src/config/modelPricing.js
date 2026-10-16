// Betelgeuse credits, not Higgsfield USD prices. Preserve the existing Kling quota.
// Add explicit rules only after the product owner has configured a tariff.
// Every price-affecting parameter must be matched; no fallback prices are inferred.
export const generationCreditCosts = { 5: 1, 10: 2 };
export const generationCreditCost = (duration) => generationCreditCosts[duration];
export const modelPricing = {
  kling: {
    status: 'configured',
    rules: ['TEXT_TO_VIDEO', 'IMAGE_TO_VIDEO'].flatMap((mode) =>
      [5, 10].map((duration) => ({
        match: { mode, duration, quality: 'standard' },
        credits: generationCreditCosts[duration],
      })),
    ),
  },
  'qwen-image-3': { status: 'unconfigured', rules: [] },
  'soul-v2': { status: 'unconfigured', rules: [] },
  'ideogram-4': { status: 'unconfigured', rules: [] },
  'recraft-v4-1': { status: 'unconfigured', rules: [] },
  'grok-image-2': { status: 'unconfigured', rules: [] },
  'kling-2-5-turbo': { status: 'unconfigured', rules: [] },
  'wan-3': { status: 'unconfigured', rules: [] },
  'kling-o3': { status: 'unconfigured', rules: [] },
  'seedance-2-5': { status: 'unconfigured', rules: [] },
  'kling-3-motion': { status: 'unconfigured', rules: [] },
};
