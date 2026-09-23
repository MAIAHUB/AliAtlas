import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  dataRoot,
  readJson,
  writeJson,
  jobPath,
  loadStudy,
  getSeries,
  seriesDir,
} from '../lib/storage.js';
import { runProcess } from '../lib/process.js';
import { labelsFromNifti } from '../lib/segmentation.js';
import { mutateAnnotations } from '../lib/annotations.js';
import { segmentationEligibility } from '../lib/dicom.js';
import { assert } from '../lib/errors.js';
import { statsKey, learn, estimateFor } from '../lib/job-timing.js';

const controller = new AbortController();
let stopped = false,
  metadata,
  heartbeatTimer;
const python = process.env.ATLAS_PYTHON_BIN || 'python3';
const command = process.env.ATLAS_TOTALSEG_BIN || 'TotalSegmentator';
const lockFile = path.join(dataRoot(), 'worker.lock');
const heartbeatFile = path.join(dataRoot(), 'worker.json');
// Learned seconds-per-slice for each task on this machine, used for time estimates.
const statsFile = path.join(dataRoot(), 'job-stats.json');
const device = () => process.env.ATLAS_AI_DEVICE || 'cpu';
const fast = () => process.env.ATLAS_AI_FAST === 'true';
const now = () => new Date().toISOString();
process.env.TOTALSEG_HOME_DIR ||= path.join(dataRoot(), 'models');
async function heartbeat(ready, message) {
  await writeJson(heartbeatFile, {
    ready,
    message,
    version: metadata?.version,
    updatedAt: new Date().toISOString(),
  });
}
async function acquireLock() {
  await fs.mkdir(dataRoot(), { recursive: true, mode: 0o700 });
  try {
    await fs.writeFile(lockFile, JSON.stringify({ pid: process.pid, host: os.hostname() }), {
      flag: 'wx',
      mode: 0o600,
    });
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const existing = await readJson(lockFile);
    let alive = true;
    try {
      process.kill(existing.pid, 0);
    } catch (error) {
      if (error.code === 'ESRCH') alive = false;
    }
    assert(
      existing.host === os.hostname() && !alive,
      'Another worker owns this data directory. Run one worker per deployment.',
      409,
    );
    await fs.unlink(lockFile);
    await acquireLock();
  }
}
async function update(job, changes) {
  Object.assign(job, changes, { updatedAt: new Date().toISOString() });
  await writeJson(jobPath(job.id), job);
}
async function runJob(job) {
  const work = path.join(dataRoot(), 'jobs', job.id),
    input = path.join(work, 'input');
  let stats = await readJson(statsFile).catch(() => ({}));
  const step = (id) => job.steps.find((s) => s.id === id);
  try {
    const study = await loadStudy(job.owner, job.studyId),
      series = getSeries(study, job.seriesId);
    const frames = series.frames.length;
    await update(job, {
      status: 'running',
      startedAt: now(),
      frameCount: frames,
      device: device(),
      message: 'Preparing scan',
      steps: [
        { id: 'prepare', label: 'Preparing scan', startedAt: now() },
        ...job.tasks.map((task) => ({
          id: task,
          label: `Segmenting ${task.replaceAll('_', ' ')}`,
          estimated: true,
          estimateSeconds: estimateFor(stats, statsKey(task, device(), fast()), frames),
        })),
        { id: 'save', label: 'Saving labels' },
      ],
    });
    const issue = segmentationEligibility(series);
    assert(!issue, issue, 422);
    await fs.mkdir(input, { recursive: true, mode: 0o700 });
    for (const fileId of new Set(series.frames.map((f) => f.fileId))) {
      const src = path.join(seriesDir(job.owner, job.studyId, job.seriesId), `${fileId}.dcm`);
      await fs.copyFile(src, path.join(input, `${fileId}.dcm`));
    }
    step('prepare').finishedAt = now();
    const records = [];
    for (let index = 0; index < job.tasks.length; index++) {
      const task = job.tasks[index];
      assert(
        metadata.maps[task],
        `Installed TotalSegmentator does not support ${task}. Update the model runtime.`,
        422,
      );
      step(task).startedAt = now();
      await update(job, {
        progress: Math.round((index / job.tasks.length) * 90),
        message: `Segmenting ${task.replaceAll('_', ' ')} (${index + 1}/${job.tasks.length})`,
      });
      const output = path.join(work, `${task}.nii.gz`);
      const args = [
        '-i',
        input,
        '-o',
        output,
        '--task',
        task,
        '--ml',
        '--device',
        process.env.ATLAS_AI_DEVICE || 'cpu',
      ];
      if (task === 'total' && process.env.ATLAS_AI_FAST === 'true') args.push('--fast');
      await runProcess(command, args, {
        timeout: Number(process.env.ATLAS_AI_TIMEOUT_MS) || 1800000,
        signal: controller.signal,
      });
      assert(
        (await fs.stat(output)).size <= 512 * 1024 * 1024,
        'The model output exceeds the processing limit.',
        413,
      );
      await update(job, {
        message: `Aligning ${task.replaceAll('_', ' ')} labels to DICOM slices`,
      });
      records.push(
        ...(await labelsFromNifti(await fs.readFile(output), series, metadata.maps[task], {
          task,
          version: metadata.version,
        })),
      );
      await fs.unlink(output);
      const done = step(task);
      done.finishedAt = now();
      stats = learn(
        stats,
        statsKey(task, device(), fast()),
        (Date.parse(done.finishedAt) - Date.parse(done.startedAt)) / 1000,
        frames,
      );
      await writeJson(statsFile, stats).catch(() => {});
      await update(job, {});
    }
    step('save').startedAt = now();
    await update(job, { message: 'Saving labels' });
    assert(
      records.length,
      'The model found no supported structures in this series. Review the scan and selected region.',
      422,
    );
    await mutateAnnotations(job.owner, job.studyId, (old) => [
      ...old.filter((r) => r.seriesId !== job.seriesId || r.source !== 'model' || r.reviewed),
      ...records.filter(
        (r) =>
          !old.some(
            (o) =>
              o.reviewed &&
              o.seriesId === r.seriesId &&
              o.frameId === r.frameId &&
              o.structure === r.structure,
          ),
      ),
    ]);
    step('save').finishedAt = now();
    await update(job, {
      status: 'completed',
      progress: 100,
      finishedAt: now(),
      message: `${records.length} slice labels ready for review`,
      labelCount: records.length,
    });
  } catch (error) {
    await update(job, {
      status: 'failed',
      finishedAt: now(),
      message: stopped
        ? 'Processing stopped. Start a new job after the worker restarts.'
        : error.code === 'ENOENT'
          ? 'The model executable or output is missing. Check the server model installation.'
          : `${error.message} Check the model installation, available memory, and scan geometry.`,
      progress: 0,
    });
    // Do not log subprocess output, filenames, or DICOM metadata: they may contain patient information.
    console.error('Segmentation job failed:', job.id, error.code || error.name);
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}
async function jobFiles() {
  return (await fs.readdir(path.join(dataRoot(), 'jobs')).catch(() => [])).filter((f) =>
    /^[a-f0-9-]{36}\.json$/.test(f),
  );
}
async function main() {
  await acquireLock();
  try {
    // Read the class mapping from the exact installed model package, avoiding version-drift label errors.
    metadata = JSON.parse(
      await runProcess(python, [
        '-c',
        'import json, importlib.metadata; from totalsegmentator.config import setup_totalseg, get_totalseg_dir; from totalsegmentator.map_to_binary import class_map; config=setup_totalseg(); config["send_usage_stats"]=False; (get_totalseg_dir()/"config.json").write_text(json.dumps(config)); print(json.dumps({"version": importlib.metadata.version("TotalSegmentator"), "maps": class_map}))',
      ]),
    );
    await runProcess(command, ['--help'], { timeout: 60000 });
    await heartbeat(true, 'Anatomy worker ready');
    heartbeatTimer = setInterval(
      () => heartbeat(true, 'Anatomy worker ready').catch(() => {}),
      5000,
    );
    for (const file of await jobFiles()) {
      const job = await readJson(path.join(dataRoot(), 'jobs', file));
      if (job.status === 'running')
        await update(job, {
          status: 'failed',
          progress: 0,
          finishedAt: job.updatedAt,
          message: 'Processing was interrupted by a server restart. Start a new job.',
        });
    }
    console.log(`AliAtlas anatomy worker ready (TotalSegmentator ${metadata.version})`);
    while (!stopped) {
      const jobs = [];
      for (const file of await jobFiles()) {
        const job = await readJson(path.join(dataRoot(), 'jobs', file));
        if (job.status === 'queued') jobs.push(job);
      }
      jobs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      if (jobs[0]) await runJob(jobs[0]);
      else await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  } catch (e) {
    await heartbeat(
      false,
      'Model runtime is unavailable. Install TotalSegmentator and check worker configuration.',
    );
    console.error('Worker could not start:', e.code || e.name);
    process.exitCode = 1;
  } finally {
    clearInterval(heartbeatTimer);
    await heartbeat(false, 'Anatomy worker offline');
    await fs.unlink(lockFile).catch(() => {});
  }
}
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    stopped = true;
    controller.abort();
  });
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
