import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { AppError, assert } from './errors.js';
import { query } from './db.js';
import { IMPORT_LIMITS } from './import.js';

// Orthanc is the DICOM archive. It has no per-user access control, so ownership of
// every stored instance is recorded in SQL and checked before anything is read back.
const ORTHANC_ID = /^[a-f0-9]{8}(-[a-f0-9]{8}){4}$/;
const base = () => process.env.ORTHANC_URL?.replace(/\/+$/, '');
export const orthancEnabled = () => Boolean(base());

async function call(route, init = {}, timeout = 60_000) {
  const headers = { ...init.headers };
  if (process.env.ORTHANC_USERNAME)
    headers.Authorization = `Basic ${Buffer.from(
      `${process.env.ORTHANC_USERNAME}:${process.env.ORTHANC_PASSWORD || ''}`,
    ).toString('base64')}`;
  let response;
  try {
    response = await fetch(`${base()}${route}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(timeout),
    });
  } catch {
    throw new AppError('The Orthanc archive is unreachable.', 502, 'ORTHANC_UNAVAILABLE');
  }
  if (response.status === 401 || response.status === 403)
    throw new AppError('AliAtlas could not authenticate with Orthanc.', 502, 'ORTHANC_AUTH');
  return response;
}

export async function orthancStatus() {
  if (!orthancEnabled()) return { enabled: false, ready: false };
  try {
    const response = await call('/system', {}, 5_000);
    const system = response.ok ? await response.json() : null;
    return { enabled: true, ready: Boolean(system), version: system?.Version };
  } catch {
    return { enabled: true, ready: false };
  }
}

async function storeInstance(bytes) {
  const response = await call('/instances', {
    method: 'POST',
    headers: { 'Content-Type': 'application/dicom' },
    body: bytes,
  });
  if (!response.ok) throw new AppError('Orthanc rejected a DICOM file.', 502, 'ORTHANC_REJECTED');
  const stored = await response.json();
  assert(
    ORTHANC_ID.test(stored.ID) && ORTHANC_ID.test(stored.ParentStudy),
    'Orthanc returned an unexpected response.',
    502,
  );
  if (stored.Status === 'AlreadyStored') {
    // Orthanc keeps the first file stored under a UID. Only grant ownership of that
    // copy when these are the same bytes; otherwise anyone who knows a UID could
    // claim another user's archived image.
    const md5 = await call(`/instances/${stored.ID}/attachments/dicom/md5`);
    assert(md5.ok, 'Orthanc could not verify an already archived image.', 502);
    assert(
      (await md5.text()).trim() === createHash('md5').update(bytes).digest('hex'),
      'A different image with the same DICOM UID is already in the archive. The upload was not imported.',
      409,
      'ORTHANC_UID_CONFLICT',
    );
  }
  return stored;
}

// Called by the importer after every file parsed and before the study is committed.
export async function archiveStudies(userId, studies) {
  const archived = [];
  for (const study of studies) {
    let orthancStudyId = null;
    const queue = [...study.files];
    const worker = async () => {
      for (let file = queue.shift(); file; file = queue.shift()) {
        const stored = await storeInstance(await fs.readFile(file));
        orthancStudyId = stored.ParentStudy;
        await query(
          `INSERT INTO orthanc_instances (user_id, orthanc_instance_id, orthanc_study_id, study_instance_uid)
           VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
          [userId, stored.ID, stored.ParentStudy, study.studyInstanceUID],
        );
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
    archived.push({ studyId: study.studyId, orthancStudyId, instances: study.files.length });
  }
  return archived;
}

export async function listArchivedStudies(userId) {
  const { rows } = await query(
    `SELECT orthanc_study_id, count(*)::int AS instances, max(created_at) AS archived_at
     FROM orthanc_instances WHERE user_id = $1
     GROUP BY orthanc_study_id ORDER BY archived_at DESC LIMIT 100`,
    [userId],
  );
  return Promise.all(
    rows.map(async (row) => {
      const response = await call(`/studies/${row.orthanc_study_id}`, {}, 10_000);
      const info = response.ok ? await response.json() : null;
      return {
        id: row.orthanc_study_id,
        instances: row.instances,
        archivedAt: row.archived_at,
        available: Boolean(info),
        description: info?.MainDicomTags?.StudyDescription || '',
        studyDate: info?.MainDicomTags?.StudyDate || '',
      };
    }),
  );
}

// Downloads only the instances this user archived; another user who uploaded
// the same StudyInstanceUID shares the Orthanc study but not these rows.
export async function downloadOwnedInstances(userId, orthancStudyId, temp) {
  assert(
    typeof orthancStudyId === 'string' && ORTHANC_ID.test(orthancStudyId),
    'Invalid archive study.',
    404,
  );
  const { rows } = await query(
    'SELECT orthanc_instance_id FROM orthanc_instances WHERE user_id = $1 AND orthanc_study_id = $2',
    [userId, orthancStudyId],
  );
  assert(rows.length, 'Archive study not found for this account.', 404);
  assert(rows.length <= IMPORT_LIMITS.files, 'This archive study has too many files to open.', 413);
  const files = [];
  let total = 0;
  for (const { orthanc_instance_id: id } of rows) {
    const response = await call(`/instances/${id}/file`);
    if (response.status === 404) continue;
    assert(response.ok, 'Orthanc could not return a DICOM file.', 502);
    assert(
      Number(response.headers.get('content-length') || 0) <= IMPORT_LIMITS.file,
      'An archived image exceeds 64 MB.',
      413,
    );
    const bytes = Buffer.from(await response.arrayBuffer());
    assert(bytes.length <= IMPORT_LIMITS.file, 'An archived image exceeds 64 MB.', 413);
    total += bytes.length;
    assert(total <= IMPORT_LIMITS.expanded, 'This archive study exceeds 1 GB.', 413);
    const target = path.join(temp, randomUUID());
    await fs.writeFile(target, bytes, { mode: 0o600 });
    files.push({ path: target, isZip: false });
  }
  assert(files.length, 'The archived images are no longer in Orthanc.', 404);
  return files;
}
