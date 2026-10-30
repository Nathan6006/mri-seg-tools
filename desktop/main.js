/**
 * Desktop shell for the review tool in ../web.
 *
 * The tool itself is unchanged: this process serves the same files the web
 * host serves, with the same headers, and adds the few things a browser tab
 * cannot do -- pick several scan folders at once from a native dialog, share
 * a plain folder on disk with ITK-SNAP without a permission dance, and launch
 * ITK-SNAP on a case.
 *
 * WHY A CUSTOM PROTOCOL AND NOT file://
 * -------------------------------------
 * Three things the tool relies on do not exist on file://:
 *   * crypto.subtle (change detection) requires a secure context,
 *   * ES modules are blocked by same-origin rules on local files,
 *   * COOP/COEP make the page cross-origin isolated, which is what allows
 *     SharedArrayBuffer and therefore multi-threaded inference. Without the
 *     headers the model still runs -- on one thread, several times slower --
 *     so getting this wrong looks like a bug in the model, not in serving.
 * A privileged custom scheme is a secure context and can send headers, so the
 * page behaves exactly as it does on the real host. The header block below is
 * kept deliberately in step with web/_headers and web/serve.py.
 *
 * SECURITY POSTURE
 * ----------------
 * The renderer runs remote-style web code with contextIsolation on and no
 * Node access. Everything native goes through the small IPC surface at the
 * bottom of this file, and every path that crosses it is validated here, in
 * the main process: scan files may only be read under a folder the user just
 * picked in a dialog, case writes may only land inside the linked export
 * folder, and ITK-SNAP can only be launched on a workspace found inside that
 * folder. The renderer only ever names things; this process decides paths.
 */

'use strict';

const { app, BrowserWindow, Menu, dialog, ipcMain, net, protocol, session, shell } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const SMOKE = process.argv.includes('--smoke');
const SELFTEST = process.argv.includes('--selftest');

// End-to-end test mode: `--e2e <scanFolder> <exportFolder>` answers the two
// native dialogs from the command line (a script cannot click them) and then
// drives the real page through import -> segment -> export -> sync. Nothing
// else is stubbed: the walk, the IPC reads, the DICOM decode and the model all
// run exactly as a user's click would run them. `--e2e-verify` re-launches on
// the same profile and checks the results survived, which is the persistence
// claim. `--profile <dir>` keeps test data out of the real user profile.
const argAfter = (flag, n = 1) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv.slice(i + 1, i + 1 + n) : null;
};
const E2E = argAfter('--e2e', 2);          // [scanDir, exportDir] or null
const E2E_VERIFY = process.argv.includes('--e2e-verify');
// `--migration` seeds localStorage with a pre-2026-08-13 prefs blob (separate
// freehand/adaptive tools, boolean brush shape), reloads, and checks the app
// maps it forward instead of booting into tools that no longer exist.
const MIGRATION = process.argv.includes('--migration');
const PROFILE = argAfter('--profile')?.[0];
if (PROFILE) {
  app.setPath('userData', PROFILE);
} else if (SMOKE || SELFTEST || E2E || E2E_VERIFY || process.argv.includes('--migration')) {
  // Test modes must NEVER run on the real profile. The selftest creates and
  // then clears workspace data -- against the user's own storage that would
  // delete their results (it did once; this guard is why it cannot again).
  // Anything that needs persistent state across launches passes --profile.
  app.setPath('userData', path.join(app.getPath('temp'), `mri-review-test-${Date.now()}`));
}

// Where the tool's files live: next door in development, packed into the app
// bundle's resources once built. Same layout either way.
const WEB_ROOT = app.isPackaged
  ? path.join(process.resourcesPath, 'web')
  : path.join(__dirname, '..', 'web');

/* ======================= serving the tool ======================= */

// Kept deliberately in step with web/_headers and web/serve.py. If you change
// one, change the others; the point is that the tool behaves identically in a
// tab, behind serve.py, and in this shell.
const HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; " +
    "worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' blob: data:; connect-src 'self'; font-src 'self'; " +
    "object-src 'none'; base-uri 'none'; form-action 'none'; " +
    "frame-ancestors 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cache-Control': 'no-store',
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  // The runtime refuses to stream-compile anything not served as
  // application/wasm -- it falls back to a slower path, or fails outright.
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.bin': 'application/octet-stream',
  '.onnx': 'application/octet-stream',
  '.gz': 'application/gzip',
};

// Must run before app.whenReady. `standard` gives the scheme an origin (so
// relative URLs and same-origin checks work), `secure` makes it a secure
// context (crypto.subtle), and supportFetchAPI/stream are what let the page
// fetch() model shards from it.
protocol.registerSchemesAsPrivileged([{
  scheme: 'app',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true },
}]);

async function serveWeb(request) {
  const url = new URL(request.url);

  // `--selftest` loads the web build's own 43-check suite, which reports by
  // POSTing its results to its origin -- normally run_selftest.py's server.
  // Answering that POST here runs the identical suite inside this shell.
  if (SELFTEST && request.method === 'POST' && url.pathname === '/__selftest_result') {
    const r = await request.json();
    for (const t of r.results || []) {
      console.log(`  ${t.ok ? 'ok  ' : 'FAIL'}  ${t.name}  (${Math.round(t.ms)} ms)`);
      if (!t.ok) console.log(`          ${t.error || ''}`);
    }
    console.log(`\n${r.passed} passed, ${r.failed} failed`);
    setImmediate(() => app.exit(r.failed ? 1 : 0));
    return new Response(null, { status: 204 });
  }

  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';

  // Resolve strictly inside WEB_ROOT. path.join collapses any ../ the URL
  // parser let through, and the prefix check catches what it did not.
  const file = path.join(WEB_ROOT, rel);
  if (file !== WEB_ROOT && !file.startsWith(WEB_ROOT + path.sep)) {
    return new Response('forbidden', { status: 403 });
  }

  let stat;
  try { stat = await fsp.stat(file); } catch { return new Response('not found', { status: 404 }); }
  if (!stat.isFile()) return new Response('not found', { status: 404 });

  // net.fetch on a file: URL streams the body, which matters for the model
  // shards -- reading 90 MB into memory to copy it once would be pointless.
  const res = await net.fetch(pathToFileURL(file).toString());
  const headers = new Headers(HEADERS);
  headers.set('Content-Type', MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
  headers.set('Content-Length', String(stat.size));
  return new Response(res.body, { status: 200, headers });
}

/* ======================= settings ======================= */
// One tiny JSON file in the app's own data directory. Holds the export-folder
// path -- the desktop counterpart of the browser build's stored directory
// handle, except a path needs no re-granting.

const SETTINGS_PATH = () => path.join(app.getPath('userData'), 'settings.json');

function readSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_PATH(), 'utf8')); }
  catch { return {}; }
}

function writeSettings(patch) {
  const merged = { ...readSettings(), ...patch };
  fs.writeFileSync(SETTINGS_PATH(), JSON.stringify(merged, null, 2));
  return merged;
}

/* ======================= name and path validation ======================= */

// Same rule serve.py enforces: a case (or file) is a NAME the page chose; it
// must never traverse anywhere.
function safeName(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 200
    && !/[/\\]|\.\./.test(name);
}

// The export folder the user linked, or null. Every case write and every
// ITK-SNAP launch resolves under this and nowhere else.
function exportRoot() {
  const dir = readSettings().exportFolder;
  if (!dir) return null;
  try { return fs.statSync(dir).isDirectory() ? fs.realpathSync(dir) : null; }
  catch { return null; }
}

function caseDir(root, caseName, { mustExist = false } = {}) {
  if (!safeName(caseName)) throw new Error(`invalid case name: ${caseName}`);
  const dir = path.join(root, caseName);
  if (mustExist && !fs.existsSync(dir)) throw new Error(`no folder named "${caseName}" in the linked folder`);
  return dir;
}

/* ======================= scan-folder ingest ======================= */
// The user picks folders in a native dialog; each pick registers a root the
// renderer can then read files under, by relative path, until the app quits.
// Nothing outside a picked root is ever readable.

const SCAN_ROOTS = new Map();   // token -> absolute path
let NEXT_TOKEN = 1;

const MAX_WALK_DEPTH = 6;       // matches the web pipeline's session discovery
const MAX_WALK_FILES = 500000;

async function walkDicom(root, rel, out, depth) {
  if (depth > MAX_WALK_DEPTH || out.length >= MAX_WALK_FILES) return;
  const entries = await fsp.readdir(path.join(root, rel), { withFileTypes: true });
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) await walkDicom(root, r, out, depth + 1);
    else if (e.isFile() && e.name.toLowerCase().endsWith('.dcm')) {
      const { size } = await fsp.stat(path.join(root, r));
      out.push({ rel: r, size });
      if (out.length >= MAX_WALK_FILES) return;
    }
  }
}

/* ======================= ITK-SNAP ======================= */

const MAC_APP = '/Applications/ITK-SNAP.app/Contents/MacOS/ITK-SNAP';

// The binary: $ITKSNAP override, then PATH, then the macOS app. Same order as
// web/serve.py, for the same reasons.
function findItksnap() {
  const onPath = () => {
    for (const dir of (process.env.PATH || '').split(path.delimiter)) {
      const p = path.join(dir, 'itksnap');
      try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* keep looking */ }
    }
    return null;
  };
  for (const cand of [process.env.ITKSNAP, onPath(), MAC_APP]) {
    if (!cand) continue;
    try { if (fs.statSync(cand).isFile()) { fs.accessSync(cand, fs.constants.X_OK); return cand; } }
    catch { /* keep looking */ }
  }
  return null;
}

/* ======================= IPC surface ======================= */

function registerIpc() {
  // ---- scan ingest ----
  ipcMain.handle('scan:pick', async (e) => {
    let filePaths;
    if (E2E) {
      filePaths = [E2E[0]];
    } else {
      const win = BrowserWindow.fromWebContents(e.sender);
      const r = await dialog.showOpenDialog(win, {
        title: 'Choose scan folders',
        buttonLabel: 'Add',
        properties: ['openDirectory', 'multiSelections'],
      });
      if (r.canceled || !r.filePaths.length) return [];
      filePaths = r.filePaths;
    }
    const picks = [];
    for (const dir of filePaths) {
      const root = fs.realpathSync(dir);
      const files = [];
      await walkDicom(root, '', files, 0);
      const token = `t${NEXT_TOKEN++}`;
      SCAN_ROOTS.set(token, root);
      picks.push({ token, name: path.basename(root), files });
    }
    return picks;
  });

  // Whole file, or a byte range: series discovery classifies each series from
  // a 16 KB header prefix, and shipping the whole file for that would make
  // discovery as expensive as loading.
  ipcMain.handle('scan:read', async (_e, token, rel, start, end) => {
    const root = SCAN_ROOTS.get(token);
    if (!root) throw new Error('unknown scan folder');
    const file = path.join(root, rel);
    const real = await fsp.realpath(file);
    if (real !== root && !real.startsWith(root + path.sep)) throw new Error('path escapes the picked folder');
    if (start == null) return fsp.readFile(file);   // Buffer -> Uint8Array in the renderer
    const fh = await fsp.open(file, 'r');
    try {
      const size = (await fh.stat()).size;
      const s = Math.max(0, Math.min(start, size));
      const e = end == null ? size : Math.max(s, Math.min(end, size));
      const buf = Buffer.alloc(e - s);
      await fh.read(buf, 0, e - s, s);
      return buf;
    } finally { await fh.close(); }
  });

  // ---- the export folder shared with ITK-SNAP ----
  ipcMain.handle('folder:status', () => {
    const root = exportRoot();
    return root ? { linked: true, name: path.basename(root), path: root }
                : { linked: false, name: null, path: null };
  });

  ipcMain.handle('folder:pick', async (e) => {
    let picked;
    if (E2E) {
      picked = E2E[1];
    } else {
      const win = BrowserWindow.fromWebContents(e.sender);
      const r = await dialog.showOpenDialog(win, {
        title: 'Choose the folder shared with ITK-SNAP',
        buttonLabel: 'Use this folder',
        properties: ['openDirectory', 'createDirectory'],
      });
      if (r.canceled || !r.filePaths.length) return null;
      picked = r.filePaths[0];
    }
    const root = fs.realpathSync(picked);
    writeSettings({ exportFolder: root });
    return { linked: true, name: path.basename(root), path: root };
  });

  ipcMain.handle('folder:forget', () => { writeSettings({ exportFolder: null }); return { linked: false }; });

  // Write one case's files into <folder>/<case>/. `skipIfExists` carries the
  // never-clobber-a-correction rule decided by the caller (lib/fsaccess.js).
  ipcMain.handle('folder:writeCase', async (_e, caseName, files) => {
    const root = exportRoot();
    if (!root) throw new Error('no folder is linked');
    const dir = caseDir(root, caseName);
    await fsp.mkdir(dir, { recursive: true });
    const written = [];
    for (const f of files) {
      if (!safeName(f.name)) throw new Error(`invalid file name: ${f.name}`);
      const dest = path.join(dir, f.name);
      if (f.skipIfExists && fs.existsSync(dest)) continue;
      await fsp.writeFile(dest, Buffer.from(f.bytes));
      written.push(f.name);
    }
    return written;
  });

  ipcMain.handle('folder:writeFile', async (_e, name, text) => {
    const root = exportRoot();
    if (!root) throw new Error('no folder is linked');
    if (!safeName(name)) throw new Error(`invalid file name: ${name}`);
    await fsp.writeFile(path.join(root, name), text, 'utf8');
  });

  ipcMain.handle('folder:readMasks', async (_e, wanted) => {
    const root = exportRoot();
    if (!root) throw new Error('no folder is linked');
    const found = [];
    for (const w of wanted) {
      try {
        if (!safeName(w.case) || !safeName(w.mask)) continue;
        const file = path.join(caseDir(root, w.case, { mustExist: true }), w.mask);
        const [bytes, stat] = await Promise.all([fsp.readFile(file), fsp.stat(file)]);
        found.push({ case: w.case, bytes, lastModified: stat.mtimeMs });
      } catch { /* never exported, or no mask yet: not an error */ }
    }
    return found;
  });

  ipcMain.handle('folder:reveal', () => {
    const root = exportRoot();
    if (root) shell.openPath(root);
  });

  // ---- ITK-SNAP ----
  ipcMain.handle('itksnap:available', () => findItksnap() !== null);

  ipcMain.handle('itksnap:open', async (_e, caseName) => {
    const bin = findItksnap();
    if (!bin) return { error: 'ITK-SNAP was not found. Install it, or point the ITKSNAP environment variable at the binary.' };
    const root = exportRoot();
    if (!root) return { error: 'no folder is linked' };
    let dir;
    try { dir = caseDir(root, caseName, { mustExist: true }); }
    catch (err) { return { error: err.message }; }
    const workspaces = (await fsp.readdir(dir)).filter((f) => f.endsWith('.itksnap')).sort();
    if (!workspaces.length) return { error: `no .itksnap workspace in "${caseName}"` };
    const ws = path.join(dir, workspaces[0]);
    // `ITK-SNAP -w <workspace>` is the documented CLI and the one that
    // verifiably works on macOS -- `open -a ITK-SNAP <file>` starts the app
    // but silently drops the document. Detached, so quitting this app does
    // not take the reviewer's ITK-SNAP down with it.
    const child = spawn(bin, ['-w', ws], { cwd: dir, detached: true, stdio: 'ignore' });
    child.unref();
    return { opened: workspaces[0] };
  });
}

/* ======================= the menu ======================= */
/**
 * A real application menu, for one reason that matters and one that is nice.
 *
 * THE ONE THAT MATTERS: on macOS the DEFAULT menu owns ⌘Z, and its Undo item
 * is the text-field `undo` role -- it calls `webContents.undo()`, which does
 * nothing at all to a canvas. The page has had an undo stack the whole time;
 * the key equivalent was being eaten before the page saw it. These items send
 * the intent to the renderer instead, which decides between the mask undo and
 * a text field's own undo depending on where focus is.
 *
 * The nice one: the lab asked for ITK-SNAP's "open another image" on ⇧⌘G, and
 * a menu is where someone looks for it when they have forgotten the keys.
 */
function toPage(item, win, action) {
  const target = win || BrowserWindow.getFocusedWindow();
  if (target) target.webContents.send('menu', action);
}

function buildMenu() {
  const mac = process.platform === 'darwin';
  const template = [
    ...(mac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Open T1 for this scan',
          accelerator: 'CmdOrCtrl+Shift+G',
          click: (i, w) => toPage(i, w, 'toggleT1'),
        },
        { label: 'Save mask', accelerator: 'CmdOrCtrl+S', click: (i, w) => toPage(i, w, 'save') },
        { type: 'separator' },
        mac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        // NOT the `undo`/`redo` roles: those are the text-field ones.
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: (i, w) => toPage(i, w, 'undo') },
        { label: 'Redo', accelerator: 'Shift+CmdOrCtrl+Z', click: (i, w) => toPage(i, w, 'redo') },
        { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' }, { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ======================= window ======================= */

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 940,
    show: !SMOKE && !SELFTEST && !E2E && !E2E_VERIFY && !MIGRATION,
    backgroundColor: '#111418',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadURL(SELFTEST ? 'app://tool/test/selftest.html?report' : 'app://tool/index.html');
  return win;
}

/* ======================= smoke test ======================= */
// `npm run smoke` boots the real page in a hidden window and verifies the
// serving contract -- the properties that fail silently if the protocol setup
// is wrong. Exit code says pass or fail, so this can run in a script.

async function runSmoke(win) {
  const checks = await win.webContents.executeJavaScript(`(async () => {
    const out = {
      secureContext: window.isSecureContext,
      crossOriginIsolated: window.crossOriginIsolated,
      cryptoSubtle: !!window.crypto?.subtle,
      compressionStream: typeof CompressionStream !== 'undefined',
      indexedDB: typeof indexedDB !== 'undefined',
      cores: navigator.hardwareConcurrency,
    };
    try {
      // Same module instance as the page's own import, so this observes the
      // load the page kicked off. Poll rather than await modelReady(): if the
      // page has not assigned the load promise yet, modelReady() returns at
      // once -- the startup race the web build already documents.
      const b = await import('./lib/backend.js');
      const t0 = Date.now();
      let s = b.state();
      while (Date.now() - t0 < 90000) {
        s = b.state();
        if (s.model_id || s.model_error) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      out.modelReady = s.model === 'onnx' && !!s.model_id;
      out.modelId = s.model_id || null;
      out.modelError = s.model_error || null;
    } catch (e) { out.modelError = String(e); }
    return out;
  })()`, true);

  const failures = [];
  for (const k of ['secureContext', 'crossOriginIsolated', 'cryptoSubtle', 'compressionStream', 'indexedDB']) {
    if (!checks[k]) failures.push(k);
  }
  // A missing model is a deployment mistake, not a protocol one, but the whole
  // point of the shell is that the model is bundled -- so the smoke test
  // treats "stub" as a failure too.
  if (!checks.modelReady) failures.push(`model (${checks.modelError || 'not loaded'})`);

  console.log('[smoke]', JSON.stringify(checks, null, 2));
  console.log(failures.length ? `[smoke] FAIL: ${failures.join(', ')}` : '[smoke] PASS');
  app.exit(failures.length ? 1 : 0);
}

/* ======================= end-to-end test ======================= */
// Drives the real page: the same bridge calls the buttons make, then the same
// Backend calls app.js makes, in the same order. What it deliberately does NOT
// do is stub anything on the page side.

async function runE2E(win) {
  const script = `(async () => {
    const out = { steps: [] };
    const step = (name, v) => out.steps.push({ name, v });
    try {
      // Poll rather than await modelReady(): before the page's init() has
      // assigned the load promise, modelReady() returns at once -- the same
      // startup race the web build documents.
      const Backend = await import('./lib/backend.js');
      const t0 = Date.now();
      let state0 = Backend.state();
      while (Date.now() - t0 < 90000) {
        state0 = Backend.state();
        if (state0.model_id || state0.model_error) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      step('model', state0.model_id);
      if (state0.model !== 'onnx') throw new Error('the trained model did not load: '
        + (state0.model_error || 'no error reported'));

      if (${E2E_VERIFY ? 'true' : 'false'}) {
        // Second launch on the same profile: the import below already ran.
        const cases = Backend.state().cases;
        step('persisted_cases', cases.map(c => ({ case: c.case, vol: c.auto_volume_mm3,
                                                  t1: c.t1 ? c.t1.series : null })));
        if (!cases.length) throw new Error('no cases survived the relaunch');
        // The T1 is stored beside the scan, so it has to come back with it.
        const withT1 = cases.filter(c => c.t1);
        for (const c of withT1) {
          const t1 = await Backend.t1Raw(c.case);
          if (!t1) throw new Error(c.case + ': the T1 record survived but the image did not');
        }
        step('persisted_t1', withT1.length);
        out.ok = true;
        return out;
      }

      // 1. Import by path, exactly as the Choose-scan-folders button does.
      const picks = await window.desktopBridge.pickScanFolders();
      step('picked', picks.map(p => ({ name: p.name, files: p.files.length })));
      if (!picks.length || !picks[0].files.length) throw new Error('the walk found no DICOM files');
      const { entriesFromPicks } = await import('./lib/desktop.js');
      const run = await Backend.run(entriesFromPicks(picks, window.desktopBridge), {});
      step('run', run);

      const cases = Backend.state().cases;
      if (!cases.length) throw new Error('no case was stored: '
        + (Backend.STATE.job.log.join(' | ') || 'no failure logged'));
      const c = cases[0];
      step('case', { case: c.case, volume: c.auto_volume_mm3,
                     slices: c.n_tumor_slices, components: c.n_components });

      // 1b. The T1 companion. This folder has a T1 axial series, so it must
      //     have been captured -- on its OWN grid, which is the whole reason
      //     the viewer lines the two up in millimetres rather than by index.
      step('t1_record', c.t1);
      if (!c.t1) throw new Error('the T1 axial series in this folder was not captured');
      const t1 = await Backend.t1Raw(c.case);
      if (!t1) throw new Error('the T1 record is there but no image was stored');
      step('t1_volume', { size: [t1.meta.nx, t1.meta.ny, t1.meta.nz],
                          spacing: [t1.meta.sx, t1.meta.sy, t1.meta.sz],
                          origin: t1.meta.origin, series: t1.meta.series });
      if (!(t1.meta.origin || []).length || !(t1.meta.direction || []).length)
        throw new Error('the T1 came back with no physical placement');
      if (t1.data.length !== t1.meta.nx * t1.meta.ny * t1.meta.nz)
        throw new Error('the T1 image does not match its own dimensions');
      const t2geom = await Backend.volumeRaw(c.case);
      step('t2_geometry', { origin: t2geom.meta.origin, direction: t2geom.meta.direction });
      if (!(t2geom.meta.origin || []).length)
        throw new Error('the T2 no longer carries its origin, so nothing can be lined up with it');

      // 2. Link the export folder and write the case, as the buttons do.
      const link = await Backend.linkFolder();
      step('linked', link);
      const exp = await Backend.exportToFolder([c.case]);
      step('exported', exp);

      // 3. Read the folder back: nothing has been edited, so nothing changes.
      const sync = await Backend.syncFromFolder();
      step('sync', sync);
      if (sync.checked < 1) throw new Error('sync did not see the exported case');
      if (sync.changed.length) throw new Error('sync reported an edit that never happened');

      // 3b. A real edit: flip one voxel of the working mask in the folder --
      //     decoded and re-encoded with the page's own NIfTI code, the way a
      //     saved correction would arrive -- and the next check must flag
      //     exactly this case as changed.
      const nifti = await import('./lib/nifti.js');
      const fsx = await import('./lib/fsaccess.js');
      const folder = await fsx.activeFolder(true);
      const maskName = c.files.mask;
      const [got] = await fsx.readMasks(folder, [{ case: c.case, files: { mask: maskName } }]);
      if (!got) throw new Error('could not read the exported working mask back');
      const vol = await nifti.readNifti(got.bytes);
      vol.data[0] = vol.data[0] ? 0 : 1;
      const edited = await nifti.writeNiftiGz(vol);
      await window.desktopBridge.writeCase(c.case, [{ name: maskName, bytes: edited, skipIfExists: false }]);
      const sync2 = await Backend.syncFromFolder();
      step('sync_after_edit', sync2);
      if (!sync2.changed.includes(c.case)) throw new Error('an edited mask in the folder was not detected');
      const after = Backend.state().cases.find(x => x.case === c.case);
      step('edited_case', { edited: after.edited, auto: after.auto_volume_mm3,
                            corrected: after.corrected_volume_mm3 });
      if (!after.edited) throw new Error('the case was not marked edited');

      // 4. The launch path's validation: a name that is not there must come
      //    back as a refusal, never a crash and never a launch.
      const bad = await window.desktopBridge.itksnapOpen('no-such-case');
      step('itksnap_refusal', bad);
      if (!bad.error) throw new Error('a bogus case name was accepted');
      step('itksnap_available', await window.desktopBridge.itksnapAvailable());

      // 5. And, when asked to, the real thing: launch ITK-SNAP on the case
      //    just exported. The runner script checks the process exists and
      //    quits it again.
      if (${process.argv.includes('--e2e-launch') ? 'true' : 'false'}) {
        const opened = await window.desktopBridge.itksnapOpen(c.case);
        step('itksnap_opened', opened);
        if (opened.error) throw new Error('launch failed: ' + opened.error);
      }

      out.ok = true;
    } catch (e) { out.ok = false; out.error = e.message; }
    return out;
  })()`;

  const r = await win.webContents.executeJavaScript(script, true);
  for (const s of r.steps) console.log(`[e2e] ${s.name}:`, JSON.stringify(s.v));

  // The page said what it did; now check the disk agrees.
  if (r.ok && !E2E_VERIFY) {
    const written = fs.readdirSync(E2E[1], { recursive: true }).map(String);
    console.log('[e2e] export folder:', JSON.stringify(written));
    const failures = [];
    if (!written.includes('Tumor_label.txt')) failures.push('label file missing');
    if (!written.some((f) => f.endsWith('.itksnap'))) failures.push('workspace missing');
    if (!written.some((f) => f.endsWith('.nii.gz'))) failures.push('volumes missing');
    if (failures.length) { r.ok = false; r.error = failures.join('; '); }
  }

  // Second phase: the keyboard map, exercised on the real UI. Reload so the
  // page renders the imported case, click it the way a user would, then
  // dispatch real KeyboardEvents and assert what the DOM shows.
  if (r.ok && !E2E_VERIFY) {
    win.webContents.reload();
    await new Promise((res) => win.webContents.once('did-finish-load', res));
    const ui = await win.webContents.executeJavaScript(UI_KEYS_SCRIPT, true);
    for (const s of ui.steps) console.log(`[e2e:keys] ${s.name}:`, JSON.stringify(s.v ?? true));
    if (!ui.ok) { r.ok = false; r.error = 'keyboard: ' + ui.error; }
  }

  // Third phase: the application menu. Its key equivalents never reach the
  // page -- a macOS menu eats its own -- so ⌘Z arrives as an IPC message
  // instead, and THAT is the leg worth testing: the page's own keydown
  // handler is already covered above, and was never the thing that was broken.
  if (r.ok && !E2E_VERIFY) {
    const menu = await runMenuPhase(win);
    for (const s of menu.steps) console.log(`[e2e:menu] ${s.name}:`, JSON.stringify(s.v ?? true));
    if (!menu.ok) { r.ok = false; r.error = 'menu: ' + menu.error; }
  }

  console.log(r.ok ? '[e2e] PASS' : `[e2e] FAIL: ${r.error}`);
  app.exit(r.ok ? 0 : 1);
}

/**
 * Drive the menu items the way the menu does -- by sending their action to the
 * page -- and check the page did the thing.
 */
async function runMenuPhase(win) {
  const out = { steps: [], ok: false };
  const step = (name, v) => out.steps.push({ name, v });
  const evaluate = (src) => win.webContents.executeJavaScript(src, true);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    if (!await evaluate(`!!window.desktopBridge && !!window.desktopBridge.onMenu`)) {
      throw new Error('the bridge does not expose the menu channel');
    }

    // Editing again, then an edit that is certainly an edit: clear the slice.
    await evaluate(`(async () => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      document.dispatchEvent(new KeyboardEvent('keydown', {key:'3', bubbles:true, cancelable:true}));
      for (let i = 0; i < 100 && !document.querySelector('#tClear'); i++) await sleep(150);
      await sleep(600);
      document.querySelector('#tClear').click();
      await sleep(200);
      return true;
    })()`);
    const dirty0 = await evaluate(`!!document.querySelector('#edStats2 .dirty')`);
    step('edit_made', dirty0);
    if (!dirty0) throw new Error('clearing the slice did not mark it edited');

    win.webContents.send('menu', 'undo');
    await sleep(500);
    const dirty1 = await evaluate(`!!document.querySelector('#edStats2 .dirty')`);
    step('menu_undo', { dirty0, dirty1 });
    if (dirty1) throw new Error('the menu Undo did not reach the mask');

    win.webContents.send('menu', 'toggleT1');
    await sleep(1200);
    const pane = await evaluate(`!!document.querySelector('#paneT1')`);
    step('menu_open_t1', pane);
    if (!pane) throw new Error('the menu did not open the T1');

    out.ok = true;
  } catch (e) { out.error = e.message; }
  return out;
}

const UI_KEYS_SCRIPT = `(async () => {
  const out = { steps: [], ok: false };
  const step = (n, v) => out.steps.push({ name: n, v });
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const waitFor = async (fn, ms = 30000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await sleep(150); }
    return null;
  };
  const key = (k, opts = {}) => document.dispatchEvent(new KeyboardEvent('keydown',
    Object.assign({ key: k, bubbles: true, cancelable: true }, opts)));
  try {
    const item = await waitFor(() => document.querySelector('.caseitem'));
    if (!item) throw new Error('no case in the list after reload');
    item.click();
    if (!await waitFor(() => {
      const m = document.querySelector('#axMsk');
      return m && m.style.opacity !== '';
    })) throw new Error('the viewer did not render the case');

    key('s');
    const hidden = document.querySelector('#axMsk').style.opacity;
    key('s');
    const shown = document.querySelector('#axMsk').style.opacity;
    step('S_mask_toggle', { hidden, shown });
    if (+hidden !== 0 || +shown <= 0) throw new Error('S did not toggle the mask');

    const op0 = +document.querySelector('#ctOpacity').value;
    key('a'); key('a'); key('d');
    const op1 = +document.querySelector('#ctOpacity').value;
    step('AD_opacity', { op0, op1 });
    if (op1 !== op0 - 5) throw new Error('A/D opacity steps wrong');

    key('y');
    if (!await waitFor(() => document.querySelector('.caseitem .chip.accepted'), 5000))
      throw new Error('Y did not mark the case accepted');
    step('Y_review');

    key('3');
    if (!await waitFor(() => document.querySelector('#edBar')))
      throw new Error('3 did not open the editor');
    if (!document.querySelector('#tPoly.on')) throw new Error('polygon not active after 3');
    step('3_opens_editor_polygon');

    // The freehand gesture, exactly as a hand would make it: trace a loop and
    // let go back at the start. ITK-SNAP closes the outline on that release;
    // so must we. Then Enter accepts, and undo puts the mask back.
    {
      const ovr = document.querySelector('#axOvr');
      // The editor lays itself out asynchronously: the volume load resizes
      // the canvases when it lands, and tracing against a rect measured
      // mid-settle puts every point somewhere else than intended. Wait for
      // the axial canvas to be sized to the volume (renderPane ran), then for
      // the pane to hold still for half a second.
      const img = document.querySelector('#axImg');
      if (!await waitFor(() => img.width > 0 && img.width !== 300, 30000))
        throw new Error('the axial canvas was never sized to the volume');
      let r = null, still = 0;
      for (let prev = null, i = 0; i < 200 && still < 4; i++) {
        const cur = ovr.getBoundingClientRect();
        const same = prev && Math.abs(cur.top - prev.top) < 0.5
          && Math.abs(cur.left - prev.left) < 0.5
          && Math.abs(cur.width - prev.width) < 0.5
          && Math.abs(cur.height - prev.height) < 0.5;
        still = same ? still + 1 : 0;
        prev = cur; r = cur;
        await sleep(150);
      }
      if (still < 4) throw new Error('the pane never stopped moving');
      const pt = (t, x, y, extra = {}) => ovr.dispatchEvent(new PointerEvent(t,
        Object.assign({ bubbles: true, cancelable: true, pointerId: 7,
                        button: 0, buttons: 1, clientX: x, clientY: y }, extra)));
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2, rad = r.width * 0.2;
      // A gesture must not move the page: the pane shifting mid-stroke was a
      // real bug once (an empty hint filling in on the first click), so the
      // harness asserts layout stillness across the whole trace.
      const h0 = ovr.getBoundingClientRect();
      pt('pointerdown', cx + rad, cy);
      for (let i = 1; i <= 40; i++) {
        const a = i / 40 * 2 * Math.PI;
        pt('pointermove', cx + rad * Math.cos(a), cy + rad * Math.sin(a));
      }
      const h1 = ovr.getBoundingClientRect();
      if (Math.abs(h1.top - h0.top) > 0.5 || Math.abs(h1.width - h0.width) > 0.5)
        throw new Error('the pane moved mid-trace: '
          + JSON.stringify([h0.top, h0.width]) + ' -> ' + JSON.stringify([h1.top, h1.width]));
      step('layout_still_during_trace');
      pt('pointerup', cx + rad, cy, { buttons: 0 });
      await sleep(200);
      if (!document.querySelector('#pAccept'))
        throw new Error('a trace released at its start did not close the outline');
      step('freehand_trace_closes_on_release');
      key('Enter');
      await sleep(200);
      if (document.querySelector('#pAccept')) throw new Error('Enter did not accept the outline');
      if (!document.querySelector('#edStats2 .dirty')) throw new Error('accept did not fill anything');
      step('freehand_accept_fills');
      key('z', { metaKey: true });
      await sleep(200);
      if (document.querySelector('#edStats2 .dirty')) throw new Error('undo did not restore the mask');
      step('undo_restores');
    }

    // The AREA ERASER: draw round a region, press Enter, everything inside it
    // goes. Filled first with the outline tool so there is certainly something
    // to take away, then erased with the same gesture -- which is the whole
    // claim: same gesture, opposite effect.
    {
      const voxels = () => {
        const m = /([0-9]+) voxels/.exec(document.querySelector('#edStats2').textContent || '');
        return m ? +m[1] : NaN;
      };
      const settled = async () => {
        const img = document.querySelector('#axImg');
        if (!await waitFor(() => img && img.width > 1, 30000))
          throw new Error('the axial canvas was never sized');
        await sleep(400);
        return document.querySelector('#axOvr');
      };
      const trace = async (ovr) => {
        const r = ovr.getBoundingClientRect();
        const pt = (t, x, y, extra = {}) => ovr.dispatchEvent(new PointerEvent(t,
          Object.assign({ bubbles: true, cancelable: true, pointerId: 9,
                          button: 0, buttons: 1, clientX: x, clientY: y }, extra)));
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2, rad = r.width * 0.2;
        pt('pointerdown', cx + rad, cy);
        for (let i = 1; i <= 40; i++) {
          const a = i / 40 * 2 * Math.PI;
          pt('pointermove', cx + rad * Math.cos(a), cy + rad * Math.sin(a));
        }
        pt('pointerup', cx + rad, cy, { buttons: 0 });
        await sleep(200);
        key('Enter');
        await sleep(250);
      };

      const v0 = voxels();
      await trace(await settled());
      const v1 = voxels();
      if (!(v1 > v0)) throw new Error('the outline did not fill: ' + v0 + ' -> ' + v1);

      key('e');
      if (!await waitFor(() => document.querySelector('#tErase.on'), 5000))
        throw new Error('E did not select the eraser');
      const area = await waitFor(() => document.querySelector('#tEraseSeg button[data-erase=area]'), 5000);
      if (!area) throw new Error('the eraser has no area option');
      area.click();
      if (!await waitFor(() => document.querySelector('#polyBar'), 5000))
        throw new Error('the area eraser does not draw an outline');
      step('area_eraser_selected');

      await trace(await settled());
      const v2 = voxels();
      step('area_eraser', { v0, v1, v2 });
      if (!(v2 < v1)) throw new Error('the area eraser removed nothing: ' + v1 + ' -> ' + v2);
      if (v2 > v0) throw new Error('the area eraser left voxels the fill had added');

      key('z', { metaKey: true });
      key('z', { metaKey: true });
      await sleep(250);
      if (voxels() !== v0) throw new Error('undo did not restore the mask after erasing');
      step('area_eraser_undo_restores');
    }

    // The T1 companion in the UI: ⇧⌘G opens it, and it follows the T2 through
    // the stack -- the two scrolling together is the point of it.
    {
      key('g', { metaKey: true, shiftKey: true });
      const pane = await waitFor(() => document.querySelector('#paneT1'), 20000);
      if (!pane) throw new Error('shift-cmd-G did not open the T1 pane');
      const lab0 = document.querySelector('#t1Lab').textContent;
      for (let i = 0; i < 6; i++) { key('PageDown'); await sleep(80); }
      await sleep(250);
      const lab1 = document.querySelector('#t1Lab').textContent;
      step('t1_follows_slices', { lab0, lab1 });
      if (!lab0 || lab0 === lab1)
        throw new Error('the T1 did not move with the T2: ' + lab0 + ' / ' + lab1);
      key('g', { metaKey: true, shiftKey: true });
      await sleep(300);
      if (document.querySelector('#paneT1')) throw new Error('shift-cmd-G did not close the T1 pane');
      step('t1_toggles_closed');
    }

    key('4');
    if (!await waitFor(() => document.querySelector('#tBrush.on'), 5000))
      throw new Error('4 did not select the brush');
    if (!document.querySelector('#tShapeSeg')) throw new Error('no brush shape control');
    const size0 = +document.querySelector('#tSize').value;
    key('+'); key('+'); key('-');
    const size1 = +document.querySelector('#tSize').value;
    step('brush_plus_minus', { size0, size1 });
    if (size1 !== size0 + 1) throw new Error('brush +/- resize wrong');

    const lab0 = document.querySelector('#axLab').textContent;
    key('PageDown');
    await sleep(200);
    const lab1 = document.querySelector('#axLab').textContent;
    step('PgDn_slice', { lab0, lab1 });
    if (lab0 === lab1) throw new Error('PageDown did not change slice');

    const sa0 = document.querySelector('#saLab').textContent;
    key('ArrowRight', { shiftKey: true });
    await sleep(200);
    const sa1 = document.querySelector('#saLab').textContent;
    step('editor_arrows_cursor', { sa0, sa1 });
    if (sa0 === sa1) throw new Error('arrows did not move the cursor in the editor');

    key('Escape');
    if (!await waitFor(() => !document.querySelector('#edBar'), 5000))
      throw new Error('Escape did not leave the editor');
    step('Esc_exits_editor');

    out.ok = true;
  } catch (e) { out.error = e.message; }
  return out;
})()`;

/* ======================= prefs-migration test ======================= */

async function runMigration(win) {
  await win.webContents.executeJavaScript(`localStorage.setItem('mriseg.prefs',
    JSON.stringify({tool:'freehand', square:true, freehandAuto:false, radius:9}))`, true);
  win.webContents.reload();
  await new Promise((res) => win.webContents.once('did-finish-load', res));
  const r = await win.webContents.executeJavaScript(`(async () => {
    // Force a savePrefs so the migrated state lands back in storage.
    const cb = document.querySelector('#autoNext');
    cb.click(); cb.click();
    const p = JSON.parse(localStorage.getItem('mriseg.prefs'));
    return { tool: p.tool, brushShape: p.brushShape, radius: p.radius,
             square: p.square, freehandAuto: p.freehandAuto };
  })()`, true);
  console.log('[migration]', JSON.stringify(r));
  const ok = r.tool === 'polygon' && r.brushShape === 'square' && r.radius === 9
          && r.square === undefined && r.freehandAuto === undefined;
  console.log(ok ? '[migration] PASS' : '[migration] FAIL');
  app.exit(ok ? 0 : 1);
}

/* ======================= lifecycle ======================= */

// The About box names the model weights this copy carries. Two runs with
// different weights give different volumes, so an app that cannot say which
// weights it has is ambiguous in exactly the way results files must not be.
function setAboutPanel() {
  let models = 'no model bundled — the tool will run on the stub';
  try {
    const mj = JSON.parse(fs.readFileSync(path.join(WEB_ROOT, 'model', 'models.json'), 'utf8'));
    models = mj.models
      .map((m) => `${m.id} ${m.version}${m.id === mj.default ? ' (default)' : ''}`)
      .join('\n');
  } catch { /* stub it is */ }
  app.setAboutPanelOptions({
    applicationName: 'MRI Review',
    applicationVersion: app.getVersion(),
    credits: `Bundled model weights:\n${models}`,
  });
}

app.whenReady().then(() => {
  protocol.handle('app', serveWeb);
  registerIpc();
  setAboutPanel();
  buildMenu();

  // Results live in IndexedDB in this app's own profile; nothing evicts them,
  // but saying so to the page keeps its storage banner honest.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(permission === 'persistent-storage');
  });

  const win = createWindow();
  if (SMOKE) {
    win.webContents.once('did-finish-load', () => {
      runSmoke(win).catch((e) => { console.error('[smoke] error', e); app.exit(2); });
    });
  } else if (E2E || E2E_VERIFY) {
    win.webContents.once('did-finish-load', () => {
      runE2E(win).catch((e) => { console.error('[e2e] error', e); app.exit(2); });
    });
  } else if (MIGRATION) {
    win.webContents.once('did-finish-load', () => {
      runMigration(win).catch((e) => { console.error('[migration] error', e); app.exit(2); });
    });
  }

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => app.quit());
