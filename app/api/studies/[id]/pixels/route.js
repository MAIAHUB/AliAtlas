import { promises as fs } from 'node:fs';
import path from 'node:path';
import { route } from '../../../../../lib/http.js';
import { requireUser } from '../../../../../lib/auth.js';
import { loadStudy, getSeries, seriesDir } from '../../../../../lib/storage.js';
import { decodePixels } from '../../../../../lib/dicom.js';
import { assert } from '../../../../../lib/errors.js';
export const runtime = 'nodejs';
export const GET = route(async (request, { params }) => {
  const { owner } = await requireUser(request),
    { id } = await params,
    url = new URL(request.url);
  const study = await loadStudy(owner, id),
    series = getSeries(study, url.searchParams.get('series'));
  const frame = series.frames.find((f) => f.id === url.searchParams.get('frame'));
  assert(frame, 'Frame not found.', 404);
  const bytes = await fs.readFile(
    path.join(seriesDir(owner, id, series.id), `${frame.fileId}.dcm`),
  );
  const pixels = decodePixels(bytes, frame),
    body = Buffer.allocUnsafe(pixels.length * 4);
  for (let i = 0; i < pixels.length; i++) body.writeFloatLE(pixels[i], i * 4);
  return new Response(body, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Pixel-Format': 'float32-le',
      'X-Image-Rows': String(frame.rows),
      'X-Image-Columns': String(frame.columns),
    },
  });
});
