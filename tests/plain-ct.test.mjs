import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { makeDicom } from './fixtures.mjs';
import { importStudy } from '../lib/import.js';
import { loadStudy, writeJson, studyDir } from '../lib/storage.js';
import { classifyPhase, approximateSizes } from '../lib/contrast.js';
import { roiStats, densityHint, formatHu } from '../lib/roi.js';
import { craniocaudalExtent, ellipsoidVolumeMl, formatSize } from '../lib/measure.js';
import { validateFinding, updateFinding, roiStatsFor, mutateFindings } from '../lib/findings.js';
import { updateReport, readReport, withDefaults, composeFindings } from '../lib/report.js';

const owner = 'e'.repeat(64);
const user = { name: 'Reader', email: 'reader@example.test' };

test('classifies the contrast phase from DICOM tags, descriptions, or a correction', () => {
  assert.equal(classifyPhase({ description: 'Abdomen NC 5mm' }).phase, 'non-contrast');
  assert.equal(classifyPhase({ description: 'CT KUB plain' }).phase, 'non-contrast');
  assert.equal(classifyPhase({ description: 'Brain w/o' }).phase, 'non-contrast');
  assert.equal(classifyPhase({ description: 'Liver arterial phase' }).phase, 'arterial');
  assert.equal(classifyPhase({ description: 'PV 70s' }).phase, 'portal-venous');
  assert.equal(classifyPhase({ description: 'Delayed 10 min' }).phase, 'delayed');
  assert.equal(classifyPhase({ description: 'Chest with contrast' }).phase, 'contrast');
  assert.equal(classifyPhase({ description: 'Chest without contrast' }).phase, 'non-contrast');
  const tagged = classifyPhase({ description: 'Axial 1.25', contrastAgent: 'Omnipaque 350' });
  assert.deepEqual(tagged, { phase: 'contrast', source: 'dicom' });
  assert.equal(classifyPhase({ description: 'Axial', contrastAgent: 'NONE' }).phase, 'unknown');
  assert.deepEqual(classifyPhase({ description: 'Axial 5mm' }), {
    phase: 'unknown',
    source: 'none',
  });
  assert.deepEqual(classifyPhase({ description: 'NC', phaseOverride: 'arterial' }), {
    phase: 'arterial',
    source: 'user',
  });
  assert.equal(approximateSizes({ description: 'plain' }), true);
  assert.equal(approximateSizes({ description: 'x', phaseOverride: 'portal-venous' }), false);
});

test('computes HU statistics inside a circle and gives plain-CT density hints', () => {
  const frame = { rows: 10, columns: 10, spacing: [0.5, 0.5] };
  const pixels = new Float32Array(100).fill(-1000);
  for (let y = 3; y <= 7; y++) for (let x = 3; x <= 7; x++) pixels[y * 10 + x] = 10;
  const stats = roiStats(pixels, frame, [5, 5], 2);
  assert.equal(stats.count, 13);
  assert.equal(stats.mean, 10);
  assert.equal(stats.sd, 0);
  assert.equal(stats.areaMm2, 3.3);
  assert.equal(formatHu(stats), '10 ± 0 HU');
  assert.match(densityHint(10, false), /Fluid/);
  assert.match(densityHint(-100, false), /Fat/);
  assert.match(densityHint(65, false), /blood/);
  assert.match(densityHint(400, false), /Calcification/);
  assert.match(densityHint(-700, false), /lung/);
  assert.match(densityHint(35, true), /do not apply/);
  assert.match(densityHint(-100, true), /Fat/, 'fat is recognizable after contrast');
  assert.match(
    densityHint(129, false, { sd: 787, count: 400 }),
    /Heterogeneous region \(SD 787 HU\)/,
  );
  assert.match(densityHint(10, false, { sd: 12, count: 5 }), /too small/);
  assert.match(densityHint(10, false, { sd: 12, count: 80 }), /Fluid/);
});

async function withSeries(options, run) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'aliatlas-plain-'));
  const previous = process.env.ATLAS_DATA_DIR;
  process.env.ATLAS_DATA_DIR = directory;
  try {
    const form = new FormData();
    for (let index = 0; index < 5; index++)
      form.append(
        'files',
        new Blob([
          makeDicom({
            index,
            rows: 20,
            columns: 20,
            spacing: [1, 1],
            position: [0, 0, index * 2.5],
            ...options,
          }),
        ]),
        `s${index}.dcm`,
      );
    const imported = await importStudy(
      new Request('http://127.0.0.1/import', { method: 'POST', body: form }),
      owner,
    );
    await run(await loadStudy(owner, imported.studies[0].id));
  } finally {
    process.env.ATLAS_DATA_DIR = previous;
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test('measures craniocaudal extent from slice positions and estimates ellipsoid volume', async () => {
  await withSeries({}, async (study) => {
    const series = study.series[0],
      frames = series.frames;
    assert.deepEqual(craniocaudalExtent(series, frames[1].id, frames[3].id), {
      ccMm: 7.5,
      slices: 3,
    });
    assert.equal(craniocaudalExtent(series, frames[2].id, frames[2].id).ccMm, 2.5);
    assert.equal(ellipsoidVolumeMl(40, 30, 20), 12.6);
    const finding = validateFinding(study, {
      seriesId: series.id,
      frameId: frames[2].id,
      label: 'Mass',
      category: 'mass',
      long: [
        [2, 2],
        [12, 2],
      ],
      short: [
        [7, 0],
        [7, 6],
      ],
      extent: { firstFrameId: frames[1].id, lastFrameId: frames[3].id },
    });
    assert.equal(finding.ccMm, 7.5);
    assert.equal(finding.volumeMl, 0.2);
    assert.equal(formatSize(finding, { approx: true }), '≈ 10.0 × 6.0 × 7.5 mm');
    const cleared = updateFinding(study, finding, { extent: null }, user);
    assert.equal(cleared.ccMm, null);
    assert.equal(cleared.volumeMl, null);
  });
});

test('stores server-computed HU for a density-only finding', async () => {
  await withSeries({}, async (study) => {
    const series = study.series[0],
      frame = series.frames[0];
    const input = {
      seriesId: series.id,
      frameId: frame.id,
      label: 'Cyst',
      category: 'cyst',
      roi: { center: [10, 10], radius: 3, stats: { mean: 9999 } },
    };
    const stats = await roiStatsFor(owner, study.id, study, series.id, frame.id, input.roi);
    const finding = validateFinding(study, input, { roiStats: stats });
    assert.notEqual(finding.roi.stats.mean, 9999, 'client-sent statistics are ignored');
    assert.equal(finding.roi.stats.count, 29);
    assert.equal(finding.longMm, null);
    assert.throws(
      () => validateFinding(study, { ...input, roi: undefined }),
      /size or its density/,
    );
    await mutateFindings(owner, study.id, () => [finding]);
    assert.match(composeFindings(study, [finding]), /Cyst \(cyst\).*mean density -?\d+ ± \d+ HU/);
  });
});

test('plain CT defaults to a screening report with limitations; diagnostic needs contrast', async () => {
  await withSeries({}, async (study) => {
    const report = withDefaults(await readReport(owner, study.id), study, []);
    assert.equal(report.reportType, 'screening');
    assert.equal(report.canDiagnose, false);
    assert.match(report.limitations, /Contrast phase not recorded/);
    assert.match(report.technique, /contrast phase not recorded/);
    await assert.rejects(
      updateReport(owner, study.id, { reportType: 'diagnostic' }, user),
      /needs a contrast-enhanced series/,
    );
    // A reader marks the series as portal venous: diagnostic reporting becomes available.
    study.series[0].phaseOverride = 'portal-venous';
    await writeJson(path.join(studyDir(owner, study.id), 'study.json'), study);
    const saved = await updateReport(owner, study.id, { reportType: 'diagnostic' }, user);
    assert.equal(saved.reportType, 'diagnostic');
    assert.equal(saved.canDiagnose, true);
  });
});

test('labels a plain series from its description', async () => {
  await withSeries({ seriesDescription: 'CT KUB NON CONTRAST' }, async (study) => {
    const report = withDefaults(await readReport(owner, study.id), study, []);
    assert.match(report.limitations, /^Non-contrast CT\./);
    assert.match(report.technique, /^Non-contrast CT/);
  });
});

test('reads the DICOM contrast agent tag at import', async () => {
  await withSeries({ contrastAgent: 'Iohexol 350' }, async (study) => {
    assert.equal(study.series[0].contrastAgent, 'Iohexol 350');
    assert.equal(classifyPhase(study.series[0]).phase, 'contrast');
    assert.equal(
      withDefaults(await readReport(owner, study.id), study, []).reportType,
      'diagnostic',
    );
  });
});

test('report wording for density states only what was measured', async () => {
  await withSeries({}, async (study) => {
    const series = study.series[0];
    const base = {
      id: 'f',
      seriesId: series.id,
      frameId: series.frames[0].id,
      label: 'Region',
      category: 'other',
      status: 'confirmed',
      longMm: null,
    };
    const text = (stats) => composeFindings(study, [{ ...base, roi: { stats } }]);
    assert.match(text({ mean: 129, sd: 787, count: 400 }), /129 ± 787 HU \(heterogeneous\)\./);
    assert.match(text({ mean: 12, sd: 8, count: 400 }), /12 ± 8 HU \(fluid range/);
    assert.match(text({ mean: 12, sd: 8, count: 4 }), /12 ± 8 HU\./);
  });
});
