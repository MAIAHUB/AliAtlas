import { defineConfig } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const testData =
  process.env.ATLAS_TEST_DATA_DIR || mkdtempSync(path.join(tmpdir(), 'aliatlas-e2e-'));
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 60000,
  use: {
    baseURL: 'http://127.0.0.1:3200',
    viewport: { width: 1512, height: 982 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: process.env.ATLAS_CHROMIUM_PATH
      ? {
          executablePath: process.env.ATLAS_CHROMIUM_PATH,
          args: [
            '--no-sandbox',
            '--disable-dev-shm-usage',
            '--use-gl=angle',
            '--use-angle=swiftshader',
            '--disable-gpu-sandbox',
          ],
        }
      : {},
  },
  webServer: {
    command: 'npm run start -- --port 3200',
    url: 'http://127.0.0.1:3200',
    reuseExistingServer: false,
    timeout: 60000,
    env: {
      ATLAS_DATA_DIR: testData,
      ATLAS_AI_ENABLED: 'false',
      NEXT_TELEMETRY_DISABLED: '1',
      DATABASE_URL:
        process.env.DATABASE_URL ||
        'postgres://aliatlas:aliatlas-dev-password@127.0.0.1:5432/aliatlas',
      ORTHANC_URL: process.env.ORTHANC_URL || '',
      ORTHANC_USERNAME: process.env.ORTHANC_USERNAME || '',
      ORTHANC_PASSWORD: process.env.ORTHANC_PASSWORD || '',
    },
  },
});
