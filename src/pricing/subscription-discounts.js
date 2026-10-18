import { pricingPolicy, subscriptionPlans } from './pricing-policy.js';
export { subscriptionPlans } from './pricing-policy.js';
import { creditCeil, decimal, markupFactor, power } from './exact-money.js';

export function publicSubscriptionPlans() {
  return Object.entries(subscriptionPlans).map(
    ([id, { name, monthlyPriceKZT, discountPercent }]) => ({
      id,
      name,
      monthlyPriceKZT,
      discountPercent,
    }),
  );
}
export const activeSubscriptionWhere = (now) => ({
  status: 'active',
  OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
});
export function selectPricingSubscription(subscriptions, now = new Date()) {
  // If historical data contains overlapping subscriptions, the best active known
  // tier wins. Unknown/legacy plan names never silently grant a discount.
  return (
    subscriptions
      .filter(
        (s) =>
          s.status === 'active' &&
          (s.expiresAt === null || new Date(s.expiresAt).getTime() > now.getTime()),
      )
      .sort(
        (a, b) =>
          (subscriptionPlans[b.plan.name.trim().toLowerCase()]?.rank ?? 0) -
            (subscriptionPlans[a.plan.name.trim().toLowerCase()]?.rank ?? 0) ||
          a.id.localeCompare(b.id),
      )[0] ?? null
  );
}
export async function pricingSubscription(db, userId, now = new Date()) {
  const subscriptions = await db.subscription.findMany({
    where: { userId, ...activeSubscriptionWhere(now) },
    include: { plan: true },
  });
  return selectPricingSubscription(subscriptions, now);
}
export function applySubscriptionDiscount(baseQuote, subscription, policy = pricingPolicy) {
  if (baseQuote.status !== 'AVAILABLE') return baseQuote;
  try {
    const active = selectPricingSubscription(subscription ? [subscription] : []);
    const planId = active?.plan.name.trim().toLowerCase() || 'free';
    const plan = Object.hasOwn(subscriptionPlans, planId)
      ? subscriptionPlans[planId]
      : subscriptionPlans.free;
    const baseFactor = markupFactor(policy.markup);
    const tierFactor = markupFactor(plan.markup ?? policy.markup);
    if (policy.rounding !== 'ceil') throw new Error('Unsupported rounding');
    const credits = creditCeil(
      decimal(baseQuote.retailUSD, 80),
      policy.creditValueUSD,
      tierFactor.coefficient * power(baseFactor.scale),
      baseFactor.coefficient * power(tierFactor.scale),
    );
    return {
      ...baseQuote,
      baseCredits: baseQuote.credits,
      credits,
      subscriptionPlan: plan.name.toLowerCase(),
      discountPercent: plan.discountPercent,
    };
  } catch {
    return { status: 'PRICE_UNAVAILABLE', credits: null, tariffVersion: null };
  }
}
