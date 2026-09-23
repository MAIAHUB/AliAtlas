import { promises as fs } from 'node:fs';
import path from 'node:path';
import { sameOrigin, json, route, readBody } from '../../../../lib/http.js';
import { requireUser } from '../../../../lib/auth.js';
import { audit } from '../../../../lib/db.js';
import {
  loadStudy,
  publicStudy,
  studyDir,
  withLock,
  jobPath,
  dataRoot,
  getSeries,
  writeJson,
} from '../../../../lib/storage.js';
import { PHASES } from '../../../../lib/contrast.js';
import { listJobs } from '../../../../lib/jobs.js';
import { assert } from '../../../../lib/errors.js';
export const runtime = 'nodejs';
export const GET = route(async (request, { params }) => {
  const { owner } = await requireUser(request),
    { id } = await params;
  return json(publicStudy(await loadStudy(owner, id)));
});
// Correct a series' contrast phase when DICOM tags are missing or wrong ("auto" clears it).
export const PATCH = route(async (request, { params }) => {
  sameOrigin(request);
  const { user, owner } = await requireUser(request),
    { id } = await params,
    input = await readBody(request);
  assert(
    input.phase === 'auto' || PHASES.some((p) => p.id === input.phase && p.id !== 'unknown'),
    'Choose a contrast phase.',
  );
  const study = await withLock(studyDir(owner, id), async () => {
    const current = await loadStudy(owner, id),
      series = getSeries(current, input.seriesId);
    if (input.phase === 'auto') delete series.phaseOverride;
    else series.phaseOverride = input.phase;
    await writeJson(path.join(studyDir(owner, id), 'study.json'), current);
    return current;
  });
  await audit(user.id, 'series.phase', { studyId: id, phase: input.phase });
  return json(publicStudy(study));
});
export const DELETE = route(async (request, { params }) => {
  sameOrigin(request);
  const { user, owner } = await requireUser(request),
    { id } = await params;
  await loadStudy(owner, id);
  await withLock(studyDir(owner, id), async () => {
    const jobs = await listJobs(owner, id);
    assert(
      !jobs.some((j) => ['queued', 'running'].includes(j.status)),
      'Wait for anatomy processing to finish before removing this study.',
      409,
    );
    for (const job of jobs) {
      await fs.rm(jobPath(job.id), { force: true });
      await fs.rm(path.join(dataRoot(), 'jobs', job.id), { recursive: true, force: true });
    }
    await fs.rm(studyDir(owner, id), { recursive: true, force: true });
  });
  // The Orthanc copy is kept as the archive; the study can be reopened from there.
  await audit(user.id, 'study.delete', { studyId: id });
  return json({ deleted: true });
});
