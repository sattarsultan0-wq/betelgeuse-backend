import { prisma } from '../config/prisma.js';
import { validateModelInput } from './model-validation.service.js';
import { quotePrice, publicPrice } from '../pricing/pricing-engine.js';
import { AppError } from '../middleware/errors.js';
import { createHash } from 'node:crypto';
import {
  applySubscriptionDiscount,
  pricingSubscription,
} from '../pricing/subscription-discounts.js';
import { providerReady, r2Ready } from '../config/env.js';

export async function generationEstimate(body, userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { isAdmin: true, generationCredits: true },
  });
  if (!user) throw new AppError(401, 'Аккаунт не найден');
  const calculated = await priceGeneration(body, userId);
  const quote = publicPrice(calculated);
  const adminTest = calculated.status === 'AVAILABLE' ? calculated.adminTest : user.isAdmin;
  const sufficientBalance =
    quote.credits !== null && (adminTest || user.generationCredits >= quote.credits);
  return {
    ...quote,
    providerAvailable: providerReady(),
    storageAvailable: r2Ready(),
    canGenerate: quote.status === 'AVAILABLE' && sufficientBalance && providerReady() && r2Ready(),
    adminTest,
    chargedCredits: quote.credits === null ? null : adminTest ? 0 : quote.credits,
    sufficientBalance,
  };
}

export function estimateCredits(body, user = {}, context = {}) {
  const quote = publicPrice(quotePrice(body, context));
  return {
    ...quote,
    chargedCredits: quote.credits === null ? null : user.isAdmin ? 0 : quote.credits,
    adminTest: user.isAdmin === true,
  };
}

// Duration comes exclusively from the server's inspected, owned upload.
// Client duration metadata is never used for reference-video billing.
export async function priceGeneration(body, userId, { db = prisma, ...context } = {}) {
  let caps;
  try {
    ({ caps } = validateModelInput(body, { estimate: true }));
  } catch {
    return quotePrice(body, context);
  }
  const videoRule = caps.references.find((rule) => rule.type === 'video');
  if (videoRule && !caps.durations.length) {
    const reference = body.references?.find((ref) => ref.role === videoRule.role);
    if (!reference) return quotePrice(body, context);
    const stored = await db.storedImage.findFirst({ where: { id: reference.uploadId, userId } });
    if (!stored) throw new AppError(404, 'Референс не найден');
    if (!videoRule.mimeTypes.includes(stored.mimeType) || stored.size > videoRule.maxBytes)
      throw new AppError(400, 'Формат или размер референса не поддерживается');
    context.referenceDuration = stored.durationSeconds;
  }
  const base = quotePrice(body, context);
  if (base.status !== 'AVAILABLE') return base;
  const subscription = await pricingSubscription(db, userId);
  const quote = applySubscriptionDiscount(base, subscription, context.policy);
  if (quote.status !== 'AVAILABLE') return quote;
  const account = await db.user.findUnique({ where: { id: userId }, select: { isAdmin: true } });
  if (!account) throw new AppError(401, 'Аккаунт не найден');
  // Confirmation is a comparison with a fresh server calculation, never a
  // client-provided price. It binds the quote to its owner, parameters and plan.
  const normalized = {
    model: body.model,
    mode: body.mode,
    duration: body.duration ?? null,
    quality: body.quality ?? null,
    aspectRatio: body.aspectRatio ?? null,
    parameters: Object.entries(caps.parameters)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, rule]) => [key, body.parameters?.[key] ?? rule.default]),
    videoReferences: (body.references || []).filter((ref) =>
      caps.references.some((rule) => rule.type === 'video' && rule.role === ref.role),
    ),
  };
  const priceConfirmation = createHash('sha256')
    .update(
      JSON.stringify({
        userId,
        adminTest: account.isAdmin,
        normalized,
        price: publicPrice(quote),
        subscription: subscription
          ? [subscription.id, subscription.planId, subscription.expiresAt]
          : null,
      }),
    )
    .digest('hex');
  return { ...quote, priceConfirmation, adminTest: account.isAdmin };
}

export function confirmPrice(quote, confirmation, { isAdmin = false } = {}) {
  // Existing uncharged ADMIN clients stay compatible. Paid requests always
  // require an explicitly accepted estimate, including after a plan change.
  if ((!isAdmin || confirmation) && confirmation !== quote.priceConfirmation) {
    const error = new AppError(
      409,
      'Цена изменилась. Проверьте стоимость и нажмите Generate ещё раз.',
      'PRICE_CHANGED',
    );
    error.currentQuote = publicPrice(quote);
    throw error;
  }
}

export function requirePrice(quote) {
  if (quote.status !== 'AVAILABLE') throw new AppError(400, 'Цена не указана', 'PRICE_UNAVAILABLE');
  return quote;
}
