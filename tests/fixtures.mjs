import { Buffer } from 'node:buffer';

function element(group, tag, vr, value, big = false, implicit = false) {
  const data = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  const padded =
    data.length % 2
      ? Buffer.concat([data, Buffer.from([vr === 'UI' || vr === 'OB' ? 0 : 32])])
      : data;
  const long = ['OB', 'OW', 'OF', 'SQ', 'UT', 'UN'].includes(vr),
    header = Buffer.alloc(implicit ? 8 : long ? 12 : 8);
  header[big ? 'writeUInt16BE' : 'writeUInt16LE'](group, 0);
  header[big ? 'writeUInt16BE' : 'writeUInt16LE'](tag, 2);
  if (implicit) header[big ? 'writeUInt32BE' : 'writeUInt32LE'](padded.length, 4);
  else {
    header.write(vr, 4);
    header[
      big ? (long ? 'writeUInt32BE' : 'writeUInt16BE') : long ? 'writeUInt32LE' : 'writeUInt16LE'
    ](padded.length, long ? 8 : 6);
  }
  return Buffer.concat([header, padded]);
}
const us = (value, big) => {
  const b = Buffer.alloc(2);
  b[big ? 'writeUInt16BE' : 'writeUInt16LE'](value);
  return b;
};
const item = (data) => {
  const h = Buffer.alloc(8);
  h.writeUInt16LE(0xfffe, 0);
  h.writeUInt16LE(0xe000, 2);
  h.writeUInt32LE(data.length, 4);
  return Buffer.concat([h, data]);
};
const sq = (group, tag, children) => element(group, tag, 'SQ', item(Buffer.concat(children)));

export function makeDicom({
  rows = 16,
  columns = 16,
  index = 0,
  big = false,
  implicit = false,
  signed = true,
  bits = 16,
  bitsStored = 16,
  highBit = bitsStored - 1,
  intercept = 0,
  slope = 1,
  monochrome = 'MONOCHROME2',
  position = [0, 0, index * 2],
  orientation = [1, 0, 0, 0, 1, 0],
  spacing = [1, 1],
  studyUID = '1.2.826.0.1.3680043.10.543.1',
  seriesUID = '1.2.826.0.1.3680043.10.543.1.1',
  sopUID = `1.2.826.0.1.3680043.10.543.1.1.${index + 1}`,
  values,
  enhancedFrames = 0,
  transferSyntax,
  modality = 'CT',
} = {}) {
  const count = enhancedFrames || 1;
  const pixels = Buffer.alloc(rows * columns * count * (bits / 8));
  for (let n = 0; n < rows * columns * count; n++) {
    const value = values?.[n] ?? 40;
    const packed = (value < 0 ? value + 2 ** bitsStored : value) << (highBit - bitsStored + 1);
    if (bits === 8) pixels.writeUInt8(packed & 255, n);
    else pixels[big ? 'writeUInt16BE' : 'writeUInt16LE'](packed & 65535, n * 2);
  }
  const e = (g, t, vr, value) => element(g, t, vr, value, big, implicit);
  const syntax =
    transferSyntax ||
    (big ? '1.2.840.10008.1.2.2' : implicit ? '1.2.840.10008.1.2' : '1.2.840.10008.1.2.1');
  const sop = enhancedFrames ? '1.2.840.10008.5.1.4.1.1.2.1' : '1.2.840.10008.5.1.4.1.1.2';
  const elements = [
    e(8, 8, 'CS', 'ORIGINAL\\PRIMARY\\AXIAL'),
    e(8, 0x16, 'UI', sop),
    e(8, 0x18, 'UI', sopUID),
    e(8, 0x60, 'CS', modality),
    e(8, 0x103e, 'LO', 'Synthetic QA phantom'),
    e(0x18, 0x15, 'CS', 'NECK'),
    e(0x18, 0x50, 'DS', '2'),
    e(0x20, 0x0d, 'UI', studyUID),
    e(0x20, 0x0e, 'UI', seriesUID),
    e(0x20, 0x11, 'IS', '1'),
    e(0x20, 0x13, 'IS', String(index + 1)),
    e(0x20, 0x32, 'DS', position.join('\\')),
    e(0x20, 0x37, 'DS', orientation.join('\\')),
    e(0x20, 0x52, 'UI', '1.2.826.0.1.3680043.10.543.2'),
    e(0x28, 2, 'US', us(1, big)),
    e(0x28, 4, 'CS', monochrome),
    ...(enhancedFrames ? [e(0x28, 8, 'IS', String(count))] : []),
    e(0x28, 0x10, 'US', us(rows, big)),
    e(0x28, 0x11, 'US', us(columns, big)),
    e(0x28, 0x30, 'DS', spacing.join('\\')),
    e(0x28, 0x100, 'US', us(bits, big)),
    e(0x28, 0x101, 'US', us(bitsStored, big)),
    e(0x28, 0x102, 'US', us(highBit, big)),
    e(0x28, 0x103, 'US', us(signed ? 1 : 0, big)),
    e(0x28, 0x1050, 'DS', '40'),
    e(0x28, 0x1051, 'DS', '350'),
    e(0x28, 0x1052, 'DS', String(intercept)),
    e(0x28, 0x1053, 'DS', String(slope)),
  ];
  if (enhancedFrames) {
    elements.push(
      sq(0x5200, 0x9229, [
        sq(0x20, 0x9116, [element(0x20, 0x37, 'DS', orientation.join('\\'))]),
        sq(0x28, 0x9110, [element(0x28, 0x30, 'DS', spacing.join('\\'))]),
      ]),
    );
    elements.push(
      element(
        0x5200,
        0x9230,
        'SQ',
        Buffer.concat(
          Array.from({ length: count }, (_, n) =>
            item(
              sq(0x20, 0x9113, [
                element(
                  0x20,
                  0x32,
                  'DS',
                  [position[0], position[1], position[2] + n * 2].join('\\'),
                ),
              ]),
            ),
          ),
        ),
      ),
    );
  }
  elements.push(e(0x7fe0, 0x10, bits === 8 ? 'OB' : 'OW', pixels));
  const preamble = Buffer.alloc(132);
  preamble.write('DICM', 128);
  return Buffer.concat([
    preamble,
    element(2, 1, 'OB', Buffer.from([0, 1])),
    element(2, 2, 'UI', sop),
    element(2, 3, 'UI', sopUID),
    element(2, 0x10, 'UI', syntax),
    ...elements,
  ]);
}

export function phantomPixels(index, rows = 256, columns = 256) {
  const result = new Int16Array(rows * columns),
    size = 1 + Math.sin(index / 3) * 0.04;
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < columns; x++) {
      const px = (x - columns / 2) / size,
        py = (y - rows * 0.48) / size;
      const body = (px / (columns * 0.31)) ** 2 + (py / (rows * 0.39)) ** 2;
      let value = -1000;
      if (body < 1)
        value =
          body > 0.94
            ? -65
            : 35 + 18 * Math.sin(x * 1.87 + y * 2.51 + index) * Math.sin(y * 0.74 + x * 0.41);
      const skull = (px / (columns * 0.235)) ** 2 + ((py + rows * 0.08) / (rows * 0.24)) ** 2;
      if (body < 0.94 && skull > 0.79 && skull < 1) value = 900 + 180 * Math.sin(x * 2 + y);
      const airway = (px / (columns * 0.065)) ** 2 + ((py - rows * 0.04) / (rows * 0.066)) ** 2;
      if (airway < 1) value = -850;
      const spine = (px / (columns * 0.1)) ** 2 + ((py - rows * 0.19) / (rows * 0.09)) ** 2;
      if (spine < 1) value = spine > 0.56 ? 800 : 150;
      const bed = (px / (columns * 0.45)) ** 2 + ((py - rows * 0.035) / (rows * 0.49)) ** 2;
      if (py > rows * 0.3 && bed > 1 && bed < 1.035) value = 1200;
      result[y * columns + x] = value;
    }
  return result;
}

export function makeNifti({
  dimensions = [4, 4, 3],
  affine = [
    [-1, 0, 0, 0],
    [0, -1, 0, 0],
    [0, 0, 2, 0],
    [0, 0, 0, 1],
  ],
  values,
  units = 2,
} = {}) {
  const count = dimensions.reduce((a, b) => a * b, 1),
    buffer = Buffer.alloc(352 + count);
  buffer.writeInt32LE(348, 0);
  buffer.writeInt16LE(3, 40);
  dimensions.forEach((n, i) => buffer.writeInt16LE(n, 42 + i * 2));
  buffer.writeInt16LE(1, 48);
  buffer.writeInt16LE(2, 70);
  buffer.writeInt16LE(8, 72);
  buffer.writeFloatLE(1, 76);
  buffer.writeFloatLE(1, 80);
  buffer.writeFloatLE(1, 84);
  buffer.writeFloatLE(2, 88);
  buffer.writeFloatLE(352, 108);
  buffer.writeUInt8(units, 123);
  buffer.writeInt16LE(1, 254);
  affine
    .slice(0, 3)
    .flat()
    .forEach((n, i) => buffer.writeFloatLE(n, 280 + i * 4));
  buffer.write('n+1\0', 344);
  if (values) for (let i = 0; i < count; i++) buffer[352 + i] = values[i] || 0;
  return buffer;
}
