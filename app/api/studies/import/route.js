import { session, sameOrigin, json, route } from '../../../../lib/http.js';
import { importStudy } from '../../../../lib/import.js';
export const runtime = 'nodejs';
export const maxDuration = 300;
export const POST = route(async (request) => {
  sameOrigin(request);
  const { owner } = session(request);
  return json(await importStudy(request, owner), 201);
});
