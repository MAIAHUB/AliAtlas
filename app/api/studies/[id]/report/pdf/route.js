import { promises as fs } from 'node:fs';
import path from 'node:path';
import { route } from '../../../../../../lib/http.js';
import { requireUser } from '../../../../../../lib/auth.js';
import { audit } from '../../../../../../lib/db.js';
import { loadStudy, studyDir } from '../../../../../../lib/storage.js';
import { readFindings } from '../../../../../../lib/findings.js';
import { readReport, withDefaults } from '../../../../../../lib/report.js';
import { buildReportPdf } from '../../../../../../lib/report-pdf.js';
export const runtime = 'nodejs';

// Downloads the saved report as an A4 PDF with its key images.
export const GET = route(async (request, { params }) => {
  const { user, owner } = await requireUser(request),
    { id } = await params;
  const study = await loadStudy(owner, id),
    { records } = await readFindings(owner, id);
  const report = withDefaults(await readReport(owner, id), study, records);
  const folder = path.join(studyDir(owner, id), 'finding-images');
  const images = new Map();
  for (const name of await fs.readdir(folder).catch(() => []))
    if (/^[a-f0-9-]{36}\.png$/.test(name))
      images.set(name.slice(0, -4), await fs.readFile(path.join(folder, name)));
  const pdf = await buildReportPdf({ study, report, findings: records, images });
  await audit(user.id, 'report.pdf', { studyId: id, status: report.status });
  const date = new Date().toISOString().slice(0, 10);
  const kind = report.reportType === 'diagnostic' ? 'diagnostic' : 'screening';
  return new Response(pdf, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="AliAtlas-CT-${kind}-report-${date}.pdf"`,
      'Cache-Control': 'private, no-store',
    },
  });
});
