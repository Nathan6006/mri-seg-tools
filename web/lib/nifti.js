/**
 * NIfTI-1 read and write, matching byte for byte what SimpleITK produces.
 *
 * The masks this tool writes have to open in ITK-SNAP, on the same grid as the
 * scan, next to masks the lab drew by hand two years ago. That means matching
 * ITK's conventions rather than inventing our own defensible ones.
 *
 * THE COORDINATE FLIP, WHICH IS THE ONLY HARD PART
 * -----------------------------------------------
 * DICOM and ITK work in LPS (+x left, +y posterior, +z superior). NIfTI is
 * RAS (+x right, +y anterior). ITK converts on the way out by negating the
 * first two rows of the affine -- so a scan whose ITK direction is
 * (-1,0,0, 0,-1,0, 0,0,1) comes out with an identity rotation in the file, and
 * an origin of (19.92, 19.92, -21.35) is written as (-19.92, -19.92, -21.35).
 *
 * Both the qform (quaternion) and the sform (affine) are written, with
 * qform_code = sform_code = 1, because that is what SimpleITK does and readers
 * disagree about which one wins when only one is present.
 *
 * Verified against a reference file: every header field this module writes for
 * a real session matches `sitk.WriteImage` exactly.
 */

import { Volume } from './volume.js';
import { gzip, gunzip, isGzip } from './gz.js';

const DT = {
  UINT8: 2, INT16: 4, INT32: 8, FLOAT32: 16, FLOAT64: 64,
  INT8: 256, UINT16: 512, UINT32: 768,
};

const READERS = {
  [DT.UINT8]:   { Kind: Uint8Array,   bytes: 1 },
  [DT.INT8]:    { Kind: Int8Array,    bytes: 1 },
  [DT.INT16]:   { Kind: Int16Array,   bytes: 2 },
  [DT.UINT16]:  { Kind: Uint16Array,  bytes: 2 },
  [DT.INT32]:   { Kind: Int32Array,   bytes: 4 },
  [DT.UINT32]:  { Kind: Uint32Array,  bytes: 4 },
  [DT.FLOAT32]: { Kind: Float32Array, bytes: 4 },
  [DT.FLOAT64]: { Kind: Float64Array, bytes: 8 },
};

export class NiftiError extends Error {}

// ---------------------------------------------------------------------------
// LPS <-> RAS
// ---------------------------------------------------------------------------

/**
 * ITK direction+origin+spacing (LPS) -> the 3x4 RAS affine NIfTI stores.
 * Returns rows [srow_x, srow_y, srow_z], each 4 long.
 */
function affineRAS(direction, spacing, origin) {
  const flip = [-1, -1, 1];      // negate x and y going LPS -> RAS
  const rows = [];
  for (let i = 0; i < 3; i++) {
    const r = [];
    for (let j = 0; j < 3; j++) r.push(flip[i] * direction[i * 3 + j] * spacing[j]);
    r.push(flip[i] * origin[i]);
    rows.push(r);
  }
  return rows;
}

/** The inverse: a stored RAS affine back to ITK's direction/spacing/origin. */
function affineToITK(rows) {
  const flip = [-1, -1, 1];
  const m = rows.map((r, i) => r.slice(0, 3).map((v) => flip[i] * v));
  const origin = rows.map((r, i) => flip[i] * r[3]);
  const spacing = [0, 1, 2].map((j) =>
    Math.hypot(m[0][j], m[1][j], m[2][j]));
  const direction = new Array(9).fill(0);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      direction[i * 3 + j] = spacing[j] > 1e-12 ? m[i][j] / spacing[j] : (i === j ? 1 : 0);
    }
  }
  return { direction, spacing, origin };
}

/**
 * Rotation matrix -> NIfTI quaternion, following nifti1_io's
 * nifti_mat44_to_quatern. `rows` is the RAS 3x4 affine.
 *
 * qfac comes back as -1 for a left-handed matrix, which NIfTI encodes by
 * storing it in pixdim[0]. None of this study's scans are left-handed, but a
 * silently-dropped qfac would mirror the z axis, so it is handled rather than
 * asserted away.
 */
function quaternion(rows) {
  const sp = [0, 1, 2].map((j) => Math.hypot(rows[0][j], rows[1][j], rows[2][j]) || 1);
  let r = [0, 1, 2].map((i) => [0, 1, 2].map((j) => rows[i][j] / sp[j]));

  const det =
      r[0][0] * (r[1][1] * r[2][2] - r[1][2] * r[2][1])
    - r[0][1] * (r[1][0] * r[2][2] - r[1][2] * r[2][0])
    + r[0][2] * (r[1][0] * r[2][1] - r[1][1] * r[2][0]);

  let qfac = 1;
  if (det < 0) {
    qfac = -1;
    r = r.map((row) => [row[0], row[1], -row[2]]);
  }

  const [r11, r12, r13] = r[0], [r21, r22, r23] = r[1], [r31, r32, r33] = r[2];
  let a = r11 + r22 + r33 + 1, b, c, d;
  if (a > 0.5) {
    a = 0.5 * Math.sqrt(a);
    b = 0.25 * (r32 - r23) / a;
    c = 0.25 * (r13 - r31) / a;
    d = 0.25 * (r21 - r12) / a;
  } else {
    const xd = 1 + r11 - (r22 + r33);
    const yd = 1 + r22 - (r11 + r33);
    const zd = 1 + r33 - (r11 + r22);
    if (xd > 1) {
      b = 0.5 * Math.sqrt(xd);
      c = 0.25 * (r12 + r21) / b;
      d = 0.25 * (r13 + r31) / b;
      a = 0.25 * (r32 - r23) / b;
    } else if (yd > 1) {
      c = 0.5 * Math.sqrt(yd);
      b = 0.25 * (r12 + r21) / c;
      d = 0.25 * (r23 + r32) / c;
      a = 0.25 * (r13 - r31) / c;
    } else {
      d = 0.5 * Math.sqrt(zd);
      b = 0.25 * (r13 + r31) / d;
      c = 0.25 * (r23 + r32) / d;
      a = 0.25 * (r21 - r12) / d;
    }
    if (a < 0) { a = -a; b = -b; c = -c; d = -d; }
  }
  return { b, c, d, qfac };
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

const HEADER_BYTES = 348;
const VOX_OFFSET = 352;      // 348 header + 4 bytes of "no extensions"

function datatypeOf(data) {
  if (data instanceof Uint8Array) return DT.UINT8;
  if (data instanceof Int16Array) return DT.INT16;
  if (data instanceof Uint16Array) return DT.UINT16;
  if (data instanceof Float32Array) return DT.FLOAT32;
  if (data instanceof Float64Array) return DT.FLOAT64;
  throw new NiftiError(`no NIfTI datatype for ${data.constructor.name}`);
}

/**
 * Serialise a Volume as an uncompressed NIfTI-1 (.nii) byte array.
 * Use `writeNiftiGz` for the `.nii.gz` the lab actually uses.
 */
export function writeNifti(vol) {
  const datatype = datatypeOf(vol.data);
  const bitpix = READERS[datatype].bytes * 8;
  const rows = affineRAS(vol.direction, vol.spacing, vol.origin);
  const q = quaternion(rows);

  const total = VOX_OFFSET + vol.data.byteLength;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);

  dv.setInt32(0, HEADER_BYTES, true);              // sizeof_hdr
  // dim_info (byte 39) stays 0: no slice-timing information to record.
  dv.setInt16(40, 3, true);                        // dim[0] = 3 dimensions
  dv.setInt16(42, vol.nx, true);
  dv.setInt16(44, vol.ny, true);
  dv.setInt16(46, vol.nz, true);
  for (let k = 4; k < 8; k++) dv.setInt16(40 + k * 2, 1, true);

  dv.setInt16(70, datatype, true);
  dv.setInt16(72, bitpix, true);

  dv.setFloat32(76, q.qfac, true);                 // pixdim[0] carries qfac
  dv.setFloat32(80, vol.spacing[0], true);
  dv.setFloat32(84, vol.spacing[1], true);
  dv.setFloat32(88, vol.spacing[2], true);

  dv.setFloat32(108, VOX_OFFSET, true);
  dv.setFloat32(112, 1.0, true);                   // scl_slope: data is as-is
  dv.setFloat32(116, 0.0, true);                   // scl_inter
  out[123] = 10;                                   // xyzt_units: mm | sec

  dv.setInt16(252, 1, true);                       // qform_code = scanner anat
  dv.setInt16(254, 1, true);                       // sform_code = scanner anat
  dv.setFloat32(256, q.b, true);
  dv.setFloat32(260, q.c, true);
  dv.setFloat32(264, q.d, true);
  dv.setFloat32(268, rows[0][3], true);            // qoffset_x
  dv.setFloat32(272, rows[1][3], true);
  dv.setFloat32(276, rows[2][3], true);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 4; j++) dv.setFloat32(280 + i * 16 + j * 4, rows[i][j], true);
  }
  out.set(new TextEncoder().encode('n+1\0'), 344); // magic

  out.set(new Uint8Array(vol.data.buffer, vol.data.byteOffset, vol.data.byteLength),
          VOX_OFFSET);
  return out;
}

/** The `.nii.gz` form, which is what everything in this project uses. */
export async function writeNiftiGz(vol) {
  return gzip(writeNifti(vol));
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Read a `.nii` or `.nii.gz` into a Volume.
 *
 * Handles the byte-swapped variant, because a header written on a big-endian
 * machine is legal NIfTI and reading it as little-endian would give a plausible
 * but completely wrong volume rather than an error.
 */
export async function readNifti(bytes) {
  if (isGzip(bytes)) bytes = await gunzip(bytes);
  if (bytes.length < HEADER_BYTES) throw new NiftiError('file is shorter than a NIfTI header');

  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let le = true;
  if (dv.getInt32(0, true) !== HEADER_BYTES) {
    if (dv.getInt32(0, false) === HEADER_BYTES) le = false;
    else throw new NiftiError(
      'sizeof_hdr is neither 348 nor a byte-swapped 348 -- this is not NIfTI-1');
  }

  const magic = String.fromCharCode(...bytes.subarray(344, 347));
  if (magic === 'ni1') {
    throw new NiftiError(
      'this is a .hdr/.img pair, not a single-file .nii. Convert it, or open ' +
      'it in ITK-SNAP and save as .nii.gz.');
  }
  if (magic !== 'n+1') throw new NiftiError(`bad NIfTI magic ${JSON.stringify(magic)}`);

  const ndim = dv.getInt16(40, le);
  const nx = dv.getInt16(42, le), ny = dv.getInt16(44, le), nz = dv.getInt16(46, le);
  if (ndim < 3) throw new NiftiError(`this file is ${ndim}-dimensional; a scan needs 3`);
  if (ndim > 3) {
    for (let k = 4; k <= ndim; k++) {
      if (dv.getInt16(40 + k * 2, le) > 1) {
        throw new NiftiError(
          `this file has ${ndim} dimensions with more than one volume in it. ` +
          `A tumour mask should be a single 3-D volume.`);
      }
    }
  }

  const datatype = dv.getInt16(70, le);
  const spec = READERS[datatype];
  if (!spec) throw new NiftiError(`unsupported NIfTI datatype code ${datatype}`);

  const voxOffset = Math.round(dv.getFloat32(108, le)) || VOX_OFFSET;
  const n = nx * ny * nz;
  const need = n * spec.bytes;
  if (bytes.length < voxOffset + need) {
    throw new NiftiError(
      `header says ${nx}x${ny}x${nz} (${need} bytes of data) but only ` +
      `${bytes.length - voxOffset} follow the header -- the file is truncated`);
  }

  // .slice() rather than a view: vox_offset is 352 here, which is 8-byte
  // aligned, but a file with an extension header need not be, and a misaligned
  // typed-array view throws.
  const raw = bytes.buffer.slice(bytes.byteOffset + voxOffset,
                                 bytes.byteOffset + voxOffset + need);
  let data = new spec.Kind(raw);
  if (!le && spec.bytes > 1) data = byteSwap(data, spec.bytes);

  const sclSlope = dv.getFloat32(112, le), sclInter = dv.getFloat32(116, le);
  if (sclSlope !== 0 && !(sclSlope === 1 && sclInter === 0)) {
    const scaled = new Float32Array(n);
    for (let i = 0; i < n; i++) scaled[i] = data[i] * sclSlope + sclInter;
    data = scaled;
  }

  const sformCode = dv.getInt16(254, le);
  const qformCode = dv.getInt16(252, le);
  let geom;
  if (sformCode > 0) {
    const rows = [0, 1, 2].map((i) =>
      [0, 1, 2, 3].map((j) => dv.getFloat32(280 + i * 16 + j * 4, le)));
    geom = affineToITK(rows);
  } else if (qformCode > 0) {
    geom = fromQform(dv, le);
  } else {
    // Method 1: no orientation at all, just pixdim. Legal, and a real
    // possibility for a mask exported by some other tool.
    geom = {
      direction: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      spacing: [dv.getFloat32(80, le), dv.getFloat32(84, le), dv.getFloat32(88, le)],
      origin: [0, 0, 0],
    };
  }

  return new Volume({ nx, ny, nz, ...geom, data });
}

function fromQform(dv, le) {
  const qfac = dv.getFloat32(76, le) < 0 ? -1 : 1;
  const sp = [dv.getFloat32(80, le), dv.getFloat32(84, le), dv.getFloat32(88, le)];
  const b = dv.getFloat32(256, le), c = dv.getFloat32(260, le), d = dv.getFloat32(264, le);
  const a = Math.sqrt(Math.max(0, 1 - (b * b + c * c + d * d)));
  const R = [
    [a*a + b*b - c*c - d*d, 2*(b*c - a*d),         2*(b*d + a*c)],
    [2*(b*c + a*d),         a*a + c*c - b*b - d*d, 2*(c*d - a*b)],
    [2*(b*d - a*c),         2*(c*d + a*b),         a*a + d*d - c*c - b*b],
  ];
  const rows = [0, 1, 2].map((i) => [
    R[i][0] * sp[0], R[i][1] * sp[1], R[i][2] * sp[2] * qfac,
    dv.getFloat32(268 + i * 4, le),
  ]);
  return affineToITK(rows);
}

function byteSwap(arr, width) {
  const b = new Uint8Array(arr.buffer);
  for (let i = 0; i < b.length; i += width) {
    for (let j = 0; j < width >> 1; j++) {
      const t = b[i + j]; b[i + j] = b[i + width - 1 - j]; b[i + width - 1 - j] = t;
    }
  }
  return arr;
}
