import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { makeDicom, makeNifti } from './fixtures.mjs';
import { parseDicom } from '../lib/dicom.js';
import { studyDir, seriesDir, writeJson, readJson, jobPath } from '../lib/storage.js';

test(
  'Node worker consumes a queued job and persists slice-aligned labels from a fixture model process',
  { timeout: 20000 },
  async () => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), 'aliatlas-worker-'));
    const previous = process.env.ATLAS_DATA_DIR;
    process.env.ATLAS_DATA_DIR = directory;
    const owner = 'a'.repeat(64),
      studyId = randomUUID(),
      seriesId = randomUUID(),
      jobId = randomUUID();
    let child;
    try {
      const frames = [];
      for (let index = 0; index < 3; index++) {
        const bytes = makeDicom({ index, rows: 4, columns: 4 }),
          frame = { ...parseDicom(bytes).frames[0], id: randomUUID(), fileId: randomUUID() };
        frames.push(frame);
        await fs.mkdir(seriesDir(owner, studyId, seriesId), { recursive: true });
        await fs.writeFile(
          path.join(seriesDir(owner, studyId, seriesId), `${frame.fileId}.dcm`),
          bytes,
        );
      }
      await writeJson(path.join(studyDir(owner, studyId), 'study.json'), {
        id: studyId,
        series: [{ id: seriesId, frames }],
      });
      await writeJson(path.join(studyDir(owner, studyId), 'annotations.json'), {
        revision: 0,
        records: [],
      });
      await writeJson(jobPath(jobId), {
        id: jobId,
        owner,
        studyId,
        seriesId,
        region: 'wholebody',
        tasks: ['total'],
        status: 'queued',
        createdAt: new Date().toISOString(),
      });
      const values = new Uint8Array(48);
      for (let z = 0; z < 3; z++) for (const i of [0, 1, 4, 5]) values[z * 16 + i] = 1;
      const map = path.join(directory, 'fixture.nii');
      await fs.writeFile(map, makeNifti({ values }));
      const runtime = path.join(directory, 'fixture-runtime.cjs'),
        model = path.join(directory, 'fixture-model.cjs');
      await fs.writeFile(
        runtime,
        '#!/usr/bin/env node\nconsole.log(JSON.stringify({version:"synthetic-test-only",maps:{total:{1:"liver"}}}));\n',
        { mode: 0o700 },
      );
      await fs.writeFile(
        model,
        '#!/usr/bin/env node\nconst fs=require("node:fs");const args=process.argv.slice(2);if(args.includes("--help")){console.log("Fixture only");process.exit(0);}fs.copyFileSync(process.env.ATLAS_FIXTURE_MASK,args[args.indexOf("-o")+1]);\n',
        { mode: 0o700 },
      );
      child = spawn(process.execPath, ['scripts/worker.mjs'], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          ATLAS_PYTHON_BIN: runtime,
          ATLAS_TOTALSEG_BIN: model,
          ATLAS_FIXTURE_MASK: map,
        },
        stdio: 'pipe',
      });
      let result;
      for (let i = 0; i < 120; i++) {
        result = await readJson(jobPath(jobId));
        if (['completed', 'failed'].includes(result.status)) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.equal(result.status, 'completed', result.message);
      const annotations = await readJson(path.join(studyDir(owner, studyId), 'annotations.json'));
      assert.equal(annotations.records.length, 3);
      assert.deepEqual(
        annotations.records.map((r) => r.frameId),
        frames.map((f) => f.id),
      );
      assert.equal(annotations.records[0].model.version, 'synthetic-test-only');
      // Timing is recorded per step and learned for later estimates.
      assert.ok(Date.parse(result.finishedAt) >= Date.parse(result.startedAt));
      assert.deepEqual(
        result.steps.map((s) => s.id),
        ['prepare', 'total', 'save'],
      );
      assert.ok(result.steps.every((s) => s.startedAt && s.finishedAt));
      assert.equal(result.steps[1].estimateSeconds, null);
      assert.equal(result.frameCount, 3);
      const stats = await readJson(path.join(directory, 'job-stats.json'));
      assert.equal(Object.values(stats)[0].runs, 1);
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
      child = null;
      assert.equal((await readJson(path.join(directory, 'worker.json'))).ready, false);
    } finally {
      if (child) {
        child.kill('SIGKILL');
        await once(child, 'exit').catch(() => {});
      }
      if (previous === undefined) delete process.env.ATLAS_DATA_DIR;
      else process.env.ATLAS_DATA_DIR = previous;
      await fs.rm(directory, { recursive: true, force: true });
    }
  },
);
