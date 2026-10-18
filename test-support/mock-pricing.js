import { higgsfieldPricing } from '../src/pricing/pricing-engine.js';

// Synthetic rates exist only in process memory for tests; never write to the JSON tariff.
export function mockPricing(rate = '0.001') {
  const original = structuredClone(higgsfieldPricing.models);
  for (const model of Object.keys(higgsfieldPricing.models)) setModelTestPrice(model, rate);
  return () => {
    higgsfieldPricing.models = original;
  };
}
export function setModelTestPrice(model, rate) {
  function fill(value) {
    return value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, fill(child)]))
      : rate;
  }
  for (const config of Object.values(higgsfieldPricing.models[model])) {
    config.prices = fill(config.prices);
    // Adapter lifecycle tests use synthetic flat rates and mocked provider HTTP.
    // Production keeps this review flag; no token tariff is asserted by this fixture.
    if (config.billingReviewRequired) config.billingReviewRequired = false;
  }
}
