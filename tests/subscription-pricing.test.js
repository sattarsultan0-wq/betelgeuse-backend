import test from 'node:test';
import assert from 'node:assert/strict';
import { calculatePrice, publicPrice, tariffVersion } from '../src/pricing/pricing-engine.js';
import {
  applySubscriptionDiscount,
  selectPricingSubscription,
  subscriptionPlans,
  publicSubscriptionPlans,
} from '../src/pricing/subscription-discounts.js';

const subscription = (name, extra = {}) => ({
  id: name,
  status: 'active',
  expiresAt: null,
  plan: { name },
  ...extra,
});
for (const [plan, credits] of [
  ['Free', 180],
  ['Basic', 160],
  ['Creator', 140],
  ['Pro', 120],
]) {
  test(`${plan}: exact multiplier, final credit conversion and public projection`, () => {
    const quote = applySubscriptionDiscount(calculatePrice('1'), subscription(plan));
    assert.equal(quote.credits, credits);
    assert.equal(quote.baseCredits, 180);
    assert.equal(quote.subscriptionPlan, plan.toLowerCase());
    const exposed = publicPrice(quote);
    assert.equal(exposed.credits, credits);
    assert.ok(!JSON.stringify(exposed).includes('USD'));
    assert.ok(!JSON.stringify(exposed).includes('markup'));
  });
}
test('round only after the exact subscription ratio, including recurring 8/9 and 7/9', () => {
  // Rounding base credits first would produce Basic=2 instead of 1.
  for (const plan of ['Basic', 'Creator', 'Pro'])
    assert.equal(applySubscriptionDiscount(calculatePrice('0.006'), subscription(plan)).credits, 1);
  assert.equal(applySubscriptionDiscount(calculatePrice('0.05'), subscription('Basic')).credits, 8);
  assert.equal(
    applySubscriptionDiscount(calculatePrice('0.050000000000000001'), subscription('Basic'))
      .credits,
    9,
  );
  assert.equal(
    applySubscriptionDiscount(calculatePrice('0.05'), subscription('Creator')).credits,
    7,
  );
  assert.equal(applySubscriptionDiscount(calculatePrice('0.05'), subscription('Pro')).credits, 6);
  assert.equal(
    applySubscriptionDiscount(
      calculatePrice('1', { markup: '0.8', creditValueUSD: '0.02', rounding: 'ceil' }),
      subscription('Pro'),
      { markup: '0.8', creditValueUSD: '0.02', rounding: 'ceil' },
    ).credits,
    60,
  );
});
test('missing, expired, canceled and unknown subscriptions use the standard price', () => {
  for (const sub of [
    null,
    subscription('Pro', { status: 'canceled' }),
    subscription('Pro', { status: 'expired' }),
    subscription('Pro', { expiresAt: new Date(Date.now() - 1) }),
    subscription('STARTER'),
    subscription('constructor'),
  ]) {
    const quote = applySubscriptionDiscount(calculatePrice('1'), sub);
    assert.equal(quote.credits, 180);
    assert.equal(quote.subscriptionPlan, 'free');
  }
  const now = new Date();
  assert.equal(selectPricingSubscription([subscription('Pro', { expiresAt: now })], now), null);
});
test('overlapping subscriptions select the best active tier deterministically', () => {
  const subs = [
    subscription('Basic'),
    subscription('Creator'),
    subscription('Pro', { status: 'canceled' }),
  ];
  assert.equal(selectPricingSubscription(subs).plan.name, 'Creator');
  assert.equal(selectPricingSubscription(subs.reverse()).plan.name, 'Creator');
});
test('unavailable provider prices never turn into zero or discounted prices', () => {
  assert.equal(
    applySubscriptionDiscount(calculatePrice(null), subscription('Pro')).status,
    'PRICE_UNAVAILABLE',
  );
});
test('public plan offerings contain display percentages and KZT prices without financial coefficients', () => {
  assert.deepEqual(
    publicSubscriptionPlans().map((p) => [p.monthlyPriceKZT, p.discountPercent]),
    [
      [0, 0],
      [4990, 11],
      [14990, 22],
      [26990, 33],
    ],
  );
  assert.ok(!JSON.stringify(publicSubscriptionPlans()).includes('markup'));
  const version = tariffVersion();
  subscriptionPlans.pro.markup = '0.21';
  try {
    assert.notEqual(tariffVersion(), version);
  } finally {
    subscriptionPlans.pro.markup = '0.2';
  }
});
