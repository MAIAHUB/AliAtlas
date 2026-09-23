import { test, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createFixtures } from '../../scripts/create-fixtures.mjs';
import { makeDicom } from '../fixtures.mjs';

test('imports real DICOM bytes, scrolls, labels, persists, and exports an actual PNG', async ({
  page,
}) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const folder = await createFixtures(),
    files = (await fs.readdir(folder)).map((f) => path.join(folder, f));
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await page.screenshot({ path: 'test-results/login.png' });
  await page.getByRole('button', { name: 'Create an account' }).click();
  await page.getByLabel('Name').fill('QA Reviewer');
  await page.getByLabel('Email').fill(`qa-${Date.now()}@example.test`);
  await page.getByLabel('Password').fill('synthetic-phantom-pass');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Import your first study' })).toBeEnabled();
  await page.screenshot({ path: 'test-results/empty-workspace.png', fullPage: true });
  await page.getByRole('button', { name: 'Import your first study' }).click();
  await page.locator('dialog input[type=file]').first().setInputFiles(files);
  await page.getByRole('button', { name: 'Import study', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Synthetic QA phantom' })).toBeVisible();
  await expect(page.getByLabel('CT Axial slice 7')).toBeVisible();
  await expect(page.getByText('Loading CT slice', { exact: true })).toHaveCount(0);
  const rendered = await page.locator('.dicom-viewport canvas').evaluate((canvas) => {
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let bright = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i] > 50) bright++;
    return bright;
  });
  expect(rendered).toBeGreaterThan(30000);
  await page.getByRole('button', { name: 'Add label', exact: true }).click();
  const box = await page.getByLabel('CT image viewport').boundingBox();
  await page.mouse.click(box.x + box.width * 0.49, box.y + box.height * 0.48);
  await page.getByLabel('Structure name').fill('Phantom center');
  await page.getByRole('button', { name: 'Save label', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Select Phantom center' })).toBeVisible();
  const anchor = await page.locator('.anatomy-label circle').getAttribute('cx');
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await expect
    .poll(() => page.locator('.anatomy-label circle').getAttribute('cx'))
    .not.toBe(anchor);
  await page.getByRole('button', { name: 'Next slice', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Select Phantom center' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Previous slice', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Select Phantom center' })).toBeVisible();
  await page.getByLabel('Window preset').selectOption('bone');
  await expect(page.locator('.viewport-meta')).toContainText('W 1800');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export slice', exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('AliAtlas-slice-7.png');
  const file = await download.path();
  expect((await fs.readFile(file)).subarray(1, 4).toString()).toBe('PNG');
  const labelDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export labels', exact: true }).click();
  const labelFile = await labelDownload;
  const bundle = JSON.parse(await fs.readFile(await labelFile.path(), 'utf8'));
  expect(bundle.records).toHaveLength(1);
  expect(bundle.records[0].sopInstanceUID).toBeTruthy();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Select Phantom center' })).toBeVisible();
  await page.getByRole('button', { name: 'Select Phantom center' }).click();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByLabel('Structure name').fill('Reviewed phantom');
  await page.getByRole('button', { name: 'Save label', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Select Reviewed phantom' })).toBeVisible();
  await page
    .getByRole('button', { name: 'Generate anatomy labels' })
    .isDisabled()
    .then((disabled) => expect(disabled).toBe(true));
  await page.screenshot({ path: 'test-results/ct-workspace.png', fullPage: true });
  if (process.env.ORTHANC_URL) {
    await expect(page.getByText('Private · Orthanc archive')).toBeVisible();
    await page.getByRole('button', { name: 'Import DICOM' }).click();
    await page.getByRole('tab', { name: 'From Orthanc archive' }).click();
    await expect(page.locator('.archive-list li')).toHaveCount(1);
    await page.screenshot({ path: 'test-results/orthanc-archive.png' });
    await page.getByRole('button', { name: 'Open', exact: true }).click();
    await expect(page.locator('.study-list .study-button')).toHaveCount(2);
    await expect(page.getByRole('heading', { name: 'Synthetic QA phantom' })).toBeVisible();
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Synthetic QA phantom' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: 'test-results/mobile-workspace.png', fullPage: true });
  expect(errors).toEqual([]);
});

// Distinct UIDs from the phantom so the Orthanc archive never sees conflicting copies.
const apiDicom = (index, extra = {}) =>
  makeDicom({
    index,
    studyUID: '1.2.826.0.1.3680043.10.543.2',
    seriesUID: '1.2.826.0.1.3680043.10.543.2.1',
    sopUID: `1.2.826.0.1.3680043.10.543.2.1.${index + 1}`,
    ...extra,
  });
test('isolates workspaces and validates writes and pixel responses', async ({ playwright }) => {
  const one = await playwright.request.newContext({ baseURL: 'http://127.0.0.1:3200' }),
    two = await playwright.request.newContext({ baseURL: 'http://127.0.0.1:3200' });
  try {
    expect(
      (
        await one.post('/api/studies/import', {
          multipart: {
            file: { name: 'scan.dcm', mimeType: 'application/dicom', buffer: makeDicom() },
          },
        })
      ).status(),
    ).toBe(401);
    expect((await one.get('/api/workspace')).status()).toBe(401);
    const stamp = Date.now(),
      account = { name: 'One', email: `one-${stamp}@example.test`, password: 'first-account-pass' };
    expect((await one.post('/api/auth/register', { data: account })).status()).toBe(201);
    expect((await one.post('/api/auth/register', { data: account })).status()).toBe(409);
    expect(
      (
        await two.post('/api/auth/register', {
          data: { name: 'Two', email: `two-${stamp}@example.test`, password: 'short' },
        })
      ).status(),
    ).toBe(400);
    expect(
      (
        await two.post('/api/auth/register', {
          data: {
            name: 'Two',
            email: `two-${stamp}@example.test`,
            password: 'second-account-pass',
          },
        })
      ).status(),
    ).toBe(201);
    expect(
      (
        await two.post('/api/auth/login', {
          data: { email: account.email, password: 'not-the-password' },
        })
      ).status(),
    ).toBe(401);
    expect((await (await one.get('/api/workspace')).json()).user.email).toBe(account.email);
    expect(
      (
        await one.post('/api/studies/import', {
          headers: { Origin: 'https://unrelated.example' },
          multipart: {
            file: { name: 'scan.dcm', mimeType: 'application/dicom', buffer: makeDicom() },
          },
        })
      ).status(),
    ).toBe(403);
    const upload = await one.post('/api/studies/import', {
      multipart: {
        first: { name: 'b.dcm', mimeType: 'application/dicom', buffer: apiDicom(2) },
        second: { name: 'a.dcm', mimeType: 'application/dicom', buffer: apiDicom(0) },
        third: { name: 'c.dcm', mimeType: 'application/dicom', buffer: apiDicom(1) },
        duplicate: {
          name: 'dup.dcm',
          mimeType: 'application/dicom',
          buffer: apiDicom(1),
        },
        invalid: { name: 'photo.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('not dicom') },
      },
    });
    expect(upload.status()).toBe(201);
    const result = await upload.json();
    expect(result.importedFrames).toBe(3);
    expect(result.skipped).toBe(2);
    const id = result.studies[0].id,
      study = await (await one.get(`/api/studies/${id}`)).json(),
      series = study.series[0],
      frame = series.frames[0];
    expect(series.frames.map((f) => f.position[2])).toEqual([0, 2, 4]);
    expect(frame).not.toHaveProperty('fileId');
    expect(frame).not.toHaveProperty('pixelOffset');
    const pixels = await one.get(`/api/studies/${id}/pixels?series=${series.id}&frame=${frame.id}`);
    expect(pixels.status()).toBe(200);
    expect(pixels.headers()['cache-control']).toBe('no-store');
    expect((await pixels.body()).readFloatLE(0)).toBe(40);
    const slices = `/api/studies/${id}/slices?series=${series.id}&frames=${frame.id},${series.frames[1].id}`;
    const batch = await one.get(slices);
    expect(batch.status()).toBe(200);
    expect(batch.headers()['x-pixel-format']).toBe('int16-le');
    const batchBody = await batch.body();
    expect(batchBody.length).toBe(2 * frame.rows * frame.columns * 2);
    expect(batchBody.readInt16LE(0)).toBe(40);
    expect((await two.get(slices)).status()).toBe(404);
    expect((await two.get(`/api/studies/${id}`)).status()).toBe(404);
    expect(
      (await two.get(`/api/studies/${id}/pixels?series=${series.id}&frame=${frame.id}`)).status(),
    ).toBe(404);
    expect((await two.get(`/api/studies/${id}/annotations`)).status()).toBe(404);
    expect((await two.delete(`/api/studies/${id}`)).status()).toBe(404);
    expect(
      (
        await one.post(`/api/studies/${id}/annotations`, {
          data: {
            seriesId: series.id,
            frameId: frame.id,
            label: 'Bad point',
            pixel: [9999, 0],
            side: 'left',
            color: '#aaaaaa',
          },
        })
      ).status(),
    ).toBe(400);
    expect(
      (
        await one.post(`/api/studies/${id}/jobs`, {
          data: { seriesId: series.id, region: 'headneck' },
        })
      ).status(),
    ).toBe(503);
    expect((await one.delete(`/api/studies/${id}`)).status()).toBe(200);
    expect((await one.get(`/api/studies/${id}`)).status()).toBe(404);
    if (process.env.ORTHANC_URL) {
      expect(result.archive[0].instances).toBe(3);
      const orthancStudyId = result.archive[0].orthancStudyId;
      const listed = await (await one.get('/api/orthanc/studies')).json();
      expect(listed.studies.map((s) => s.id)).toContain(orthancStudyId);
      expect((await (await two.get('/api/orthanc/studies')).json()).studies).toEqual([]);
      expect(
        (await two.post('/api/orthanc/studies/import', { data: { orthancStudyId } })).status(),
      ).toBe(404);
      // Reusing a known UID with different pixels must not grant access to the archived copy.
      const forged = await two.post('/api/studies/import', {
        multipart: {
          file: {
            name: 'forged.dcm',
            mimeType: 'application/dicom',
            buffer: apiDicom(0, { intercept: -1000 }),
          },
        },
      });
      expect(forged.status()).toBe(409);
      expect((await (await two.get('/api/orthanc/studies')).json()).studies).toEqual([]);
      const reopened = await one.post('/api/orthanc/studies/import', { data: { orthancStudyId } });
      expect(reopened.status()).toBe(201);
      expect((await reopened.json()).importedFrames).toBe(3);
    }
    expect((await one.post('/api/auth/logout')).status()).toBe(200);
    expect((await one.get('/api/workspace')).status()).toBe(401);
    expect(
      (
        await one.post('/api/auth/login', {
          data: { email: account.email, password: account.password },
        })
      ).status(),
    ).toBe(200);
    expect((await one.get('/api/workspace')).status()).toBe(200);
  } finally {
    await one.dispose();
    await two.dispose();
  }
});
