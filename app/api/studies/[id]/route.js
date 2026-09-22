import { promises as fs } from 'node:fs';
import path from 'node:path';
import { session, sameOrigin, json, route } from '../../../../lib/http.js';
import {
  loadStudy,
  publicStudy,
  studyDir,
  withLock,
  jobPath,
  dataRoot,
} from '../../../../lib/storage.js';
import { listJobs } from '../../../../lib/jobs.js';
import { assert } from '../../../../lib/errors.js';
export const runtime = 'nodejs';
export const GET = route(async (request, { params }) => {
  const { owner } = session(request),
    { id } = await params;
  return json(publicStudy(await loadStudy(owner, id)));
});
export const DELETE = route(async (request, { params }) => {
  sameOrigin(request);
  const { owner } = session(request),
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
  return json({ deleted: true });
});
