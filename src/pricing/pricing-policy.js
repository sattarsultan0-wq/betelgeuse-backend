export const pricingPolicy = {
  markup: 0.8,
  creditValueUSD: 0.01,
  rounding: 'ceil',
};

// All tier coefficients and offerings are configured in this file. Display
// percentages are marketing labels, never operands in financial calculations.
export const subscriptionPlans = Object.freeze({
  free: { name: 'Free', monthlyPriceKZT: 0, discountPercent: 0, rank: 0 },
  basic: { name: 'Basic', monthlyPriceKZT: 4990, markup: '0.6', discountPercent: 11, rank: 1 },
  creator: { name: 'Creator', monthlyPriceKZT: 14990, markup: '0.4', discountPercent: 22, rank: 2 },
  pro: { name: 'Pro', monthlyPriceKZT: 26990, markup: '0.2', discountPercent: 33, rank: 3 },
});
