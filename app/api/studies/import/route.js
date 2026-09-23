import { sameOrigin, json, route } from '../../../../lib/http.js';
import { requireUser } from '../../../../lib/auth.js';
import { audit } from '../../../../lib/db.js';
import { importStudy } from '../../../../lib/import.js';
import { autoLabelImportedStudies } from '../../../../lib/jobs.js';
import { archiveStudies, orthancEnabled } from '../../../../lib/orthanc.js';
export const runtime = 'nodejs';
export const maxDuration = 300;
export const POST = route(async (request) => {
  sameOrigin(request);
  const { user, owner } = await requireUser(request);
  const result = await importStudy(request, owner, {
    beforeCommit: orthancEnabled() ? (studies) => archiveStudies(user.id, studies) : undefined,
  });
  await audit(user.id, 'study.upload', {
    studies: result.studies.map((s) => s.id),
    frames: result.importedFrames,
    archived: Boolean(result.archive),
  });
  return json(
    { ...result, autoLabels: await autoLabelImportedStudies(owner, result.studies) },
    201,
  );
});
