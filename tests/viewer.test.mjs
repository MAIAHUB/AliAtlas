import test from 'node:test';
import assert from 'node:assert/strict';
import { SliceLoader, prefetchOrder, decodeBatch } from '../lib/slice-loader.js';
import { layoutLabels } from '../lib/label-layout.js';

const frames = Array.from({ length: 40 }, (_, i) => ({ id: `f${i}`, rows: 4, columns: 4 }));
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('prefetches outward from the focused slice, leaning in the scroll direction', () => {
  assert.deepEqual(prefetchOrder(7, 3, 1), [3, 4, 2, 5, 1, 6, 0]);
  assert.deepEqual(prefetchOrder(7, 3, -1), [3, 2, 4, 1, 5, 0, 6]);
  assert.deepEqual(prefetchOrder(4, 0, 1), [0, 1, 2, 3]);
});

test('decodes 16-bit and float batches and rejects truncated data', () => {
  const pair = frames.slice(0, 2);
  const ints = decodeBatch(new Int16Array([...Array(32).keys()]).buffer, 'int16-le', pair);
  assert.equal(ints[1][0], 16);
  assert.ok(ints[0] instanceof Int16Array);
  const floats = decodeBatch(new Float32Array(32).fill(1.5).buffer, 'float32-le', pair);
  assert.equal(floats[1][15], 1.5);
  assert.throws(() => decodeBatch(new ArrayBuffer(10), 'int16-le', pair), /incomplete/);
});

test('loads the focused slice first, then the whole series in batches', async () => {
  const requests = [];
  const loader = new SliceLoader({
    frames,
    batchSize: 8,
    concurrency: 2,
    async fetchBatch(batch) {
      requests.push(batch.map((f) => f.id));
      await tick();
      return { buffer: new Int16Array(batch.length * 16).buffer, format: 'int16-le' };
    },
  });
  loader.focus(20);
  assert.deepEqual(requests[0], ['f20']);
  assert.equal(requests[1][0], 'f21');
  for (let i = 0; i < 20 && loader.loaded < frames.length; i++) await tick();
  assert.equal(loader.loaded, frames.length);
  assert.ok(requests.every((r) => r.length <= 8));
  assert.equal(new Set(requests.flat()).size, frames.length);
  loader.dispose();
});

test('keeps only the nearest slices when a series exceeds the memory budget', async () => {
  const loader = new SliceLoader({
    frames,
    budgetBytes: 10 * 16 * 2,
    async fetchBatch(batch) {
      return { buffer: new Int16Array(batch.length * 16).buffer, format: 'int16-le' };
    },
  });
  loader.focus(0);
  for (let i = 0; i < 20; i++) await tick();
  assert.ok(loader.loaded <= 10);
  assert.ok(loader.get('f0') && loader.get('f4'));
  assert.equal(loader.get('f30'), undefined);
  loader.dispose();
});

test('places labels in non-overlapping columns beside the image', () => {
  const transform = { x: 300, y: 50, sx: 1, sy: 1 };
  const labels = Array.from({ length: 6 }, (_, i) => ({
    id: `l${i}`,
    label: i === 0 ? 'Sternocleidomastoid muscle left side' : `Structure ${i}`,
    pixel: [i % 2 ? 380 : 20, 100 + i * 2],
    side: i % 2 ? 'right' : 'left',
    color: '#83d9bd',
  }));
  const placed = layoutLabels(labels, transform, 1200, 700, [300, 700]);
  assert.equal(placed.length, 6);
  for (const side of ['left', 'right']) {
    const column = placed.filter((p) => p.side === side).sort((a, b) => a.y - b.y);
    for (let i = 1; i < column.length; i++)
      assert.ok(column[i].y >= column[i - 1].y + column[i - 1].height, 'boxes overlap');
  }
  const left = placed.find((p) => p.side === 'left'),
    right = placed.find((p) => p.side === 'right');
  assert.ok(left.x + left.width <= 300 && left.x + left.width >= 270, 'left column hugs image');
  assert.ok(right.x >= 700 && right.x <= 730, 'right column hugs image');
  assert.equal(placed.find((p) => p.id === 'l0').lines.length, 2);
});
