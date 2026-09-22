import { session, json, route } from '../../../lib/http.js';
import { listStudies } from '../../../lib/storage.js';
import { workerStatus } from '../../../lib/jobs.js';
export const runtime = 'nodejs';
export const GET = route(async (request) => {
  const { owner, setCookie } = session(request, true);
  return json(
    { studies: await listStudies(owner), ai: await workerStatus() },
    200,
    setCookie ? { 'Set-Cookie': setCookie } : {},
  );
});
