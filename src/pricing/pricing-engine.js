import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { modelConfigs } from '../config/modelCatalog.js';
import { validateModelInput } from '../services/model-validation.service.js';
import { pricingPolicy, subscriptionPlans } from './pricing-policy.js';
import { decimal, multiply, moneyString, markupFactor, creditCeil } from './exact-money.js';

// Loaded once per process; deploying a tariff requires restarting the backend.
export const higgsfieldPricing = (() => {
  try {
    return JSON.parse(
      readFileSync(new URL('./providers/higgsfield.json', import.meta.url), 'utf8'),
    );
  } catch {
    return { provider: 'higgsfield', currency: 'USD', models: {} };
  }
})();
const unavailable = () => ({ status: 'PRICE_UNAVAILABLE', credits: null, tariffVersion: null });
const own = (object, key) => object != null && Object.hasOwn(object, key);

// Decimal values are integer coefficients and powers of ten. No monetary
// multiplication, division or rounding passes through a JavaScript Number.
export function calculatePrice(providerCostUSD, policy = pricingPolicy) {
  try {
    const cost = decimal(providerCostUSD);
    const credit = decimal(policy.creditValueUSD);
    if (cost.coefficient <= 0n || credit.coefficient <= 0n || policy.rounding !== 'ceil')
      return unavailable();
    const retail = multiply(cost, markupFactor(policy.markup));
    const credits = creditCeil(retail, policy.creditValueUSD);
    return {
      status: 'AVAILABLE',
      credits,
      providerCostUSD: moneyString(cost),
      retailUSD: moneyString(retail),
    };
  } catch {
    return unavailable();
  }
}
export function tariffVersion(book = higgsfieldPricing, policy = pricingPolicy) {
  const hash = createHash('sha256')
    .update(
      JSON.stringify({
        book,
        policy,
        subscriptionPlans,
        models: modelConfigs.filter((model) => model.enabled),
      }),
    )
    .digest('hex')
    .slice(0, 16);
  return `${book.version || 'higgsfield-v1'}:${hash}`;
}
function field(body, path) {
  return path.startsWith('parameters.') ? body.parameters[path.slice(11)] : body[path];
}
function resolvePrice(
  body,
  { priceBook = higgsfieldPricing, policy = pricingPolicy, referenceDuration } = {},
) {
  try {
    const { caps } = validateModelInput(body, { estimate: true });
    if (priceBook.provider !== 'higgsfield' || priceBook.currency !== 'USD') return unavailable();
    const config = priceBook.models?.[body.model]?.[body.mode];
    if (!config || config.workflow !== caps.endpoint || !Array.isArray(config.dimensions))
      return unavailable();
    // Seedance's verified I2V billing is token-metered, not a flat per-second rate.
    // Keep the existing unit for compatibility, but do not activate an unverified
    // projection by merely filling its price cells.
    if (config.billingReviewRequired) return unavailable();
    const expectedDimensions = [
      ...(caps.qualities.length ? ['quality'] : []),
      ...(body.model === 'seedance-2-5' && body.mode === 'TEXT_TO_VIDEO' ? ['aspectRatio'] : []),
      ...Object.keys(caps.parameters).map((key) => `parameters.${key}`),
    ];
    if (JSON.stringify(config.dimensions) !== JSON.stringify(expectedDimensions))
      return unavailable();
    if (JSON.stringify(config.fixed) !== JSON.stringify(caps.fixed || {})) return unavailable();
    const normalized = {
      ...body,
      parameters: Object.fromEntries(
        Object.entries(caps.parameters).map(([key, rule]) => [
          key,
          body.parameters?.[key] ?? rule.default,
        ]),
      ),
    };
    let rate = config.prices;
    for (const dimension of config.dimensions) {
      const key = String(field(normalized, dimension));
      if (!own(rate, key)) return unavailable();
      rate = rate[key];
    }
    const unit = decimal(rate);
    if (unit.coefficient <= 0n) return unavailable();
    let quantity;
    if (
      config.unit === 'generation' &&
      !caps.durations.length &&
      !caps.references.some((r) => r.type === 'video')
    )
      quantity = decimal(1);
    else if (config.unit === 'second')
      quantity = decimal(caps.durations.length ? body.duration : referenceDuration);
    else return unavailable();
    if (quantity.coefficient <= 0n) return unavailable();
    const price = calculatePrice(moneyString(multiply(unit, quantity)), policy);
    return price;
  } catch {
    return unavailable();
  }
}
export function quotePrice(body, options = {}) {
  const price = resolvePrice(body, options);
  return price.status === 'AVAILABLE'
    ? { ...price, tariffVersion: tariffVersion(options.priceBook, options.policy) }
    : unavailable();
}
// Explicit allowlist: provider costs, USD amounts and policy never cross the API boundary.
export function publicPrice(quote) {
  return quote?.status === 'AVAILABLE' && Number.isSafeInteger(quote.credits) && quote.credits > 0
    ? {
        status: 'AVAILABLE',
        credits: quote.credits,
        tariffVersion: quote.tariffVersion,
        ...(Number.isSafeInteger(quote.baseCredits) && quote.baseCredits >= quote.credits
          ? {
              baseCredits: quote.baseCredits,
              subscriptionPlan: quote.subscriptionPlan,
              discountPercent: quote.discountPercent,
            }
          : {}),
        ...(typeof quote.priceConfirmation === 'string'
          ? { priceConfirmation: quote.priceConfirmation }
          : {}),
      }
    : unavailable();
}
export function modelPriceSummary(model, options = {}) {
  const prices = [];
  let complete = true;
  for (const [mode, caps] of Object.entries(model.modes)) {
    // A source video's duration is needed before a price can be determined.
    if (!caps.durations.length && caps.references.some((rule) => rule.type === 'video')) {
      complete = false;
      continue;
    }
    const dimensions = [
      ...(caps.qualities.length ? [['quality', caps.qualities]] : []),
      ...(model.id === 'seedance-2-5' && mode === 'TEXT_TO_VIDEO'
        ? [['aspectRatio', caps.aspectRatios]]
        : []),
      ...Object.entries(caps.parameters).map(([key, rule]) => [
        `parameters.${key}`,
        rule.type === 'boolean' ? [false, true] : rule.values,
      ]),
      ...(caps.durations.length ? [['duration', caps.durations]] : []),
    ];
    // Unpriced ratios are still validated. One supported representative avoids
    // recalculating the same price for every shape; Seedance is enumerated above.
    let variants = [{ model: model.id, mode, ...caps.defaults, parameters: {} }];
    for (const [key, values] of dimensions)
      variants = variants.flatMap((body) =>
        values.map((value) =>
          key.startsWith('parameters.')
            ? { ...body, parameters: { ...body.parameters, [key.slice(11)]: value } }
            : { ...body, [key]: value },
        ),
      );
    for (const body of variants) {
      const quote = resolvePrice(body, options);
      if (quote.status === 'AVAILABLE') prices.push(quote.credits);
      else complete = false;
    }
  }
  if (!prices.length) return { ...unavailable(), kind: null };
  const min = Math.min(...prices),
    max = Math.max(...prices);
  return {
    status: 'AVAILABLE',
    credits: min,
    kind: complete && min === max ? 'fixed' : 'from',
    tariffVersion: tariffVersion(options.priceBook, options.policy),
  };
}
