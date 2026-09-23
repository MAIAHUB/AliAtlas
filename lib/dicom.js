import dicomParser from 'dicom-parser';
import { AppError, assert } from './errors.js';
import { dot, hasGeometry, normalOf } from './geometry.js';

const NATIVE = new Set(['1.2.840.10008.1.2', '1.2.840.10008.1.2.1', '1.2.840.10008.1.2.2']);
const CT_CLASSES = new Set([
  '1.2.840.10008.5.1.4.1.1.2',
  '1.2.840.10008.5.1.4.1.1.2.1',
  '1.2.840.10008.5.1.4.1.1.2.2',
]);
const first = (ds, tag) => ds?.elements[tag]?.items?.[0]?.dataSet;
const text = (ds, tag) => ds?.string(tag)?.trim().replaceAll('\0', '') || '';
const numbers = (ds, tag) => {
  const s = text(ds, tag);
  return s ? s.split('\\').map(Number) : null;
};
const value = (ds, tag, fallback) => {
  const a = numbers(ds, tag);
  return a && Number.isFinite(a[0]) ? a[0] : fallback;
};

export function parseDicom(bytes) {
  let ds;
  try {
    ds = dicomParser.parseDicom(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), {
      untilTag: 'x7fe00010',
    });
  } catch {
    throw new AppError('This file is not a readable DICOM Part 10 image.', 422, 'INVALID_DICOM');
  }
  const transferSyntax = text(ds, 'x00020010');
  assert(
    text(ds, 'x00080060') === 'CT' && CT_CLASSES.has(text(ds, 'x00080016')),
    'Only CT Image Storage and Enhanced CT images are supported.',
    422,
    'NOT_CT',
  );
  if (!NATIVE.has(transferSyntax))
    throw new AppError(
      'This transfer syntax requires the GDCM decoder. Install libgdcm-tools or use the supplied Docker image.',
      422,
      'COMPRESSED_DICOM',
    );
  const rows = ds.uint16('x00280010'),
    columns = ds.uint16('x00280011');
  const bitsAllocated = ds.uint16('x00280100'),
    bitsStored = ds.uint16('x00280101'),
    highBit = ds.uint16('x00280102');
  const representation = ds.uint16('x00280103');
  const photometric = text(ds, 'x00280004');
  assert(
    rows > 0 && columns > 0 && rows <= 2048 && columns <= 2048,
    'Unsupported CT image dimensions (maximum 2048 × 2048).',
    422,
  );
  assert(
    [8, 16].includes(bitsAllocated) &&
      bitsStored > 0 &&
      bitsStored <= bitsAllocated &&
      highBit >= bitsStored - 1 &&
      highBit < bitsAllocated &&
      [0, 1].includes(representation),
    'Unsupported DICOM pixel representation.',
    422,
  );
  assert(
    ds.uint16('x00280002') === 1 && ['MONOCHROME1', 'MONOCHROME2'].includes(photometric),
    'Only monochrome CT pixel data is supported.',
    422,
  );
  assert(
    !ds.elements.x00283000 && !ds.elements.x00283010,
    'This image uses a non-linear modality or VOI LUT. Export it with linear rescale/window metadata.',
    422,
    'UNSUPPORTED_LUT',
  );
  const count = value(ds, 'x00280008', 1);
  assert(
    Number.isInteger(count) && count >= 1 && count <= 2000,
    'Invalid or oversized multi-frame image.',
    422,
  );
  const pixel = ds.elements.x7fe00010;
  const frameBytes = (rows * columns * bitsAllocated) / 8;
  assert(
    pixel &&
      pixel.length >= frameBytes * count &&
      pixel.dataOffset + frameBytes * count <= bytes.length,
    'DICOM pixel data is incomplete.',
    422,
  );
  const studyInstanceUID = text(ds, 'x0020000d'),
    seriesInstanceUID = text(ds, 'x0020000e'),
    sopInstanceUID = text(ds, 'x00080018');
  assert(
    [studyInstanceUID, seriesInstanceUID, sopInstanceUID].every(
      (s) => s.length <= 64 && /^[0-9]+(?:\.[0-9]+)*$/.test(s),
    ),
    'Required DICOM identifiers are missing or invalid.',
    422,
  );
  const shared = first(ds, 'x52009229');
  const perFrame = ds.elements.x52009230?.items || [];
  const frames = Array.from({ length: count }, (_, frameNumber) => {
    const functional = perFrame[frameNumber]?.dataSet;
    const group = (tag) => first(functional, tag) || first(shared, tag) || ds;
    const rescale = group('x00289145'),
      voi = group('x00289132');
    const position = numbers(group('x00209113'), 'x00200032');
    const orientation = numbers(group('x00209116'), 'x00200037');
    const spacing = numbers(group('x00289110'), 'x00280030');
    const slope = value(rescale, 'x00281053', 1),
      intercept = value(rescale, 'x00281052', 0);
    const voiFunction = text(voi, 'x00281056');
    assert(
      !voiFunction || voiFunction === 'LINEAR',
      'Only DICOM LINEAR window functions are supported.',
      422,
      'UNSUPPORTED_VOI',
    );
    assert(
      slope !== 0 && Number.isFinite(slope) && Number.isFinite(intercept),
      'Invalid CT rescale metadata.',
      422,
    );
    return {
      frameNumber,
      sopInstanceUID,
      studyInstanceUID,
      seriesInstanceUID,
      frameOfReferenceUID: text(ds, 'x00200052'),
      rows,
      columns,
      // Do not invent geometry for legacy multi-frame objects without per-frame positions.
      position: count > 1 && !first(functional, 'x00209113') ? null : position,
      orientation,
      spacing,
      slope,
      intercept,
      windowCenter: value(voi, 'x00281050', 40),
      windowWidth: Math.max(1, value(voi, 'x00281051', 350)),
      inverted: photometric === 'MONOCHROME1',
      bitsAllocated,
      bitsStored,
      highBit,
      signed: representation === 1,
      littleEndian: transferSyntax !== '1.2.840.10008.1.2.2',
      pixelOffset: pixel.dataOffset + frameNumber * frameBytes,
      pixelLength: frameBytes,
      instanceNumber: value(ds, 'x00200013', 0),
      sliceThickness: value(group('x00289110'), 'x00180050', null),
    };
  });
  return {
    studyInstanceUID,
    seriesInstanceUID,
    sopInstanceUID,
    frames,
    seriesDescription: text(ds, 'x0008103e').slice(0, 100) || 'CT series',
    bodyPart: text(ds, 'x00180015').slice(0, 50),
    imageType: text(ds, 'x00080008').slice(0, 100),
    seriesNumber: value(ds, 'x00200011', 0),
    transferSyntax,
    temporalPosition: text(ds, 'x00200100'),
  };
}

export function seriesKey(metadata) {
  const f = metadata.frames[0];
  return JSON.stringify([
    metadata.seriesInstanceUID,
    f.frameOfReferenceUID,
    f.rows,
    f.columns,
    f.orientation?.map((v) => Number(v.toFixed(4))),
    f.spacing,
    metadata.imageType,
    metadata.temporalPosition,
  ]);
}

export function decodePixels(bytes, frame) {
  assert(frame.pixelOffset + frame.pixelLength <= bytes.length, 'Pixel data is incomplete.', 422);
  const view = new DataView(bytes.buffer, bytes.byteOffset + frame.pixelOffset, frame.pixelLength);
  const output = new Float32Array(frame.rows * frame.columns);
  const shift = frame.highBit - frame.bitsStored + 1,
    mask = 2 ** frame.bitsStored - 1,
    sign = 2 ** (frame.bitsStored - 1);
  for (let i = 0; i < output.length; i++) {
    let raw =
      frame.bitsAllocated === 8 ? view.getUint8(i) : view.getUint16(i * 2, frame.littleEndian);
    raw = (raw >>> shift) & mask;
    if (frame.signed && raw & sign) raw -= 2 ** frame.bitsStored;
    output[i] = raw * frame.slope + frame.intercept;
  }
  return output;
}

export function segmentationEligibility(series) {
  if (series.frames.length < 3) return 'Upload at least three CT slices from one series.';
  if (/LOCALIZER|SCOUT/i.test(series.imageType))
    return 'Select a diagnostic CT series instead of a localizer.';
  if (series.frames.some((f) => f.frameNumber > 0))
    return 'Automatic labeling currently requires a conventional single-frame DICOM series. Enhanced CT can still be viewed and manually labeled.';
  if (!series.frames.every(hasGeometry))
    return 'This series needs complete per-slice DICOM position, orientation, and spacing for automatic labeling.';
  const coordinates = series.frames.map((f) => f.position);
  if (new Set(coordinates.map((p) => p.join(','))).size !== coordinates.length)
    return 'This series has overlapping slice positions. Select one acquisition phase.';
  return null;
}

// Some scanners put several acquisition runs under one Series Instance UID.
// Keep each monotonic run intact so DICOM-to-NIfTI conversion sees one volume.
export function acquisitionRuns(frames) {
  if (
    frames.length < 6 ||
    !frames.every((frame) => hasGeometry(frame) && frame.frameNumber === 0) ||
    new Set(frames.map((frame) => frame.instanceNumber)).size !== frames.length ||
    !frames.every((frame) => Number.isFinite(frame.instanceNumber))
  )
    return [frames];
  const ordered = [...frames].sort((a, b) => a.instanceNumber - b.instanceNumber);
  const normal = normalOf(ordered[0]);
  const runs = [];
  let current = [ordered[0]],
    direction = 0,
    spacing = 0;
  for (let i = 1; i < ordered.length; i++) {
    const delta = dot(ordered[i].position, normal) - dot(ordered[i - 1].position, normal);
    const separated =
      Math.abs(delta) < 0.001 ||
      (direction && Math.sign(delta) !== direction) ||
      (spacing && Math.abs(Math.abs(delta) - spacing) > Math.max(0.1, spacing * 0.15));
    if (separated) {
      runs.push(current);
      current = [ordered[i]];
      direction = 0;
      spacing = 0;
    } else {
      current.push(ordered[i]);
      direction = Math.sign(delta);
      spacing = Math.abs(delta);
    }
  }
  runs.push(current);
  return runs.length > 1 && runs.some((run) => run.length >= 3) ? runs : [frames];
}
