import { sameOrigin, json, route, readBody } from '../../../../lib/http.js';
import { registerUser, createSession, sessionCookie } from '../../../../lib/auth.js';
import { audit } from '../../../../lib/db.js';
export const runtime = 'nodejs';
export const POST = route(async (request) => {
  sameOrigin(request);
  const user = await registerUser(await readBody(request, 10_000));
  await audit(user.id, 'auth.register');
  const token = await createSession(user.id);
  return json({ user: { email: user.email, name: user.name } }, 201, {
    'Set-Cookie': sessionCookie(request, token),
  });
});
