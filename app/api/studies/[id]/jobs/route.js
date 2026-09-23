import { sameOrigin, json, route, readBody } from '../../../../../lib/http.js';
import { requireUser } from '../../../../../lib/auth.js';
import { loadStudy } from '../../../../../lib/storage.js';
import { listJobs, enqueueJob, publicJob } from '../../../../../lib/jobs.js';
export const runtime = 'nodejs';
export const GET = route(async (request, { params }) => {
  const { owner } = await requireUser(request),
    { id } = await params;
  await loadStudy(owner, id);
  return json({ jobs: (await listJobs(owner, id)).map(publicJob) });
});
export const POST = route(async (request, { params }) => {
  sameOrigin(request);
  const { owner } = await requireUser(request),
    { id } = await params,
    input = await readBody(request);
  return json(await enqueueJob(owner, id, input.seriesId, input.region), 202);
});
