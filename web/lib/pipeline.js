/**
 * The engine: scan folders in, masks + volumes + review priorities out.
 *
 * Port of `src/batch.py`. The record it produces has the same field names as
 * the Python one, so `results.json` from either build is readable by the other
 * and by anything the lab writes downstream.
 *
 * HOW CORRECTIONS ARE HANDLED  (unchanged from the Python, and load-bearing)
 * -------------------------------------------------------------------------
 * Every case gets TWO masks:
 *
 *     <case>_tumor_auto.nii.gz    what the model said. Never modified. Ever.
 *     <case>_tumor.nii.gz         the working copy, which a human edits.
 *
 * Both are hashed on every rescan. If they differ the case is marked `edited`,
 * and the automated and corrected volumes are reported side by side.
 *
 * The alternative -- just recompute the volume from whatever mask is current --
 * is simpler and wrong here. The paper's claim is that *automated* volumes
 * reproduce the treatment effect. If corrections were silently folded in, that
 * claim would quietly become "automated volumes plus some manual correction",
 * which is weaker and unauditable. A reviewer is entitled to ask how much
 * correction was needed; with this design the answer is a number we already
 * have. It also yields a genuinely good result for the paper: what fraction of
 * scans needed any correction at all.
 *
 * ONE DELIBERATE DIFFERENCE FROM THE PYTHON
 * -----------------------------------------
 * `batch.py` hashes the `.nii.gz` FILES. This hashes the uncompressed mask
 * voxels instead. Same meaning -- an edit that leaves the volume unchanged is
 * still detected, which is the whole reason it is a hash and not a volume
 * comparison -- but it does not depend on two gzip encoders producing identical
 * bytes for identical content. That matters here because a mask corrected in
 * ITK-SNAP and brought back in has been re-compressed by ITK, and under file
 * hashing every re-imported mask would look edited whether or not it was.
 */

import { assertSameGrid, findT2AxialSeries, loadSeries } from './volume.js';
import { writeNiftiGz, readNifti } from './nifti.js';
import { reviewScore, removeSmallComponents } from './predictor.js';
import { countComponents, maskFacts } from './label.js';
import { montage } from './qc.js';
import * as store from './store.js';

export const LABEL_FILE = `################################################
# ITK-SnAP Label Description File
################################################
    0     0    0    0        0  0  0    "Clear Label"
    1   255    0    0        1  1  1    "Tumor"
`;

/**
 * Default minimum component size. the smallest real lesion in a study may be only a few dozen voxels, so anything at or above that starts costing true positives. Zero is
 * the honest default until cross-validation says otherwise: better to show a
 * reviewer a false blob they can delete than to silently discard a real tumour.
 */
export const DEFAULT_MIN_VOXELS = 0;

export class EditedMaskError extends Error {}

const nowISO = () => new Date().toISOString().slice(0, 19);
const round = (v, n) => (v == null ? null : Math.round(v * 10 ** n) / 10 ** n);

async function sha256(bytes) {
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The stem the Python uses for output filenames: spaces and slashes to `_`. */
export const stemOf = (name) => name.replace(/[ /]/g, '_');

export const fileNames = (name) => {
  const s = stemOf(name);
  return {
    image: `${s}_T2ax.nii.gz`,
    auto_mask: `${s}_tumor_auto.nii.gz`,
    mask: `${s}_tumor.nii.gz`,
    qc: `${s}_qc.png`,
    workspace: `${s}.itksnap`,
  };
};

/**
 * A minimal ITK-SNAP workspace, so a case opens with one double-click.
 *
 * The Python writes absolute paths, which it can because the results folder
 * stays where it was written. Here the files arrive as a downloaded zip and are
 * extracted somewhere unknowable, so the paths are bare filenames relative to
 * the workspace. ITK-SNAP resolves those when the workspace sits beside the
 * files -- which it does inside the zip -- and the README in the bundle says
 * what to do if a particular build of ITK-SNAP does not: open the image, then
 * File > Open Segmentation.
 */
export function itksnapWorkspace(imageName, segName) {
  const layer = (i, path, role) =>
    `  <folder key="Layer[${String(i).padStart(3, '0')}]">\n` +
    `    <entry key="AbsolutePath" value="${path}" />\n` +
    `    <entry key="Role" value="${role}" />\n` +
    `    <entry key="Tags" value="" />\n` +
    `  </folder>\n`;
  return `<?xml version='1.0' encoding='utf-8'?>\n<registry>\n <folder key="Layers">\n` +
         layer(0, imageName, 'MainRole') +
         (segName ? layer(1, segName, 'SegmentationRole') : '') +
         ` </folder>\n</registry>\n`;
}

// ---------------------------------------------------------------------------
// One session, end to end
// ---------------------------------------------------------------------------

/**
 * Run one session and store every artifact for it.
 *
 * @param {string} name          the session folder name, used as the case ID
 * @param {Array<{file,path}>} entries  that session's files
 * @param {Predictor} predictor
 * @param {{minVoxels?:number, force?:boolean}} opts
 * @throws {EditedMaskError} if the working mask has been hand-corrected and
 *         `force` is not set, so re-running a folder never destroys human work.
 */
export async function processSession(name, entries, predictor, opts = {}) {
  const minVoxels = opts.minVoxels ?? DEFAULT_MIN_VOXELS;

  const prior = await store.allCases().then((cs) => cs.find((c) => c.case === name));
  if (!opts.force && prior?.edited) {
    throw new EditedMaskError(
      'this mask has been corrected by hand; skipping so the edit is not ' +
      'overwritten (use Force to re-run it anyway)');
  }

  const series = await findT2AxialSeries(entries);
  if (!series.length) {
    throw new Error("no T2w axial series here (expected SequenceName starting " +
                    "'T2w FSE (axial')");
  }
  // Highest series number is the most recent acquisition, which is the redo if
  // there was one.
  const chosen = series[series.length - 1];
  const { volume: vol, meta } = await loadSeries(chosen.files);

  const { mask: rawMask, prob } = await predictor.predict(vol);
  // The model's output must land on the source grid exactly, or the mask will
  // be shifted relative to the scan in ITK-SNAP and every volume will be wrong.
  assertSameGrid(rawMask, vol, 'prediction');

  const { mask, nComponents } = removeSmallComponents(
    rawMask.data, vol.nx, vol.ny, vol.nz, minVoxels);

  const facts = maskFacts(mask, vol.nx, vol.ny, vol.nz);
  const volumeMm3 = facts.voxels * vol.voxelVolumeMm3;
  const rs = reviewScore(mask, prob?.data ?? null, volumeMm3, nComponents,
                         vol.nx, vol.ny, vol.nz);

  const names = fileNames(name);
  const maskVol = vol.withData(mask);
  const imageBytes = await writeNiftiGz(vol);
  const maskBytes = await writeNiftiGz(maskVol);
  const qcBlob = await montage(vol, facts.voxels ? mask : null,
    facts.voxels ? `${name}   ${volumeMm3.toFixed(2)} mm3` : `${name}   no tumour`);

  await store.putFiles(name, {
    image: imageBytes,
    auto_mask: maskBytes,
    // The working copy starts identical to the automated one. A human edits
    // this; the auto file is the immutable record of what the model said.
    mask: maskBytes,
    qc: qcBlob,
    workspace: itksnapWorkspace(names.image, names.mask),
  });

  const record = {
    case: name,
    source: name,
    series: chosen.seriesLabel,
    mouse_from_dicom: meta.patientName,
    study_date: meta.studyDate,
    size_xyz: [vol.nx, vol.ny, vol.nz],
    spacing: vol.spacing.map((s) => round(s, 5)),
    voxel_volume_mm3: round(vol.voxelVolumeMm3, 7),
    n_slices: vol.nz,

    model: predictor.name,
    model_is_real: predictor.isReal,
    min_voxels: minVoxels,

    tumor_present: facts.voxels > 0,
    auto_volume_mm3: round(volumeMm3, 4),
    auto_voxels: facts.voxels,
    n_components: nComponents,
    n_tumor_slices: facts.nTumorSlices,
    // Which slices actually contain tumour, so the viewer can open on the
    // tumour instead of the middle of the volume. On an 18-slice stack where
    // the tumour spans 3, the middle slice is usually empty.
    tumor_slices: facts.tumorSlices,

    review: rs,
    reviewed: false,
    review_status: 'pending',
    review_note: '',

    edited: false,
    corrected_volume_mm3: null,
    auto_mask_sha256: await sha256(mask),

    files: names,
    processed_at: nowISO(),
  };
  await store.putCase(record);
  return record;
}

// ---------------------------------------------------------------------------
// Edits
// ---------------------------------------------------------------------------

/**
 * Re-read the working masks and pick up anything a human changed.
 *
 * Compares the working copy against the untouched automated mask by hash, so
 * an edit is detected even if it happens to leave the volume unchanged -- a
 * reshaped tumour of the same size is still an edit worth knowing about.
 *
 * @returns {number} how many cases changed edited-status
 */
export async function refreshEdits(records) {
  let changed = 0;
  for (const r of records) {
    const bytes = await store.getFile(r.case, 'mask');
    if (!bytes) continue;
    const m = await readNifti(bytes);
    const mask = new Uint8Array(m.data.length);
    for (let i = 0; i < mask.length; i++) mask[i] = m.data[i] > 0 ? 1 : 0;

    const was = !!r.edited;
    const hash = await sha256(mask);
    if (hash !== r.auto_mask_sha256) {
      const facts = maskFacts(mask, m.nx, m.ny, m.nz);
      r.edited = true;
      r.corrected_volume_mm3 = round(facts.voxels * m.voxelVolumeMm3, 4);
      r.corrected_voxels = facts.voxels;
      r.corrected_at = r.corrected_at || nowISO();
    } else {
      r.edited = false;
      r.corrected_volume_mm3 = null;
      delete r.corrected_voxels;
      delete r.corrected_at;
    }

    // These describe the mask as it currently stands, so they must follow the
    // working copy rather than the model's original. Without this the viewer's
    // slice markers keep pointing at where the tumour used to be, and "jump to
    // tumour" lands on an empty slice.
    const facts = maskFacts(mask, m.nx, m.ny, m.nz);
    r.tumor_slices = facts.tumorSlices;
    r.n_tumor_slices = facts.nTumorSlices;
    r.n_components = countComponents(mask, m.nx, m.ny, m.nz);
    r.tumor_present = facts.voxels > 0;

    if (!!r.edited !== was) changed++;
  }
  await store.putCases(records);
  return changed;
}

/**
 * Replace a case's working mask with one corrected elsewhere -- typically
 * opened in ITK-SNAP from the shared folder, or downloaded and brought back.
 *
 * This is the static build's answer to `batch.py --rescan`. Without it the
 * correction-tracking story would only cover edits made in the browser, and
 * ITK-SNAP is still the right tool for heavy 3-D work.
 *
 * A mask identical to the one already stored is a no-op, and that matters more
 * than it looks: the shared folder is re-read in full on every check, so most
 * cases are unchanged every time. Writing them anyway would move
 * `corrected_at` forward on scans nobody had touched, which is exactly the
 * field a reviewer would use to ask when a correction was made.
 *
 * @param {{when?: number}} opts `when` is a timestamp (e.g. the file's
 *        lastModified) to record instead of "now" -- the truthful answer when
 *        the edit happened in another program some time ago.
 * @returns {Promise<{record: object, changed: boolean}>}
 */
export async function importCorrectedMask(record, bytes, opts = {}) {
  const incoming = await readNifti(bytes);
  const imageBytes = await store.getFile(record.case, 'image');
  if (!imageBytes) throw new Error(`no stored scan for ${record.case}`);
  const image = await readNifti(imageBytes);
  assertSameGrid(incoming, image, `corrected mask for ${record.case}`);

  const mask = new Uint8Array(incoming.data.length);
  for (let i = 0; i < mask.length; i++) mask[i] = incoming.data[i] > 0 ? 1 : 0;

  const current = await store.getFile(record.case, 'mask');
  if (current) {
    const stored = await readNifti(current);
    const same = stored.data.length === mask.length
      && mask.every((v, i) => v === (stored.data[i] > 0 ? 1 : 0));
    if (same) return { record, changed: false };
  }

  await store.putFile(record.case, 'mask', await writeNiftiGz(image.withData(mask)));
  record.corrected_at = opts.when
    ? new Date(opts.when).toISOString().slice(0, 19)
    : nowISO();
  await refreshEdits([record]);
  return { record, changed: true };
}

/** Throw away every human edit and restore the model's original mask. */
export async function revertToAuto(record) {
  const auto = await store.getFile(record.case, 'auto_mask');
  if (!auto) throw new Error('the original automated mask is missing');
  await store.putFile(record.case, 'mask', auto);
  delete record.corrected_at;
  await refreshEdits([record]);
  return record;
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

/** The volume to actually use: corrected if a human edited it, else automated. */
export function finalVolume(r) {
  if (!r.tumor_present && !r.edited) return 0.0;
  if (r.edited && r.corrected_volume_mm3 != null) return r.corrected_volume_mm3;
  return r.auto_volume_mm3;
}

const CSV_COLUMNS = [
  'case', 'mouse_from_dicom', 'study_date', 'series', 'n_slices', 'tumor_present',
  'auto_volume_mm3', 'edited_by_human', 'corrected_volume_mm3', 'final_volume_mm3',
  'n_components', 'review_priority', 'review_band', 'review_status', 'review_note',
  'model', 'model_is_real',
];

const csvCell = (v) => {
  if (v == null) return '';
  const s = typeof v === 'boolean' ? (v ? 'True' : 'False') : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** volumes.csv, with the same columns and the same order as `batch.write_outputs`. */
export function volumesCsv(records) {
  const rows = records.map((r) => ({
    case: r.case,
    mouse_from_dicom: r.mouse_from_dicom,
    study_date: r.study_date,
    series: r.series,
    n_slices: r.n_slices,
    tumor_present: r.tumor_present,
    auto_volume_mm3: r.auto_volume_mm3,
    edited_by_human: r.edited,
    corrected_volume_mm3: r.corrected_volume_mm3,
    final_volume_mm3: finalVolume(r),
    n_components: r.n_components,
    review_priority: r.review?.score,
    review_band: r.review?.band,
    review_status: r.review_status,
    review_note: r.review_note,
    model: r.model,
    model_is_real: r.model_is_real,
  }));
  return [CSV_COLUMNS.join(','),
          ...rows.map((r) => CSV_COLUMNS.map((c) => csvCell(r[c])).join(','))].join('\n') + '\n';
}

export function resultsJson(records) {
  return JSON.stringify({ written_at: nowISO(), cases: records }, null, 2);
}
