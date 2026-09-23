import { sameOrigin, json, route } from '../../../../lib/http.js';
import { readSessionToken, destroySession, sessionCookie } from '../../../../lib/auth.js';
export const runtime = 'nodejs';
export const POST = route(async (request) => {
  sameOrigin(request);
  await destroySession(readSessionToken(request));
  return json({ signedOut: true }, 200, { 'Set-Cookie': sessionCookie(request, null) });
});
