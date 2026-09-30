import { sameOrigin, json, route } from '../../../../lib/http.js';
import { readSessionToken, destroySession, sessionCookie } from '../../../../lib/auth.js';
import { maiaEnabled, maiaSignOut } from '../../../../lib/maia.js';
export const runtime = 'nodejs';
export const POST = route(async (request) => {
  sameOrigin(request);
  if (maiaEnabled()) {
    // The session is MAIA's (shared with ct.maiahub.my): end it there and relay
    // MAIA's cookie clearing to the browser.
    const response = json({ signedOut: true });
    for (const cookie of await maiaSignOut(request.headers.get('cookie')))
      response.headers.append('Set-Cookie', cookie);
    return response;
  }
  await destroySession(readSessionToken(request));
  return json({ signedOut: true }, 200, { 'Set-Cookie': sessionCookie(request, null) });
});
