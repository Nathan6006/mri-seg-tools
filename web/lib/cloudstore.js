/**
 * The shared-workspace twin of store.js.
 *
 * It exports the same names with the same signatures, so `backend.js` can be
 * pointed at either one and the 3,000 lines of viewer above it never learn
 * which is in use. That interface was already the seam between the viewer and
 * IndexedDB; this file is the second thing behind it.
 *
 * WHAT IS DIFFERENT, AND IT IS ONE THING
 * --------------------------------------
 * Locally, a case has *a* mask. Here, each member of a workspace has their
 * own. `putFile(name, 'mask', ...)` writes to the caller's own layer and can
 * never touch anybody else's; `getFile(name, 'mask')` reads the caller's.
 * A colleague's layer is reachable only through `getUserMask`, and only to
 * read. Nothing in this module can overwrite another person's voxels, which
 * is a property of the URL space rather than a rule anyone has to remember.
 *
 * `auto_mask` is NOT per-user: it is what the model produced, it is the same
 * for everyone, and it is never written by an edit.
 *
 * WHAT STAYS LOCAL
 * ----------------
 * getKV/setKV. Those hold display preferences and one-time migration markers
 * -- per-device settings, not study data. Putting them on the server would
 * mean one reviewer changing a default for everybody.
 */

import * as local from './store.js';

// Per-user layers live behind their own endpoint; everything else is a
// shared case-level file.
const PER_USER_KINDS = new Set(['mask']);

let SESSION = { workspaceId: null, user: null };

export function configure({ workspaceId, user }) {
  SESSION = { workspaceId, user };
}

export function currentUser() { return SESSION.user; }
export function currentWorkspace() { return SESSION.workspaceId; }

function base() {
  if (!SESSION.workspaceId) throw new Error('no workspace selected');
  return `/api/w/${encodeURIComponent(SESSION.workspaceId)}`;
}

const caseUrl = (name) => `${base()}/cases/${encodeURIComponent(name)}`;

async function req(url, init = {}) {
  const r = await fetch(url, { credentials: 'same-origin', ...init });
  if (r.status === 401) {
    // The session expired underneath a working reviewer. Say so in the one
    // place that can distinguish it from a network failure.
    throw Object.assign(new Error('Your session has expired. Please sign in again.'), { authExpired: true });
  }
  return r;
}

async function jsonReq(url, init) {
  const r = await req(url, init);
  if (!r.ok) {
    let msg = `${r.status} ${r.statusText}`;
    try { msg = (await r.json()).error || msg; } catch { /* keep the status */ }
    throw new Error(msg);
  }
  return r.json();
}

/* ------------------------------------------------------------------ cases */

// The server returns each record with `annotations` and `reviews` attached.
// They are kept on the record -- the viewer ignores fields it does not know,
// and the workspace UI needs them to show who else has outlined a case.
export async function allCases() {
  const { cases } = await jsonReq(`${base()}/cases`);
  return cases;
}

export async function putCase(record) {
  // Strip the server-derived fields before sending them back, so the stored
  // record stays the client's own shape and does not accumulate copies of
  // other people's annotations inside itself.
  const { annotations, reviews, updated_at, ...clean } = record;
  const mine = (annotations || []).find((a) => a.mine);
  await jsonReq(caseUrl(record.case), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      record: clean,
      annotation: {
        volume_mm3: record.corrected_volume_mm3 ?? record.auto_volume_mm3 ?? mine?.volume_mm3 ?? null,
        voxels: record.mask_voxels ?? mine?.voxels ?? null,
        edited: !!record.edited,
      },
    }),
  });
}

export async function putCases(records) {
  // Sequential on purpose. A cohort import is tens of cases, and firing them
  // all at once buys nothing against a single D1 database while making a
  // partial failure much harder to describe to the person watching.
  for (const r of records) await putCase(r);
}

export async function deleteCase(name) {
  await jsonReq(caseUrl(name), { method: 'DELETE' });
}

export async function clearAll() {
  const cases = await allCases();
  for (const c of cases) await deleteCase(c.case);
}

/* ------------------------------------------------------------------ files */

// The server explains refusals it understands -- a deleted case, a read-only
// role, a file over the ceiling. Reporting the bare status instead would turn
// all of those into "could not save your mask: 404", which tells the person
// losing an edit nothing about what to do next.
async function serverMessage(response, fallback) {
  try {
    const body = await response.json();
    if (body?.error) return body.error;
  } catch { /* not every error response has a JSON body */ }
  return `${fallback} (${response.status})`;
}

/**
 * Every write answers with the account's storage usage, and that answer is
 * broadcast rather than returned.
 *
 * An event, not an import, because `account.js` already imports `backend.js`
 * which imports this file -- having this one reach back for the header would
 * close the loop. It also means the ingest path needs no changes at all: the
 * meter updates because bytes moved, wherever in the code they moved from.
 */
function announceUsage(usage) {
  if (!usage) return;
  window.dispatchEvent(new CustomEvent('mriseg:usage', { detail: usage }));
}

export async function putFile(name, kind, bytes) {
  const body = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const perUser = PER_USER_KINDS.has(kind);
  const url = perUser ? `${caseUrl(name)}/mask` : `${caseUrl(name)}/files/${kind}`;

  const r = await req(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    body,
  });
  if (!r.ok) {
    // 507 is the quota ceiling. Its message already explains what to do, so
    // it is passed through verbatim rather than wrapped in "could not
    // upload image", which would bury the actionable half.
    let payload = null;
    try { payload = await r.clone().json(); } catch { /* no body */ }
    if (payload?.usage) announceUsage(payload.usage);
    if (payload?.code === 'quota_exceeded') {
      throw Object.assign(new Error(payload.error), { quotaExceeded: true });
    }
    throw new Error(await serverMessage(
      r, perUser ? 'could not save your mask' : `could not upload ${kind}`));
  }
  try { announceUsage((await r.json()).usage); } catch { /* no body is fine */ }
}

export async function getFile(name, kind) {
  const perUser = PER_USER_KINDS.has(kind);
  const url = perUser ? `${caseUrl(name)}/mask` : `${caseUrl(name)}/files/${kind}`;
  const r = await req(url);

  if (r.status === 404) {
    // A SECOND REVIEWER OPENING A CASE HAS NO LAYER YET, AND MUST NOT BE
    // SHOWN AN EMPTY MASK.
    //
    // The first reviewer's layer is seeded from the model at ingest. Anyone
    // added to the workspace afterwards has nothing, and returning empty
    // would draw every scan as having no tumour -- which in this kind of
    // study is not a blank slate but a claim, and a plausible-looking one:
    // genuinely tumour-free scans are real, expected, and concentrated in
    // the treated arms. A reviewer told "no tumour" on every case they open
    // would have no way to tell the difference.
    //
    // So their first view is the model's own output, which is what they are
    // there to check. Their first save forks it into their own layer and
    // nothing they do touches anyone else's.
    if (perUser) {
      const auto = await req(`${caseUrl(name)}/files/auto_mask`);
      if (auto.ok) return new Uint8Array(await auto.arrayBuffer());
    }
    return undefined;
  }
  if (!r.ok) throw new Error(`could not read ${kind}: ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

/** Read a colleague's annotation layer. Read-only, by construction. */
export async function getUserMask(name, userId) {
  const r = await req(`${caseUrl(name)}/mask?user=${encodeURIComponent(userId)}`);
  if (r.status === 404) return undefined;
  if (!r.ok) throw new Error(`could not read that layer: ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

/**
 * Make sure the case row exists before anything is hung off it.
 *
 * The local store is IndexedDB, which has no foreign keys, so `pipeline.js`
 * was written to upload a case's FILES first and write the case RECORD
 * afterwards -- an order that is fine there and violates a foreign key here.
 * The cloud store has to honour the contract the pipeline was written
 * against, so it creates the parent row rather than making the pipeline
 * reorder itself for one backend.
 *
 * The placeholder record is replaced moments later by the real one. Doing
 * this explicitly, once, rather than relying on `image` happening to be the
 * first key of the object passed to putFiles: that order is an
 * implementation detail of an object literal three files away.
 */
async function ensureCase(name) {
  await jsonReq(caseUrl(name), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ record: { case: name, incomplete: true } }),
  });
}

export async function putFiles(name, files) {
  await ensureCase(name);
  for (const [kind, bytes] of Object.entries(files)) {
    if (bytes != null) await putFile(name, kind, bytes);
  }
}

/* ---------------------------------------------------------- small values */

export const getKV = local.getKV;
export const setKV = local.setKV;

/* ------------------------------------------------------------ housekeeping */

// Server-side storage is not subject to browser eviction, so the question
// `requestPersistence` exists to answer does not arise. These three return
// the same SHAPES as their counterparts in store.js, because the UI renders
// them without knowing which backend produced them.
export async function requestPersistence() {
  return { supported: true, persisted: true };
}

// Browser quota is irrelevant here, and reporting the origin's IndexedDB
// figures would be actively misleading -- they describe storage this backend
// is not using. Null is the honest answer and the readout handles it.
export async function usage() {
  return { used: null, quota: null };
}

/**
 * The one unambiguously good answer of the four store.js has to choose
 * between. Safari's seven-day eviction -- the case that actually bit a
 * reviewer coming back to a cohort a fortnight later -- does not apply to
 * data held on the server, and neither does disk pressure or clearing site
 * data. Signing in on another machine shows the same work.
 */
export function storagePolicy() {
  return {
    level: 'ok',
    lifetime: 'indefinitely, on the server',
    note: 'Results are saved to the shared workspace, not to this browser. '
        + 'They survive clearing site data, they are not subject to Safari\'s '
        + 'seven-day eviction, and they follow you to any computer you sign '
        + 'in from. Everyone you have invited sees them.',
  };
}
