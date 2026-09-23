import { json, route } from '../../../lib/http.js';
import { requireUser } from '../../../lib/auth.js';
import { listStudies } from '../../../lib/storage.js';
import { workerStatus } from '../../../lib/jobs.js';
import { orthancStatus } from '../../../lib/orthanc.js';
import { visionStatus } from '../../../lib/vision.js';
export const runtime = 'nodejs';
export const GET = route(async (request) => {
  const { user, owner } = await requireUser(request);
  const [studies, ai, archive] = await Promise.all([
    listStudies(owner),
    workerStatus(),
    orthancStatus(),
  ]);
  return json({
    user: { email: user.email, name: user.name },
    studies,
    ai,
    archive,
    vision: visionStatus(),
  });
});
