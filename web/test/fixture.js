/**
 * A synthetic DICOM series, written from scratch.
 *
 * The self-test needs scans to run on, and the real ones are unpublished lab
 * data that must not be committed. So this writes valid Explicit VR Little
 * Endian DICOM files in the browser -- the same flavour the MRS3000 produces --
 * with the geometry this study actually has:
 *
 *     248 x 256 in-plane, 0.1563 x 0.1613 mm
 *     slices 1.10 mm apart (NOT the 1.00 mm SliceThickness)
 *     SequenceName "T2w FSE (axial,n"
 *     InstanceNumber running OPPOSITE to +z, which is the trap that makes a
 *       hand-rolled slice stack come out upside down
 *
 * The last one is the point. A fixture where InstanceNumber and z agree would
 * pass whether or not the loader sorts correctly, which would make the whole
 * self-test worthless for the one bug most likely to be there.
 *
 * Sizes are shrunk by default so the test runs in a second; pass the real ones
 * to check performance.
 */

const enc = new TextEncoder();

/** Explicit VR Little Endian element. */
function element(group, elem, vr, value) {
  let bytes;
  if (value instanceof Uint8Array) bytes = value;
  else if (typeof value === 'string') {
    // DICOM string values are padded to an even length -- with NUL for UI,
    // space for everything else.
    const s = value.length % 2 ? value + (vr === 'UI' ? '\0' : ' ') : value;
    bytes = enc.encode(s);
  } else if (vr === 'US') {
    bytes = new Uint8Array(2);
    new DataView(bytes.buffer).setUint16(0, value, true);
  } else if (vr === 'UL') {
    bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value, true);
  } else throw new Error(`fixture cannot write ${vr}`);

  const long = ['OB', 'OW', 'SQ', 'UN', 'UT'].includes(vr);
  const head = new Uint8Array(long ? 12 : 8);
  const dv = new DataView(head.buffer);
  dv.setUint16(0, group, true);
  dv.setUint16(2, elem, true);
  head.set(enc.encode(vr), 4);
  if (long) dv.setUint32(8, bytes.length, true);
  else dv.setUint16(6, bytes.length, true);

  const out = new Uint8Array(head.length + bytes.length);
  out.set(head, 0);
  out.set(bytes, head.length);
  return out;
}

function concat(chunks) {
  const n = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

export const GEOMETRY = {
  rows: 64, columns: 62,          // shrunk from the real 256 x 248
  nz: 6,                          // shrunk from 18
  pixelSpacing: [0.1563, 0.1613], // [row, column] mm, as DICOM orders them
  sliceThickness: 1.00,
  spacingBetweenSlices: 1.10,     // the 0.10 mm gap that makes volumes correct
  zTop: -2.65,                    // slice 1 sits HIGH and runs down, as in the study
  originXY: [19.92, 19.92],
  rescaleSlope: 1.13874,
  rescaleIntercept: 0.667458,
};

/**
 * One synthetic session.
 *
 * @param {string} name        session folder name
 * @param {object} opts
 *        `sequenceName` to make a series that is NOT the T2 axial,
 *        `blob` to paint a bright ellipsoid so the image is not flat noise,
 *        `seriesNumbers` to create several series in one session.
 * @returns {Array<{file: File, path: string}>} exactly what a folder drop gives
 */
export function makeSession(name, opts = {}) {
  const g = { ...GEOMETRY, ...(opts.geometry || {}) };
  const out = [];

  const series = opts.series || [
    { number: 40003, sequenceName: 'T2w FSE (cor,n)' },   // a decoy: same slice
    { number: 40004, sequenceName: 'T2w FSE (axial,n' },  // count, same description
  ];

  for (const s of series) {
    for (let k = 0; k < g.nz; k++) {
      // InstanceNumber 1 is the TOP slice and z DECREASES with it, which is
      // backwards from the array order the mask uses. See the module comment.
      const instance = k + 1;
      const z = g.zTop - k * g.spacingBetweenSlices;
      const px = new Uint16Array(g.rows * g.columns);
      const zi = g.nz - 1 - k;                       // index in ascending-z order
      for (let y = 0; y < g.rows; y++) {
        for (let x = 0; x < g.columns; x++) {
          // A smooth gradient plus a blob, so slices differ from each other and
          // a mis-ordered stack is detectable by value, not just by geometry.
          let v = 200 + x * 3 + y * 2 + zi * 40;
          if (opts.blob !== false) {
            const d = Math.hypot((x - g.columns / 2) / 8, (y - g.rows / 2) / 8,
                                 (zi - g.nz / 2) / 1.5);
            if (d < 1) v += 1500 * (1 - d);
          }
          px[y * g.columns + x] = v & 0x0fff;         // 12 bits stored
        }
      }

      const pixels = new Uint8Array(px.buffer.slice(0));
      const parts = [
        new Uint8Array(128),                          // preamble
        enc.encode('DICM'),
        element(0x0002, 0x0000, 'UL', 0),             // group length, patched below
        element(0x0002, 0x0010, 'UI', '1.2.840.10008.1.2.1'),
        element(0x0008, 0x0020, 'DA', '20260615'),
        element(0x0008, 0x0031, 'TM', '142017'),
        element(0x0008, 0x0060, 'CS', 'MR'),
        element(0x0008, 0x103e, 'LO', "MRI 'FSE26' Scan"),
        element(0x0010, 0x0010, 'PN', opts.patientName || name.split(' ')[1] || 'TEST'),
        element(0x0010, 0x0020, 'LO', name.split(' ')[0]),
        element(0x0018, 0x0024, 'SH', s.sequenceName),
        element(0x0018, 0x0050, 'DS', g.sliceThickness.toFixed(2)),
        element(0x0018, 0x0080, 'DS', '5000.000000'),
        element(0x0018, 0x0081, 'DS', '68.000000'),
        element(0x0018, 0x0088, 'DS', g.spacingBetweenSlices.toFixed(2)),
        element(0x0020, 0x0011, 'IS', String(s.number)),
        element(0x0020, 0x0013, 'IS', String(instance)),
        element(0x0020, 0x0032, 'DS',
                `${g.originXY[0]}\\${g.originXY[1]}\\${z.toFixed(2)}`),
        element(0x0020, 0x0037, 'DS', '-1.00\\0.00\\-0.00\\0.00\\-1.00\\-0.00'),
        element(0x0028, 0x0002, 'US', 1),
        element(0x0028, 0x0004, 'CS', 'MONOCHROME2'),
        element(0x0028, 0x0010, 'US', g.rows),
        element(0x0028, 0x0011, 'US', g.columns),
        element(0x0028, 0x0030, 'DS', `${g.pixelSpacing[0]}\\${g.pixelSpacing[1]}`),
        element(0x0028, 0x0100, 'US', 16),
        element(0x0028, 0x0101, 'US', 12),
        element(0x0028, 0x0102, 'US', 11),
        element(0x0028, 0x0103, 'US', 0),
        element(0x0028, 0x1052, 'DS', String(g.rescaleIntercept)),
        element(0x0028, 0x1053, 'DS', String(g.rescaleSlope)),
        element(0x7fe0, 0x0010, 'OW', pixels),
      ];
      const bytes = concat(parts);
      // Patch the meta group length now that it is known: everything from the
      // end of the group-length element to the end of group 0002.
      const metaLen = parts[3].length;
      new DataView(bytes.buffer).setUint32(132 + 8, metaLen, true);

      const path = `${name}/DICOM/${s.number}/1/IM_${String(instance).padStart(4, '0')}.dcm`;
      out.push({ file: new File([bytes], path.split('/').pop()), path });
    }
  }
  return out;
}

/** What `loadSeries` should produce for the T2 axial series of `makeSession`. */
export function expectedGeometry(g = GEOMETRY) {
  return {
    nx: g.columns, ny: g.rows, nz: g.nz,
    // DICOM PixelSpacing is [row, column]; ITK spacing is [x, y, z].
    spacing: [g.pixelSpacing[1], g.pixelSpacing[0], g.spacingBetweenSlices],
    // Origin is the LOWEST-z slice, not the first file.
    origin: [g.originXY[0], g.originXY[1], g.zTop - (g.nz - 1) * g.spacingBetweenSlices],
    direction: [-1, 0, 0, 0, -1, 0, 0, 0, 1],
  };
}
