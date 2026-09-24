import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { makeDicom } from './fixtures.mjs';
import { importStudy } from '../lib/import.js';
import { loadStudy } from '../lib/storage.js';
import { validateFinding } from '../lib/findings.js';
import {
  generateReportDraft,
  templateImpression,
  withDefaults,
  keepsMeasurements,
} from '../lib/report.js';
import { buildReportPdf, pdfText } from '../lib/report-pdf.js';
import { encodeGrayPng } from '../lib/png.js';

const owner = '9'.repeat(64);

async function withFinding(run) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'aliatlas-pdf-'));
  const previous = process.env.ATLAS_DATA_DIR;
  process.env.ATLAS_DATA_DIR = directory;
  try {
    const form = new FormData();
    for (let index = 0; index < 3; index++)
      form.append(
        'files',
        new Blob([makeDicom({ index, rows: 32, columns: 32, spacing: [1, 1] })]),
        `s${index}.dcm`,
      );
    const imported = await importStudy(
      new Request('http://x/import', { method: 'POST', body: form }),
      owner,
    );
    const study = await loadStudy(owner, imported.studies[0].id);
    const series = study.series[0];
    const finding = validateFinding(study, {
      seriesId: series.id,
      frameId: series.frames[1].id,
      label: 'Left lung nodule',
      category: 'nodule',
      long: [
        [4, 4],
        [24, 4],
      ],
      short: [
        [14, 0],
        [14, 12],
      ],
    });
    await run(study, finding);
  } finally {
    process.env.ATLAS_DATA_DIR = previous;
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test('spells out symbols the PDF standard fonts cannot draw', () => {
  assert.equal(
    pdfText('≈ 20.0 × 12.0 mm, π/6, 12 ± 3 HU'),
    'approx. 20.0 × 12.0 mm, pi/6, 12 ± 3 HU',
  );
  assert.equal(pdfText('雪'), '?');
});

test('drafting fills findings, impression, limitations and recommendation; measurements are protected', async () => {
  await withFinding(async (study, finding) => {
    const empty = { status: 'draft', revision: 0 };
    let sent;
    const good = {
      findingsText:
        'A non-calcified nodule on image 2 measures ≈ 20.0 × 12.0 mm. No other measured abnormality was recorded.',
      impression: '1. Left lung nodule, indeterminate.',
      limitations: 'Single series; sizes are approximate on this non-contrast study.',
      recommendation: 'Follow-up CT per Fleischner Society guidelines, depending on risk factors.',
      model: 'gpt-5.5',
    };
    const ai = await generateReportDraft(study, [finding], empty, async (input) => {
      sent = input;
      return good;
    });
    assert.deepEqual(Object.keys(sent).sort(), ['findingsText', 'reportType', 'technique']);
    assert.equal(ai.reportType, 'screening');
    assert.equal(ai.clinicalHistory, 'Not provided.');
    assert.equal(ai.findingsText, good.findingsText);
    assert.equal(ai.impression, good.impression);
    assert.equal(ai.limitations, good.limitations);
    assert.match(ai.recommendation, /Fleischner/);
    assert.equal(ai.impressionSource, 'gpt-5.5');
    assert.equal(ai.note, null);
    // Changed measurement: the measured findings text is kept instead.
    const altered = await generateReportDraft(study, [finding], empty, async () => ({
      ...good,
      findingsText: 'A nodule measures 21 × 12 mm.',
    }));
    assert.match(altered.findingsText, /Left lung nodule \(nodule\).*≈ 20\.0 × 12\.0 mm/);
    assert.match(altered.note, /did not keep every measurement/);
    // A screening report always states that sizes are approximate.
    const vague = await generateReportDraft(study, [finding], empty, async () => ({
      ...good,
      limitations: 'Single series only.',
    }));
    assert.match(vague.limitations, /measurements are approximate.*Single series only\./);
    // Existing clinical history is kept.
    const history = await generateReportDraft(
      study,
      [finding],
      { ...empty, clinicalHistory: 'Smoker, cough.' },
      async () => good,
    );
    assert.equal(history.clinicalHistory, 'Smoker, cough.');
    // Failure falls back to templates.
    const failed = await generateReportDraft(study, [finding], empty, async () => {
      throw new Error('timeout');
    });
    assert.equal(failed.impressionSource, 'template');
    assert.match(failed.note, /timeout/);
    assert.equal(failed.impression, templateImpression(study, [finding], 'screening'));
    assert.match(failed.impression, /\n2\. Screening study/);
    let called = false;
    const none = await generateReportDraft(study, [], empty, async () => {
      called = true;
    });
    assert.equal(called, false, 'no drafting call without findings');
    assert.match(none.impression, /No measured abnormality/);
  });
});

test('checks that drafted text keeps every measurement exactly', () => {
  const f = { status: 'confirmed', longMm: 28.3, shortMm: 20, ccMm: 2.5 };
  assert.equal(keepsMeasurements('measures 28.3 × 20.0 × 2.5 mm', [f]), true);
  assert.equal(keepsMeasurements('measures 28.3 × 20 × 2.5 mm', [f]), false);
  assert.equal(keepsMeasurements('measures 128.3 × 20.0 × 2.5 mm', [f]), false);
  assert.equal(keepsMeasurements('measures 28.35 × 20.0 × 2.5 mm', [f]), false);
  assert.equal(keepsMeasurements('anything', [{ ...f, status: 'rejected' }]), true);
});

test('builds a valid A4 PDF with key images', async () => {
  await withFinding(async (study, finding) => {
    const report = withDefaults(
      { status: 'draft', impression: '1. Nodule.', findingsText: 'Nodule ≈ 20 mm.' },
      study,
      [finding],
    );
    const pages = (pdf) => (pdf.toString('latin1').match(/\/Type \/Page\b/g) || []).length;
    // Text only fits on one page: the footer inside the bottom margin must not add another.
    const textOnly = await buildReportPdf({
      study,
      report,
      findings: [finding],
      images: new Map(),
    });
    assert.equal(textOnly.toString('latin1').slice(0, 5), '%PDF-');
    assert.equal(pages(textOnly), 1, 'no stray pages from the footer');
    // The key image does not fit under the table, so it moves to a second page.
    const image = encodeGrayPng(4, 4, new Uint8Array(16).fill(128));
    const pdf = await buildReportPdf({
      study,
      report,
      findings: [finding],
      images: new Map([[finding.id, image]]),
    });
    assert.equal(pages(pdf), 2);
    assert.match(pdf.toString('latin1'), /\/Subtype \/Image/);
  });
});
