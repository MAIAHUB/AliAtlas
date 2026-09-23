import test from 'node:test';
import assert from 'node:assert/strict';
import { sameOrigin } from '../lib/http.js';
import {
  hashPassword,
  verifyPassword,
  validateCredentials,
  sessionCookie,
  readSessionToken,
  ownerFor,
} from '../lib/auth.js';
test('checks the browser Host instead of the internal Next bind address', () => {
  assert.doesNotThrow(() =>
    sameOrigin(
      new Request('http://localhost:3000/api/studies/import', {
        headers: {
          host: '127.0.0.1:3000',
          origin: 'http://127.0.0.1:3000',
          'sec-fetch-site': 'same-origin',
        },
      }),
    ),
  );
  assert.throws(
    () =>
      sameOrigin(
        new Request('http://localhost:3000/api/studies/import', {
          headers: {
            host: '127.0.0.1:3000',
            origin: 'http://unrelated.example',
            'sec-fetch-site': 'cross-site',
          },
        }),
      ),
    /Cross-origin/,
  );
});
test('accepts every origin listed in ATLAS_PUBLIC_ORIGIN', () => {
  const previous = process.env.ATLAS_PUBLIC_ORIGIN;
  process.env.ATLAS_PUBLIC_ORIGIN = 'http://localhost:3000, http://127.0.0.1:3000';
  const write = (origin) =>
    sameOrigin(
      new Request('http://0.0.0.0:3000/api/auth/register', {
        headers: { origin, 'sec-fetch-site': 'same-origin' },
      }),
    );
  try {
    assert.doesNotThrow(() => write('http://localhost:3000'));
    assert.doesNotThrow(() => write('http://127.0.0.1:3000'));
    assert.throws(() => write('http://evil.example'), /Cross-origin/);
  } finally {
    if (previous === undefined) delete process.env.ATLAS_PUBLIC_ORIGIN;
    else process.env.ATLAS_PUBLIC_ORIGIN = previous;
  }
});
test('issues an HTTP-only, same-site session cookie and reads it back', () => {
  const token = 'c'.repeat(64);
  const cookie = sessionCookie(new Request('https://atlas.example/api/auth/login'), token);
  assert.match(cookie, /HttpOnly; SameSite=Strict/);
  assert.match(cookie, /Secure/);
  const request = new Request('https://atlas.example/api/workspace', {
    headers: { cookie: `other=1; ${cookie.split(';')[0]}` },
  });
  assert.equal(readSessionToken(request), token);
  assert.equal(
    readSessionToken(
      new Request('https://atlas.example/', { headers: { cookie: 'aliatlas_session=../x' } }),
    ),
    null,
  );
  assert.match(sessionCookie(new Request('http://localhost/'), null), /Max-Age=0/);
});
test('hashes passwords with a per-user salt and verifies them', async () => {
  const first = await hashPassword('correct horse battery');
  const second = await hashPassword('correct horse battery');
  assert.notEqual(first, second);
  assert.equal(await verifyPassword('correct horse battery', first), true);
  assert.equal(await verifyPassword('wrong password!', first), false);
  assert.equal(await verifyPassword('anything', 'not-a-hash'), false);
});
test('validates registration input and derives a stable workspace owner', () => {
  assert.equal(
    validateCredentials({ email: ' A@Example.org ', password: 'x' }).email,
    'a@example.org',
  );
  assert.throws(
    () => validateCredentials({ email: 'a@b.co', password: 'short', name: 'A' }, true),
    /10 characters/,
  );
  assert.throws(() => validateCredentials({ email: 'nope', password: 'x' }), /valid email/);
  assert.match(ownerFor('0f8c3c1e-0000-4000-8000-000000000000'), /^[a-f0-9]{64}$/);
  assert.equal(ownerFor('u1'), ownerFor('u1'));
  assert.notEqual(ownerFor('u1'), ownerFor('u2'));
});
