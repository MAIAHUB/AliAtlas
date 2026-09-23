import { json, route } from '../../../../lib/http.js';
import { requireUser } from '../../../../lib/auth.js';
import { assert } from '../../../../lib/errors.js';
import { listArchivedStudies, orthancEnabled } from '../../../../lib/orthanc.js';
export const runtime = 'nodejs';
export const GET = route(async (request) => {
  const { user } = await requireUser(request);
  assert(orthancEnabled(), 'The Orthanc archive is not configured on this server.', 503);
  return json({ studies: await listArchivedStudies(user.id) });
});
