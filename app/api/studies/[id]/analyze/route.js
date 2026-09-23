import { sameOrigin, json, route, readBody } from '../../../../../lib/http.js';
import { requireUser } from '../../../../../lib/auth.js';
import { audit } from '../../../../../lib/db.js';
import { detectAbnormalities } from '../../../../../lib/vision.js';
import { mutateFindings, validateFinding } from '../../../../../lib/findings.js';
export const runtime = 'nodejs';
export const maxDuration = 300;
// Asks b.ai for abnormality suggestions on the selected slices. Earlier unreviewed
// AI suggestions on those slices are replaced; reviewed ones are kept.
export const POST = route(async (request, { params }) => {
  sameOrigin(request);
  const { user, owner } = await requireUser(request),
    { id } = await params,
    input = await readBody(request);
  const started = Date.now();
  const result = await detectAbnormalities(owner, id, input);
  const analyzed = new Set(input.frameIds);
  let created = [];
  const findings = await mutateFindings(owner, id, (records, study) => {
    created = result.inputs.map((finding) => ({
      ...validateFinding(study, finding, { source: 'ai' }),
      model: result.model,
    }));
    return [
      ...records.filter(
        (r) => !(r.source === 'ai' && r.status === 'unreviewed' && analyzed.has(r.frameId)),
      ),
      ...created,
    ];
  });
  await audit(user.id, 'ai.detect', {
    studyId: id,
    slices: input.frameIds.length,
    suggestions: created.length,
  });
  return json({
    ...findings,
    created: created.map((f) => f.id),
    summary: result.summary,
    dropped: result.dropped,
    seconds: Math.round((Date.now() - started) / 100) / 10,
  });
});
