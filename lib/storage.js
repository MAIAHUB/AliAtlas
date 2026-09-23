import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppError, assert } from './errors.js';

export const dataRoot = () => path.resolve(process.env.ATLAS_DATA_DIR || 'data');
export function validId(id) {
  assert(typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id), 'Invalid resource ID.', 404);
  return id;
}
export function ownerDir(owner) {
  assert(/^[a-f0-9]{64}$/.test(owner), 'Invalid workspace.', 401);
  return path.join(dataRoot(), 'workspaces', owner);
}
export const studyDir = (owner, id) => path.join(ownerDir(owner), 'studies', validId(id));
export const seriesDir = (owner, studyId, seriesId) =>
  path.join(studyDir(owner, studyId), 'series', validId(seriesId));
export const jobPath = (id) => path.join(dataRoot(), 'jobs', `${validId(id)}.json`);
export async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(data), { mode: 0o600 });
  await fs.rename(temp, file);
}
export async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}
export async function loadStudy(owner, id) {
  try {
    return await readJson(path.join(studyDir(owner, id), 'study.json'));
  } catch (e) {
    if (e.code === 'ENOENT') throw new AppError('Study not found in this workspace.', 404);
    throw e;
  }
}
export function getSeries(study, id) {
  const series = study.series.find((s) => s.id === id);
  assert(series, 'Series not found.', 404);
  return series;
}
export async function listStudies(owner) {
  const root = path.join(ownerDir(owner), 'studies');
  const entries = await fs.readdir(root, { withFileTypes: true }).catch((e) => {
    if (e.code === 'ENOENT') return [];
    throw e;
  });
  const result = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name)) continue;
    // A folder without study.json is not a study (e.g. left by an interrupted write).
    const s = await loadStudy(owner, entry.name).catch((e) => {
      if (e.status === 404) return null;
      throw e;
    });
    if (!s) continue;
    result.push({
      id: s.id,
      title: s.title,
      createdAt: s.createdAt,
      seriesCount: s.series.length,
      frameCount: s.series.reduce((n, s) => n + s.frames.length, 0),
      bodyPart: s.series[0]?.bodyPart || 'CT',
    });
  }
  return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
// Locks an existing study directory. It never creates the directory: a request for a
// study that is not in this workspace must not leave an empty folder behind.
export async function withLock(directory, action) {
  const lock = path.join(directory, '.write-lock');
  let acquired = false;
  for (let i = 0; i < 100; i++) {
    try {
      await fs.mkdir(lock);
      acquired = true;
      break;
    } catch (e) {
      if (e.code === 'ENOENT') throw new AppError('Study not found in this workspace.', 404);
      if (e.code !== 'EEXIST') throw e;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  assert(acquired, 'This study is busy. Please retry.', 409);
  try {
    return await action();
  } finally {
    await fs.rmdir(lock).catch(() => {});
  }
}
export function publicStudy(study) {
  return {
    ...study,
    series: study.series.map((s) => ({
      ...s,
      frames: s.frames.map(
        ({
          pixelOffset,
          pixelLength,
          fileId,
          bitsAllocated,
          bitsStored,
          highBit,
          signed,
          littleEndian,
          ...f
        }) => f,
      ),
    })),
  };
}
