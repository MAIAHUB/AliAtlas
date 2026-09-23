import path from 'node:path';
import { assert } from './errors.js';
import { studyDir, readJson, writeJson, withLock, loadStudy } from './storage.js';
import { readFindings } from './findings.js';
import { categoryName, formatSize, formatVolume } from './measure.js';
import { classifyPhase, phaseInfo, isEnhanced, approximateSizes } from './contrast.js';
import { formatHu, densityHint, HETEROGENEOUS_SD, MIN_ROI_PIXELS } from './roi.js';

export const reportFile = (owner, id) => path.join(studyDir(owner, id), 'report.json');
const FIELDS = [
  'clinicalHistory',
  'technique',
  'findingsText',
  'impression',
  'limitations',
  'recommendation',
];
export const REPORT_TYPES = [
  { id: 'screening', name: 'Screening report' },
  { id: 'diagnostic', name: 'Diagnostic report' },
];

// Diagnostic reporting needs at least one contrast-enhanced series; plain CT supports
// screening and teaching (lesion margins and enhancement cannot be assessed).
export const canDiagnose = (study) => study.series.some(isEnhanced);

export function defaultLimitations(study) {
  if (canDiagnose(study)) return '';
  const phases = new Set(study.series.map((s) => classifyPhase(s).phase));
  return phases.has('non-contrast')
    ? 'Non-contrast CT. Lesion margins, enhancement pattern and internal characteristics cannot be assessed; measurements are approximate.'
    : 'Contrast phase not recorded in the images. Assessed as a non-contrast study; lesion characterization is limited and measurements are approximate.';
}

export const defaultRecommendation = (study, findings) =>
  !canDiagnose(study) && findings.some((f) => f.status === 'confirmed')
    ? 'Further evaluation with contrast-enhanced CT or MRI is recommended for characterization of the reported findings.'
    : '';

export async function readReport(owner, id) {
  return readJson(reportFile(owner, id)).catch((e) => {
    if (e.code === 'ENOENT')
      return {
        revision: 0,
        status: 'draft',
        clinicalHistory: '',
        technique: '',
        findingsText: '',
        impression: '',
      };
    throw e;
  });
}

// Fills defaults for anything not yet written (older reports have no type or limitations).
export function withDefaults(report, study, findings) {
  return {
    ...report,
    reportType: report.reportType || (canDiagnose(study) ? 'diagnostic' : 'screening'),
    technique: report.technique || defaultTechnique(study),
    limitations: report.limitations ?? defaultLimitations(study),
    recommendation: report.recommendation ?? defaultRecommendation(study, findings),
    canDiagnose: canDiagnose(study),
  };
}

export function sliceOf(study, finding) {
  const series = study.series.find((s) => s.id === finding.seriesId);
  const index = series?.frames.findIndex((f) => f.id === finding.frameId) ?? -1;
  return { series, index, total: series?.frames.length || 0 };
}

export function defaultTechnique(study) {
  const series = study.series[0];
  if (!series) return '';
  const frame = series.frames[0] || {};
  const phase = phaseInfo(classifyPhase(series).phase);
  const spacing = frame.spacing
    ? ` In-plane pixel spacing ${frame.spacing.map((v) => Number(v).toFixed(2)).join(' × ')} mm.`
    : '';
  const thickness = frame.sliceThickness ? ` Slice thickness ${frame.sliceThickness} mm.` : '';
  const contrast = phase.id === 'unknown' ? 'CT (contrast phase not recorded)' : `${phase.name} CT`;
  return `${contrast}, ${series.bodyPart || ''} ${series.plane || 'axial'} series "${series.description || 'CT'}", ${series.frames.length} images.${spacing}${thickness}`.replace(
    /\s+/g,
    ' ',
  );
}

// One line per confirmed finding, in slice order, with approximate sizes on plain CT.
export function describeFinding(study, finding) {
  const { series } = sliceOf(study, finding);
  const approx = series ? approximateSizes(series) : true;
  const parts = [];
  if (finding.longMm != null) {
    let axes = 'long axis';
    if (finding.ccMm != null) axes = 'L × W × CC';
    else if (finding.shortMm != null) axes = 'long × short axis';
    parts.push(`${formatSize(finding, { approx })} (${axes})`);
  }
  const volume = formatVolume(finding, { approx });
  if (volume) parts.push(`volume ${volume}`);
  if (finding.roi?.stats) parts.push(describeDensity(finding.roi.stats, series));
  return parts.join('; ');
}

// Report wording for a density region. The on-screen hint includes instructions for the
// reader; the report states only what was measured.
function describeDensity(stats, series) {
  const density = `mean density ${formatHu(stats)}`;
  if (stats.count < MIN_ROI_PIXELS) return density;
  if (stats.sd > HETEROGENEOUS_SD) return `${density} (heterogeneous)`;
  const hint = densityHint(stats.mean, series ? !approximateSizes(series) : false, stats);
  return hint ? `${density} (${hint.charAt(0).toLowerCase()}${hint.slice(1)})` : density;
}

export function composeFindings(study, findings) {
  const confirmed = findings
    .filter((f) => f.status === 'confirmed')
    .map((f) => ({ f, ...sliceOf(study, f) }))
    .sort((a, b) => a.index - b.index);
  if (!confirmed.length) return 'No measured abnormality recorded.';
  return confirmed
    .map(
      ({ f, series, index, total }, i) =>
        `${i + 1}. ${f.label} (${categoryName(f.category).toLowerCase()}), series "${series?.description || 'CT'}", image ${index + 1}/${total}: ${describeFinding(study, f)}.${f.note ? ` ${f.note}` : ''}`,
    )
    .join('\n');
}

export async function updateReport(owner, id, input, user) {
  return withLock(studyDir(owner, id), async () => {
    const study = await loadStudy(owner, id),
      current = await readReport(owner, id),
      { records } = await readFindings(owner, id);
    const next = { ...current };
    assert(
      current.status !== 'final' || input.status === 'draft',
      'This report is final. Reopen it before editing.',
      409,
    );
    for (const field of FIELDS)
      if (input[field] !== undefined) {
        assert(typeof input[field] === 'string', 'Invalid report text.');
        assert(input[field].length <= 20000, 'A report section is limited to 20,000 characters.');
        next[field] = input[field];
      }
    if (input.reportType !== undefined) {
      assert(
        REPORT_TYPES.some((t) => t.id === input.reportType),
        'Choose a report type.',
      );
      assert(
        input.reportType !== 'diagnostic' || canDiagnose(study),
        'A diagnostic report needs a contrast-enhanced series. This study supports screening reports.',
        409,
        'NEEDS_CONTRAST',
      );
      next.reportType = input.reportType;
    }
    if (input.status === 'final') {
      const pending = records.filter((f) => f.status === 'unreviewed').length;
      assert(
        !pending,
        `Review ${pending} AI suggestion${pending === 1 ? '' : 's'} before finalizing.`,
        409,
        'UNREVIEWED_FINDINGS',
      );
      assert(next.impression?.trim(), 'Write an impression before finalizing.', 409);
      next.status = 'final';
      next.finalizedBy = { name: user.name, email: user.email };
      next.finalizedAt = new Date().toISOString();
    } else if (input.status === 'draft') {
      next.status = 'draft';
      next.finalizedBy = null;
      next.finalizedAt = null;
    }
    const filled = withDefaults(next, study, records);
    delete filled.canDiagnose;
    // A diagnostic type saved earlier stays invalid if the contrast series was re-labelled.
    assert(
      filled.reportType !== 'diagnostic' || canDiagnose(study),
      'A diagnostic report needs a contrast-enhanced series.',
      409,
      'NEEDS_CONTRAST',
    );
    filled.revision = current.revision + 1;
    filled.updatedAt = new Date().toISOString();
    filled.updatedBy = { name: user.name, email: user.email };
    await writeJson(reportFile(owner, id), filled);
    return { ...filled, canDiagnose: canDiagnose(study) };
  });
}
