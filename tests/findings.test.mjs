import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import { inflateSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { makeDicom } from './fixtures.mjs';
import { importStudy } from '../lib/import.js';
import { loadStudy } from '../lib/storage.js';
import { lineLength, formatSize } from '../lib/measure.js';
import { encodeGrayPng } from '../lib/png.js';
import { validateFinding, updateFinding, mutateFindings, readFindings } from '../lib/findings.js';
import { updateReport, composeFindings } from '../lib/report.js';
import { detectAbnormalities, parseModelJson, visionStatus } from '../lib/vision.js';

const owner = 'c'.repeat(64);
const reviewer = { name: 'QA Reviewer', email: 'qa@example.test' };

async function withStudy(run) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'aliatlas-findings-'));
  const previous = process.env.ATLAS_DATA_DIR;
  process.env.ATLAS_DATA_DIR = directory;
  try {
    const form = new FormData();
    for (let index = 0; index < 3; index++)
      form.append(
        'files',
        new Blob([
          makeDicom({ index, rows: 32, columns: 40, spacing: [0.5, 0.8], values: undefined }),
        ]),
        `s${index}.dcm`,
      );
    const imported = await importStudy(
      new Request('http://127.0.0.1/api/studies/import', { method: 'POST', body: form }),
      owner,
    );
    const study = await loadStudy(owner, imported.studies[0].id);
    await run(study);
  } finally {
    process.env.ATLAS_DATA_DIR = previous;
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test('measures calipers in millimetres from row and column pixel spacing', () => {
  const frame = { spacing: [0.5, 0.8] };
  assert.equal(
    lineLength(frame, [
      [0, 0],
      [10, 0],
    ]).value,
    8,
  );
  assert.equal(
    lineLength(frame, [
      [0, 0],
      [0, 10],
    ]).value,
    5,
  );
  assert.equal(
    lineLength({}, [
      [0, 0],
      [3, 4],
    ]).unit,
    'px',
  );
  assert.equal(formatSize({ longMm: 23.44, shortMm: 15.06, unit: 'mm' }), '23.4 × 15.1 mm');
  assert.equal(formatSize({ longMm: 104.4, shortMm: null, unit: 'mm' }), '104 mm');
});

test('encodes a valid grayscale PNG', () => {
  const png = encodeGrayPng(3, 2, new Uint8Array([0, 128, 255, 10, 20, 30]));
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  assert.equal(png.readUInt32BE(16), 3);
  assert.equal(png.readUInt32BE(20), 2);
  const idat = png.indexOf('IDAT');
  const raw = inflateSync(png.subarray(idat + 4, idat + 4 + png.readUInt32BE(idat - 4)));
  assert.deepEqual([...raw], [0, 0, 128, 255, 0, 10, 20, 30]);
});

test('stores findings with server-computed sizes and gates report finalization on review', async () => {
  await withStudy(async (study) => {
    const series = study.series[0],
      frame = series.frames[1];
    assert.throws(
      () =>
        validateFinding(study, {
          seriesId: series.id,
          frameId: frame.id,
          label: 'Outside',
          category: 'mass',
          long: [
            [0, 0],
            [99, 0],
          ],
        }),
      /inside the image/,
    );
    const manual = validateFinding(study, {
      seriesId: series.id,
      frameId: frame.id,
      label: 'Liver lesion',
      category: 'mass',
      longMm: 999,
      long: [
        [5, 5],
        [15, 5],
      ],
      short: [
        [10, 1],
        [10, 9],
      ],
    });
    assert.equal(manual.longMm, 8);
    assert.equal(manual.shortMm, 4);
    assert.equal(manual.status, 'confirmed');
    const ai = validateFinding(
      study,
      {
        seriesId: series.id,
        frameId: series.frames[2].id,
        label: 'Possible nodule',
        category: 'nodule',
        confidence: 4,
        long: [
          [1, 1],
          [4, 1],
        ],
      },
      { source: 'ai' },
    );
    assert.equal(ai.status, 'unreviewed');
    assert.equal(ai.confidence, 1);
    await mutateFindings(owner, study.id, () => [manual, ai]);
    await assert.rejects(
      updateReport(owner, study.id, { impression: 'Liver mass.', status: 'final' }, reviewer),
      /Review 1 AI suggestion/,
    );
    await mutateFindings(owner, study.id, (records) =>
      records.map((r) =>
        r.id === ai.id ? updateFinding(study, r, { status: 'rejected' }, reviewer) : r,
      ),
    );
    const final = await updateReport(
      owner,
      study.id,
      { impression: 'Liver mass.', status: 'final' },
      reviewer,
    );
    assert.equal(final.status, 'final');
    assert.equal(final.finalizedBy.email, reviewer.email);
    await assert.rejects(
      updateReport(owner, study.id, { impression: 'Changed' }, reviewer),
      /Reopen it/,
    );
    const { records } = await readFindings(owner, study.id);
    const text = composeFindings(study, records);
    // The synthetic series has no contrast information, so sizes are approximate.
    assert.match(text, /Liver lesion \(mass \/ tumour\).*image 2\/3: ≈ 8\.0 × 4\.0 mm/);
    assert.doesNotMatch(text, /Possible nodule/);
  });
});

test('sends only rendered pixels to b.ai and keeps well-formed suggestions', async () => {
  await withStudy(async (study) => {
    const series = study.series[0];
    const env = ['BAI_API_KEY', 'BAI_BASE_URL', 'BAI_MODEL'].map((k) => [k, process.env[k]]);
    let received;
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received = { url: req.url, auth: req.headers.authorization, body: JSON.parse(body) };
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  content:
                    '```json\n{"findings":[{"image":2,"label":"Hypodense mass","category":"mass","description":"Round lesion.","confidence":0.7,"long":[[5,5],[15,5]],"short":[[10,1],[10,9]]},{"image":9,"label":"Bad","long":[[0,0],[1,1]]},{"image":1,"label":"No axis"}],"summary":"One mass."}\n```',
                },
              },
            ],
          }),
        );
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      delete process.env.BAI_API_KEY;
      assert.equal(visionStatus().configured, false);
      await assert.rejects(
        detectAbnormalities(owner, study.id, {
          seriesId: series.id,
          frameIds: [series.frames[0].id],
        }),
        /BAI_API_KEY/,
      );
      process.env.BAI_API_KEY = 'test-key';
      process.env.BAI_BASE_URL = `http://127.0.0.1:${server.address().port}/v1/`;
      process.env.BAI_MODEL = 'vision-test';
      const result = await detectAbnormalities(owner, study.id, {
        seriesId: series.id,
        frameIds: series.frames.map((f) => f.id),
        window: { center: 40, width: 400 },
      });
      assert.equal(received.url, '/v1/chat/completions');
      assert.equal(received.auth, 'Bearer test-key');
      assert.equal(received.body.model, 'vision-test');
      const parts = received.body.messages[1].content;
      const images = parts.filter((p) => p.type === 'image_url');
      assert.equal(images.length, 3);
      assert.match(images[0].image_url.url, /^data:image\/png;base64,/);
      const sent = JSON.stringify(received.body);
      assert.ok(!sent.includes(study.studyInstanceUID), 'study UID must not be sent');
      assert.ok(!sent.includes(series.seriesInstanceUID), 'series UID must not be sent');
      assert.equal(result.inputs.length, 1);
      assert.equal(result.dropped, 2);
      assert.equal(result.inputs[0].frameId, series.frames[1].id);
      assert.equal(result.summary, 'One mass.');
      const stored = validateFinding(study, result.inputs[0], { source: 'ai' });
      assert.equal(stored.longMm, 8);
    } finally {
      server.close();
      for (const [k, v] of env) v === undefined ? delete process.env[k] : (process.env[k] = v);
    }
  });
});

test('reads JSON even when the model wraps it in prose', () => {
  assert.deepEqual(parseModelJson('Here you go: {"findings":[]} thanks'), { findings: [] });
  assert.throws(() => parseModelJson('no json'), /unreadable/);
});

test('a write to a study that is not in the workspace leaves no folder behind', async () => {
  const { listStudies, studyDir } = await import('../lib/storage.js');
  await withStudy(async (study) => {
    const stranger = 'd'.repeat(64);
    await assert.rejects(
      mutateFindings(stranger, study.id, (records) => records),
      /Study not found/,
    );
    await assert.rejects(fs.stat(studyDir(stranger, study.id)), { code: 'ENOENT' });
    // A stray folder without study.json (from older versions) does not break the list.
    await fs.mkdir(studyDir(owner, '00000000-0000-4000-8000-000000000000'), { recursive: true });
    assert.deepEqual(
      (await listStudies(owner)).map((s) => s.id),
      [study.id],
    );
  });
});
