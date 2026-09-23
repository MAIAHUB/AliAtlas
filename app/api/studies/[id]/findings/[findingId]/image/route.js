import { sameOrigin, json, route } from '../../../../../../../lib/http.js';
import { requireUser } from '../../../../../../../lib/auth.js';
import { AppError, assert } from '../../../../../../../lib/errors.js';
import { loadStudy } from '../../../../../../../lib/storage.js';
import { saveFindingImage, readFindingImage } from '../../../../../../../lib/findings.js';
export const runtime = 'nodejs';
const MAX = 3 * 1024 * 1024;
export const GET = route(async (request, { params }) => {
  const { owner } = await requireUser(request),
    { id, findingId } = await params;
  await loadStudy(owner, id);
  return new Response(await readFindingImage(owner, id, findingId), {
    headers: { 'Content-Type': 'image/png', 'Cache-Control': 'private, no-store' },
  });
});
// Key image captured by the viewer: the slice with its caliper overlay.
export const PUT = route(async (request, { params }) => {
  sameOrigin(request);
  const { owner } = await requireUser(request),
    { id, findingId } = await params;
  assert(request.headers.get('content-type') === 'image/png', 'Send a PNG image.', 415);
  assert(
    Number(request.headers.get('content-length') || 0) <= MAX,
    'The key image is too large.',
    413,
  );
  const reader = request.body?.getReader();
  assert(reader, 'Request body is missing.');
  const chunks = [];
  let length = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX) {
      await reader.cancel();
      throw new AppError('The key image is too large.', 413);
    }
    chunks.push(value);
  }
  await saveFindingImage(owner, id, findingId, Buffer.concat(chunks));
  return json({ saved: true });
});
