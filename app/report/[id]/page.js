import { promises as fs } from 'node:fs';
import path from 'node:path';
import { cookies } from 'next/headers';
import { redirect, notFound } from 'next/navigation';
import { SESSION_COOKIE, userFromToken } from '../../../lib/auth.js';
import { loadStudy, studyDir } from '../../../lib/storage.js';
import { readFindings } from '../../../lib/findings.js';
import { readReport, withDefaults, sliceOf } from '../../../lib/report.js';
import { categoryName, formatSize, formatVolume } from '../../../lib/measure.js';
import { approximateSizes, classifyPhase, phaseInfo } from '../../../lib/contrast.js';
import { formatHu } from '../../../lib/roi.js';
import PrintButton from '../../../components/PrintButton.js';

export const metadata = { title: 'CT report · AliAtlas' };

// Print-friendly report. The browser's "Save as PDF" produces the PDF.
export default async function ReportPage({ params }) {
  const user = await userFromToken((await cookies()).get(SESSION_COOKIE)?.value);
  if (!user) redirect('/login');
  const { id } = await params;
  let study;
  try {
    study = await loadStudy(user.owner, id);
  } catch {
    notFound();
  }
  const { records } = await readFindings(user.owner, id);
  const report = withDefaults(await readReport(user.owner, id), study, records);
  const images = new Set(
    (await fs.readdir(path.join(studyDir(user.owner, id), 'finding-images')).catch(() => [])).map(
      (f) => f.replace(/\.png$/, ''),
    ),
  );
  const confirmed = records
    .filter((f) => f.status === 'confirmed')
    .map((f) => {
      const slice = sliceOf(study, f);
      return { f, ...slice, approx: slice.series ? approximateSizes(slice.series) : true };
    })
    .sort((a, b) => a.index - b.index);
  const pending = records.filter((f) => f.status === 'unreviewed').length;
  const final = report.status === 'final';
  const diagnostic = report.reportType === 'diagnostic';
  const phases = [...new Set(study.series.map((s) => phaseInfo(classifyPhase(s).phase).name))];
  const sections = [
    ['Clinical history', report.clinicalHistory],
    ['Technique', report.technique],
    ['Findings', report.findingsText],
    ['Impression', report.impression],
    ['Limitations', report.limitations],
    ['Recommendation', report.recommendation],
  ].filter(([title, text]) => text?.trim() || !['Limitations', 'Recommendation'].includes(title));
  return (
    <main className="print-report">
      <div className="print-toolbar">
        <PrintButton />
      </div>
      <article className="print-sheet">
        {!final && <div className="print-watermark">DRAFT</div>}
        <header>
          <div>
            <h1>{diagnostic ? 'CT Diagnostic Report' : 'CT Screening Report'}</h1>
            <p>{study.title}</p>
          </div>
          <dl>
            <dt>Status</dt>
            <dd>{final ? 'Final' : 'Draft – not for clinical use'}</dd>
            <dt>Contrast</dt>
            <dd>{phases.join(', ')}</dd>
            <dt>Study imported</dt>
            <dd>{new Date(study.createdAt).toLocaleDateString()}</dd>
            <dt>Printed</dt>
            <dd>{new Date().toLocaleString()}</dd>
          </dl>
        </header>
        {sections.map(([title, text]) => (
          <section key={title}>
            <h2>{title}</h2>
            <p>{text?.trim() || '—'}</p>
          </section>
        ))}
        <section>
          <h2>Measured lesions</h2>
          {confirmed.length ? (
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Finding</th>
                  <th>Series / image</th>
                  <th>Size</th>
                  <th>Density</th>
                </tr>
              </thead>
              <tbody>
                {confirmed.map(({ f, series, index, total, approx }, i) => (
                  <tr key={f.id}>
                    <td>{i + 1}</td>
                    <td>
                      {f.label}
                      <small>
                        {categoryName(f.category)}
                        {f.source === 'ai' ? ' · auto-detected, confirmed by reader' : ''}
                      </small>
                    </td>
                    <td>
                      {series?.description || 'CT'} · {index + 1}/{total}
                    </td>
                    <td>
                      {formatSize(f, { approx })}
                      {formatVolume(f, { approx }) && (
                        <small>volume {formatVolume(f, { approx })}</small>
                      )}
                    </td>
                    <td>{f.roi?.stats ? formatHu(f.roi.stats) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p>No measured lesions.</p>
          )}
        </section>
        {confirmed.some(({ f }) => images.has(f.id)) && (
          <section className="print-images">
            <h2>Key images</h2>
            <div>
              {confirmed
                .filter(({ f }) => images.has(f.id))
                .map(({ f, index, approx }, i) => (
                  <figure key={f.id}>
                    <img src={`/api/studies/${id}/findings/${f.id}/image`} alt={f.label} />
                    <figcaption>
                      {i + 1}. {f.label} · image {index + 1} ·{' '}
                      {f.longMm != null ? formatSize(f, { approx }) : formatHu(f.roi?.stats)}
                    </figcaption>
                  </figure>
                ))}
            </div>
          </section>
        )}
        {pending > 0 && (
          <p className="print-warning">
            {pending} automated suggestion(s) have not been reviewed and are not included.
          </p>
        )}
        <footer>
          <p>
            {final
              ? `Finalized by ${report.finalizedBy?.name || '—'} (${report.finalizedBy?.email || ''}) on ${new Date(report.finalizedAt).toLocaleString()}.`
              : 'Not finalized.'}
          </p>
          <p>
            Generated with AliAtlas, an educational workspace.{' '}
            {diagnostic
              ? 'Measurements are made on the displayed images.'
              : 'Screening report on non-contrast or unconfirmed-phase CT: sizes marked ≈ are approximate and this report is not sufficient for diagnosis.'}{' '}
            Automated suggestions and drafts are not a diagnosis and were reviewed by the reader
            named above.
          </p>
        </footer>
      </article>
    </main>
  );
}
