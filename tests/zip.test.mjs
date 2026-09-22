import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { extractZip, IMPORT_LIMITS } from '../lib/import.js';
import { makeDicom } from './fixtures.mjs';

export function makeZip(entries) {
  const locals = [],
    central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name),
      data = entry.data;
    const compressed = deflateRawSync(data);
    let crc = -1;
    for (const byte of data) {
      crc ^= byte;
      for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    crc = (crc ^ -1) >>> 0;
    const length = entry.declaredSize ?? data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, compressed);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(8, 10);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(compressed.length, 20);
    dir.writeUInt32LE(length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, name);
    offset += local.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
async function withArchive(entries, action) {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'aliatlas-zip-'));
  const archive = path.join(dir, 'input.zip');
  await fs.writeFile(archive, makeZip(entries));
  try {
    return await action(archive, dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
test('extracts nested DICOM entries to safe random names and measures expanded bytes', async () => {
  const bytes = makeDicom();
  await withArchive([{ name: 'scan/nested/image.dcm', data: bytes }], async (archive, dir) => {
    const budget = { files: 0, bytes: 0, entries: 0 };
    const files = await extractZip(archive, dir, budget);
    assert.equal(files.length, 1);
    assert.equal(budget.bytes, bytes.length);
    assert.match(path.basename(files[0].path), /^[a-f0-9-]{36}$/);
    assert.deepEqual(await fs.readFile(files[0].path), bytes);
  });
});
test('rejects archive traversal, oversized entries and false decompressed sizes', async () => {
  for (const entry of [
    { name: '../escape.dcm', data: makeDicom() },
    { name: 'large.dcm', data: makeDicom(), declaredSize: IMPORT_LIMITS.file + 1 },
    { name: 'false-size.dcm', data: makeDicom(), declaredSize: 2 },
  ])
    await withArchive([entry], async (archive, dir) => {
      await assert.rejects(extractZip(archive, dir, { files: 0, bytes: 0, entries: 0 }));
    });
});
