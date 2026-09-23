import { sameOrigin, json, route, readBody } from '../../../../../lib/http.js';
import { requireUser } from '../../../../../lib/auth.js';
import { loadStudy, readJson } from '../../../../../lib/storage.js';
import {
  annotationFile,
  mutateAnnotations,
  validateAnnotation,
  exportAnnotations,
  importAnnotations,
} from '../../../../../lib/annotations.js';
import { assert } from '../../../../../lib/errors.js';
export const runtime = 'nodejs';
export const GET = route(async (request, { params }) => {
  const { owner } = await requireUser(request),
    { id } = await params,
    study = await loadStudy(owner, id);
  const current = await readJson(annotationFile(owner, id));
  return json(
    new URL(request.url).searchParams.has('export')
      ? exportAnnotations(study, current.records)
      : current,
  );
});
export const POST = route(async (request, { params }) => {
  sameOrigin(request);
  const { owner } = await requireUser(request),
    { id } = await params,
    input = await readBody(request);
  return json(
    await mutateAnnotations(owner, id, (records, study) => [
      ...records,
      validateAnnotation(study, input),
    ]),
    201,
  );
});
export const PATCH = route(async (request, { params }) => {
  sameOrigin(request);
  const { owner } = await requireUser(request),
    { id } = await params,
    input = await readBody(request);
  return json(
    await mutateAnnotations(owner, id, (records, study) => {
      const existing = records.find((r) => r.id === input.id);
      assert(existing, 'Annotation not found.', 404);
      const checked = validateAnnotation(study, {
        ...existing,
        ...input,
        frameId: existing.frameId,
        seriesId: existing.seriesId,
      });
      return records.map((r) =>
        r.id === input.id
          ? {
              ...r,
              label: checked.label,
              pixel: checked.pixel,
              color: checked.color,
              side: checked.side,
              reviewed: input.reviewed === undefined ? r.reviewed : input.reviewed === true,
            }
          : r,
      );
    }),
  );
});
export const DELETE = route(async (request, { params }) => {
  sameOrigin(request);
  const { owner } = await requireUser(request),
    { id } = await params,
    input = await readBody(request);
  return json(
    await mutateAnnotations(owner, id, (records) => {
      assert(
        records.some((r) => r.id === input.id),
        'Annotation not found.',
        404,
      );
      return records.filter((r) => r.id !== input.id);
    }),
  );
});
export const PUT = route(async (request, { params }) => {
  sameOrigin(request);
  const { owner } = await requireUser(request),
    { id } = await params,
    bundle = await readBody(request, 20_000_000);
  return json(
    await mutateAnnotations(owner, id, (records, study) => {
      const additions = importAnnotations(study, bundle);
      const key = (r) => JSON.stringify([r.seriesId, r.frameId, r.label, r.pixel]);
      const seen = new Set(records.map(key));
      return [
        ...records,
        ...additions.filter((r) => {
          const k = key(r);
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        }),
      ];
    }),
  );
});
