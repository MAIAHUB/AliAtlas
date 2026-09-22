import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAnnotation, exportAnnotations, importAnnotations } from '../lib/annotations.js';
const study = {
  studyInstanceUID: '1.2.3',
  series: [
    {
      id: 'series',
      seriesInstanceUID: '1.2.3.1',
      frames: [
        { id: 'frame', sopInstanceUID: '1.2.3.1.1', frameNumber: 0, columns: 512, rows: 256 },
      ],
    },
  ],
};
const annotation = {
  seriesId: 'series',
  frameId: 'frame',
  label: 'Liver',
  pixel: [120, 120],
  side: 'left',
  color: '#83d9bd',
};
test('validates slice membership and rejects invalid positions', () => {
  assert.throws(
    () => validateAnnotation(study, { ...annotation, frameId: 'another-slice' }),
    /reference a frame/,
  );
  for (const pixel of [
    [-1, 50],
    [512, 20],
    [10, 256],
    [NaN, 30],
    [Infinity, 4],
  ])
    assert.throws(() => validateAnnotation(study, { ...annotation, pixel }), /inside/);
});
test('does not let a client fabricate model provenance', () => {
  const record = validateAnnotation(study, { ...annotation, source: 'model', reviewed: false });
  assert.equal(record.source, 'manual');
  assert.equal(record.reviewed, true);
});
test('annotation import resolves SOP and frame identity after a new upload', () => {
  const record = validateAnnotation(study, annotation),
    bundle = exportAnnotations(study, [record]);
  const reimported = {
    ...study,
    series: [
      {
        ...study.series[0],
        id: 'new-series',
        frames: [{ ...study.series[0].frames[0], id: 'new-frame' }],
      },
    ],
  };
  const imported = importAnnotations(reimported, bundle)[0];
  assert.equal(imported.seriesId, 'new-series');
  assert.equal(imported.frameId, 'new-frame');
  assert.equal(imported.source, 'imported');
  assert.equal(imported.reviewed, false);
});
test('rejects labels from a different study or missing instance', () => {
  const bundle = exportAnnotations(study, [validateAnnotation(study, annotation)]);
  assert.throws(
    () => importAnnotations(study, { ...bundle, studyInstanceUID: '9.9.9' }),
    /different study/,
  );
  assert.throws(
    () =>
      importAnnotations(study, {
        ...bundle,
        records: [{ ...bundle.records[0], sopInstanceUID: '9.9.9' }],
      }),
    /missing or ambiguous/,
  );
});
