import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { assert } from './errors.js';
import {
  dataRoot,
  jobPath,
  readJson,
  writeJson,
  loadStudy,
  getSeries,
  studyDir,
  withLock,
} from './storage.js';
import { segmentationEligibility } from './dicom.js';
import { REGIONS, tasksForRegion } from './catalog.js';

export async function workerStatus() {
  if (process.env.ATLAS_AI_ENABLED !== 'true')
    return { ready: false, message: 'Automatic labeling is not enabled on this server.' };
  const heartbeat = await readJson(path.join(dataRoot(), 'worker.json')).catch(() => null);
  if (!heartbeat || Date.now() - Date.parse(heartbeat.updatedAt) > 30000)
    return {
      ready: false,
      message: 'The anatomy worker is offline. Start the worker to enable automatic labels.',
    };
  return { ready: heartbeat.ready, message: heartbeat.message, version: heartbeat.version };
}
export async function listJobs(owner, studyId) {
  const entries = await fs.readdir(path.join(dataRoot(), 'jobs')).catch((e) => {
    if (e.code === 'ENOENT') return [];
    throw e;
  });
  const jobs = [];
  for (const entry of entries.filter((e) => /^[a-f0-9-]{36}\.json$/.test(e))) {
    const job = await readJson(path.join(dataRoot(), 'jobs', entry));
    if (job.owner === owner && (!studyId || job.studyId === studyId)) jobs.push(job);
  }
  return jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
export const publicJob = ({ owner, ...job }) => job;
export async function enqueueJob(owner, studyId, seriesId, region) {
  const status = await workerStatus();
  assert(status.ready, status.message, 503, 'AI_UNAVAILABLE');
  assert(
    REGIONS.some((r) => r.id === region),
    'Choose a supported CT region.',
  );
  return withLock(studyDir(owner, studyId), async () => {
    const study = await loadStudy(owner, studyId),
      series = getSeries(study, seriesId);
    const issue = segmentationEligibility(series);
    assert(!issue, issue, 422);
    const pending = (await listJobs(owner)).filter((j) => ['queued', 'running'].includes(j.status));
    assert(
      !pending.some((j) => j.studyId === studyId && j.seriesId === seriesId),
      'This series is already being processed.',
      409,
    );
    assert(pending.length < 3, 'This workspace already has three queued jobs.', 429);
    const job = {
      id: randomUUID(),
      owner,
      studyId,
      seriesId,
      region,
      tasks: tasksForRegion(region),
      status: 'queued',
      progress: 0,
      message: 'Waiting for the anatomy worker',
      createdAt: new Date().toISOString(),
    };
    await writeJson(jobPath(job.id), job);
    return publicJob(job);
  });
}
