import { modelPricing } from '../config/modelPricing.js';
import { AppError } from '../middleware/errors.js';

export function estimateCredits(body, { isAdmin = false } = {}) {
  const policy = modelPricing[body.model];
  const values = { ...body, parameters: body.parameters || {} };
  const rules = policy?.status === 'configured' ? policy.rules : [];
  const matches = rules.filter(({ match }) =>
    Object.entries(match).every(([key, expected]) => {
      const actual = key.startsWith('parameters.') ? values.parameters[key.slice(11)] : values[key];
      return actual === expected;
    }),
  );
  // Public tariffs stay unconfigured; ADMIN testing does not depend on a retail tariff.
  if (matches.length !== 1 || !Number.isSafeInteger(matches[0].credits) || matches[0].credits < 0)
    return {
      status: isAdmin ? 'admin_test' : 'unconfigured',
      credits: isAdmin ? 0 : null,
      baseCredits: null,
    };
  const baseCredits = matches[0].credits;
  return { status: 'configured', credits: isAdmin ? 0 : baseCredits, baseCredits };
}

// Indicative analytics only, not an invoice or public credit tariff. Image rates:
// HIGGSFIELD_API.md §4.3. Video list starting rates: https://open.higgsfield.ai/pricing.
// Parameter/account discounts can change the actual provider charge.
const referenceRates = {
  'qwen-image-3': ['image', 0.035],
  'soul-v2': ['image', 0.094],
  'ideogram-4': ['image', 0.045],
  'recraft-v4-1': ['image', 0.025],
  'grok-image-2': ['image', 0.05],
  kling: ['second', 0.084],
  'kling-2-5-turbo': ['second', 0.042],
  'wan-3': ['second', 0.05],
  'seedance-2-5': ['second', 0.206],
  'kling-o3': ['second', 0.084],
  // Same family starting rate; actual Motion Control charge must be reconciled in Console.
  'kling-3-motion': ['second', 0.084],
};
export function estimateProviderCost(body, referenceDuration) {
  const [unit, unitRateUsd] = referenceRates[body.model];
  const quantity = unit === 'image' ? 1 : body.duration || referenceDuration;
  if (!Number.isFinite(quantity) || quantity <= 0)
    throw new AppError(400, 'Не удалось определить длительность видео. Загрузите референс заново.');
  return {
    amountUsd: Number((unitRateUsd * quantity).toFixed(6)),
    kind: 'estimate',
    scope: 'Reference baseline only; parameters and account discounts may change the actual charge',
    unitRateUsd,
    quantity,
    unit,
    basis: 'indicative_reference_rate',
    source: unit === 'image' ? 'HIGGSFIELD_API.md#4.3' : 'https://open.higgsfield.ai/pricing',
    estimatedAt: new Date().toISOString(),
  };
}
