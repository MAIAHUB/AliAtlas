import { dot, hasGeometry, normalOf } from './geometry.js';

// Caliper maths shared by the server (authoritative sizes) and the viewer (live preview).
// DICOM Pixel Spacing is [row spacing, column spacing]: rows step along y, columns along x.
export const FINDING_CATEGORIES = [
  { id: 'mass', name: 'Mass / tumour' },
  { id: 'nodule', name: 'Nodule' },
  { id: 'lymph-node', name: 'Lymph node' },
  { id: 'cyst', name: 'Cyst' },
  { id: 'fluid', name: 'Fluid / collection' },
  { id: 'other', name: 'Other abnormality' },
];

export function lineLength(frame, line) {
  if (!line) return null;
  const [[x1, y1], [x2, y2]] = line;
  const [rowSpacing, columnSpacing] = frame.spacing || [];
  const calibrated = rowSpacing > 0 && columnSpacing > 0;
  const dx = (x2 - x1) * (calibrated ? columnSpacing : 1),
    dy = (y2 - y1) * (calibrated ? rowSpacing : 1);
  return { value: Math.hypot(dx, dy), unit: calibrated ? 'mm' : 'px' };
}

// L × W (× craniocaudal) in mm. `approx` marks plain-CT sizes, whose margins are uncertain.
export function formatSize(finding, { approx = false } = {}) {
  const unit = finding.unit || 'mm';
  const f = (v) => (v >= 100 ? v.toFixed(0) : v.toFixed(1));
  if (finding.longMm == null) return '—';
  const dims = [finding.longMm, finding.shortMm, finding.ccMm].filter((v) => v != null);
  return `${approx ? '≈ ' : ''}${dims.map(f).join(' × ')} ${unit}`;
}

export function formatVolume(finding, { approx = false } = {}) {
  if (finding.volumeMl == null) return null;
  const digits = finding.volumeMl >= 10 ? 0 : 1;
  return `${approx ? '≈ ' : ''}${finding.volumeMl.toFixed(digits)} mL`;
}

// Craniocaudal extent from the first to the last slice showing a lesion, using DICOM
// positions along the slice normal plus one slice interval (a lesion seen on a single
// slice is one interval thick). Null when the series lacks usable geometry.
export function craniocaudalExtent(series, firstFrameId, lastFrameId) {
  const frames = series.frames;
  const a = frames.findIndex((f) => f.id === firstFrameId),
    b = frames.findIndex((f) => f.id === lastFrameId);
  if (a < 0 || b < 0 || !frames.every(hasGeometry)) return null;
  const normal = normalOf(frames[0]);
  const depth = (f) => dot(f.position, normal);
  const gaps = frames
    .slice(1)
    .map((f, i) => Math.abs(depth(f) - depth(frames[i])))
    .filter((g) => g > 1e-3)
    .sort((x, y) => x - y);
  if (!gaps.length) return null;
  const interval = gaps[Math.floor(gaps.length / 2)];
  return {
    ccMm: Math.round((Math.abs(depth(frames[b]) - depth(frames[a])) + interval) * 10) / 10,
    slices: Math.abs(b - a) + 1,
  };
}

// Ellipsoid approximation: π/6 × L × W × H, in millilitres.
export const ellipsoidVolumeMl = (l, w, h) =>
  [l, w, h].every((v) => v > 0) ? Math.round(((Math.PI / 6) * l * w * h) / 100) / 10 : null;

export const categoryName = (id) =>
  FINDING_CATEGORIES.find((c) => c.id === id)?.name || 'Other abnormality';
