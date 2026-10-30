/**
 * The shared-workspace backend.
 *
 * WHY ONE ORIGIN
 * --------------
 * This Worker serves the static page *and* /api/*. Putting the API on its own
 * host would have been tidier to reason about and would have broken two things
 * that are easy to break silently:
 *
 *   1. The page's CSP is `connect-src 'self'`. Same origin means that line --
 *      the one that makes "this page cannot phone anywhere else" enforced
 *      rather than promised -- survives unchanged.
 *   2. The page is cross-origin isolated (COOP + COEP), which is what lets the
 *      inference runtime use more than one thread. A cross-origin fetch into
 *      an isolated page needs Cross-Origin-Resource-Policy on every response,
 *      and getting it wrong does not raise an error: inference just quietly
 *      drops to a single thread and a scan takes minutes instead of seconds.
 *
 * Assets are matched before the Worker runs, so everything reaching `fetch`
 * below is an API call or a miss.
 *
 * WHAT IS NOT HERE
 * ----------------
 * No model, no inference, no DICOM parsing. Segmentation still happens in the
 * browser tab, which is why this backend stays inside a free tier: it moves
 * bytes and checks who you are, and nothing else.
 */

import {
  SESSION_COOKIE, createSession, destroySession, hashPassword, randomId,
  readCookie, sessionCookie, throttleCheck, throttleClear, throttleFail,
  userForToken, verifyPassword,
} from './auth.js';

/* ------------------------------------------------------------- small utils */

const json = (data, init = {}) => new Response(JSON.stringify(data), {
  ...init,
  headers: { 'Content-Type': 'application/json; charset=utf-8', ...(init.headers || {}) },
});

const fail = (status, error, extra = {}) => json({ error, ...extra }, { status });

const now = () => Date.now();

const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;
const CASE_RE = /^[^\u0000/\\]{1,200}$/;          // no NUL, no path separators
const KIND_RE = /^[a-z0-9_]{1,32}$/;

// Upload ceiling. A scan is a couple of megabytes; 64 MB is far above any
// legitimate single file and well under the point where a Worker struggles.
const MAX_BLOB_BYTES = 64 * 1024 * 1024;

function slugify(name) {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return `${base || 'workspace'}-${randomId().slice(0, 8)}`;
}

async function readJson(request) {
  try { return await request.json(); } catch { return null; }
}

/* --------------------------------------------------------------- blob keys */

// Workspace id and case name both come from the caller, so the key is built
// from validated parts only and the case name is encoded -- a name containing
// a slash would otherwise invent a directory level and could collide with
// another case's files.
const blobKey = (ws, caseName, kind) => `w/${ws}/c/${encodeURIComponent(caseName)}/${kind}`;
const maskKey = (ws, caseName, userId) => `w/${ws}/c/${encodeURIComponent(caseName)}/u/${userId}/mask`;

/* ------------------------------------------------------------- membership */

async function membership(env, workspaceId, userId) {
  return env.DB.prepare(
    'SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?',
  ).bind(workspaceId, userId).first();
}

const CAN_WRITE = new Set(['owner', 'editor']);

/* ===================================================================== auth */

async function handleRegister(request, env, url) {
  const body = await readJson(request);
  if (!body) return fail(400, 'Malformed request');

  const username = String(body.username || '').trim().toLowerCase();
  const displayName = String(body.displayName || '').trim();
  const password = String(body.password || '');
  const email = body.email ? String(body.email).trim() : null;

  if (!USERNAME_RE.test(username)) {
    return fail(400, 'Username must be 3-32 characters: letters, digits, dot, dash or underscore, starting with a letter or digit.');
  }
  if (!displayName || displayName.length > 100) return fail(400, 'Please give a display name.');
  // Length is the only rule. Composition rules (a digit, a symbol) measurably
  // push people toward shorter, more guessable passwords, and NIST dropped
  // them for that reason.
  if (password.length < 8) return fail(400, 'Password must be at least 8 characters.');
  if (password.length > 512) return fail(400, 'Password is too long.');

  const existing = await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(username).first();
  if (existing) return fail(409, 'That username is taken.');

  const userId = randomId();
  const pwHash = await hashPassword(password);
  const ts = now();

  // A new account is useless without somewhere to put scans, so it gets a
  // workspace of its own immediately rather than a "create your first
  // workspace" step that everyone would click through anyway.
  const workspaceId = randomId();
  const wsName = `${displayName.split(/\s+/)[0]}'s workspace`;

  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO users (id, username, display_name, email, pw_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).bind(userId, username, displayName, email, pwHash, ts),
    env.DB.prepare(
      'INSERT INTO workspaces (id, name, slug, owner_id, created_at) VALUES (?, ?, ?, ?, ?)',
    ).bind(workspaceId, wsName, slugify(wsName), userId, ts),
    env.DB.prepare(
      "INSERT INTO workspace_members (workspace_id, user_id, role, added_at) VALUES (?, ?, 'owner', ?)",
    ).bind(workspaceId, userId, ts),
  ]);

  const token = await createSession(env.DB, userId, request.headers.get('User-Agent'));
  return json(
    { user: { id: userId, username, displayName, email } },
    { status: 201, headers: { 'Set-Cookie': sessionCookie(token, url) } },
  );
}

async function handleLogin(request, env, url) {
  const body = await readJson(request);
  if (!body) return fail(400, 'Malformed request');

  const username = String(body.username || '').trim().toLowerCase();
  const password = String(body.password || '');
  const ip = request.headers.get('CF-Connecting-IP') || 'local';

  for (const key of [`u:${username}`, `ip:${ip}`]) {
    const wait = await throttleCheck(env.DB, key);
    if (wait) return fail(429, `Too many failed attempts. Try again in ${Math.ceil(wait / 60)} minute(s).`);
  }

  const row = await env.DB.prepare(
    'SELECT id, username, display_name, email, pw_hash FROM users WHERE username = ?',
  ).bind(username).first();

  // The same message and roughly the same work either way: a fast "no such
  // user" against a slow "wrong password" tells an attacker which usernames
  // are real.
  const ok = row ? await verifyPassword(password, row.pw_hash)
                 : await verifyPassword(password, await hashPassword('placeholder'));
  if (!row || !ok) {
    await throttleFail(env.DB, `u:${username}`);
    await throttleFail(env.DB, `ip:${ip}`);
    return fail(401, 'Wrong username or password.');
  }

  await throttleClear(env.DB, `u:${username}`);
  await throttleClear(env.DB, `ip:${ip}`);
  await env.DB.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').bind(now(), row.id).run();

  const token = await createSession(env.DB, row.id, request.headers.get('User-Agent'));
  return json(
    { user: { id: row.id, username: row.username, displayName: row.display_name, email: row.email } },
    { headers: { 'Set-Cookie': sessionCookie(token, url) } },
  );
}

async function handleLogout(request, env, url) {
  await destroySession(env.DB, readCookie(request, SESSION_COOKIE));
  return json({ ok: true }, { headers: { 'Set-Cookie': sessionCookie('', url, { clear: true }) } });
}

/* =============================================================== workspaces */

async function listWorkspaces(env, user) {
  const { results } = await env.DB.prepare(
    `SELECT w.id, w.name, w.slug, w.owner_id, m.role,
            (SELECT COUNT(*) FROM cases c WHERE c.workspace_id = w.id)              AS n_cases,
            (SELECT COUNT(*) FROM workspace_members mm WHERE mm.workspace_id = w.id) AS n_members
       FROM workspaces w
       JOIN workspace_members m ON m.workspace_id = w.id
      WHERE m.user_id = ?
      ORDER BY w.created_at`,
  ).bind(user.id).all();
  return json({ workspaces: results || [] });
}

async function createWorkspace(request, env, user) {
  const body = await readJson(request);
  const name = String(body?.name || '').trim();
  if (!name || name.length > 100) return fail(400, 'Please give the workspace a name.');

  const id = randomId();
  const ts = now();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO workspaces (id, name, slug, owner_id, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(id, name, slugify(name), user.id, ts),
    env.DB.prepare("INSERT INTO workspace_members (workspace_id, user_id, role, added_at) VALUES (?, ?, 'owner', ?)")
      .bind(id, user.id, ts),
  ]);
  return json({ workspace: { id, name, role: 'owner', n_cases: 0, n_members: 1 } }, { status: 201 });
}

async function listMembers(env, workspaceId) {
  const { results } = await env.DB.prepare(
    `SELECT u.id, u.username, u.display_name, m.role, m.added_at
       FROM workspace_members m JOIN users u ON u.id = m.user_id
      WHERE m.workspace_id = ? ORDER BY m.added_at`,
  ).bind(workspaceId).all();
  return json({ members: results || [] });
}

async function addMember(request, env, workspaceId, role) {
  if (role !== 'owner') return fail(403, 'Only the workspace owner can add people.');
  const body = await readJson(request);
  const username = String(body?.username || '').trim().toLowerCase();
  const newRole = ['editor', 'viewer'].includes(body?.role) ? body.role : 'editor';

  const target = await env.DB.prepare('SELECT id, display_name FROM users WHERE username = ?')
    .bind(username).first();
  if (!target) return fail(404, `No account with the username "${username}".`);

  await env.DB.prepare(
    'INSERT INTO workspace_members (workspace_id, user_id, role, added_at) VALUES (?, ?, ?, ?) ' +
    'ON CONFLICT(workspace_id, user_id) DO UPDATE SET role = excluded.role',
  ).bind(workspaceId, target.id, newRole, now()).run();

  return json({ ok: true, member: { id: target.id, username, display_name: target.display_name, role: newRole } });
}

async function removeMember(env, workspaceId, role, targetId) {
  if (role !== 'owner') return fail(403, 'Only the workspace owner can remove people.');
  const ws = await env.DB.prepare('SELECT owner_id FROM workspaces WHERE id = ?').bind(workspaceId).first();
  if (ws?.owner_id === targetId) return fail(400, 'The owner cannot be removed from their own workspace.');
  await env.DB.prepare('DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
    .bind(workspaceId, targetId).run();
  return json({ ok: true });
}

/* ==================================================================== cases */

async function listCases(env, workspaceId, userId) {
  // Every member's annotation is reported, not just the caller's. Seeing that
  // someone else has already outlined a case -- and how their volume compares
  // -- is the entire point of sharing a workspace, and it is cheap here
  // because masks are kilobytes and the join is on the primary key.
  const [cases, annotations, reviews] = await Promise.all([
    env.DB.prepare('SELECT name, record, updated_at FROM cases WHERE workspace_id = ? ORDER BY name')
      .bind(workspaceId).all(),
    env.DB.prepare(
      `SELECT a.case_name, a.user_id, a.volume_mm3, a.voxels, a.edited, a.updated_at,
              u.username, u.display_name
         FROM annotations a JOIN users u ON u.id = a.user_id
        WHERE a.workspace_id = ?`,
    ).bind(workspaceId).all(),
    env.DB.prepare(
      `SELECT r.case_name, r.user_id, r.verdict, r.note, r.updated_at, u.username, u.display_name
         FROM reviews r JOIN users u ON u.id = r.user_id
        WHERE r.workspace_id = ?`,
    ).bind(workspaceId).all(),
  ]);

  const byCase = new Map();
  for (const row of cases.results || []) {
    let record;
    try { record = JSON.parse(row.record); } catch { record = {}; }
    byCase.set(row.name, { ...record, case: row.name, updated_at: row.updated_at, annotations: [], reviews: [] });
  }
  for (const a of annotations.results || []) {
    byCase.get(a.case_name)?.annotations.push({
      userId: a.user_id, username: a.username, displayName: a.display_name,
      volume_mm3: a.volume_mm3, voxels: a.voxels, edited: !!a.edited,
      updated_at: a.updated_at, mine: a.user_id === userId,
    });
  }
  for (const r of reviews.results || []) {
    byCase.get(r.case_name)?.reviews.push({
      userId: r.user_id, username: r.username, displayName: r.display_name,
      verdict: r.verdict, note: r.note, updated_at: r.updated_at, mine: r.user_id === userId,
    });
  }
  return json({ cases: [...byCase.values()] });
}

async function putCase(request, env, workspaceId, caseName, user) {
  const body = await readJson(request);
  if (!body || typeof body.record !== 'object' || body.record === null) {
    return fail(400, 'Expected a case record.');
  }
  const ts = now();
  const statements = [env.DB.prepare(
    `INSERT INTO cases (workspace_id, name, record, created_at, created_by, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(workspace_id, name) DO UPDATE SET record = excluded.record, updated_at = excluded.updated_at`,
  ).bind(workspaceId, caseName, JSON.stringify(body.record), ts, user.id, ts)];

  // The volume of an edited mask is only known once the client has recomputed
  // it, which happens *after* the mask blob is uploaded. Rather than make the
  // client issue a third request, the figures ride along with the record
  // update that follows every edit. Metadata only -- this never touches the
  // blob, so it cannot overwrite anyone's voxels.
  const ann = body.annotation;
  if (ann && typeof ann === 'object') {
    statements.push(env.DB.prepare(
      `UPDATE annotations SET volume_mm3 = ?, voxels = ?, edited = ?, updated_at = ?
        WHERE workspace_id = ? AND case_name = ? AND user_id = ?`,
    ).bind(
      Number.isFinite(ann.volume_mm3) ? ann.volume_mm3 : null,
      Number.isFinite(ann.voxels) ? ann.voxels : null,
      ann.edited ? 1 : 0, ts, workspaceId, caseName, user.id,
    ));
  }

  await env.DB.batch(statements);
  return json({ ok: true, updated_at: ts });
}

async function deleteCase(env, workspaceId, caseName) {
  // R2 has no cascade, so the blobs have to go explicitly. They are listed
  // rather than guessed: per-user mask keys include a user id this code does
  // not otherwise know.
  const prefix = `w/${workspaceId}/c/${encodeURIComponent(caseName)}/`;
  let cursor;
  do {
    const listing = await env.BLOBS.list({ prefix, cursor });
    if (listing.objects.length) await env.BLOBS.delete(listing.objects.map((o) => o.key));
    cursor = listing.truncated ? listing.cursor : undefined;
  } while (cursor);

  await env.DB.prepare('DELETE FROM cases WHERE workspace_id = ? AND name = ?')
    .bind(workspaceId, caseName).run();
  return json({ ok: true });
}

/* ==================================================================== blobs */

async function getBlob(env, key, request) {
  const object = await env.BLOBS.get(key);
  if (!object) return fail(404, 'Not found');

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('Cache-Control', 'private, no-cache');
  // The page is cross-origin isolated; same-origin responses need this to be
  // embeddable under COEP: require-corp.
  headers.set('Cross-Origin-Resource-Policy', 'same-origin');

  // Let the browser skip the download when it already has the bytes. Scans
  // are the large thing here and they never change once uploaded.
  if (request.headers.get('If-None-Match') === object.httpEtag) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(object.body, { headers });
}

async function putBlob(request, env, key) {
  const declared = Number(request.headers.get('Content-Length') || 0);
  if (declared > MAX_BLOB_BYTES) return fail(413, 'That file is too large.');
  if (!request.body) return fail(400, 'Empty upload.');

  const object = await env.BLOBS.put(key, request.body, {
    httpMetadata: { contentType: request.headers.get('Content-Type') || 'application/octet-stream' },
  });
  return { key, bytes: object.size };
}

/* ============================================================== annotations */

// An absent query parameter is `null`, and `Number(null)` is 0 -- so reading
// these with a bare Number() turned "no volume was reported" into "the volume
// is zero mm3", which for a tumour mask is not a missing value but a clinical
// claim. Unknown has to stay unknown.
function numParam(params, name) {
  const raw = params.get(name);
  if (raw === null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

async function saveAnnotation(request, env, workspaceId, caseName, user) {
  const url = new URL(request.url);
  const volume = numParam(url.searchParams, 'volume_mm3');
  const voxels = numParam(url.searchParams, 'voxels');
  const edited = url.searchParams.get('edited') === '1';

  // `annotations` has a foreign key onto `cases`, so saving a layer for a
  // case that is not there fails inside SQLite and surfaces as a bare 500.
  // The case genuinely can be gone -- a colleague may have deleted it while
  // this reviewer had it open -- so the honest answer is to say which, not to
  // report a server fault for a situation the server understands perfectly.
  const parent = await env.DB.prepare(
    'SELECT 1 AS ok FROM cases WHERE workspace_id = ? AND name = ?',
  ).bind(workspaceId, caseName).first();
  if (!parent) {
    return fail(404, 'That scan is no longer in this workspace. Someone may have removed it.');
  }

  const key = maskKey(workspaceId, caseName, user.id);
  const put = await putBlob(request, env, key);
  if (put instanceof Response) return put;

  const ts = now();
  await env.DB.prepare(
    `INSERT INTO annotations (workspace_id, case_name, user_id, r2_key, volume_mm3, voxels, edited, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(workspace_id, case_name, user_id) DO UPDATE SET
       r2_key = excluded.r2_key, volume_mm3 = excluded.volume_mm3,
       voxels = excluded.voxels, edited = excluded.edited, updated_at = excluded.updated_at`,
  ).bind(workspaceId, caseName, user.id, key, volume, voxels, edited ? 1 : 0, ts).run();

  return json({ ok: true, bytes: put.bytes, updated_at: ts });
}

async function saveReview(request, env, workspaceId, caseName, user) {
  const body = await readJson(request);
  const verdict = body?.verdict ? String(body.verdict).slice(0, 32) : null;
  const note = body?.note ? String(body.note).slice(0, 10000) : null;
  const ts = now();
  await env.DB.prepare(
    `INSERT INTO reviews (workspace_id, case_name, user_id, verdict, note, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(workspace_id, case_name, user_id) DO UPDATE SET
       verdict = excluded.verdict, note = excluded.note, updated_at = excluded.updated_at`,
  ).bind(workspaceId, caseName, user.id, verdict, note, ts).run();
  return json({ ok: true, updated_at: ts });
}

/* ================================================================== routing */

async function route(request, env, url) {
  const path = url.pathname;
  const method = request.method;
  const seg = path.split('/').filter(Boolean);       // ['api', ...]

  /* -- unauthenticated -- */
  if (path === '/api/auth/register' && method === 'POST') return handleRegister(request, env, url);
  if (path === '/api/auth/login'    && method === 'POST') return handleLogin(request, env, url);
  if (path === '/api/auth/logout'   && method === 'POST') return handleLogout(request, env, url);

  const user = await userForToken(env.DB, readCookie(request, SESSION_COOKIE));

  if (path === '/api/auth/me') {
    return user ? json({ user }) : json({ user: null }, { status: 401 });
  }
  if (!user) return fail(401, 'Please sign in.');

  /* -- workspaces -- */
  if (path === '/api/workspaces') {
    if (method === 'GET') return listWorkspaces(env, user);
    if (method === 'POST') return createWorkspace(request, env, user);
  }

  // /api/w/<workspaceId>/...
  if (seg[0] === 'api' && seg[1] === 'w' && seg[2]) {
    const workspaceId = seg[2];
    const member = await membership(env, workspaceId, user.id);
    // 404 rather than 403: a non-member should not be able to learn that a
    // workspace id exists at all.
    if (!member) return fail(404, 'No such workspace.');
    const canWrite = CAN_WRITE.has(member.role);

    if (seg.length === 4 && seg[3] === 'members') {
      if (method === 'GET') return listMembers(env, workspaceId);
      if (method === 'POST') return addMember(request, env, workspaceId, member.role);
    }
    if (seg.length === 5 && seg[3] === 'members' && method === 'DELETE') {
      return removeMember(env, workspaceId, member.role, seg[4]);
    }

    if (seg.length === 4 && seg[3] === 'cases' && method === 'GET') {
      return listCases(env, workspaceId, user.id);
    }

    if (seg[3] === 'cases' && seg[4]) {
      const caseName = decodeURIComponent(seg[4]);
      if (!CASE_RE.test(caseName)) return fail(400, 'Bad case name.');

      if (seg.length === 5) {
        if (method === 'PUT') {
          if (!canWrite) return fail(403, 'You have read-only access to this workspace.');
          return putCase(request, env, workspaceId, caseName, user);
        }
        if (method === 'DELETE') {
          if (!canWrite) return fail(403, 'You have read-only access to this workspace.');
          return deleteCase(env, workspaceId, caseName);
        }
      }

      // Shared, case-level files: the scan itself and the model's own mask.
      if (seg.length === 7 && seg[5] === 'files') {
        const kind = seg[6];
        if (!KIND_RE.test(kind)) return fail(400, 'Bad file kind.');
        const key = blobKey(workspaceId, caseName, kind);
        if (method === 'GET') return getBlob(env, key, request);
        if (method === 'PUT') {
          if (!canWrite) return fail(403, 'You have read-only access to this workspace.');
          const put = await putBlob(request, env, key);
          if (put instanceof Response) return put;
          await env.DB.prepare(
            `INSERT INTO case_files (workspace_id, case_name, kind, r2_key, bytes, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(workspace_id, case_name, kind) DO UPDATE SET
               r2_key = excluded.r2_key, bytes = excluded.bytes, updated_at = excluded.updated_at`,
          ).bind(workspaceId, caseName, kind, key, put.bytes, now()).run();
          return json({ ok: true, bytes: put.bytes });
        }
      }

      // Per-user annotation layer. GET defaults to the caller's own; ?user=
      // reads a colleague's, which is read-only for everyone including them.
      if (seg.length === 6 && seg[5] === 'mask') {
        if (method === 'GET') {
          const whose = url.searchParams.get('user') || user.id;
          return getBlob(env, maskKey(workspaceId, caseName, whose), request);
        }
        if (method === 'PUT') {
          if (!canWrite) return fail(403, 'You have read-only access to this workspace.');
          return saveAnnotation(request, env, workspaceId, caseName, user);
        }
      }

      if (seg.length === 6 && seg[5] === 'review' && method === 'PUT') {
        if (!canWrite) return fail(403, 'You have read-only access to this workspace.');
        return saveReview(request, env, workspaceId, caseName, user);
      }
    }
  }

  return fail(404, 'No such endpoint.');
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (!url.pathname.startsWith('/api/')) {
      // Not an API path and no asset matched it.
      return env.ASSETS ? env.ASSETS.fetch(request) : fail(404, 'Not found');
    }

    try {
      const response = await route(request, env, url);
      // No endpoint here is cacheable, and an intermediary caching a case
      // list would show one reviewer another's stale workspace.
      response.headers.set('Cache-Control', response.headers.get('Cache-Control') || 'no-store');
      response.headers.set('X-Content-Type-Options', 'nosniff');
      return response;
    } catch (err) {
      // The message can carry a SQL fragment or a key; log it, do not ship it.
      console.error('unhandled', url.pathname, err?.stack || err);
      return fail(500, 'Something went wrong on the server.');
    }
  },
};
