import { session, sameOrigin, json, route } from '../../../../lib/http.js';
import { importStudy } from '../../../../lib/import.js';
import { autoLabelImportedStudies } from '../../../../lib/jobs.js';
export const runtime = 'nodejs';
export const maxDuration = 300;
export const POST = route(async (request) => {
  sameOrigin(request);
  const { owner } = session(request);
  const result = await importStudy(request, owner);
  return json(
    { ...result, autoLabels: await autoLabelImportedStudies(owner, result.studies) },
    201,
  );
});
