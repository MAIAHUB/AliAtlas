// Circular region-of-interest density statistics in Hounsfield units. Shared by the
// viewer (live preview) and the server (stored values are always recomputed there).
export function roiStats(pixels, frame, center, radius) {
  const [cx, cy] = center,
    r2 = radius * radius;
  const x0 = Math.max(0, Math.floor(cx - radius)),
    x1 = Math.min(frame.columns - 1, Math.ceil(cx + radius));
  const y0 = Math.max(0, Math.floor(cy - radius)),
    y1 = Math.min(frame.rows - 1, Math.ceil(cy + radius));
  let count = 0,
    sum = 0,
    sumSq = 0,
    min = Infinity,
    max = -Infinity;
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 > r2) continue;
      const v = pixels[y * frame.columns + x];
      count++;
      sum += v;
      sumSq += v * v;
      if (v < min) min = v;
      if (v > max) max = v;
    }
  if (!count) return null;
  const mean = sum / count;
  const [rowSpacing, columnSpacing] = frame.spacing || [];
  return {
    mean: Math.round(mean * 10) / 10,
    sd: Math.round(Math.sqrt(Math.max(0, sumSq / count - mean * mean)) * 10) / 10,
    min: Math.round(min),
    max: Math.round(max),
    count,
    areaMm2:
      rowSpacing > 0 && columnSpacing > 0
        ? Math.round(count * rowSpacing * columnSpacing * 10) / 10
        : null,
  };
}

// Typical attenuation ranges on non-contrast CT. A hint for the reader, not a diagnosis:
// partial volume, beam hardening and noise all shift values. Contrast enhancement
// invalidates the soft-tissue ranges; fat and gas are still recognizable.
const RANGES = [
  { max: -900, text: 'Gas / air range', always: true },
  { max: -190, min: -900, text: 'Aerated lung / gas-containing tissue range', always: true },
  { max: -30, min: -190, text: 'Fat range', always: true },
  { max: -10, min: -30, text: 'Indeterminate (fat/fluid mixture or partial volume)' },
  { max: 20, min: -10, text: 'Fluid range (e.g. simple cyst)' },
  { max: 45, min: 20, text: 'Soft tissue or complex/proteinaceous fluid range' },
  { max: 90, min: 45, text: 'Hyperdense: acute blood or dense soft tissue range' },
  { max: 150, min: 90, text: 'High density: possible calcification or clotted blood' },
  { min: 150, text: 'Calcification / bone range' },
];

// Image noise on CT is typically 10–40 HU (SD); far more means the circle mixes tissues.
export const HETEROGENEOUS_SD = 60;
export const MIN_ROI_PIXELS = 10;

export function densityHint(mean, enhanced, { sd, count } = {}) {
  if (!Number.isFinite(mean)) return null;
  if (Number.isFinite(count) && count < MIN_ROI_PIXELS)
    return 'Region too small for a reliable mean: draw a larger circle';
  if (Number.isFinite(sd) && sd > HETEROGENEOUS_SD)
    return `Heterogeneous region (SD ${Math.round(sd)} HU): mixed tissues or partial volume, so no density range is suggested. Keep the circle inside the lesion`;
  const range = RANGES.find(
    (r) => (r.min === undefined || mean >= r.min) && (r.max === undefined || mean < r.max),
  );
  if (!range) return null;
  if (enhanced && !range.always)
    return 'Contrast-enhanced image: plain-CT density ranges do not apply';
  return range.text;
}

export const formatHu = (stats) =>
  stats ? `${Math.round(stats.mean)} ± ${Math.round(stats.sd)} HU` : '—';
