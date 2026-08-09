/**
 * A real folder on disk, shared with ITK-SNAP.
 *
 * WHY THIS EXISTS
 * ---------------
 * A web page cannot launch a program. `src/app.py` opened ITK-SNAP with
 * `subprocess.Popen` because it was a Python process running as you; a page in
 * a browser tab has no such API and never will, because that is the sandbox
 * doing its job. So "Open in ITK-SNAP" cannot be a button that opens ITK-SNAP.
 *
 * What it CAN be is a shared folder. The File System Access API lets the user
 * grant this page write access to one directory they choose. After that:
 *
 *   * a case can be written straight into it -- no zip, no unzipping,
 *   * ITK-SNAP opens the workspace from that folder and saves back over the
 *     same mask file,
 *   * and this page can read the folder again to find what changed, which
 *     restores the one-click "check for edits" the Flask build had by watching
 *     a results directory.
 *
 * That is two clicks instead of a five-step round trip, and it is as close to
 * the old behaviour as a browser can get.
 *
 * VERIFIED: the workspace this writes resolves correctly in ITK-SNAP. Checked
 * with `itksnap-wt -i <ws> -layers-list`, which reported absolute paths in the
 * folder the workspace was opened from -- both for bare relative filenames and
 * after moving the whole folder somewhere else. See pipeline.itksnapWorkspace.
 *
 * SUPPORT
 * -------
 * Chrome and Edge only. Firefox and Safari have not shipped
 * `showDirectoryPicker`. Everything here is therefore optional: when it is
 * missing the tool falls back to downloading a zip and taking corrections back
 * through a file picker, which works everywhere. `isSupported()` is what the UI
 * branches on, and it must never be assumed.
 */

import * as store from './store.js';

const HANDLE_KEY = 'itksnapFolder';

export function isSupported() {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
}

/**
 * Ask the user for a folder and remember it.
 *
 * Must be called from a user gesture -- the browser refuses otherwise, and the
 * rejection looks identical to the user clicking Cancel.
 */
export async function pickFolder() {
  if (!isSupported()) {
    throw new Error(
      'This browser cannot share a folder with ITK-SNAP -- showDirectoryPicker ' +
      'is Chrome and Edge only. Use "Download for ITK-SNAP" instead; it works ' +
      'everywhere.');
  }
  const handle = await window.showDirectoryPicker({ mode: 'readwrite', id: 'mriseg' });
  // Handles survive in IndexedDB across sessions, but the PERMISSION does not:
  // it has to be re-granted from a gesture on each new page load.
  await store.setKV(HANDLE_KEY, handle);
  return handle;
}

export async function storedFolder() {
  return store.getKV(HANDLE_KEY, null);
}

export async function forgetFolder() {
  await store.setKV(HANDLE_KEY, null);
}

/**
 * The remembered folder, with permission confirmed.
 *
 * @param {boolean} interactive true only inside a click handler; a silent
 *        `requestPermission` throws, which would turn a background check into
 *        a confusing error.
 * @returns {Promise<FileSystemDirectoryHandle|null>}
 */
export async function activeFolder(interactive = false) {
  const handle = await storedFolder();
  if (!handle) return null;
  const opts = { mode: 'readwrite' };
  let state = await handle.queryPermission(opts);
  if (state === 'prompt' && interactive) state = await handle.requestPermission(opts);
  return state === 'granted' ? handle : null;
}

/** Does the remembered folder need a click to re-grant access? */
export async function needsPermission() {
  const handle = await storedFolder();
  if (!handle) return false;
  return (await handle.queryPermission({ mode: 'readwrite' })) !== 'granted';
}

const toBytes = async (v) =>
  v instanceof Blob ? new Uint8Array(await v.arrayBuffer())
  : typeof v === 'string' ? new TextEncoder().encode(v)
  : v;

/**
 * Write one case into `<folder>/<case>/`.
 *
 * The working mask is written only when it is not already there, so a
 * correction sitting in the folder is never clobbered by re-exporting the case.
 * That is the same rule `processSession` follows in storage, for the same
 * reason: nobody should lose an afternoon of tracing to a stray click.
 */
export async function writeCase(folder, record, files, { overwriteMask = false } = {}) {
  const dir = await folder.getDirectoryHandle(record.case, { create: true });
  const written = [];

  for (const [kind, name] of Object.entries(record.files)) {
    if (kind === 'mask' && !overwriteMask && await exists(dir, name)) continue;
    const bytes = await toBytes(files[kind]);
    if (bytes == null) continue;
    const fh = await dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(bytes);
    await w.close();
    written.push(name);
  }
  return written;
}

/** The ITK-SNAP label description, written once at the top of the folder. */
export async function writeLabelFile(folder, contents) {
  const fh = await folder.getFileHandle('Tumor_label.txt', { create: true });
  const w = await fh.createWritable();
  await w.write(new TextEncoder().encode(contents));
  await w.close();
}

async function exists(dir, name) {
  try { await dir.getFileHandle(name); return true; } catch { return false; }
}

/**
 * Read back every working mask in the folder.
 *
 * Returns `[{case, bytes}]` for cases that have one. Deciding whether each is
 * actually a change is left to the caller -- the pipeline already hashes masks
 * to answer that, and duplicating the rule here is how the two would drift.
 */
export async function readMasks(folder, records) {
  const found = [];
  for (const r of records) {
    try {
      const dir = await folder.getDirectoryHandle(r.case);
      const fh = await dir.getFileHandle(r.files.mask);
      const file = await fh.getFile();
      found.push({ case: r.case, bytes: new Uint8Array(await file.arrayBuffer()),
                   lastModified: file.lastModified });
    } catch {
      // No folder or no mask for this case: it was never exported. Not an
      // error -- most cases will not have been.
    }
  }
  return found;
}
