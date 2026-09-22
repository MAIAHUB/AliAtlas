import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { makeNifti } from './fixtures.mjs';
import { labelsFromNifti, readLabelmap, inverseAffine } from '../lib/segmentation.js';

const series = {
  id: 'test-series',
  frames: [0, 1, 2].map((z) => ({
    id: `frame-${z}`,
    position: [0, 0, z * 2],
    orientation: [1, 0, 0, 0, 1, 0],
    spacing: [1, 1],
    rows: 4,
    columns: 4,
  })),
};
test('maps RAS masks onto the matching LPS DICOM frame, independent of frame order', async () => {
  const values = new Uint8Array(48);
  values[16 + 1] = 1;
  values[16 + 2] = 1;
  values[16 + 5] = 1;
  const records = await labelsFromNifti(
    gzipSync(makeNifti({ values })),
    { ...series, frames: [series.frames[2], series.frames[0], series.frames[1]] },
    { 1: 'kidney_left' },
    { task: 'total', version: 'test' },
  );
  assert.equal(records.length, 1);
  assert.equal(records[0].frameId, 'frame-1');
  assert.deepEqual(records[0].pixel, [1, 0]);
  assert.equal(records[0].source, 'model');
  assert.equal(records[0].reviewed, false);
});
test('anchors concave anatomy inside its mask, not at an empty centroid', async () => {
  const values = new Uint8Array(48);
  for (const n of [0, 1, 2, 3, 4, 7, 8, 11, 12, 13, 14, 15]) values[n] = 1;
  const records = await labelsFromNifti(makeNifti({ values }), series, { 1: 'skull' });
  const [x, y] = records[0].pixel;
  assert.equal(values[y * 4 + x], 1);
  assert.notDeepEqual([x, y], [1.5, 1.5]);
});
test('handles a permuted NIfTI affine with anisotropic DICOM spacing', async () => {
  const frames = [
    {
      id: 'oblique-grid',
      position: [0, 0, 0],
      orientation: [1, 0, 0, 0, 1, 0],
      spacing: [3, 2],
      rows: 4,
      columns: 4,
    },
  ];
  const values = new Uint8Array(48);
  values[1 * 4 + 2] = 1;
  values[1 * 4 + 3] = 1;
  values[2 * 4 + 2] = 1;
  const affine = [
    [0, -2, 0, 0],
    [-3, 0, 0, 0],
    [0, 0, 2, 0],
    [0, 0, 0, 1],
  ];
  const records = await labelsFromNifti(
    makeNifti({ values, affine }),
    { id: 's', frames },
    { 1: 'liver' },
  );
  assert.equal(records.length, 1);
  assert.deepEqual(records[0].pixel, [1, 2]);
});
test('rejects unmapped labels, missing geometry, singular affine and undefined units', async () => {
  assert.throws(
    () =>
      inverseAffine([
        [0, 0, 0, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
      ]),
    /singular/,
  );
  assert.throws(() => readLabelmap(makeNifti({ units: 0 })), /units/);
  const values = new Uint8Array(48);
  values[0] = 5;
  await assert.rejects(labelsFromNifti(makeNifti({ values }), series, {}), /no entry/);
  await assert.rejects(labelsFromNifti(makeNifti(), { id: 's', frames: [{}] }, {}), /geometry/);
});
