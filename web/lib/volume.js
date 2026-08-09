/**
 * Turning a pile of DICOM files into a volume with correct geometry.
 *
 * This is the port of `src/loader.py`, and it is the part of the whole static
 * build that most needs to be right. Everything downstream -- the mask, the
 * volume in mm3, the overlay, the file ITK-SNAP opens -- inherits its geometry
 * from here. A mistake does not produce an error; it produces a number that is
 * wrong by an amount nobody can see.
 *
 * THE THREE RULES, ALL OF WHICH BIT SOMEONE ALREADY
 * -------------------------------------------------
 * 1. Order slices by ImagePositionPatient projected on the slice normal.
 *    InstanceNumber runs the OTHER WAY in this study -- instance 1 is at
 *    z = -2.65 and instance 18 is at z = -21.35 -- so an InstanceNumber stack
 *    is upside down relative to every mask the lab has ever drawn.
 * 2. Slice spacing is 1.10 mm (SpacingBetweenSlices), not 1.00 (SliceThickness).
 *    There is a 0.10 mm gap. Using thickness underestimates every volume by 9%.
 * 3. RescaleSlope/Intercept are per slice and must be applied once.
 *
 * The volume produced here is float32, which is exactly what `src/batch.py`
 * writes out (`sitk.Cast(img, sitk.sitkFloat32)`), so the two tools' image
 * files are directly comparable.
 */

import * as dicom from './dicom.js';

/** Physical position of a slice projected onto the slice normal. */
const project = (p, n) => p[0] * n[0] + p[1] * n[1] + p[2] * n[2];

const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

export class GeometryError extends Error {}

/**
 * A scan on a voxel grid, in the same terms SimpleITK uses.
 *
 * `data` is float32 in z-major order -- index (z*ny + y)*nx + x -- which is the
 * layout `sitk.GetArrayFromImage` produces, so array code ported from the
 * Python side indexes identically.
 */
export class Volume {
  constructor({ nx, ny, nz, spacing, origin, direction, data }) {
    this.nx = nx; this.ny = ny; this.nz = nz;
    this.spacing = spacing;       // [sx, sy, sz] mm
    this.origin = origin;         // [x, y, z] mm, LPS
    this.direction = direction;   // 9 numbers, row-major, columns = axis dirs
    this.data = data;
  }

  get length() { return this.nx * this.ny * this.nz; }
  get sliceSize() { return this.nx * this.ny; }
  get voxelVolumeMm3() { return this.spacing[0] * this.spacing[1] * this.spacing[2]; }

  /** A zero-filled companion on the same grid, for masks. */
  emptyLike(Kind = Uint8Array) {
    return new Volume({ ...this, data: new Kind(this.length) });
  }

  withData(data) {
    return new Volume({
      nx: this.nx, ny: this.ny, nz: this.nz, spacing: this.spacing,
      origin: this.origin, direction: this.direction, data,
    });
  }

  sameGridAs(other, tol = { spacing: 1e-4, origin: 1e-3, direction: 1e-3 }) {
    const bad = [];
    if (this.nx !== other.nx || this.ny !== other.ny || this.nz !== other.nz) {
      bad.push(`size ${this.nx}x${this.ny}x${this.nz} != ` +
               `${other.nx}x${other.ny}x${other.nz}`);
    }
    for (let i = 0; i < 3; i++) {
      if (Math.abs(this.spacing[i] - other.spacing[i]) > tol.spacing) {
        bad.push(`spacing [${this.spacing}] != [${other.spacing}]`); break;
      }
    }
    for (let i = 0; i < 3; i++) {
      if (Math.abs(this.origin[i] - other.origin[i]) > tol.origin) {
        bad.push(`origin [${this.origin}] != [${other.origin}]`); break;
      }
    }
    for (let i = 0; i < 9; i++) {
      if (Math.abs(this.direction[i] - other.direction[i]) > tol.direction) {
        bad.push(`direction differs`); break;
      }
    }
    return bad;
  }
}

/**
 * Raise unless two volumes sit on exactly the same voxel grid.
 *
 * The port of `loader.assert_same_grid`. Called on every predicted mask before
 * anything is written, because a mask that is a voxel off is invisible in a
 * thumbnail and wrong in every number.
 */
export function assertSameGrid(a, b, what = '') {
  const bad = a.sameGridAs(b);
  if (bad.length) throw new GeometryError(`grid mismatch ${what}: ${bad.join('; ')}`);
}

// ---------------------------------------------------------------------------
// Discovery: files in, series out
// ---------------------------------------------------------------------------

const dirOf = (p) => p.slice(0, p.lastIndexOf('/'));
const baseOf = (p) => p.slice(p.lastIndexOf('/') + 1);

const HEADER_PREFIX_BYTES = 16384;   // SequenceName sits far inside this

/**
 * Group files into series and keep only the T2 axial ones.
 *
 * @param {Array<{file: File|Blob, path: string}>} entries
 * @returns {Promise<Array<{seriesDir, seriesNumber, files, meta}>>} ordered by
 *          series number, which ascends with acquisition time -- so the LAST
 *          entry is the most recent acquisition, which is the redo when there
 *          was one. `src/loader.py` orders these the same way and
 *          `process_session` takes the last for the same reason.
 */
export async function findT2AxialSeries(entries) {
  const bySeries = new Map();
  for (const e of entries) {
    if (!e.path.toLowerCase().endsWith('.dcm')) continue;
    const d = dirOf(e.path);
    if (!bySeries.has(d)) bySeries.set(d, []);
    bySeries.get(d).push(e);
  }

  const out = [];
  for (const [seriesDir, files] of bySeries) {
    files.sort((a, b) => a.path.localeCompare(b.path));
    let m;
    try {
      // One header per series is enough to classify it, and a prefix of one
      // file is enough for that header.
      const buf = await files[0].file.slice(0, HEADER_PREFIX_BYTES).arrayBuffer();
      m = dicom.meta(dicom.parse(buf, { headerOnly: true, name: files[0].path }));
    } catch {
      continue;                    // unreadable series does not stop the walk
    }
    if (!dicom.isT2Axial(m)) continue;

    // The series number is the folder ABOVE the leaf: DICOM/40004/1/*.dcm.
    // Falling back to the leaf name keeps flatter layouts working.
    const parent = baseOf(dirOf(seriesDir));
    const n = parseInt(parent, 10);
    out.push({
      seriesDir,
      seriesNumber: Number.isFinite(n) ? n : parseInt(baseOf(seriesDir), 10) || 0,
      seriesLabel: Number.isFinite(n) ? parent : baseOf(seriesDir),
      files,
      meta: m,
    });
  }
  out.sort((a, b) => a.seriesNumber - b.seriesNumber);
  return out;
}

/**
 * Every scan folder in a set of dropped files.
 *
 * The browser hands over relative paths, so this is grouping rather than the
 * directory walk `batch.find_sessions` does -- but the rule is the same one:
 * the session is the path component just above `DICOM/`. That holds whether
 * the user picked one scan folder, a parent full of them, or dragged in a
 * mixture, which is exactly why the Python side recurses instead of assuming
 * a fixed depth.
 */
export function groupSessions(entries) {
  const sessions = new Map();
  for (const e of entries) {
    if (!e.path.toLowerCase().endsWith('.dcm')) continue;
    const parts = e.path.split('/');
    const i = parts.findIndex((p) => p.toUpperCase() === 'DICOM');
    const key = i > 0 ? parts.slice(0, i).join('/')
              : parts.length > 1 ? parts.slice(0, -1).join('/')
              : '(loose files)';
    if (!sessions.has(key)) sessions.set(key, []);
    sessions.get(key).push(e);
  }
  return sessions;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/**
 * Read one series directory into a Volume.
 *
 * @param {Array<{file: File|Blob, path: string}>} files every .dcm of the series
 */
export async function loadSeries(files) {
  if (!files.length) throw new GeometryError('no files in this series');

  const slices = [];
  for (const f of files) {
    const buf = await f.file.arrayBuffer();
    const parsed = dicom.parse(buf, { name: f.path });
    const m = dicom.meta(parsed);
    if (!m.position || m.position.length !== 3) {
      throw new GeometryError(
        `${f.path} has no ImagePositionPatient (0020,0032). Slice order cannot ` +
        `be determined without it, and InstanceNumber is not a safe substitute ` +
        `in this study -- it runs the opposite way to +z.`);
    }
    if (!m.orientation || m.orientation.length !== 6) {
      throw new GeometryError(`${f.path} has no ImageOrientationPatient (0020,0037)`);
    }
    slices.push({ meta: m, pixels: dicom.pixelArray(buf, parsed), path: f.path });
  }

  const first = slices[0].meta;
  const nx = first.columns, ny = first.rows;
  for (const s of slices) {
    if (s.meta.columns !== nx || s.meta.rows !== ny) {
      throw new GeometryError(
        `slices disagree on size: ${nx}x${ny} vs ` +
        `${s.meta.columns}x${s.meta.rows} in ${s.path}. This is not one series.`);
    }
  }

  const r = first.orientation.slice(0, 3);
  const c = first.orientation.slice(3, 6);
  const n = cross(r, c);

  // Sort along the slice normal. This is the whole ballgame -- see rule 1.
  slices.sort((a, b) => project(a.meta.position, n) - project(b.meta.position, n));
  const nz = slices.length;

  // Slice spacing from the actual positions, which is what ITK's series reader
  // does. SpacingBetweenSlices agrees here (both 1.10) but the positions are
  // the ground truth: they are where the slices physically are.
  let sz;
  if (nz === 1) {
    sz = first.spacingBetweenSlices || first.sliceThickness || 1;
  } else {
    const p0 = project(slices[0].meta.position, n);
    sz = project(slices[1].meta.position, n) - p0;
    for (let k = 1; k < nz; k++) {
      const step = (project(slices[k].meta.position, n) - p0) / k;
      if (Math.abs(step - sz) > 1e-3) {
        throw new GeometryError(
          `slice spacing is not uniform: ${sz.toFixed(4)} mm between the first ` +
          `two but ${step.toFixed(4)} mm on average by slice ${k}. A volume ` +
          `built from these would have the wrong physical size.`);
      }
    }
    if (Math.abs(sz) < 1e-6) {
      throw new GeometryError(
        'slice spacing is zero -- every slice is at the same position. The ' +
        'Scout/localiser series does this; it is not a volume.');
    }
  }

  // PixelSpacing is [row, column]: row spacing is the y step, column the x.
  const ps = first.pixelSpacing || [1, 1];
  const spacing = [ps[1], ps[0], Math.abs(sz)];

  // ITK's direction matrix has the axis directions as its COLUMNS, flattened
  // row-major. Column 0 is the x (column-index) direction, column 1 the y,
  // column 2 the slice normal.
  const direction = [r[0], c[0], n[0],
                     r[1], c[1], n[1],
                     r[2], c[2], n[2]];
  const origin = slices[0].meta.position.slice();

  const data = new Float32Array(nx * ny * nz);
  for (let z = 0; z < nz; z++) {
    const s = slices[z];
    const slope = s.meta.rescaleSlope, inter = s.meta.rescaleIntercept;
    const px = s.pixels;
    const off = z * nx * ny;
    for (let i = 0; i < nx * ny; i++) data[off + i] = px[i] * slope + inter;
  }

  return {
    volume: new Volume({ nx, ny, nz, spacing, origin, direction, data }),
    meta: first,
  };
}
