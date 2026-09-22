import test from 'node:test';
import assert from 'node:assert/strict';
import { sameOrigin, session } from '../lib/http.js';
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
test('generates an opaque, HTTP-only, same-site workspace cookie', () => {
  const created = session(new Request('https://atlas.example/api/workspace'), true);
  assert.match(created.setCookie, /HttpOnly; SameSite=Strict/);
  assert.match(created.setCookie, /Secure/);
  const resumed = session(
    new Request('https://atlas.example/api/workspace', {
      headers: { cookie: created.setCookie.split(';')[0] },
    }),
  );
  assert.equal(created.owner, resumed.owner);
  assert.equal(resumed.setCookie, undefined);
});
