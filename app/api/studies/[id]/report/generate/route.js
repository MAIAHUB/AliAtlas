import { sameOrigin, json, route } from '../../../../../../lib/http.js';
import { requireUser } from '../../../../../../lib/auth.js';
import { audit } from '../../../../../../lib/db.js';
import { assert } from '../../../../../../lib/errors.js';
import { loadStudy } from '../../../../../../lib/storage.js';
import { readFindings } from '../../../../../../lib/findings.js';
import { readReport, generateReportDraft } from '../../../../../../lib/report.js';
import { draftReport, visionStatus } from '../../../../../../lib/vision.js';
export const runtime = 'nodejs';
export const maxDuration = 120;

// Builds a draft of every report section. Nothing is saved until the reader saves it.
export const POST = route(async (request, { params }) => {
  sameOrigin(request);
  const { user, owner } = await requireUser(request),
    { id } = await params;
  const study = await loadStudy(owner, id),
    report = await readReport(owner, id),
    { records } = await readFindings(owner, id);
  assert(report.status !== 'final', 'This report is final. Reopen it before regenerating.', 409);
  const draft = await generateReportDraft(
    study,
    records,
    report,
    visionStatus().configured ? draftReport : null,
  );
  await audit(user.id, 'report.generate', { studyId: id, impression: draft.impressionSource });
  return json(draft);
});
