import test from 'node:test';
import assert from 'node:assert/strict';
import { maiaCookies, maiaSession } from '../lib/maia.js';
import { withToken } from '../lib/tokens.js';

const KEY = 'k'.repeat(40);
const COOKIE = '__Secure-better-auth.session_token=abc.def; aliatlas_session=' + 'a'.repeat(64);

// A fake MAIA: records calls and answers /api/ct/* like the real endpoints.
function fakeMaia({ balance = 2, unlimited = false } = {}) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const path = new URL(url).pathname;
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ path, body, headers: init.headers });
    const reply = (status, data) => Response.json(data, { status });
    if (init.headers['x-ali-ct-key'] !== KEY) return reply(403, {});
    if (path === '/api/ct/me')
      return reply(200, {
        user: { id: 'maia-1', email: 'Dr@Example.com', name: 'Dr A', image: null },
        wallet: { balance, unlimited },
      });
    if (path === '/api/ct/spend') {
      if (!unlimited && balance < 1) return reply(402, { error: 'no_tokens', balance: 0 });
      if (!unlimited) balance--;
      return reply(200, { charged: !unlimited, balance, unlimited });
    }
    if (path === '/api/ct/refund') {
      balance++;
      return reply(200, { refunded: true });
    }
    return reply(404, {});
  };
  return { calls, restore: () => (globalThis.fetch = original) };
}

function withEnv(t) {
  const saved = { ...process.env };
  process.env.MAIA_URL = 'https://maia.test';
  process.env.ALI_CT_SERVICE_KEY = KEY;
  t.after(() => {
    process.env = saved;
  });
}
const request = () => new Request('https://ct.test/api/x', { headers: { cookie: COOKIE } });

test('forwards only MAIA session cookies, never Ali CT’s own', () => {
  assert.equal(maiaCookies(COOKIE), '__Secure-better-auth.session_token=abc.def');
  assert.equal(maiaCookies('aliatlas_session=x; other=1'), '');
  assert.equal(maiaCookies(undefined), '');
});

test('resolves the MAIA user and wallet from the forwarded cookie', async (t) => {
  withEnv(t);
  const maia = fakeMaia({ balance: 3 });
  t.after(maia.restore);
  const session = await maiaSession('__Secure-better-auth.session_token=me.1');
  assert.equal(session.user.id, 'maia-1');
  assert.deepEqual(session.wallet, { balance: 3, unlimited: false });
  assert.equal(maia.calls[0].headers.cookie, '__Secure-better-auth.session_token=me.1');
  assert.equal(await maiaSession('aliatlas_session=x'), null);
});

test('charges one token per action and returns the new balance', async (t) => {
  withEnv(t);
  const maia = fakeMaia({ balance: 2 });
  t.after(maia.restore);
  const { result, wallet } = await withToken(request(), 'detect', async () => 'done');
  assert.equal(result, 'done');
  assert.deepEqual(wallet, { balance: 1, unlimited: false });
  const spend = maia.calls.find((c) => c.path === '/api/ct/spend');
  assert.equal(spend.body.action, 'detect');
  assert.match(spend.body.ref, /^detect-[0-9a-f-]{36}$/);
  assert.ok(!maia.calls.some((c) => c.path === '/api/ct/refund'));
});

test('gives the token back when the action fails', async (t) => {
  withEnv(t);
  const maia = fakeMaia({ balance: 1 });
  t.after(maia.restore);
  await assert.rejects(
    withToken(request(), 'report', async () => {
      throw new Error('drafting failed');
    }),
    /drafting failed/,
  );
  const spend = maia.calls.find((c) => c.path === '/api/ct/spend');
  const refund = maia.calls.find((c) => c.path === '/api/ct/refund');
  assert.equal(refund.body.ref, spend.body.ref);
});

test('an empty wallet stops the action with NO_TOKENS before any work', async (t) => {
  withEnv(t);
  const maia = fakeMaia({ balance: 0 });
  t.after(maia.restore);
  let ran = false;
  await assert.rejects(
    withToken(request(), 'detect', async () => {
      ran = true;
    }),
    (e) => e.status === 402 && e.code === 'NO_TOKENS',
  );
  assert.equal(ran, false);
});

test('paid MAIA plans are not charged', async (t) => {
  withEnv(t);
  const maia = fakeMaia({ balance: 0, unlimited: true });
  t.after(maia.restore);
  const { wallet } = await withToken(request(), 'report', async () => 'ok');
  assert.deepEqual(wallet, { balance: 0, unlimited: true });
});

test('without MAIA configured nothing is metered', async (t) => {
  const saved = process.env.MAIA_URL;
  delete process.env.MAIA_URL;
  t.after(() => {
    if (saved !== undefined) process.env.MAIA_URL = saved;
  });
  const { result, wallet } = await withToken(request(), 'detect', async () => 42);
  assert.equal(result, 42);
  assert.equal(wallet, null);
});
