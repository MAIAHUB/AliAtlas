import { sameOrigin, json, route, readBody } from '../../../../../lib/http.js';
import { requireUser } from '../../../../../lib/auth.js';
import { audit } from '../../../../../lib/db.js';
import { assert } from '../../../../../lib/errors.js';
import { importFiles } from '../../../../../lib/import.js';
import { autoLabelImportedStudies } from '../../../../../lib/jobs.js';
import { downloadOwnedInstances, orthancEnabled } from '../../../../../lib/orthanc.js';
export const runtime = 'nodejs';
export const maxDuration = 300;
export const POST = route(async (request) => {
  sameOrigin(request);
  const { user, owner } = await requireUser(request);
  assert(orthancEnabled(), 'The Orthanc archive is not configured on this server.', 503);
  const { orthancStudyId } = await readBody(request);
  const result = await importFiles(owner, (temp) =>
    downloadOwnedInstances(user.id, orthancStudyId, temp),
  );
  await audit(user.id, 'study.open_from_archive', {
    orthancStudyId,
    studies: result.studies.map((s) => s.id),
  });
  return json(
    { ...result, autoLabels: await autoLabelImportedStudies(owner, result.studies) },
    201,
  );
});
