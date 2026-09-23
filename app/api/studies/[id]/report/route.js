import { sameOrigin, json, route, readBody } from '../../../../../lib/http.js';
import { requireUser } from '../../../../../lib/auth.js';
import { audit } from '../../../../../lib/db.js';
import { loadStudy } from '../../../../../lib/storage.js';
import { readFindings } from '../../../../../lib/findings.js';
import {
  readReport,
  updateReport,
  composeFindings,
  withDefaults,
} from '../../../../../lib/report.js';
export const runtime = 'nodejs';
export const GET = route(async (request, { params }) => {
  const { owner } = await requireUser(request),
    { id } = await params;
  const study = await loadStudy(owner, id),
    report = await readReport(owner, id),
    { records } = await readFindings(owner, id);
  return json({
    ...withDefaults(report, study, records),
    suggestedFindings: composeFindings(study, records),
  });
});
export const PUT = route(async (request, { params }) => {
  sameOrigin(request);
  const { user, owner } = await requireUser(request),
    { id } = await params;
  const report = await updateReport(owner, id, await readBody(request, 200_000), user);
  if (report.status === 'final') await audit(user.id, 'report.finalize', { studyId: id });
  return json(report);
});
