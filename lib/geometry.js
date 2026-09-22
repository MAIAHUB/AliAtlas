export const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
export const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
export const finiteVector = (v, n) =>
  Array.isArray(v) && v.length === n && v.every(Number.isFinite);

export function hasGeometry(frame) {
  if (
    !finiteVector(frame.position, 3) ||
    !finiteVector(frame.orientation, 6) ||
    !finiteVector(frame.spacing, 2) ||
    !frame.spacing.every((v) => v > 0)
  )
    return false;
  const row = frame.orientation.slice(0, 3),
    col = frame.orientation.slice(3);
  return (
    Math.abs(dot(row, row) - 1) < 0.01 &&
    Math.abs(dot(col, col) - 1) < 0.01 &&
    Math.abs(dot(row, col)) < 0.01
  );
}

export function normalOf(frame) {
  const n = cross(frame.orientation.slice(0, 3), frame.orientation.slice(3));
  const major = n.map(Math.abs).indexOf(Math.max(...n.map(Math.abs)));
  return n[major] < 0 ? n.map((x) => -x) : n;
}

// DICOM pixel centres: row direction advances column index; column direction advances row index.
export function pixelToLps(frame, [x, y]) {
  return frame.position.map(
    (v, i) =>
      v +
      x * frame.spacing[1] * frame.orientation[i] +
      y * frame.spacing[0] * frame.orientation[i + 3],
  );
}

export function lpsToPixel(frame, point) {
  const delta = point.map((v, i) => v - frame.position[i]);
  return [
    dot(delta, frame.orientation.slice(0, 3)) / frame.spacing[1],
    dot(delta, frame.orientation.slice(3)) / frame.spacing[0],
  ];
}

export function sortFrames(frames) {
  const geometric = frames.every(hasGeometry);
  const normal = geometric ? normalOf(frames[0]) : null;
  return [...frames].sort((a, b) => {
    const delta = geometric
      ? dot(a.position, normal) - dot(b.position, normal)
      : (a.instanceNumber ?? 0) - (b.instanceNumber ?? 0);
    return Math.abs(delta) > 0.0001
      ? delta
      : a.frameNumber - b.frameNumber || a.sopInstanceUID.localeCompare(b.sopInstanceUID);
  });
}

export function planeOf(frame) {
  if (!frame || !hasGeometry(frame)) return 'Source';
  const n = normalOf(frame).map(Math.abs);
  return n[2] > 0.98 ? 'Axial' : n[1] > 0.98 ? 'Coronal' : n[0] > 0.98 ? 'Sagittal' : 'Oblique';
}

function direction(v) {
  return v
    .map((value, index) => ({ value, index }))
    .filter((x) => Math.abs(x.value) > 0.2)
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
    .map(
      ({ value, index }) =>
        [
          ['R', 'L'],
          ['A', 'P'],
          ['I', 'S'],
        ][index][value > 0 ? 1 : 0],
    )
    .join('');
}

export function orientationLabels(frame) {
  if (!frame || !hasGeometry(frame)) return {};
  const row = frame.orientation.slice(0, 3),
    col = frame.orientation.slice(3);
  return {
    left: direction(row.map((v) => -v)),
    right: direction(row),
    top: direction(col.map((v) => -v)),
    bottom: direction(col),
  };
}

export function imageTransform(frame, width, height, zoom = 1, pan = [0, 0]) {
  const sx = frame.spacing?.[1] || 1,
    sy = frame.spacing?.[0] || 1;
  const margin = width > 900 ? 185 : width > 600 ? 135 : 28;
  const scale =
    Math.min(
      Math.max(80, width - margin * 2) / (frame.columns * sx),
      Math.max(80, height - 75) / (frame.rows * sy),
    ) * zoom;
  return {
    x: (width - frame.columns * sx * scale) / 2 + pan[0],
    y: (height - frame.rows * sy * scale) / 2 + pan[1],
    sx: sx * scale,
    sy: sy * scale,
  };
}
export const pixelToScreen = (t, [x, y]) => [t.x + (x + 0.5) * t.sx, t.y + (y + 0.5) * t.sy];
export const screenToPixel = (t, [x, y]) => [(x - t.x) / t.sx - 0.5, (y - t.y) / t.sy - 0.5];

export function windowPixel(value, center, width, inverted = false) {
  // DICOM C.11.2 LINEAR VOI, including the width=1 threshold case.
  const gray =
    width <= 1
      ? value > center - 0.5
        ? 255
        : 0
      : clamp(((value - (center - 0.5)) / (width - 1) + 0.5) * 255, 0, 255);
  return inverted ? 255 - gray : gray;
}
