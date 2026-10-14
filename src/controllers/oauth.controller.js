import { z } from 'zod';
import { env } from '../config/env.js';
import { AppError } from '../middleware/errors.js';
import { setSession } from '../middleware/auth.js';
import {
  beginOAuth,
  consumeOAuthAttempt,
  exchangeOAuthCode,
  oauthCookieName,
  oauthCookieOptions,
  oauthReturnUrl,
  publicAuthProviders,
  socialAccount,
  verifyOAuthToken,
} from '../services/oauth.service.js';

export function providers(req, res) {
  res.json({ providers: publicAuthProviders() });
}
export async function start(req, res) {
  const provider = z.enum(['google', 'apple']).parse(req.params.provider);
  const origin = req.get('Origin') || new URL(env.FRONTEND_URL).origin;
  const result = await beginOAuth(provider, origin);
  res.cookie(oauthCookieName(provider), result.binding, result.cookieOptions);
  res.json({ authorizationUrl: result.authorizationUrl });
}
const callbackSchema = z.object({
  state: z.string().min(1).max(255),
  code: z.string().min(1).max(4096).optional(),
  error: z.string().max(100).optional(),
  user: z.string().max(8192).optional(),
});

export function callback(provider) {
  return async (req, res) => {
    let origin = new URL(env.FRONTEND_URL).origin;
    res.set('Cache-Control', 'no-store');
    try {
      if (
        provider === 'apple' &&
        req.get('Origin') &&
        req.get('Origin') !== 'https://appleid.apple.com'
      )
        throw new AppError(401, 'Недействительный источник входа.', 'OAUTH_STATE');
      const body = callbackSchema.parse(provider === 'apple' ? req.body : req.query);
      const attempt = await consumeOAuthAttempt(
        provider,
        body.state,
        req.cookies[oauthCookieName(provider)],
      );
      origin = attempt.frontendOrigin;
      const { maxAge, ...cookie } = oauthCookieOptions(provider, attempt.redirectUri);
      res.clearCookie(oauthCookieName(provider), cookie);
      if (body.error) {
        res.redirect(
          303,
          oauthReturnUrl(origin, body.error === 'access_denied' ? 'canceled' : 'failed'),
        );
        return;
      }
      if (!body.code) throw new AppError(401, 'Отсутствует код входа.', 'OAUTH_TOKEN');
      const token = await exchangeOAuthCode(provider, body.code, attempt);
      const profile = await verifyOAuthToken(provider, token, attempt);
      if (provider === 'apple' && body.user) {
        try {
          const info = JSON.parse(body.user);
          const name = z
            .object({
              firstName: z.string().max(80).optional(),
              lastName: z.string().max(80).optional(),
            })
            .parse(info.name);
          profile.name = [name.firstName, name.lastName]
            .filter(Boolean)
            .join(' ')
            .trim()
            .slice(0, 80);
        } catch {
          /* Apple's optional first-consent name is only display data. */
        }
      }
      const user = await socialAccount(profile);
      setSession(res, user);
      res.redirect(303, oauthReturnUrl(origin, 'success'));
    } catch (error) {
      console.error(
        JSON.stringify({
          event: 'oauth_error',
          provider,
          requestId: req.requestId,
          code: error.code || 'OAUTH_ERROR',
        }),
      );
      const result =
        error.code === 'OAUTH_ACCOUNT_EXISTS'
          ? 'account_exists'
          : error.code === 'OAUTH_STATE'
            ? 'expired'
            : 'failed';
      res.redirect(303, oauthReturnUrl(origin, result));
    }
  };
}
