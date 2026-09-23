import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import { route } from '../../../../../lib/http.js';
import { requireUser } from '../../../../../lib/auth.js';
import { loadStudy, getSeries, seriesDir } from '../../../../../lib/storage.js';
import { decodePixels } from '../../../../../lib/dicom.js';
import { assert } from '../../../../../lib/errors.js';
export const runtime = 'nodejs';
const gzipAsync = promisify(gzip);
const MAX_SLICES_PER_REQUEST = 24;

// Several slices per request for background prefetching. Values are sent as
// 16-bit integers when every value fits exactly (typical CT), halving the size
// without loss; otherwise as 32-bit floats. The body is gzip-compressed.
export const GET = route(async (request, { params }) => {
  const { owner } = await requireUser(request),
    { id } = await params,
    url = new URL(request.url);
  const study = await loadStudy(owner, id),
    series = getSeries(study, url.searchParams.get('series'));
  const ids = [...new Set((url.searchParams.get('frames') || '').split(',').filter(Boolean))];
  assert(
    ids.length && ids.length <= MAX_SLICES_PER_REQUEST,
    `Request 1 to ${MAX_SLICES_PER_REQUEST} slices.`,
  );
  const byId = new Map(series.frames.map((f) => [f.id, f]));
  const frames = ids.map((frameId) => {
    const frame = byId.get(frameId);
    assert(frame, 'Frame not found.', 404);
    return frame;
  });
  const files = new Map(),
    decoded = [];
  for (const frame of frames) {
    if (!files.has(frame.fileId))
      files.set(
        frame.fileId,
        await fs.readFile(path.join(seriesDir(owner, id, series.id), `${frame.fileId}.dcm`)),
      );
    decoded.push(decodePixels(files.get(frame.fileId), frame));
  }
  const fitsInt16 = decoded.every((pixels) =>
    pixels.every((v) => Number.isInteger(v) && v >= -32768 && v <= 32767),
  );
  const total = decoded.reduce((n, p) => n + p.length, 0);
  const output = fitsInt16 ? new Int16Array(total) : new Float32Array(total);
  let offset = 0;
  for (const pixels of decoded) {
    output.set(pixels, offset);
    offset += pixels.length;
  }
  // Typed arrays use platform byte order; every supported Node platform is little-endian.
  const body = await gzipAsync(Buffer.from(output.buffer), { level: 1 });
  return new Response(body, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'gzip',
      'Cache-Control': 'private, no-store',
      'X-Pixel-Format': fitsInt16 ? 'int16-le' : 'float32-le',
    },
  });
});
