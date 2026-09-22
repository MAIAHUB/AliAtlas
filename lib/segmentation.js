import * as nifti from 'nifti-reader-js';
import { gunzipSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { assert } from './errors.js';
import { pixelToLps, hasGeometry } from './geometry.js';
import { COLORS, structureName, structureCategory } from './catalog.js';

export function inverseAffine(m) {
  const [[a, b, c, x], [d, e, f, y], [g, h, i, z]] = m;
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  assert(
    Number.isFinite(det) && Math.abs(det) > 1e-10,
    'The segmentation affine is singular.',
    422,
  );
  const inv = [
    [(e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det],
    [(f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det],
    [(d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det],
  ];
  return inv.map((row) => [...row, -(row[0] * x + row[1] * y + row[2] * z)]);
}
export const applyAffine = (m, p) =>
  m.slice(0, 3).map((row) => row[0] * p[0] + row[1] * p[1] + row[2] * p[2] + row[3]);

export function readLabelmap(input) {
  const bytes =
    input[0] === 31 && input[1] === 139
      ? gunzipSync(input, { maxOutputLength: 1024 * 1024 * 1024 })
      : input;
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  assert(nifti.isNIFTI(buffer), 'The model did not return a NIfTI labelmap.', 422);
  const header = nifti.readHeader(buffer);
  assert(
    header && (header.sform_code > 0 || header.qform_code > 0),
    'Segmentation has no physical coordinate transform.',
    422,
  );
  assert(
    header.dims[0] >= 3 && header.dims.slice(4).every((d) => d === 0 || d === 1),
    'Only a 3D segmentation labelmap is supported.',
    422,
  );
  const dimensions = header.dims.slice(1, 4),
    count = dimensions.reduce((a, b) => a * b, 1);
  assert(
    dimensions.every((d) => Number.isInteger(d) && d > 0) && count <= 512 * 1024 * 1024,
    'Segmentation dimensions are invalid or too large.',
    422,
  );
  const unit = { 1: 1000, 2: 1, 3: 0.001 }[header.xyzt_units & 7];
  assert(unit, 'Segmentation spatial units must be defined.', 422);
  assert(
    (!header.scl_slope || header.scl_slope === 1) && !header.scl_inter,
    'Scaled segmentation values are not supported.',
    422,
  );
  const readers = {
    2: ['getUint8', 1],
    4: ['getInt16', 2],
    8: ['getInt32', 4],
    512: ['getUint16', 2],
    768: ['getUint32', 4],
  };
  const reader = readers[header.datatypeCode];
  assert(reader, 'The model labelmap must contain integer labels.', 422);
  assert(
    header.vox_offset + count * reader[1] <= buffer.byteLength,
    'The segmentation pixel data is incomplete.',
    422,
  );
  const image = new DataView(buffer, header.vox_offset, count * reader[1]);
  const affine = header.affine.map((row, i) => (i < 3 ? row.map((v) => v * unit) : row));
  const inverse = inverseAffine(affine);
  return {
    dimensions,
    inverse,
    get: (index) => image[reader[0]](index * reader[1], header.littleEndian),
  };
}

export async function labelsFromNifti(
  input,
  series,
  classMap,
  { task, version, minPixels = 3 } = {},
) {
  assert(
    series.frames.every(hasGeometry),
    'Image geometry is required to align model labels.',
    422,
  );
  const volume = readLabelmap(input),
    [nx, ny, nz] = volume.dimensions,
    records = [];
  const voxelAt = (p) => applyAffine(volume.inverse, [-p[0], -p[1], p[2]]); // DICOM LPS → NIfTI RAS
  for (const frame of series.frames) {
    const origin = voxelAt(pixelToLps(frame, [0, 0]));
    const nextX = voxelAt(pixelToLps(frame, [1, 0])).map((v, i) => v - origin[i]);
    const nextY = voxelAt(pixelToLps(frame, [0, 1])).map((v, i) => v - origin[i]);
    const slice = new Uint32Array(frame.rows * frame.columns),
      stats = new Map();
    for (let y = 0; y < frame.rows; y++) {
      let vx = origin[0] + nextY[0] * y,
        vy = origin[1] + nextY[1] * y,
        vz = origin[2] + nextY[2] * y;
      for (let x = 0; x < frame.columns; x++, vx += nextX[0], vy += nextX[1], vz += nextX[2]) {
        const ix = Math.round(vx),
          iy = Math.round(vy),
          iz = Math.round(vz);
        if (ix < 0 || ix >= nx || iy < 0 || iy >= ny || iz < 0 || iz >= nz) continue;
        const label = volume.get(ix + nx * (iy + ny * iz));
        if (!label) continue;
        assert(
          classMap[label],
          `The installed model class map has no entry for label ${label}.`,
          422,
        );
        slice[y * frame.columns + x] = label;
        const item = stats.get(label) || { n: 0, x: 0, y: 0, best: Infinity, point: null };
        item.n++;
        item.x += x;
        item.y += y;
        stats.set(label, item);
      }
    }
    for (const stat of stats.values()) {
      stat.x /= stat.n;
      stat.y /= stat.n;
    }
    // The arithmetic centroid can lie in air for curved/disconnected anatomy. Anchor on an actual mask pixel.
    for (let y = 0; y < frame.rows; y++)
      for (let x = 0; x < frame.columns; x++) {
        const label = slice[y * frame.columns + x];
        if (!label) continue;
        const item = stats.get(label),
          distance = (x - item.x) ** 2 + (y - item.y) ** 2;
        if (distance < item.best) {
          item.best = distance;
          item.point = [x, y];
        }
      }
    for (const [label, stat] of stats) {
      if (stat.n < minPixels) continue;
      const structure = classMap[label];
      records.push({
        id: randomUUID(),
        seriesId: series.id,
        frameId: frame.id,
        pixel: stat.point,
        label: structureName(structure),
        structure,
        color: COLORS[structureCategory(structure)],
        side: stat.point[0] < frame.columns / 2 ? 'left' : 'right',
        source: 'model',
        reviewed: false,
        model: { name: 'TotalSegmentator', version, task },
        createdAt: new Date().toISOString(),
      });
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  return records;
}
