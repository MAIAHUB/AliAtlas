import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { assert } from './errors.js';
import { studyDir, loadStudy, getSeries, readJson, writeJson, withLock } from './storage.js';

export const annotationFile = (owner, id) => path.join(studyDir(owner, id), 'annotations.json');
export function validateAnnotation(study, input, { source = 'manual' } = {}) {
  assert(input && typeof input === 'object', 'Invalid annotation.');
  const series = getSeries(study, input.seriesId),
    frame = series.frames.find((f) => f.id === input.frameId);
  assert(frame, 'The annotation must reference a frame in this series.');
  assert(
    typeof input.label === 'string' &&
      input.label.trim().length > 0 &&
      input.label.trim().length <= 80,
    'Use a label between 1 and 80 characters.',
  );
  assert(
    Array.isArray(input.pixel) &&
      input.pixel.length === 2 &&
      input.pixel.every(Number.isFinite) &&
      input.pixel[0] >= 0 &&
      input.pixel[0] <= frame.columns - 1 &&
      input.pixel[1] >= 0 &&
      input.pixel[1] <= frame.rows - 1,
    'The label anchor must be inside the image.',
  );
  assert(['left', 'right'].includes(input.side), 'Choose a left or right label position.');
  assert(/^#[0-9a-f]{6}$/i.test(input.color), 'Invalid label color.');
  return {
    id: randomUUID(),
    seriesId: series.id,
    frameId: frame.id,
    label: input.label.trim(),
    pixel: input.pixel,
    side: input.side,
    color: input.color,
    source,
    reviewed: source === 'manual',
    createdAt: new Date().toISOString(),
  };
}
export async function mutateAnnotations(owner, id, action) {
  return withLock(studyDir(owner, id), async () => {
    const study = await loadStudy(owner, id),
      current = await readJson(annotationFile(owner, id));
    const records = await action(current.records, study);
    assert(records.length <= 100000, 'The study annotation limit was reached.', 413);
    const next = { revision: current.revision + 1, records };
    await writeJson(annotationFile(owner, id), next);
    return next;
  });
}
export function exportAnnotations(study, records) {
  return {
    format: 'aliatlas.annotations.v1',
    studyInstanceUID: study.studyInstanceUID,
    exportedAt: new Date().toISOString(),
    records: records.map((r) => {
      const series = getSeries(study, r.seriesId),
        frame = series.frames.find((f) => f.id === r.frameId);
      return {
        seriesInstanceUID: series.seriesInstanceUID,
        sopInstanceUID: frame.sopInstanceUID,
        frameNumber: frame.frameNumber,
        label: r.label,
        pixel: r.pixel,
        color: r.color,
        side: r.side,
        source: r.source,
        reviewed: r.reviewed,
      };
    }),
  };
}
export function importAnnotations(study, bundle) {
  assert(
    bundle?.format === 'aliatlas.annotations.v1' &&
      bundle.studyInstanceUID === study.studyInstanceUID,
    'The annotation file belongs to a different study or format.',
  );
  assert(
    Array.isArray(bundle.records) && bundle.records.length <= 100000,
    'Invalid annotation records.',
  );
  return bundle.records.map((record) => {
    const candidates = study.series
      .filter((s) => s.seriesInstanceUID === record.seriesInstanceUID)
      .flatMap((series) =>
        series.frames
          .filter(
            (f) =>
              f.sopInstanceUID === record.sopInstanceUID && f.frameNumber === record.frameNumber,
          )
          .map((frame) => ({ series, frame })),
      );
    assert(
      candidates.length === 1,
      'An imported label references a missing or ambiguous DICOM frame.',
    );
    const { series, frame } = candidates[0];
    return validateAnnotation(
      study,
      { ...record, seriesId: series.id, frameId: frame.id },
      { source: 'imported' },
    );
  });
}
