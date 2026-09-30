import { createHash } from 'node:crypto';
import { AppError } from './errors.js';

// MAIA hub connection. When MAIA_URL is set, Ali CT has no accounts of its own:
// the browser carries MAIA's session cookie (shared across *.maiahub.my) and the
// server forwards it to MAIA's /api/ct/* endpoints, together with the shared
// ALI_CT_SERVICE_KEY. MAIA answers who is signed in and owns the CT token wallet.
// With MAIA_URL unset (local development, tests) Ali CT keeps its own email and
// password accounts and nothing is metered.

const base = () => process.env.MAIA_URL?.replace(/\/+$/, '') || '';
export const maiaEnabled = () => Boolean(base());
/** Browser-facing MAIA address (sign-in, buying tokens). */
export const maiaPublicUrl = () => process.env.MAIA_PUBLIC_URL?.replace(/\/+$/, '') || base();
export const maiaSignInUrl = () => `${maiaPublicUrl()}/?next=/ct`;
export const maiaBuyTokensUrl = () => `${maiaPublicUrl()}/ct`;

// Only MAIA's session cookies are forwarded, never Ali CT's own.
export function maiaCookies(cookieHeader) {
  return (cookieHeader || '')
    .split(';')
    .map((c) => c.trim())
    .filter((c) => /^(__Secure-|__Host-)?better-auth\./.test(c))
    .join('; ');
}

async function call(path, { cookie = '', method = 'GET', body } = {}) {
  const key = process.env.ALI_CT_SERVICE_KEY;
  if (!key)
    throw new AppError('Sign-in is not configured on this server.', 503, 'MAIA_UNCONFIGURED');
  let response;
  try {
    response = await fetch(`${base()}${path}`, {
      method,
      headers: {
        'x-ali-ct-key': key,
        ...(cookie ? { cookie } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new AppError('MAIA is unreachable. Please retry in a moment.', 503, 'MAIA_UNAVAILABLE');
  }
  const data = await response.json().catch(() => ({}));
  if (response.status === 403)
    throw new AppError('Sign-in is misconfigured on this server.', 503, 'MAIA_FORBIDDEN');
  if (response.status >= 500)
    throw new AppError('MAIA is unavailable. Please retry in a moment.', 503, 'MAIA_UNAVAILABLE');
  return { status: response.status, data };
}

// Every slice request needs the session, so answers are cached briefly per cookie.
const CACHE_MS = 30_000;
const cache = new Map();
const cacheKey = (cookie) => createHash('sha256').update(cookie).digest('hex');

/** The signed-in MAIA user and CT wallet for this cookie header, or null. */
export async function maiaSession(cookieHeader) {
  const cookie = maiaCookies(cookieHeader);
  if (!cookie) return null;
  const k = cacheKey(cookie);
  const hit = cache.get(k);
  if (hit && hit.expires > Date.now()) return hit.value;
  const { status, data } = await call('/api/ct/me', { cookie });
  if (status !== 200 || !data?.user?.id) {
    cache.delete(k);
    return null;
  }
  const value = { user: data.user, wallet: data.wallet };
  if (cache.size > 5000) cache.delete(cache.keys().next().value);
  cache.set(k, { value, expires: Date.now() + CACHE_MS });
  return value;
}

function rememberWallet(cookie, wallet) {
  const hit = cache.get(cacheKey(cookie));
  if (hit) hit.value = { ...hit.value, wallet };
}

/**
 * Charge one CT token for `ref`. Throws 402 NO_TOKENS when the wallet is empty.
 * Returns the wallet after the charge.
 */
export async function spendToken(cookieHeader, ref, action) {
  const cookie = maiaCookies(cookieHeader);
  const { status, data } = await call('/api/ct/spend', {
    cookie,
    method: 'POST',
    body: { ref, action },
  });
  if (status === 401) throw new AppError('Sign in to continue.', 401, 'UNAUTHENTICATED');
  if (status === 402) {
    rememberWallet(cookie, { balance: 0, unlimited: false });
    throw new AppError('You are out of Ali CT tokens. Buy more to continue.', 402, 'NO_TOKENS');
  }
  if (status !== 200)
    throw new AppError('Could not use a token. Please retry.', 502, 'SPEND_FAILED');
  const wallet = { balance: data.balance, unlimited: data.unlimited };
  rememberWallet(cookie, wallet);
  return wallet;
}

/** Give back the token for a failed action. Never throws. */
export async function refundToken(cookieHeader, ref) {
  try {
    const { data } = await call('/api/ct/refund', { method: 'POST', body: { ref } });
    if (data?.refunded) cache.delete(cacheKey(maiaCookies(cookieHeader)));
  } catch (e) {
    console.error('[Ali CT] token refund failed', ref, e.code || e.name);
  }
}

/**
 * End the MAIA session (it is shared, so this signs out of MAIA too). Returns
 * MAIA's Set-Cookie headers so the browser's shared cookie is cleared.
 */
export async function maiaSignOut(cookieHeader) {
  const cookie = maiaCookies(cookieHeader);
  if (!cookie) return [];
  cache.delete(cacheKey(cookie));
  try {
    const response = await fetch(`${base()}/api/auth/sign-out`, {
      method: 'POST',
      headers: {
        cookie,
        origin: process.env.ALI_CT_URL || maiaPublicUrl(),
        'content-type': 'application/json',
      },
      body: '{}',
      signal: AbortSignal.timeout(10_000),
    });
    return response.headers.getSetCookie?.() || [];
  } catch {
    return [];
  }
}
