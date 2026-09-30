import { randomUUID } from 'node:crypto';
import { maiaEnabled, refundToken, spendToken } from './maia.js';

// Metered actions cost one Ali CT token from the user's MAIA wallet (paid MAIA
// plans are not charged). The token is taken before the work starts and given
// back if the work fails, so a failed detection or report never costs anything.
// Without MAIA (local accounts) nothing is metered and `wallet` is null.
export async function withToken(request, action, run) {
  if (!maiaEnabled()) return { result: await run(), wallet: null };
  const cookie = request.headers.get('cookie');
  const ref = `${action}-${randomUUID()}`;
  const wallet = await spendToken(cookie, ref, action);
  try {
    return { result: await run(), wallet };
  } catch (error) {
    await refundToken(cookie, ref);
    throw error;
  }
}
