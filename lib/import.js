import Busboy from 'busboy';
import yauzl from 'yauzl';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppError, assert } from './errors.js';
import { acquisitionRuns, parseDicom, seriesKey, segmentationEligibility } from './dicom.js';
import { sortFrames, planeOf, hasGeometry } from './geometry.js';
import { dataRoot, ownerDir, listStudies, writeJson } from './storage.js';
import { runProcess } from './process.js';

export const IMPORT_LIMITS = {
  request: 512 * 1024 * 1024,
  file: 64 * 1024 * 1024,
  expanded: 1024 * 1024 * 1024,
  files: 2000,
  frames: 6000,
};
function limiter(max, increment = () => {}) {
  let count = 0;
  return new Transform({
    transform(chunk, _enc, callback) {
      count += chunk.length;
      if (count > max) return callback(new AppError('Upload exceeds its size limit.', 413));
      try {
        increment(chunk.length);
        callback(null, chunk);
      } catch (e) {
        callback(e);
      }
    },
  });
}

async function receiveFiles(request, temp) {
  assert(
    request.headers.get('content-type')?.startsWith('multipart/form-data'),
    'Choose DICOM files, a folder, or a ZIP archive.',
    415,
  );
  assert(
    Number(request.headers.get('content-length') || 0) <= IMPORT_LIMITS.request,
    'Upload exceeds 512 MB. Import a smaller series.',
    413,
  );
  let parser;
  try {
    parser = Busboy({
      headers: Object.fromEntries(request.headers),
      limits: {
        files: IMPORT_LIMITS.files,
        fileSize: IMPORT_LIMITS.request,
        fields: 0,
        parts: IMPORT_LIMITS.files,
      },
    });
  } catch {
    throw new AppError('Invalid multipart upload.');
  }
  const files = [],
    writes = [];
  let failure;
  parser.on('file', (_field, stream, info) => {
    const filePath = path.join(temp, randomUUID());
    const isZip = /\.zip$/i.test(info.filename);
    stream.on('limit', () => {
      failure = new AppError('A file exceeds the upload limit.', 413);
    });
    const write = pipeline(
      stream,
      limiter(isZip ? IMPORT_LIMITS.request : IMPORT_LIMITS.file),
      createWriteStream(filePath, { mode: 0o600 }),
    ).catch((e) => {
      failure = e;
    });
    writes.push(write);
    files.push({ path: filePath, isZip });
  });
  parser.on('filesLimit', () => {
    failure = new AppError('Too many files. Maximum 2000 per import.', 413);
  });
  parser.on('partsLimit', () => {
    failure = new AppError('Too many upload parts.', 413);
  });
  try {
    await pipeline(Readable.fromWeb(request.body), limiter(IMPORT_LIMITS.request), parser);
  } catch (e) {
    failure = e;
  }
  await Promise.all(writes);
  if (failure) throw failure;
  assert(files.length, 'No files were selected.');
  return files;
}

export async function extractZip(filePath, temp, budget) {
  const archive = await new Promise((resolve, reject) =>
    yauzl.open(filePath, { lazyEntries: true, validateEntrySizes: true }, (e, z) =>
      e ? reject(e) : resolve(z),
    ),
  );
  const files = [];
  try {
    await new Promise((resolve, reject) => {
      let settled = false;
      const fail = (e) => {
        if (settled) return;
        settled = true;
        archive.close();
        reject(e);
      };
      archive.on('error', fail);
      archive.on('end', () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      });
      archive.on('entry', (entry) => {
        (async () => {
          budget.entries++;
          assert(budget.entries <= 10000, 'Archive has too many entries.', 413);
          if (
            /\/$/.test(entry.fileName) ||
            /(^|\/)__MACOSX\//.test(entry.fileName) ||
            /(^|\/)\.[^/]+$/.test(entry.fileName)
          ) {
            archive.readEntry();
            return;
          }
          assert(
            !(entry.generalPurposeBitFlag & 1),
            'Encrypted ZIP archives are not supported.',
            422,
          );
          assert(entry.uncompressedSize <= IMPORT_LIMITS.file, 'A ZIP entry exceeds 64 MB.', 413);
          assert(
            files.length + budget.files < IMPORT_LIMITS.files,
            'Archive contains too many files.',
            413,
          );
          // Entry names never become filesystem paths; every output receives a random ID.
          const target = path.join(temp, randomUUID());
          const input = await new Promise((res, rej) =>
            archive.openReadStream(entry, (e, s) => (e ? rej(e) : res(s))),
          );
          await pipeline(
            input,
            limiter(IMPORT_LIMITS.file, (n) => {
              budget.bytes += n;
              assert(budget.bytes <= IMPORT_LIMITS.expanded, 'Expanded archive exceeds 1 GB.', 413);
            }),
            createWriteStream(target, { mode: 0o600 }),
          );
          files.push({ path: target, isZip: false });
          archive.readEntry();
        })().catch(fail);
      });
      archive.readEntry();
    });
  } finally {
    archive.close();
  }
  budget.files += files.length;
  return files;
}

async function readImage(filePath) {
  const bytes = await fs.readFile(filePath);
  try {
    return { metadata: parseDicom(bytes), filePath };
  } catch (e) {
    if (e.code !== 'COMPRESSED_DICOM') throw e;
    const normalized = `${filePath}.decoded`;
    try {
      await runProcess(process.env.ATLAS_GDCM_BIN || 'gdcmconv', ['--raw', filePath, normalized], {
        timeout: 60_000,
      });
    } catch (error) {
      if (error.code === 'ENOENT') throw e;
      throw new AppError(
        'GDCM could not decode this compressed DICOM image.',
        422,
        'DECODE_FAILED',
      );
    }
    assert(
      (await fs.stat(normalized)).size <= IMPORT_LIMITS.file,
      'Decoded image exceeds 64 MB.',
      413,
    );
    return { metadata: parseDicom(await fs.readFile(normalized)), filePath: normalized };
  }
}

async function splitStoredSeries(staged, study, series) {
  const runs = acquisitionRuns(series.frames);
  if (runs.length === 1) return [series];
  const result = [];
  for (let index = 0; index < runs.length; index++) {
    const id = index === 0 ? series.id : randomUUID();
    const next = {
      ...series,
      id,
      description: `${series.description} (acquisition ${index + 1})`,
      frames: runs[index],
    };
    if (index > 0) {
      const source = path.join(staged, study.id, 'series', series.id);
      const destination = path.join(staged, study.id, 'series', id);
      await fs.mkdir(destination, { recursive: true, mode: 0o700 });
      for (const fileId of new Set(next.frames.map((frame) => frame.fileId)))
        await fs.rename(
          path.join(source, `${fileId}.dcm`),
          path.join(destination, `${fileId}.dcm`),
        );
    }
    result.push(next);
  }
  return result;
}

export const importStudy = (request, owner, options) =>
  importFiles(owner, (temp) => receiveFiles(request, temp), options);

// `collect` places the incoming files in the temporary directory. `beforeCommit`
// receives every validated study with its original DICOM files (e.g. for archiving)
// and may abort the import by throwing; its result is returned as `archive`.
export async function importFiles(owner, collect, { beforeCommit } = {}) {
  assert(
    (await listStudies(owner)).length < 20,
    'This workspace has 20 studies. Remove an old study before importing more.',
    409,
  );
  const temp = path.join(dataRoot(), 'imports', randomUUID());
  await fs.mkdir(temp, { recursive: true, mode: 0o700 });
  const staged = path.join(temp, 'studies');
  try {
    const incoming = await collect(temp),
      files = [],
      originals = new Map();
    const budget = { bytes: 0, files: incoming.filter((f) => !f.isZip).length, entries: 0 };
    for (const file of incoming) {
      if (file.isZip) {
        try {
          files.push(...(await extractZip(file.path, temp, budget)));
        } catch (e) {
          if (e instanceof AppError) throw e;
          throw new AppError('The ZIP archive is invalid or damaged.', 422, 'INVALID_ZIP');
        }
      } else files.push(file);
    }
    const studies = new Map(),
      seriesMaps = new Map(),
      seen = new Set(),
      warnings = [];
    let frameCount = 0,
      skipped = 0;
    for (let i = 0; i < files.length; i++) {
      let parsed;
      try {
        parsed = await readImage(files[i].path);
      } catch (e) {
        skipped++;
        if (warnings.length < 30)
          warnings.push(
            `File ${i + 1}: ${e instanceof AppError ? e.message : 'Could not read the image.'}`,
          );
        continue;
      }
      const { metadata: m, filePath } = parsed;
      const uidKey = `${m.studyInstanceUID}|${m.sopInstanceUID}`;
      if (seen.has(uidKey)) {
        skipped++;
        if (warnings.length < 30) warnings.push(`File ${i + 1}: duplicate SOP instance skipped.`);
        continue;
      }
      seen.add(uidKey);
      frameCount += m.frames.length;
      assert(
        frameCount <= IMPORT_LIMITS.frames,
        'Import exceeds 6000 frames. Split the upload.',
        413,
      );
      if (!studies.has(m.studyInstanceUID)) {
        assert(studies.size < 20, 'An import may contain at most 20 studies.', 413);
        studies.set(m.studyInstanceUID, {
          id: randomUUID(),
          studyInstanceUID: m.studyInstanceUID,
          title: 'CT study',
          createdAt: new Date().toISOString(),
          series: [],
        });
        seriesMaps.set(m.studyInstanceUID, new Map());
      }
      const study = studies.get(m.studyInstanceUID),
        bySeries = seriesMaps.get(m.studyInstanceUID),
        key = seriesKey(m);
      if (!bySeries.has(key)) {
        const series = {
          id: randomUUID(),
          seriesInstanceUID: m.seriesInstanceUID,
          description: m.seriesDescription,
          bodyPart: m.bodyPart,
          number: m.seriesNumber,
          imageType: m.imageType,
          frames: [],
        };
        bySeries.set(key, series);
        study.series.push(series);
      }
      const series = bySeries.get(key),
        fileId = randomUUID();
      const destination = path.join(staged, study.id, 'series', series.id);
      await fs.mkdir(destination, { recursive: true, mode: 0o700 });
      await fs.rename(filePath, path.join(destination, `${fileId}.dcm`));
      // Compressed input was transcoded; keep the source bytes for the archive.
      if (filePath !== files[i].path) originals.set(fileId, files[i].path);
      series.frames.push(...m.frames.map((f) => ({ ...f, id: randomUUID(), fileId })));
    }
    assert(
      studies.size > 0,
      warnings[0] || 'No supported CT images were found.',
      422,
      'NO_CT_IMAGES',
    );
    const result = [];
    for (const study of studies.values()) {
      study.series = (
        await Promise.all(study.series.map((series) => splitStoredSeries(staged, study, series)))
      ).flat();
      for (const series of study.series) {
        series.frames = sortFrames(series.frames);
        series.plane = planeOf(series.frames[0]);
        series.geometryKnown = series.frames.every(hasGeometry);
        series.segmentationIssue = segmentationEligibility(series);
      }
      study.series.sort((a, b) => a.number - b.number);
      study.title = study.series[0].bodyPart ? `${study.series[0].bodyPart} CT` : 'CT study';
      await writeJson(path.join(staged, study.id, 'study.json'), study);
      await writeJson(path.join(staged, study.id, 'annotations.json'), {
        revision: 0,
        records: [],
      });
      result.push({
        id: study.id,
        title: study.title,
        seriesCount: study.series.length,
        frameCount: study.series.reduce((n, s) => n + s.frames.length, 0),
      });
    }
    const archive = beforeCommit
      ? await beforeCommit(
          [...studies.values()].map((study) => ({
            studyId: study.id,
            studyInstanceUID: study.studyInstanceUID,
            files: study.series.flatMap((series) =>
              [...new Set(series.frames.map((f) => f.fileId))].map(
                (fileId) =>
                  originals.get(fileId) ||
                  path.join(staged, study.id, 'series', series.id, `${fileId}.dcm`),
              ),
            ),
          })),
        )
      : undefined;
    const destination = path.join(ownerDir(owner), 'studies');
    await fs.mkdir(destination, { recursive: true, mode: 0o700 });
    const committed = [];
    try {
      for (const study of studies.values()) {
        await fs.rename(path.join(staged, study.id), path.join(destination, study.id));
        committed.push(study.id);
      }
    } catch (error) {
      for (const id of committed)
        await fs.rm(path.join(destination, id), { recursive: true, force: true });
      throw error;
    }
    return { studies: result, importedFrames: frameCount, skipped, warnings, archive };
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}
