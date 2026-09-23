import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { makeDicom } from './fixtures.mjs';
import { importStudy } from '../lib/import.js';
import { autoLabelImportedStudies } from '../lib/jobs.js';
import { loadStudy, readJson, writeJson, jobPath, seriesDir } from '../lib/storage.js';

test('imports separate acquisition runs and automatically queues the longest stack', async () => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'aliatlas-import-'));
  const before = Object.fromEntries(
    ['ATLAS_DATA_DIR', 'ATLAS_AI_ENABLED', 'ATLAS_AUTO_LABEL_ON_IMPORT'].map((key) => [
      key,
      process.env[key],
    ]),
  );
  process.env.ATLAS_DATA_DIR = directory;
  process.env.ATLAS_AI_ENABLED = 'true';
  process.env.ATLAS_AUTO_LABEL_ON_IMPORT = 'true';
  const owner = 'b'.repeat(64);
  try {
    const form = new FormData();
    const positions = [0, -2, -4, -6, 6, 4, 2, 0, -2, -4];
    for (let index = 0; index < positions.length; index++)
      form.append(
        'files',
        new Blob([makeDicom({ index, position: [0, 0, positions[index]] })]),
        `slice-${index}.dcm`,
      );
    const request = new Request('http://127.0.0.1:3000/api/studies/import', {
      method: 'POST',
      body: form,
    });
    const imported = await importStudy(request, owner);
    assert.equal(imported.importedFrames, positions.length);
    assert.equal(imported.studies[0].seriesCount, 2);
    const study = await loadStudy(owner, imported.studies[0].id);
    assert.deepEqual(
      study.series.map((series) => series.frames.length),
      [4, 6],
    );
    assert.ok(study.series.every((series) => !series.segmentationIssue));
    for (const series of study.series)
      for (const frame of series.frames)
        assert.ok(
          (await fs.stat(path.join(seriesDir(owner, study.id, series.id), `${frame.fileId}.dcm`)))
            .size > 0,
        );
    await writeJson(path.join(directory, 'worker.json'), {
      ready: true,
      message: 'Anatomy worker ready',
      updatedAt: new Date().toISOString(),
    });
    const [auto] = await autoLabelImportedStudies(owner, imported.studies);
    assert.equal(auto.status, 'queued');
    assert.equal(auto.seriesId, study.series[1].id);
    assert.equal((await readJson(jobPath(auto.jobId))).seriesId, study.series[1].id);
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(directory, { recursive: true, force: true });
  }
});
