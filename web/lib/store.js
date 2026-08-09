/**
 * Where results live when there is no server.
 *
 * The Flask build has a results folder on disk. This one has IndexedDB, which
 * is the only browser storage that will hold a few hundred megabytes of binary
 * data and survive a reload. localStorage is a few megabytes of strings and
 * would not hold one scan.
 *
 * WHAT THIS CHANGES FOR THE USER, AND WHY IT IS SAID OUT LOUD IN THE UI
 * --------------------------------------------------------------------
 * Results are now stored *in this browser, on this machine*. They are not in a
 * folder anyone can back up, they do not follow the user to another computer,
 * and clearing site data deletes them. That is a real downside next to the
 * Flask build, so the tool tells the user plainly, asks the browser to make the
 * storage persistent, and puts "Download everything" where it cannot be missed.
 *
 * A scan is about 4.5 MB stored (image + two masks + QC PNG), so a 40-scan
 * cohort is roughly 180 MB. Browsers grant far more than that by default, but
 * an origin can be evicted under storage pressure if permission was refused,
 * which is exactly why `requestPersistence` is called on startup and its answer
 * is surfaced rather than swallowed.
 */

const DB_NAME = 'mri-review';
const DB_VERSION = 1;
const CASES = 'cases';
const FILES = 'files';
const KV = 'kv';

let _db = null;

function open() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(CASES)) db.createObjectStore(CASES, { keyPath: 'case' });
      if (!db.objectStoreNames.contains(FILES)) db.createObjectStore(FILES);
      if (!db.objectStoreNames.contains(KV)) db.createObjectStore(KV);
    };
    req.onsuccess = () => {
      _db = req.result;
      // A second tab running a newer version would otherwise block forever on
      // its upgrade. Close and let the user reload rather than hang.
      _db.onversionchange = () => { _db.close(); _db = null; };
      resolve(_db);
    };
    req.onerror = () => reject(new Error(
      `cannot open local storage: ${req.error?.message || 'unknown error'}. ` +
      `Private-browsing windows in some browsers block IndexedDB entirely.`));
  });
}

function run(storeNames, mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(storeNames, mode);
    let out;
    tx.oncomplete = () => resolve(out);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('storage transaction aborted'));
    out = fn(...storeNames.map((n) => tx.objectStore(n)));
    if (out && typeof out.then === 'function') {
      reject(new Error('store callbacks must be synchronous -- an await inside ' +
                       'one lets the IndexedDB transaction auto-close'));
    }
  }));
}

const wrap = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

// NUL separates the two parts of the key. A space or a slash would not:
// session folder names contain spaces ("0001 SUBJ-A Male d12"), so
// `A B` + `c` and `A` + `B c` would collide on the same record. NUL is
// the one byte that cannot appear in either half.
const fileKey = (name, kind) => `${name}\u0000${kind}`;

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

export async function allCases() {
  const db = await open();
  const tx = db.transaction(CASES, 'readonly');
  return wrap(tx.objectStore(CASES).getAll());
}

export async function putCase(record) {
  return run([CASES], 'readwrite', (s) => { s.put(record); });
}

export async function putCases(records) {
  return run([CASES], 'readwrite', (s) => { for (const r of records) s.put(r); });
}

export async function deleteCase(name) {
  const db = await open();
  const tx = db.transaction([CASES, FILES], 'readwrite');
  tx.objectStore(CASES).delete(name);
  for (const kind of ['image', 'auto_mask', 'mask', 'qc', 'workspace']) {
    tx.objectStore(FILES).delete(fileKey(name, kind));
  }
  return new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
}

export async function clearAll() {
  return run([CASES, FILES, KV], 'readwrite', (c, f, k) => { c.clear(); f.clear(); k.clear(); });
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

export async function putFile(name, kind, bytes) {
  return run([FILES], 'readwrite', (s) => { s.put(bytes, fileKey(name, kind)); });
}

export async function getFile(name, kind) {
  const db = await open();
  const tx = db.transaction(FILES, 'readonly');
  return wrap(tx.objectStore(FILES).get(fileKey(name, kind)));
}

/** Several files of one case in a single transaction. */
export async function putFiles(name, files) {
  return run([FILES], 'readwrite', (s) => {
    for (const [kind, bytes] of Object.entries(files)) {
      if (bytes != null) s.put(bytes, fileKey(name, kind));
    }
  });
}

// ---------------------------------------------------------------------------
// Small values
// ---------------------------------------------------------------------------

export async function getKV(key, fallback = null) {
  const db = await open();
  const tx = db.transaction(KV, 'readonly');
  const v = await wrap(tx.objectStore(KV).get(key));
  return v === undefined ? fallback : v;
}

export async function setKV(key, value) {
  return run([KV], 'readwrite', (s) => { s.put(value, key); });
}

// ---------------------------------------------------------------------------
// Housekeeping
// ---------------------------------------------------------------------------

/**
 * Ask the browser not to evict this origin's data under storage pressure.
 *
 * Returns what it actually got, not what it asked for. Chrome grants this
 * silently for a site the user has engaged with; Safari is stricter. Either
 * way the answer is shown in the UI, because "your results might vanish" is
 * not something to discover after a day of review work.
 */
export async function requestPersistence() {
  if (!navigator.storage?.persist) return { supported: false, persisted: false };
  const already = await navigator.storage.persisted();
  const persisted = already || await navigator.storage.persist();
  return { supported: true, persisted };
}

/** Bytes used and the quota, for the storage readout. */
export async function usage() {
  if (!navigator.storage?.estimate) return null;
  const { usage: used, quota } = await navigator.storage.estimate();
  return { used, quota };
}

/**
 * HOW LONG DOES ANY OF THIS ACTUALLY LAST?
 *
 * It is not one answer, it is four, and the differences are large enough that
 * the tool has to say which one applies rather than a generic "stored locally".
 *
 *   Chrome / Edge, persistence granted
 *       Indefinite. Never evicted automatically; goes only when someone clears
 *       site data. This is what the app asks for on startup, and Chrome grants
 *       it silently once the site has any engagement history.
 *
 *   Chrome / Edge, persistence refused ("best-effort")
 *       Kept until the disk gets tight, then origins are evicted
 *       least-recently-used. No warning, no time limit.
 *
 *   Safari
 *       SEVEN DAYS. Safari's tracking prevention deletes all script-writable
 *       storage -- IndexedDB included -- after seven days of browsing without
 *       the user visiting the site. It is not about disk pressure and asking
 *       for persistence does not exempt you; only adding the page to the Home
 *       Screen as a web app does. For a lab where someone reviews a cohort
 *       every couple of weeks, this is the case that actually bites.
 *
 *   Private / incognito window, any browser
 *       Gone when the window closes.
 *
 * Firefox behaves like Chrome but prompts the user for persistence rather than
 * deciding heuristically.
 *
 * Detecting Safari from the user agent is normally a bad idea, and it is the
 * right one here: this is a storage POLICY difference, not a missing feature,
 * so there is nothing to feature-detect. Getting it wrong is cheap in both
 * directions -- an unnecessary warning, or a missing one about a real risk.
 */
export function storagePolicy(persisted) {
  const ua = navigator.userAgent;
  const isSafari = /^((?!chrome|chromium|android|crios|fxios|edg).)*safari/i.test(ua);

  if (isSafari) {
    return {
      level: 'warn',
      lifetime: 'about 7 days without opening this page',
      note: 'Safari deletes site storage after seven days of not visiting a ' +
            'page, whatever permissions it has been given. Download a copy ' +
            'before you leave results for more than a few days — or use ' +
            'Chrome, where they persist indefinitely.',
    };
  }
  if (persisted) {
    return {
      level: 'ok',
      lifetime: 'indefinitely, until you clear site data',
      note: 'This browser has granted persistent storage, so results are not ' +
            'evicted automatically.',
    };
  }
  return {
    level: 'warn',
    lifetime: 'until this disk runs low on space',
    note: 'This browser has not granted persistent storage, so results here ' +
          'can be cleared automatically if the disk gets full. Use ' +
          '"Download all" to keep a copy you control.',
  };
}
