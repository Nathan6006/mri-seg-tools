/**
 * Accounts, passwords and sessions.
 *
 * PASSWORDS are PBKDF2-SHA256, because that is the only password-grade KDF
 * WebCrypto exposes and a Worker has no native modules to reach for. bcrypt,
 * scrypt and Argon2 are all better by design -- they are memory-hard, and
 * PBKDF2 is not, so a GPU parallelises an attack on it far more cheaply.
 * The mitigation is iteration count: 210,000, which is OWASP's 2023 floor for
 * PBKDF2-SHA256. The stored string carries its own iteration count so the
 * number can be raised later and old hashes still verify -- `verifyPassword`
 * reads the cost from the hash, never from this constant.
 *
 * SESSIONS are an opaque 32-byte random token in an httpOnly cookie. The
 * database stores only its SHA-256. This is deliberate and not theatre: the
 * sessions table is the one table whose contents would otherwise be
 * immediately replayable as a login, and a read-only leak (a backup, a stray
 * query, a `d1 execute` in a shared terminal) is a much likelier failure than
 * a full compromise. A JWT would avoid the lookup but cannot be revoked, and
 * revocation is the thing a shared lab account actually needs.
 */

const PBKDF2_ITERATIONS = 210_000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;   // 30 days
export const SESSION_COOKIE = 'mri_session';

// Sign-in throttle. Deliberately generous -- this exists to make online
// guessing hopeless, not to lock out a reviewer who fat-fingered twice.
const MAX_FAILURES = 8;
const LOCKOUT_MS = 15 * 60 * 1000;
const FAILURE_WINDOW_MS = 60 * 60 * 1000;

const enc = new TextEncoder();

const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export function randomId() {
  return crypto.randomUUID();
}

function randomToken() {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  // base64url: safe in a cookie without escaping.
  return b64(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(password), 'PBKDF2', false, ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256,
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password, iterations = PBKDF2_ITERATIONS) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const dk = await pbkdf2(password, salt, iterations);
  return `pbkdf2-sha256$${iterations}$${b64(salt)}$${b64(dk)}`;
}

/**
 * Constant-time compare. `===` on two strings short-circuits at the first
 * differing byte, which leaks how much of a guess was right through timing.
 * The cost of doing it properly here is nanoseconds.
 */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2-sha256') return false;
  const iterations = Number(parts[1]);
  if (!Number.isFinite(iterations) || iterations < 1000) return false;
  const dk = await pbkdf2(password, unb64(parts[2]), iterations);
  return timingSafeEqual(dk, unb64(parts[3]));
}

/* ---------------------------------------------------------------- throttle */

export async function throttleCheck(db, key) {
  const now = Date.now();
  const row = await db.prepare(
    'SELECT failures, first_at, locked_until FROM login_attempts WHERE key = ?',
  ).bind(key).first();
  if (!row) return null;
  if (row.locked_until && row.locked_until > now) {
    return Math.ceil((row.locked_until - now) / 1000);
  }
  return null;
}

export async function throttleFail(db, key) {
  const now = Date.now();
  const row = await db.prepare(
    'SELECT failures, first_at FROM login_attempts WHERE key = ?',
  ).bind(key).first();

  // Outside the window the count starts over, so occasional typos across a
  // week never accumulate into a lockout.
  if (!row || now - row.first_at > FAILURE_WINDOW_MS) {
    await db.prepare(
      'INSERT INTO login_attempts (key, failures, first_at, locked_until) VALUES (?, 1, ?, NULL) ' +
      'ON CONFLICT(key) DO UPDATE SET failures = 1, first_at = ?, locked_until = NULL',
    ).bind(key, now, now).run();
    return;
  }
  const failures = row.failures + 1;
  const lockedUntil = failures >= MAX_FAILURES ? now + LOCKOUT_MS : null;
  await db.prepare(
    'UPDATE login_attempts SET failures = ?, locked_until = ? WHERE key = ?',
  ).bind(failures, lockedUntil, key).run();
}

export async function throttleClear(db, key) {
  await db.prepare('DELETE FROM login_attempts WHERE key = ?').bind(key).run();
}

/* ---------------------------------------------------------------- sessions */

export async function createSession(db, userId, userAgent) {
  const token = randomToken();
  const now = Date.now();
  await db.prepare(
    'INSERT INTO sessions (token_hash, user_id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)',
  ).bind(await sha256Hex(token), userId, now, now + SESSION_TTL_MS, (userAgent || '').slice(0, 300)).run();
  return token;
}

export async function userForToken(db, token) {
  if (!token) return null;
  const row = await db.prepare(
    `SELECT u.id, u.username, u.display_name, u.email, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?`,
  ).bind(await sha256Hex(token)).first();
  if (!row) return null;
  if (row.expires_at <= Date.now()) {
    await destroySession(db, token);
    return null;
  }
  return { id: row.id, username: row.username, displayName: row.display_name, email: row.email };
}

export async function destroySession(db, token) {
  if (!token) return;
  await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256Hex(token)).run();
}

/* ----------------------------------------------------------------- cookies */

export function readCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

/**
 * `Secure` is set only on https. Hardcoding it would be the safer-looking
 * choice and would silently break local development: a Secure cookie is
 * discarded outright over http://localhost, so sign-in would appear to
 * succeed and every subsequent request would arrive logged out.
 */
export function sessionCookie(token, url, { clear = false } = {}) {
  const secure = url.protocol === 'https:' ? '; Secure' : '';
  const age = clear ? 0 : Math.floor(SESSION_TTL_MS / 1000);
  const value = clear ? '' : encodeURIComponent(token);
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${secure}`;
}
