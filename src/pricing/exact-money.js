// Decimal coefficients and integer ratios keep all monetary operations exact.
export const power = (scale) => 10n ** BigInt(scale);
export function decimal(value, maxScale = 18) {
  if (typeof value !== 'string' && typeof value !== 'number') throw new Error('Invalid decimal');
  const text = String(value);
  if (!new RegExp(`^\\d{1,12}(?:\\.\\d{1,${maxScale}})?$`).test(text))
    throw new Error('Invalid decimal');
  const [integer, fraction = ''] = text.split('.');
  return { coefficient: BigInt(integer + fraction), scale: fraction.length };
}
export function multiply(a, b) {
  return { coefficient: a.coefficient * b.coefficient, scale: a.scale + b.scale };
}
export function moneyString({ coefficient, scale }) {
  const digits = coefficient.toString().padStart(scale + 1, '0');
  return scale
    ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}`.replace(/\.?0+$/, '')
    : digits;
}
export function markupFactor(markup) {
  const value = decimal(markup);
  return { coefficient: power(value.scale) + value.coefficient, scale: value.scale };
}
// The only place prices are rounded. Ratios can be recurring (e.g. 8/9).
export function creditCeil(amount, creditValueUSD, numerator = 1n, denominator = 1n) {
  const credit = decimal(creditValueUSD);
  if (amount.coefficient <= 0n || credit.coefficient <= 0n || numerator <= 0n || denominator <= 0n)
    throw new Error('Invalid price');
  const top = amount.coefficient * power(credit.scale) * numerator;
  const bottom = power(amount.scale) * credit.coefficient * denominator;
  const credits = (top + bottom - 1n) / bottom;
  if (credits <= 0n || credits > 2147483647n) throw new Error('Price out of range');
  return Number(credits);
}
