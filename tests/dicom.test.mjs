import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDicom } from './fixtures.mjs';
import {
  acquisitionRuns,
  parseDicom,
  decodePixels,
  seriesKey,
  segmentationEligibility,
} from '../lib/dicom.js';
import {
  sortFrames,
  pixelToLps,
  lpsToPixel,
  orientationLabels,
  imageTransform,
  pixelToScreen,
  screenToPixel,
  windowPixel,
} from '../lib/geometry.js';

for (const mode of [
  { name: 'explicit little endian' },
  { name: 'implicit little endian', implicit: true },
  { name: 'explicit big endian', big: true },
]) {
  test(`decodes signed CT and rescale: ${mode.name}`, () => {
    const bytes = makeDicom({
      ...mode,
      rows: 2,
      columns: 2,
      values: [-2048, -1, 0, 2047],
      slope: 2,
      intercept: -100,
    });
    const image = parseDicom(bytes);
    assert.deepEqual([...decodePixels(bytes, image.frames[0])], [-4196, -102, -100, 3994]);
  });
}
test('honors 12-bit sign extension and non-default high bit', () => {
  const bytes = makeDicom({
    rows: 1,
    columns: 4,
    bitsStored: 12,
    highBit: 14,
    values: [-2048, -1, 0, 2047],
  });
  assert.deepEqual([...decodePixels(bytes, parseDicom(bytes).frames[0])], [-2048, -1, 0, 2047]);
});
test('decodes 8-bit unsigned data', () => {
  const bytes = makeDicom({
    rows: 1,
    columns: 3,
    bits: 8,
    bitsStored: 8,
    signed: false,
    values: [0, 127, 255],
  });
  assert.deepEqual([...decodePixels(bytes, parseDicom(bytes).frames[0])], [0, 127, 255]);
});
test('rejects invalid, non-CT, compressed-without-codec and truncated inputs', () => {
  assert.throws(() => parseDicom(Buffer.from('not dicom')), /readable DICOM/);
  assert.throws(() => parseDicom(makeDicom({ modality: 'MR' })), /Only CT/);
  assert.throws(
    () => parseDicom(makeDicom({ transferSyntax: '1.2.840.10008.1.2.4.90' })),
    (e) => e.code === 'COMPRESSED_DICOM',
  );
  assert.throws(() => parseDicom(makeDicom().subarray(0, -10)), /incomplete/);
});
test('extracts enhanced multi-frame geometry and distinct pixel frames', () => {
  const bytes = makeDicom({
    rows: 2,
    columns: 2,
    enhancedFrames: 3,
    values: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
  });
  const parsed = parseDicom(bytes);
  assert.equal(parsed.frames.length, 3);
  assert.deepEqual(
    parsed.frames.map((f) => f.position[2]),
    [0, 2, 4],
  );
  assert.deepEqual([...decodePixels(bytes, parsed.frames[1])], [5, 6, 7, 8]);
  assert.match(segmentationEligibility({ frames: parsed.frames }), /single-frame/);
});
test('orders slices in physical space despite reversed filenames and instance numbers', () => {
  const frames = [3, 0, 2, 1].map((z, index) => ({
    ...parseDicom(makeDicom({ index, position: [0, 0, z], orientation: [1, 0, 0, 0, -1, 0] }))
      .frames[0],
    instanceNumber: 99 - index,
  }));
  assert.deepEqual(
    sortFrames(frames).map((f) => f.position[2]),
    [0, 1, 2, 3],
  );
});
test('keeps incompatible orientations in separate stacks', () => {
  assert.notEqual(
    seriesKey(parseDicom(makeDicom())),
    seriesKey(parseDicom(makeDicom({ orientation: [0, 1, 0, 0, 0, 1] }))),
  );
});
test('separates repeated CT acquisition runs by instance order', () => {
  const positions = [0, -2, -4, -6, 6, 4, 2, 0, -2, -4];
  const frames = positions.map(
    (z, index) => parseDicom(makeDicom({ index, position: [0, 0, z] })).frames[0],
  );
  const runs = acquisitionRuns(frames.toReversed());
  assert.deepEqual(
    runs.map((run) => run.length),
    [4, 6],
  );
  assert.ok(runs.every((run) => !segmentationEligibility({ frames: run })));
  const repeated = Array.from(
    { length: 5 },
    (_, index) => parseDicom(makeDicom({ index, position: [0, 0, 0] })).frames[0],
  );
  assert.equal(acquisitionRuns(repeated).length, 1);
  assert.match(segmentationEligibility({ frames: repeated }), /overlapping slice positions/);
});
test('respects DICOM row/column spacing and orientation', () => {
  const f = { position: [10, 20, 30], orientation: [0, 1, 0, 0, 0, 1], spacing: [2, 3] };
  assert.deepEqual(pixelToLps(f, [4, 5]), [10, 32, 40]);
  assert.deepEqual(lpsToPixel(f, [10, 32, 40]), [4, 5]);
  assert.deepEqual(orientationLabels(f), { left: 'A', right: 'P', top: 'I', bottom: 'S' });
});
test('label coordinates survive anisotropic spacing, pan, and zoom', () => {
  const frame = { columns: 512, rows: 256, spacing: [2, 0.6] },
    point = [210.25, 99.75],
    t = imageTransform(frame, 1000, 750, 1.7, [37, -29]);
  const mapped = screenToPixel(t, pixelToScreen(t, point));
  mapped.forEach((v, i) => assert.ok(Math.abs(v - point[i]) < 1e-8));
});
test('implements DICOM LINEAR window boundaries and MONOCHROME1 inversion', () => {
  assert.equal(windowPixel(-135, 40, 350), 0);
  assert.equal(windowPixel(214, 40, 350), 255);
  assert.equal(windowPixel(39, 40, 1), 0);
  assert.equal(windowPixel(40, 40, 1), 255);
  assert.equal(windowPixel(40, 40, 1, true), 0);
});
