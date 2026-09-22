import { randomBytes, createHash } from 'node:crypto';
import { AppError, assert } from './errors.js';

export const json = (value, status = 200, headers = {}) =>
  Response.json(value, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
export function session(request, create = false) {
  let token = request.headers
    .get('cookie')
    ?.split(';')
    .map((s) => s.trim())
    .find((s) => s.startsWith('aliatlas_session='))
    ?.split('=')[1];
  let setCookie;
  if (!token || !/^[a-f0-9]{64}$/.test(token)) {
    assert(create, 'Open the workspace before uploading a study.', 401);
    token = randomBytes(32).toString('hex');
    const secure =
      process.env.ATLAS_COOKIE_SECURE === 'true' || new URL(request.url).protocol === 'https:';
    setCookie = `aliatlas_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${secure ? '; Secure' : ''}`;
  }
  return { owner: createHash('sha256').update(token).digest('hex'), setCookie };
}
export function sameOrigin(request) {
  const origin = request.headers.get('origin');
  const url = new URL(request.url);
  // Next may normalize request.url to its internal bind address. The Host header
  // represents the actual browser origin; proxies should set ATLAS_PUBLIC_ORIGIN.
  const expected =
    process.env.ATLAS_PUBLIC_ORIGIN ||
    new URL(`${url.protocol}//${request.headers.get('host') || url.host}`).origin;
  assert(
    request.headers.get('sec-fetch-site') !== 'cross-site' && (!origin || origin === expected),
    'Cross-origin writes are not allowed.',
    403,
  );
}
export async function readBody(request, max = 1_000_000) {
  assert(
    request.headers.get('content-type')?.startsWith('application/json'),
    'Send JSON data.',
    415,
  );
  assert(Number(request.headers.get('content-length') || 0) <= max, 'Request is too large.', 413);
  const reader = request.body?.getReader();
  assert(reader, 'Request body is missing.');
  const chunks = [];
  let length = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > max) {
      await reader.cancel();
      throw new AppError('Request is too large.', 413);
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new AppError('Invalid JSON.');
  }
}
export function route(handler) {
  return async (...args) => {
    try {
      return await handler(...args);
    } catch (error) {
      if (!(error instanceof AppError)) console.error('[AliAtlas]', error.code || error.name);
      return json(
        {
          error: error instanceof AppError ? error.message : 'The request failed. Please retry.',
          code: error instanceof AppError ? error.code : 'INTERNAL_ERROR',
        },
        error instanceof AppError ? error.status : 500,
      );
    }
  };
}
