import { sameOrigin, json, route, readBody } from '../../../../../lib/http.js';
import { requireUser } from '../../../../../lib/auth.js';
import { loadStudy } from '../../../../../lib/storage.js';
import { assert } from '../../../../../lib/errors.js';
import {
  readFindings,
  mutateFindings,
  validateFinding,
  updateFinding,
  removeFindingImage,
  roiStatsFor,
} from '../../../../../lib/findings.js';
export const runtime = 'nodejs';
export const GET = route(async (request, { params }) => {
  const { owner } = await requireUser(request),
    { id } = await params;
  await loadStudy(owner, id);
  return json(await readFindings(owner, id));
});
export const POST = route(async (request, { params }) => {
  sameOrigin(request);
  const { owner } = await requireUser(request),
    { id } = await params,
    input = await readBody(request);
  let created;
  const result = await mutateFindings(owner, id, async (records, study) => {
    const roiStats = input?.roi
      ? await roiStatsFor(owner, id, study, input.seriesId, input.frameId, input.roi)
      : null;
    created = validateFinding(study, input, { roiStats });
    return [...records, created];
  });
  return json({ ...result, created }, 201);
});
export const PATCH = route(async (request, { params }) => {
  sameOrigin(request);
  const { user, owner } = await requireUser(request),
    { id } = await params,
    input = await readBody(request);
  return json(
    await mutateFindings(owner, id, async (records, study) => {
      const existing = records.find((r) => r.id === input.id);
      assert(existing, 'Finding not found.', 404);
      const roiStats = input.roi
        ? await roiStatsFor(owner, id, study, existing.seriesId, existing.frameId, input.roi)
        : null;
      const next = updateFinding(
        study,
        existing,
        input,
        { name: user.name, email: user.email },
        { roiStats },
      );
      return records.map((r) => (r.id === input.id ? next : r));
    }),
  );
});
export const DELETE = route(async (request, { params }) => {
  sameOrigin(request);
  const { owner } = await requireUser(request),
    { id } = await params,
    input = await readBody(request);
  const result = await mutateFindings(owner, id, (records) => {
    assert(
      records.some((r) => r.id === input.id),
      'Finding not found.',
      404,
    );
    return records.filter((r) => r.id !== input.id);
  });
  await removeFindingImage(owner, id, input.id);
  return json(result);
});
