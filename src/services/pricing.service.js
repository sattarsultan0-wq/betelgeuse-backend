import { modelPricing } from '../config/modelPricing.js';

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
  // Ambiguous or missing configuration fails closed, including for administrators.
  if (matches.length !== 1 || !Number.isSafeInteger(matches[0].credits) || matches[0].credits < 0)
    return { status: 'unconfigured', credits: null, baseCredits: null };
  const baseCredits = matches[0].credits;
  return { status: 'configured', credits: isAdmin ? 0 : baseCredits, baseCredits };
}
