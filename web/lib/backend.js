/**
 * Everything the front end used to ask a server for.
 *
 * In the Flask build the browser talks to `src/app.py` over a dozen endpoints.
 * Here those become plain function calls against IndexedDB and the pipeline
 * modules. The shapes of what goes in and comes out are unchanged -- the
 * volume still arrives as uint16 with an `X-Meta`-style header object, review
 * still returns the updated record -- so the viewer, the editor and the
 * scoring all work on exactly the data they were written against.
 *
 * WHAT IS GONE, AND WHY IT CANNOT COME BACK
 * -----------------------------------------
 * `POST /api/case/<name>/open` launched ITK-SNAP with `subprocess.Popen`. A web
 * page cannot start a program on your machine, and that is not a limitation to
 * work around -- it is the entire reason this build can be hosted at all. The
 * replacement is "Download for ITK-SNAP", which hands over the scan, the mask,
 * the label file and a workspace as a zip. Corrections come back through
 * "Import corrected masks", which is the same round trip the Flask build did
 * through a shared folder.
 *
 * WHAT IS BETTER HERE
 * -------------------
 * There is no server, so there is no port to bind, no authentication to add
 * before the lab can use it, and no upload: the DICOM never leaves the machine
 * it is already on. `src/app.py` binding to 127.0.0.1 with no auth is the one
 * remaining blocker on hosting it for the lab, and this build does not have it.
 */

import { readNifti, writeNiftiGz } from './nifti.js';
import { signedDistance } from './edt.js';
import { getPredictor } from './predictor.js';
import { zip } from './gz.js';
import * as store from './store.js';
import {
  EditedMaskError, LABEL_FILE, fileNames, finalVolume, importCorrectedMask,
  processSession, refreshEdits, resultsJson, revertToAuto, volumesCsv,
} from './pipeline.js';
import { groupSessions } from './volume.js';
import * as fs from './fsaccess.js';
import * as onnx from './onnx.js';

export const STATE = {
  model: null,
  modelAvailable: false,
  modelLoading: false,
  modelReady: null,
  modelError: null,
  minVoxels: 0,
  cases: [],
  storage: { supported: false, persisted: false, used: 0, quota: 0 },
  job: { running: false, phase: 'idle', done: 0, total: 0, current: '', log: [], error: null },
};

// Decoded volumes, keyed by case. Re-reading and un-gzipping a 4 MB NIfTI every
// time someone clicks a different case would make the list feel broken. Capped
// because a cohort's worth of decoded float32 volumes is a gigabyte.
const CACHE = new Map();
const CACHE_MAX = 6;

function cacheGet(key) {
  const v = CACHE.get(key);
  if (v) { CACHE.delete(key); CACHE.set(key, v); }   // refresh LRU position
  return v;
}
function cachePut(key, value) {
  CACHE.set(key, value);
  while (CACHE.size > CACHE_MAX) CACHE.delete(CACHE.keys().next().value);
}
function cacheDrop(key) {
  if (key) CACHE.delete(key); else CACHE.clear();
}

const byName = (name) => STATE.cases.find((c) => c.case === name);

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

export async function init(model) {
  STATE.model = model ?? await store.getKV('model', null);
  // Pick up a trained model without being asked, from the cache or from one
  // served beside the page. A reviewer should not have to know the tool has a
  // model-loading step; they should only hear about it if there is no model.
  await autoloadModel().catch((e) => { STATE.modelError = e.message; });
  STATE.minVoxels = await store.getKV('minVoxels', 0);
  STATE.cases = await store.allCases();
  const p = await store.requestPersistence();
  const u = await store.usage();
  STATE.storage = {
    ...p, used: u?.used ?? 0, quota: u?.quota ?? 0,
    // How long results actually last here, which is a per-browser policy
    // question rather than a yes/no. See store.storagePolicy.
    policy: store.storagePolicy(p.persisted),
  };
  return state();
}

export function state() {
  const pred = getPredictor(STATE.model);
  return {
    model: pred.name,
    model_is_real: pred.isReal,
    model_info: onnx.activeModelInfo(),
    model_available: STATE.modelAvailable,
    model_loading: STATE.modelLoading,
    model_error: STATE.modelError || null,
    min_voxels: STATE.minVoxels,
    storage: STATE.storage,
    cases: STATE.cases,
    job: STATE.job,
  };
}

// ---------------------------------------------------------------------------
// The trained model
// ---------------------------------------------------------------------------

/**
 * Load a model from the cache or from the site, and switch to it.
 *
 * Deliberately silent when there is nothing to load: a build published without
 * weights is a supported configuration, not an error. The tool falls back to
 * the stub and the banner says so.
 */
export async function autoloadModel() {
  const chosen = STATE.model;                 // what the user last picked, if anything
  const bundle = await onnx.autoloadBundle();
  STATE.modelAvailable = !!bundle;
  if (!bundle) return null;

  // Default to the trained model, but never override a deliberate choice. The
  // first version of this reset the setting on every reload, which quietly
  // undid "use the stub" and "no mirroring" every time the page was opened.
  if (!chosen) {
    STATE.model = 'onnx';
    await store.setKV('model', 'onnx');
  }

  // Building the session takes a couple of seconds. Doing it before the first
  // paint would make the app look broken on startup, and there is nothing to
  // run it on until the user has loaded some scans anyway -- so it warms up in
  // the background and `activeModel()` waits for it if a run gets there first.
  STATE.modelLoading = true;
  STATE.modelReady = onnx.setActiveBundle(bundle)
    .then(() => { STATE.modelLoading = false; STATE.modelError = null; })
    .catch((e) => { STATE.modelLoading = false; STATE.modelError = e.message; });
  return STATE.modelReady;
}

/** Resolves when the model has finished starting (or failed to). */
export async function modelReady() {
  if (STATE.modelReady) await STATE.modelReady;
  return state();
}

/** Load a model from files the user picked, for when it is not served. */
export async function loadModelFromFiles(files) {
  const bundle = await onnx.bundleFromFiles(files);
  await onnx.cacheBundle(bundle);
  await onnx.setActiveBundle(bundle);
  STATE.modelAvailable = true;
  STATE.modelError = null;
  STATE.model = 'onnx';
  await store.setKV('model', 'onnx');
  return onnx.activeModelInfo();
}

/** Choose between the trained model, the same without mirroring, and the stub. */
export async function setModel(spec) {
  getPredictor(spec);                      // throws on an unknown spec
  if (spec.startsWith('onnx') && !await onnx.activeModel()) {
    throw new Error('there is no model loaded to switch to');
  }
  STATE.model = spec;
  await store.setKV('model', spec);
  return state();
}

export async function forgetModel() {
  await onnx.clearCachedBundle();
  onnx.forgetActiveModel();
  STATE.modelAvailable = false;
  STATE.model = 'stub';
  await store.setKV('model', 'stub');
  return state();
}

async function refreshStorage() {
  const u = await store.usage();
  if (u) STATE.storage = { ...STATE.storage, used: u.used, quota: u.quota };
}

// ---------------------------------------------------------------------------
// Running the model
// ---------------------------------------------------------------------------

/**
 * Segment every scan folder in a set of files.
 *
 * @param {Array<{file: File, path: string}>} entries
 * @param {{minVoxels?: number, force?: boolean, onTick?: Function}} opts
 */
export async function run(entries, opts = {}) {
  if (STATE.job.running) throw new Error('a run is already in progress');

  const sessions = groupSessions(entries);
  if (!sessions.size) {
    throw new Error(
      `found no DICOM files in that selection. Check that you picked the scan ` +
      `folders themselves, each containing a DICOM sub-folder.`);
  }

  const job = STATE.job;
  Object.assign(job, {
    running: true, phase: 'segmenting', done: 0, total: sessions.size,
    current: '', log: [], error: null,
  });
  STATE.minVoxels = opts.minVoxels ?? STATE.minVoxels;
  await store.setKV('minVoxels', STATE.minVoxels);

  const predictor = getPredictor(STATE.model);
  try {
    for (const [key, files] of sessions) {
      const name = key.split('/').pop() || key;
      job.current = name;
      opts.onTick?.(job);
      try {
        const rec = await processSession(name, files, predictor, {
          minVoxels: STATE.minVoxels, force: opts.force,
        });
        const i = STATE.cases.findIndex((c) => c.case === rec.case);
        if (i >= 0) STATE.cases[i] = rec; else STATE.cases.push(rec);
        cacheDrop(rec.case);
      } catch (e) {
        if (e instanceof EditedMaskError) {
          // A human corrected this one. Their work wins over a re-run.
          job.log.push(`SKIPPED ${name}: hand-corrected, left alone`);
        } else {
          job.log.push(`FAILED ${name}: ${e.message}`);
        }
      }
      job.done++;
      opts.onTick?.(job);
      // Let the browser paint between scans. Without this the whole run is one
      // long task and the progress bar never moves.
      await new Promise((r) => setTimeout(r, 0));
    }
    await refreshEdits(STATE.cases);
  } catch (e) {
    job.error = e.message;
    throw e;
  } finally {
    job.running = false;
    job.phase = 'idle';
    job.current = '';
    await refreshStorage();
    opts.onTick?.(job);
  }
  return { processed: sessions.size };
}

/** Re-read stored masks and pick up anything that changed. */
export async function rescan() {
  if (!STATE.cases.length) throw new Error('nothing loaded');
  const changed = await refreshEdits(STATE.cases);
  cacheDrop();
  return { changed, edited: STATE.cases.filter((c) => c.edited).length };
}

export async function reload() {
  STATE.cases = await store.allCases();
  cacheDrop();
  await refreshStorage();
  return { loaded: STATE.cases.length };
}

// ---------------------------------------------------------------------------
// Per-case image data
// ---------------------------------------------------------------------------
/*
 * WHY THE WHOLE VOLUME GOES TO THE VIEWER
 * ---------------------------------------
 * Kept exactly as the Flask build had it, because the viewer is built on it.
 * Three features all need the whole stack at once and none can work per-slice:
 * coronal and sagittal views reslice ACROSS the stack; real window/level needs
 * the original intensities rather than an already-windowed 8-bit picture; and
 * the adaptive brush compares intensities under the cursor.
 *
 * Intensities are rescaled to the full 0-65535 range with the true min and max
 * sent alongside, so a stored value converts back to the scanner's number
 * exactly. The source is 12-bit, so this loses nothing -- measured at 0.0015%
 * round-trip error on real data.
 */

async function decode(name) {
  const hit = cacheGet(name);
  if (hit) return hit;
  const bytes = await store.getFile(name, 'image');
  if (!bytes) throw new Error(`no stored scan for ${name}`);
  const vol = await readNifti(bytes);
  const entry = { vol };
  cachePut(name, entry);
  return entry;
}

/** The scan: uint16, z-major, with the real intensity range and a histogram. */
export async function volumeRaw(name) {
  const rec = byName(name);
  if (!rec) throw new Error('no such case');
  const { vol } = await decode(name);

  let vmin = Infinity, vmax = -Infinity;
  for (let i = 0; i < vol.data.length; i++) {
    if (vol.data[i] < vmin) vmin = vol.data[i];
    if (vol.data[i] > vmax) vmax = vol.data[i];
  }
  const span = Math.max(vmax - vmin, 1e-6);
  const u16 = new Uint16Array(vol.data.length);
  const hist = new Array(256).fill(0);
  for (let i = 0; i < vol.data.length; i++) {
    const v = Math.max(0, Math.min(65535,
      Math.round((vol.data[i] - vmin) / span * 65535)));
    u16[i] = v;
    hist[Math.min(255, (v / 256) | 0)]++;
  }
  return {
    data: u16,
    meta: {
      nx: vol.nx, ny: vol.ny, nz: vol.nz,
      sx: vol.spacing[0], sy: vol.spacing[1], sz: vol.spacing[2],
      vmin, vmax, hist,
    },
  };
}

/** The working mask: one byte per voxel, same order as the scan. */
export async function maskRaw(name) {
  const rec = byName(name);
  if (!rec) throw new Error('no such case');
  const bytes = await store.getFile(name, 'mask');
  const { vol } = await decode(name);
  const out = new Uint8Array(vol.nx * vol.ny * vol.nz);
  if (bytes) {
    const m = await readNifti(bytes);
    for (let i = 0; i < out.length; i++) out[i] = m.data[i] > 0 ? 1 : 0;
  }
  return { data: out, meta: { nx: vol.nx, ny: vol.ny, nz: vol.nz } };
}

/**
 * Write edited slices into the working mask.
 * @param {Object<number, Uint8Array>} slices  slice index -> ny*nx bytes
 */
export async function saveMaskSlices(name, slices) {
  const rec = byName(name);
  if (!rec) throw new Error('no such case');
  const keys = Object.keys(slices);
  if (!keys.length) throw new Error('no slices supplied');

  const { vol } = await decode(name);
  const current = await store.getFile(name, 'mask');
  const arr = new Uint8Array(vol.nx * vol.ny * vol.nz);
  if (current) {
    const m = await readNifti(current);
    for (let i = 0; i < arr.length; i++) arr[i] = m.data[i] > 0 ? 1 : 0;
  }

  const sliceSize = vol.nx * vol.ny;
  for (const key of keys) {
    const i = parseInt(key, 10);
    if (!Number.isInteger(i) || i < 0 || i >= vol.nz) {
      throw new Error(`slice ${key} is out of range`);
    }
    const raw = slices[key];
    if (raw.length !== sliceSize) {
      throw new Error(`slice ${i} is ${raw.length} bytes, expected ${sliceSize}`);
    }
    for (let k = 0; k < sliceSize; k++) arr[i * sliceSize + k] = raw[k] ? 1 : 0;
  }

  // Geometry comes from the scan, so an edited mask lands on the same grid and
  // still opens correctly in ITK-SNAP.
  await store.putFile(name, 'mask', await writeNiftiGz(vol.withData(arr)));
  rec.corrected_at = new Date().toISOString().slice(0, 19);
  rec.edited_in_app = true;
  await refreshEdits([rec]);
  await refreshStorage();
  return {
    edited: rec.edited,
    corrected_volume_mm3: rec.corrected_volume_mm3,
    auto_volume_mm3: rec.auto_volume_mm3,
    corrected_at: rec.corrected_at,
    n_slices_written: keys.length,
  };
}

/**
 * Fill in the slices between two that have already been drawn.
 *
 * Shape-based: each drawn slice becomes a signed distance field, the two are
 * blended linearly and thresholded at zero. Interpolating the binary masks
 * directly would cross-fade two pictures and produce garbage wherever they do
 * not overlap; distance fields interpolate the SHAPE, so a contour that moves
 * or changes size between slices comes out smoothly.
 */
export async function interpolate(name, from, to) {
  const rec = byName(name);
  if (!rec) throw new Error('no such case');
  let i0 = Math.min(from, to), i1 = Math.max(from, to);
  if (i1 - i0 < 2) {
    throw new Error('those slices are adjacent — there is nothing in between to fill');
  }

  const { vol } = await decode(name);
  const bytes = await store.getFile(name, 'mask');
  if (!bytes) throw new Error('working mask is missing');
  const m = await readNifti(bytes);
  const nx = m.nx, ny = m.ny, nz = m.nz, sliceSize = nx * ny;
  if (i0 < 0 || i1 >= nz) throw new Error('slice index out of range');

  const arr = new Uint8Array(m.data.length);
  for (let i = 0; i < arr.length; i++) arr[i] = m.data[i] > 0 ? 1 : 0;
  const slice = (z) => arr.subarray(z * sliceSize, (z + 1) * sliceSize);
  const any = (s) => s.some((v) => v);
  if (!any(slice(i0)) || !any(slice(i1))) {
    throw new Error('both ends must already have a mask drawn on them — there ' +
                    'is no shape to interpolate between otherwise');
  }

  const d0 = signedDistance(slice(i0), nx, ny);
  const d1 = signedDistance(slice(i1), nx, ny);
  const filled = new Map();
  for (let k = i0 + 1; k < i1; k++) {
    const t = (k - i0) / (i1 - i0);
    const out = new Uint8Array(sliceSize);
    for (let i = 0; i < sliceSize; i++) out[i] = (1 - t) * d0[i] + t * d1[i] < 0 ? 1 : 0;
    filled.set(k, out);
  }

  // Linear blending of distance fields collapses to nothing when the two shapes
  // do not overlap -- each one's "outside" distance overwhelms the other's
  // "inside". That is a real limit of the method, not a bug, but writing empty
  // slices and calling it success would be much worse than saying so.
  const empty = [...filled.values()].filter((s) => !s.some((v) => v)).length;
  if (empty) {
    throw new Error(
      `Interpolation collapsed on ${empty} slice(s). The two masks are probably ` +
      `too far apart or barely overlap — draw one in between and interpolate ` +
      `over a shorter gap. Nothing was changed.`);
  }

  for (const [k, s] of filled) arr.set(s, k * sliceSize);
  await store.putFile(name, 'mask', await writeNiftiGz(vol.withData(arr)));
  rec.corrected_at = new Date().toISOString().slice(0, 19);
  rec.edited_in_app = true;
  await refreshEdits([rec]);
  await refreshStorage();
  return {
    filled: [...filled.keys()],
    corrected_volume_mm3: rec.corrected_volume_mm3,
    auto_volume_mm3: rec.auto_volume_mm3,
    corrected_at: rec.corrected_at,
  };
}

export async function revert(name) {
  const rec = byName(name);
  if (!rec) throw new Error('no such case');
  await revertToAuto(rec);
  rec.edited_in_app = false;
  cacheDrop(name);
  return { edited: rec.edited, auto_volume_mm3: rec.auto_volume_mm3 };
}

export async function review(name, body) {
  const rec = byName(name);
  if (!rec) throw new Error('no such case');
  if ('status' in body) {
    if (!['pending', 'accepted', 'flagged'].includes(body.status)) {
      throw new Error('bad status');
    }
    rec.review_status = body.status;
    rec.reviewed = body.status !== 'pending';
  }
  if ('note' in body) rec.review_note = String(body.note).slice(0, 2000);
  await store.putCase(rec);
  return rec;
}

/** An object URL for the QC montage. The caller revokes it. */
export async function qcUrl(name) {
  const blob = await store.getFile(name, 'qc');
  if (!blob) return null;
  return URL.createObjectURL(blob instanceof Blob ? blob : new Blob([blob], { type: 'image/png' }));
}

// ---------------------------------------------------------------------------
// Import / export
// ---------------------------------------------------------------------------

/**
 * Take in masks corrected in ITK-SNAP.
 *
 * Files are matched to cases by filename -- `<case>_tumor.nii.gz` is what the
 * bundle handed out, so a round trip that does not rename anything just works.
 * Anything that does not match a known case is reported rather than ignored,
 * since a silently skipped file looks exactly like a successful import.
 */
export async function importMasks(files) {
  const wanted = new Map(STATE.cases.map((c) => [fileNames(c.case).mask, c]));
  const done = [], skipped = [];
  for (const f of files) {
    const base = (f.name || '').split('/').pop();
    const rec = wanted.get(base)
      // Fall back to matching on the case stem, so `4481_..._tumor (1).nii.gz`
      // from a browser's duplicate-download naming still lands.
      || STATE.cases.find((c) => base.startsWith(fileNames(c.case).mask.replace(/\.nii\.gz$/, '')));
    if (!rec) { skipped.push(base); continue; }
    try {
      const r = await importCorrectedMask(rec, new Uint8Array(await f.arrayBuffer()),
                                          { when: f.lastModified });
      cacheDrop(rec.case);
      // Report even an unchanged file as imported: the user explicitly picked
      // it, and "0 imported" after choosing 12 files reads like a failure.
      done.push(rec.case + (r.changed ? '' : ' (unchanged)'));
    } catch (e) {
      skipped.push(`${base} (${e.message})`);
    }
  }
  await refreshStorage();
  return { imported: done, skipped };
}

// ---------------------------------------------------------------------------
// The shared ITK-SNAP folder
// ---------------------------------------------------------------------------
// See lib/fsaccess.js for why this exists and what it can and cannot do. In
// short: a page cannot launch ITK-SNAP, but it can share a folder with it, and
// that removes the zip/unzip/re-pick round trip on Chrome and Edge.

export const folderSupported = fs.isSupported;

export async function folderStatus() {
  if (!fs.isSupported()) return { supported: false, linked: false };
  const stored = await fs.storedFolder();
  return {
    supported: true,
    linked: !!stored,
    name: stored?.name || null,
    needsPermission: await fs.needsPermission(),
  };
}

export async function linkFolder() {
  const handle = await fs.pickFolder();
  await fs.writeLabelFile(handle, LABEL_FILE);
  return { name: handle.name };
}

export async function unlinkFolder() {
  await fs.forgetFolder();
  return { linked: false };
}

/**
 * Write cases into the shared folder, ready to open in ITK-SNAP.
 *
 * An existing working mask in the folder is left alone unless `overwriteMask`
 * is set, so re-exporting a case cannot destroy a correction someone is part
 * way through.
 */
export async function exportToFolder(names = null, { overwriteMask = false } = {}) {
  const folder = await fs.activeFolder(true);
  if (!folder) throw new Error('no folder is linked, or permission was declined');
  const cases = names ? STATE.cases.filter((c) => names.includes(c.case)) : STATE.cases;
  if (!cases.length) throw new Error('nothing to write');

  await fs.writeLabelFile(folder, LABEL_FILE);
  const done = [];
  for (const c of cases) {
    const files = {};
    for (const kind of Object.keys(c.files)) files[kind] = await store.getFile(c.case, kind);
    await fs.writeCase(folder, c, files, { overwriteMask });
    done.push(c.case);
  }
  return { written: done, folder: folder.name };
}

/**
 * Read the shared folder and take in anything that changed.
 *
 * This is the static build's version of `batch.py --rescan`. Masks whose
 * content already matches what is stored are skipped silently -- most of the
 * folder will be unchanged on any given check, and reporting those as
 * "imported" would make the number meaningless.
 */
export async function syncFromFolder() {
  const folder = await fs.activeFolder(true);
  if (!folder) throw new Error('no folder is linked, or permission was declined');
  const found = await fs.readMasks(folder, STATE.cases);

  const changed = [], failed = [];
  for (const f of found) {
    const rec = byName(f.case);
    if (!rec) continue;
    try {
      // The file's own timestamp, not now: the edit happened when ITK-SNAP
      // saved it, which may have been yesterday.
      const r = await importCorrectedMask(rec, f.bytes, { when: f.lastModified });
      if (r.changed) { cacheDrop(rec.case); changed.push(rec.case); }
    } catch (e) {
      failed.push(`${f.case}: ${e.message}`);
    }
  }
  await refreshStorage();
  return { checked: found.length, changed, failed, folder: folder.name };
}

export function csvBlob() {
  if (!STATE.cases.length) throw new Error('nothing to export');
  return new Blob([volumesCsv(STATE.cases)], { type: 'text/csv' });
}

/** Everything for every case, for archiving or handing to someone else. */
export async function bundleBlob(only = null) {
  const cases = only ? STATE.cases.filter((c) => only.includes(c.case)) : STATE.cases;
  if (!cases.length) throw new Error('nothing to export');
  const enc = new TextEncoder();
  const entries = [
    { name: 'volumes.csv', bytes: enc.encode(volumesCsv(cases)) },
    { name: 'results.json', bytes: enc.encode(resultsJson(cases)) },
    { name: 'Tumor_label.txt', bytes: enc.encode(LABEL_FILE) },
    { name: 'README.txt', bytes: enc.encode(BUNDLE_README) },
  ];
  for (const c of cases) {
    const names = fileNames(c.case);
    for (const [kind, fname] of Object.entries(names)) {
      const bytes = await store.getFile(c.case, kind);
      if (bytes == null) continue;
      const u8 = bytes instanceof Blob ? new Uint8Array(await bytes.arrayBuffer())
               : typeof bytes === 'string' ? enc.encode(bytes)
               : bytes;
      entries.push({ name: `${c.case}/${fname}`, bytes: u8 });
    }
  }
  return zip(entries);
}

const BUNDLE_README = `Tumour segmentation — results bundle
========================================

One folder per scan. Inside each:

  *_T2ax.nii.gz        the scan, converted from DICOM with the correct
                       geometry (0.1563 x 0.1613 x 1.10 mm)
  *_tumor_auto.nii.gz  what the model produced. Never edit this one -- it is
                       the record of what was automated, and the paper's claim
                       depends on it staying untouched.
  *_tumor.nii.gz       the working copy. THIS is the one to correct.
  *_qc.png             every slice on one image, mask outlined
  *.itksnap            an ITK-SNAP workspace

To correct a mask:

  1. Open the .itksnap workspace. If your build of ITK-SNAP will not open it,
     open *_T2ax.nii.gz, then File > Open Segmentation > *_tumor.nii.gz.
  2. Load Tumor_label.txt (Segmentation > Import Label Descriptions) so the
     label is named Tumor rather than Label 1.
  3. Edit, and save the segmentation back over *_tumor.nii.gz.
  4. In the review tool, use "Import corrected masks" and select the edited
     *_tumor.nii.gz files. The tool compares them against the automated masks
     and records both volumes side by side.

volumes.csv has auto_volume_mm3, corrected_volume_mm3 and final_volume_mm3 as
separate columns on purpose. Automated and corrected numbers are never merged.
`;

/**
 * Delete everything stored in this browser.
 *
 * Deliberately not reachable without a typed confirmation in the UI: there is
 * no undo and no copy anywhere else unless the user downloaded a bundle first.
 */
export async function clearWorkspace() {
  await store.clearAll();
  STATE.cases = [];
  cacheDrop();
  await refreshStorage();
  return { cleared: true };
}

export { finalVolume };
