import pg from 'pg';
import { AppError } from './errors.js';

// Schema is idempotent and applied once per process, under an advisory lock so
// parallel web instances starting together cannot race each other.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  name text NOT NULL,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_key ON users (lower(email));
CREATE TABLE IF NOT EXISTS sessions (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);
CREATE TABLE IF NOT EXISTS orthanc_instances (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  orthanc_instance_id text NOT NULL,
  orthanc_study_id text NOT NULL,
  study_instance_uid text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, orthanc_instance_id)
);
CREATE INDEX IF NOT EXISTS orthanc_instances_study_idx ON orthanc_instances (user_id, orthanc_study_id);
CREATE TABLE IF NOT EXISTS audit_events (
  id bigserial PRIMARY KEY,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
`;

function state() {
  // Survives Next dev-server module reloads so connections are not leaked.
  globalThis.__aliatlasDb ||= { pool: null, ready: null };
  return globalThis.__aliatlasDb;
}

function pool() {
  const s = state();
  if (!s.pool) {
    if (!process.env.DATABASE_URL)
      throw new AppError('The account database is not configured.', 503, 'DB_UNAVAILABLE');
    s.pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
    s.pool.on('error', (e) => console.error('[AliAtlas] database', e.code || e.name));
  }
  return s.pool;
}

async function ready() {
  const s = state();
  s.ready ||= (async () => {
    const client = await pool().connect();
    try {
      await client.query('SELECT pg_advisory_lock(804117)');
      await client.query(SCHEMA);
    } finally {
      await client.query('SELECT pg_advisory_unlock(804117)').catch(() => {});
      client.release();
    }
  })().catch((e) => {
    s.ready = null;
    throw e;
  });
  return s.ready;
}

export async function query(text, params = []) {
  try {
    await ready();
    return await pool().query(text, params);
  } catch (e) {
    if (e instanceof AppError) throw e;
    // Connection failures carry Node error codes; SQL errors carry 5-char SQLSTATE codes.
    if (!/^[0-9A-Z]{5}$/.test(e.code || ''))
      throw new AppError('The account database is unavailable.', 503, 'DB_UNAVAILABLE');
    throw e;
  }
}

export async function audit(userId, action, detail = {}) {
  await query('INSERT INTO audit_events (user_id, action, detail) VALUES ($1, $2, $3)', [
    userId,
    action,
    detail,
  ]).catch((e) => console.error('[AliAtlas] audit', e.code || e.name));
}
