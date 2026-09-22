import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeDicom, phantomPixels } from '../tests/fixtures.mjs';
export async function createFixtures(root = 'fixtures') {
  const folder = path.resolve(root, 'ct');
  await fs.mkdir(folder, { recursive: true });
  for (let i = 0; i < 12; i++)
    await fs.writeFile(
      path.join(folder, `slice-${String(12 - i).padStart(2, '0')}.dcm`),
      makeDicom({
        index: i,
        rows: 256,
        columns: 256,
        position: [-128, -128, -20 + i * 2],
        values: phantomPixels(i),
      }),
    );
  await fs.writeFile(
    path.resolve(root, 'README.txt'),
    'SYNTHETIC SOFTWARE TEST PHANTOM. Contains no patient data. Not an anatomical reference or model validation dataset.\n',
  );
  return folder;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(await createFixtures());
}
