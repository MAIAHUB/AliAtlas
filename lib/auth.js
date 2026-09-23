import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { AppError, assert } from './errors.js';
import { query } from './db.js';

export const SESSION_COOKIE = 'aliatlas_session';
const SESSION_SECONDS = 30 * 24 * 3600;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const scryptAsync = promisify(scrypt);

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scryptAsync(password.normalize('NFKC'), salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const [scheme, N, r, p, salt, hash] = String(stored).split('$');
  if (scheme !== 'scrypt' || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const key = await scryptAsync(
    password.normalize('NFKC'),
    Buffer.from(salt, 'base64'),
    expected.length,
    { N: Number(N), r: Number(r), p: Number(p) },
  );
  return timingSafeEqual(key, expected);
}

// Compared against when an email is unknown so response time does not reveal registered accounts.
let dummyHash;
const getDummyHash = async () =>
  (dummyHash ||= await hashPassword(randomBytes(16).toString('hex')));

export function validateCredentials({ email, password, name }, registering = false) {
  assert(
    typeof email === 'string' && typeof password === 'string',
    'Enter your email and password.',
  );
  email = email.trim().toLowerCase();
  assert(
    email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),
    'Enter a valid email address.',
  );
  assert(password.length <= 200, 'Password is too long.');
  if (registering) {
    assert(password.length >= 10, 'Use a password with at least 10 characters.');
    name = typeof name === 'string' ? name.trim() : '';
    assert(name.length >= 1 && name.length <= 80, 'Enter your name (up to 80 characters).');
  }
  return { email, password, name };
}

// Workspace directories are keyed by a 64-hex owner; derive it from the account ID.
export const ownerFor = (userId) =>
  createHash('sha256').update(`aliatlas-user:${userId}`).digest('hex');
const tokenHash = (token) => createHash('sha256').update(token).digest('hex');

export function readSessionToken(request) {
  const token = request.headers
    .get('cookie')
    ?.split(';')
    .map((s) => s.trim())
    .find((s) => s.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1);
  return token && /^[a-f0-9]{64}$/.test(token) ? token : null;
}

export function sessionCookie(request, token) {
  const secure =
    process.env.ATLAS_COOKIE_SECURE === 'true' || new URL(request.url).protocol === 'https:';
  const value = token || '';
  const maxAge = token ? SESSION_SECONDS : 0;
  return `${SESSION_COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

export async function userFromToken(token) {
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const { rows } = await query(
    `SELECT u.id, u.email, u.name FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [tokenHash(token)],
  );
  return rows[0] ? { ...rows[0], owner: ownerFor(rows[0].id) } : null;
}

export async function requireUser(request) {
  const user = await userFromToken(readSessionToken(request));
  if (!user) throw new AppError('Sign in to continue.', 401, 'UNAUTHENTICATED');
  return { user, owner: user.owner };
}

export async function createSession(userId) {
  const token = randomBytes(32).toString('hex');
  await query(
    `INSERT INTO sessions (token_hash, user_id, expires_at)
     VALUES ($1, $2, now() + make_interval(secs => $3))`,
    [tokenHash(token), userId, SESSION_SECONDS],
  );
  // Opportunistic cleanup keeps the table small without a scheduler.
  await query('DELETE FROM sessions WHERE expires_at < now()');
  return token;
}

export async function destroySession(token) {
  if (token) await query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash(token)]);
}

export async function registerUser(input) {
  const { email, password, name } = validateCredentials(input, true);
  const hash = await hashPassword(password);
  try {
    const { rows } = await query(
      'INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id, email, name',
      [email, name, hash],
    );
    return rows[0];
  } catch (e) {
    if (e.code === '23505')
      throw new AppError('An account with this email already exists.', 409, 'EMAIL_TAKEN');
    throw e;
  }
}

const failures = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 8;
function checkThrottle(key) {
  const entry = failures.get(key);
  if (entry && Date.now() - entry.first > WINDOW_MS) failures.delete(key);
  assert(
    (failures.get(key)?.count || 0) < MAX_FAILURES,
    'Too many sign-in attempts. Wait 15 minutes and try again.',
    429,
    'RATE_LIMITED',
  );
}
function recordFailure(key) {
  const entry = failures.get(key) || { count: 0, first: Date.now() };
  entry.count++;
  failures.set(key, entry);
  if (failures.size > 10000) failures.delete(failures.keys().next().value);
}

// Throttled per account: client IP headers are spoofable unless a trusted proxy sets them.
export async function authenticate(input) {
  const { email, password } = validateCredentials(input);
  const key = email;
  checkThrottle(key);
  const { rows } = await query(
    'SELECT id, email, name, password_hash FROM users WHERE lower(email) = $1',
    [email],
  );
  const valid = await verifyPassword(password, rows[0]?.password_hash || (await getDummyHash()));
  if (!rows[0] || !valid) {
    recordFailure(key);
    throw new AppError('Email or password is incorrect.', 401, 'INVALID_CREDENTIALS');
  }
  failures.delete(key);
  await query('UPDATE users SET last_login_at = now() WHERE id = $1', [rows[0].id]);
  const { password_hash, ...user } = rows[0];
  return user;
}
