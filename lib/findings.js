import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppError, assert } from './errors.js';
import {
  studyDir,
  seriesDir,
  loadStudy,
  getSeries,
  readJson,
  writeJson,
  withLock,
  validId,
} from './storage.js';
import { decodePixels } from './dicom.js';
import {
  FINDING_CATEGORIES,
  lineLength,
  craniocaudalExtent,
  ellipsoidVolumeMl,
} from './measure.js';
import { roiStats } from './roi.js';

// Abnormal findings: caliper measurements (long/short axis), an optional density
// region (HU), and an optional first/last slice for the craniocaudal size. Manual
// findings are confirmed on creation; automated suggestions start unreviewed and must be
// confirmed or rejected before a report can be finalized.
export const FINDING_STATUSES = ['unreviewed', 'confirmed', 'rejected'];
export const findingsFile = (owner, id) => path.join(studyDir(owner, id), 'findings.json');
const imageFile = (owner, id, findingId) =>
  path.join(studyDir(owner, id), 'finding-images', `${validId(findingId)}.png`);

export async function readFindings(owner, id) {
  return readJson(findingsFile(owner, id)).catch((e) => {
    if (e.code === 'ENOENT') return { revision: 0, records: [] };
    throw e;
  });
}

const inside = (frame, p) =>
  Array.isArray(p) &&
  p.length === 2 &&
  p.every(Number.isFinite) &&
  p[0] >= 0 &&
  p[0] <= frame.columns - 1 &&
  p[1] >= 0 &&
  p[1] <= frame.rows - 1;
const round2 = (v) => Math.round(v * 100) / 100;

function checkLine(frame, line, name) {
  assert(
    Array.isArray(line) && line.length === 2 && line.every((p) => inside(frame, p)),
    `The ${name} must be a line inside the image.`,
  );
  assert(lineLength(frame, line).value > 0, `The ${name} has no length.`);
  return line.map((p) => p.map(round2));
}

function checkRoi(frame, roi) {
  assert(
    roi && inside(frame, roi.center) && Number.isFinite(roi.radius),
    'The density region must be a circle inside the image.',
  );
  assert(
    roi.radius >= 1 && roi.radius <= Math.min(frame.rows, frame.columns) / 2,
    'The density region is too small or too large.',
  );
  return { center: roi.center.map(round2), radius: round2(roi.radius) };
}

function checkExtent(series, extent) {
  const ids = new Set(series.frames.map((f) => f.id));
  assert(
    extent && ids.has(extent.firstFrameId) && ids.has(extent.lastFrameId),
    'Mark the first and last slice of the lesion in this series.',
  );
  return { firstFrameId: extent.firstFrameId, lastFrameId: extent.lastFrameId };
}

// HU statistics are read from the stored DICOM pixels, never taken from the client.
export async function roiStatsFor(owner, studyId, study, seriesId, frameId, roi) {
  const series = getSeries(study, seriesId),
    frame = series.frames.find((f) => f.id === frameId);
  assert(frame, 'The finding must reference a slice in this series.');
  const region = checkRoi(frame, roi);
  const bytes = await fs.readFile(
    path.join(seriesDir(owner, studyId, series.id), `${frame.fileId}.dcm`),
  );
  return roiStats(decodePixels(bytes, frame), frame, region.center, region.radius);
}

const text = (value, max, name, required = false) => {
  const v = typeof value === 'string' ? value.trim() : '';
  assert(!required || v.length > 0, `Enter a ${name}.`);
  assert(v.length <= max, `The ${name} is limited to ${max} characters.`);
  return v;
};

// Sizes are always recomputed here from DICOM geometry, never trusted from input.
function withSizes(series, frame, finding) {
  const round1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
  const long = finding.long ? lineLength(frame, finding.long) : null,
    short = finding.short ? lineLength(frame, finding.short) : null;
  const extent = finding.extent
    ? craniocaudalExtent(series, finding.extent.firstFrameId, finding.extent.lastFrameId)
    : null;
  const longMm = round1(long?.value),
    shortMm = round1(short?.value),
    unit = long?.unit || 'mm';
  const ccMm = unit === 'mm' ? (extent?.ccMm ?? null) : null;
  return {
    ...finding,
    longMm,
    shortMm,
    unit,
    ccMm,
    extentSlices: extent?.slices ?? null,
    volumeMl: unit === 'mm' ? ellipsoidVolumeMl(longMm, shortMm, ccMm) : null,
  };
}

export function validateFinding(study, input, { source = 'manual', roiStats: stats = null } = {}) {
  assert(input && typeof input === 'object', 'Invalid finding.');
  const series = getSeries(study, input.seriesId),
    frame = series.frames.find((f) => f.id === input.frameId);
  assert(frame, 'The finding must reference a slice in this series.');
  assert(
    FINDING_CATEGORIES.some((c) => c.id === input.category),
    'Choose a finding category.',
  );
  assert(input.long || input.roi, 'Measure the lesion size or its density first.');
  assert(!input.roi || stats, 'The density region could not be measured.');
  const confidence =
    source === 'ai' && Number.isFinite(input.confidence)
      ? Math.min(1, Math.max(0, input.confidence))
      : null;
  return withSizes(series, frame, {
    id: randomUUID(),
    seriesId: series.id,
    frameId: frame.id,
    label: text(input.label, 80, 'finding name', true),
    category: input.category,
    note: text(input.note, 1000, 'note'),
    long: input.long ? checkLine(frame, input.long, 'long axis') : null,
    short: input.short ? checkLine(frame, input.short, 'short axis') : null,
    roi: input.roi ? { ...checkRoi(frame, input.roi), stats } : null,
    extent: input.extent ? checkExtent(series, input.extent) : null,
    source,
    confidence,
    status: source === 'ai' ? 'unreviewed' : 'confirmed',
    createdAt: new Date().toISOString(),
  });
}

export function updateFinding(study, existing, input, reviewer, { roiStats: stats = null } = {}) {
  const series = getSeries(study, existing.seriesId),
    frame = series.frames.find((f) => f.id === existing.frameId);
  const next = { ...existing };
  if (input.label !== undefined) next.label = text(input.label, 80, 'finding name', true);
  if (input.note !== undefined) next.note = text(input.note, 1000, 'note');
  if (input.category !== undefined) {
    assert(
      FINDING_CATEGORIES.some((c) => c.id === input.category),
      'Choose a finding category.',
    );
    next.category = input.category;
  }
  if (input.long !== undefined)
    next.long = input.long ? checkLine(frame, input.long, 'long axis') : null;
  if (input.short !== undefined)
    next.short = input.short ? checkLine(frame, input.short, 'short axis') : null;
  if (input.roi !== undefined) {
    assert(!input.roi || stats, 'The density region could not be measured.');
    next.roi = input.roi ? { ...checkRoi(frame, input.roi), stats } : null;
  }
  if (input.extent !== undefined)
    next.extent = input.extent ? checkExtent(series, input.extent) : null;
  assert(next.long || next.roi, 'A finding needs a size or a density measurement.');
  if (input.status !== undefined) {
    assert(FINDING_STATUSES.includes(input.status), 'Invalid review status.');
    next.status = input.status;
    next.reviewedBy = input.status === 'unreviewed' ? null : reviewer;
    next.reviewedAt = input.status === 'unreviewed' ? null : new Date().toISOString();
  }
  return withSizes(series, frame, next);
}

export async function mutateFindings(owner, id, action) {
  return withLock(studyDir(owner, id), async () => {
    const study = await loadStudy(owner, id),
      current = await readFindings(owner, id);
    const records = await action(current.records, study);
    assert(records.length <= 2000, 'The study finding limit was reached.', 413);
    const next = { revision: current.revision + 1, records };
    await writeJson(findingsFile(owner, id), next);
    return next;
  });
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export async function saveFindingImage(owner, id, findingId, bytes) {
  assert(bytes.length <= 3 * 1024 * 1024, 'The key image is too large.', 413);
  assert(bytes.subarray(0, 8).equals(PNG_SIGNATURE), 'Key images must be PNG.', 415);
  const { records } = await readFindings(owner, id);
  assert(
    records.some((r) => r.id === findingId),
    'Finding not found.',
    404,
  );
  const file = imageFile(owner, id, findingId);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, bytes, { mode: 0o600 });
  await fs.rename(temp, file);
}

export async function readFindingImage(owner, id, findingId) {
  try {
    return await fs.readFile(imageFile(owner, id, findingId));
  } catch (e) {
    if (e.code === 'ENOENT') throw new AppError('No key image for this finding.', 404);
    throw e;
  }
}

export const removeFindingImage = (owner, id, findingId) =>
  fs.rm(imageFile(owner, id, findingId), { force: true });
