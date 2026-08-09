/**
 * A DICOM reader, in the browser, for exactly this study's files.
 *
 * This is not a general DICOM library and does not try to be. It reads what the
 * MR Solutions MRS3000 writes -- Explicit VR Little Endian, single-frame,
 * uncompressed, 16-bit -- and refuses anything else with a message that says
 * what it found. A parser that quietly mis-reads a scan is far worse here than
 * one that stops: the failure would show up as a tumour volume that is wrong by
 * some unknown amount, months later, in a figure.
 *
 * WHAT IT HAS TO GET RIGHT  (see CLAUDE.md, "Geometry gotchas")
 * ------------------------------------------------------------
 *   * SequenceName (0018,0024) is the ONLY field that distinguishes the T2
 *     axial from the T2 coronal and the T1 axial. SeriesDescription is
 *     "MRI 'FSE26' Scan" for all three, and slice count does not separate the
 *     two T2 series either.
 *   * Slices must be ordered by ImagePositionPatient projected on the slice
 *     normal, NOT by InstanceNumber. In this study InstanceNumber runs the
 *     opposite way to +z, so an InstanceNumber stack is z-flipped relative to
 *     every existing mask -- the tumour lands at the wrong end of the animal
 *     and Dice is near zero for a reason nobody would guess.
 *   * RescaleSlope/RescaleIntercept are written per slice and must be applied.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * --------------------------------
 * No sequence (SQ) contents, no compressed pixel data, no multi-frame, no
 * big-endian. None of it appears in this study; all of it is detected and
 * reported rather than guessed at.
 */

const TAG = {
  TransferSyntaxUID:        0x00020010,
  StudyDate:                0x00080020,
  SeriesTime:               0x00080031,
  Modality:                 0x00080060,
  SeriesDescription:        0x0008103e,
  PatientName:              0x00100010,
  PatientID:                0x00100020,
  PatientSex:               0x00100040,
  PatientWeight:            0x00101030,
  SequenceName:             0x00180024,
  SliceThickness:           0x00180050,
  RepetitionTime:           0x00180080,
  EchoTime:                 0x00180081,
  SpacingBetweenSlices:     0x00180088,
  SeriesNumber:             0x00200011,
  InstanceNumber:           0x00200013,
  ImagePositionPatient:     0x00200032,
  ImageOrientationPatient:  0x00200037,
  SamplesPerPixel:          0x00280002,
  PhotometricInterpretation:0x00280004,
  NumberOfFrames:           0x00280008,
  Rows:                     0x00280010,
  Columns:                  0x00280011,
  PixelSpacing:             0x00280030,
  BitsAllocated:            0x00280100,
  BitsStored:               0x00280101,
  HighBit:                  0x00280102,
  PixelRepresentation:      0x00280103,
  RescaleIntercept:         0x00281052,
  RescaleSlope:             0x00281053,
  PixelData:                0x7fe00010,
};
export { TAG };

// Implicit VR carries no VR in the stream, so it has to come from a dictionary.
// Only the tags above are listed: anything else is skipped by length and never
// needs its type. The MRS3000 writes Explicit VR, so this path is a fallback.
const IMPLICIT_VR = {
  [TAG.StudyDate]: 'DA', [TAG.SeriesTime]: 'TM', [TAG.Modality]: 'CS',
  [TAG.SeriesDescription]: 'LO', [TAG.PatientName]: 'PN', [TAG.PatientID]: 'LO',
  [TAG.PatientSex]: 'CS', [TAG.PatientWeight]: 'DS', [TAG.SequenceName]: 'SH',
  [TAG.SliceThickness]: 'DS', [TAG.RepetitionTime]: 'DS', [TAG.EchoTime]: 'DS',
  [TAG.SpacingBetweenSlices]: 'DS', [TAG.SeriesNumber]: 'IS',
  [TAG.InstanceNumber]: 'IS', [TAG.ImagePositionPatient]: 'DS',
  [TAG.ImageOrientationPatient]: 'DS', [TAG.SamplesPerPixel]: 'US',
  [TAG.PhotometricInterpretation]: 'CS', [TAG.NumberOfFrames]: 'IS',
  [TAG.Rows]: 'US', [TAG.Columns]: 'US', [TAG.PixelSpacing]: 'DS',
  [TAG.BitsAllocated]: 'US', [TAG.BitsStored]: 'US', [TAG.HighBit]: 'US',
  [TAG.PixelRepresentation]: 'US', [TAG.RescaleIntercept]: 'DS',
  [TAG.RescaleSlope]: 'DS', [TAG.PixelData]: 'OW',
};

// VRs whose explicit-VR encoding is 2 bytes of VR, 2 reserved, then a 32-bit
// length -- everything else uses a 16-bit length immediately after the VR.
// UC, UR and UT are both long-form and text, so they appear in both sets: the
// first decides how the length is read, the second how the value is decoded.
const LONG_VR = new Set(['OB', 'OD', 'OF', 'OL', 'OV', 'OW', 'SQ', 'SV',
                         'UC', 'UN', 'UR', 'UT', 'UV']);
const TEXT_VR = new Set(['AE', 'AS', 'CS', 'DA', 'DS', 'DT', 'IS', 'LO', 'LT',
                         'PN', 'SH', 'ST', 'TM', 'UC', 'UI', 'UR', 'UT']);

const UID = {
  IMPLICIT_LE: '1.2.840.10008.1.2',
  EXPLICIT_LE: '1.2.840.10008.1.2.1',
  EXPLICIT_BE: '1.2.840.10008.1.2.2',
};

const ascii = (buf, off, len) => {
  let s = '';
  const b = new Uint8Array(buf, off, len);
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  // Trailing NUL and space are both legal DICOM padding.
  return s.replace(/[\0 ]+$/, '');
};

/** Split a multi-valued string on the DICOM value delimiter. */
const parts = (s) => String(s).split('\\');

export const num = (v) => {
  if (v == null) return null;
  const f = parseFloat(Array.isArray(v) ? v[0] : v);
  return Number.isFinite(f) ? f : null;
};
export const nums = (v) => {
  if (v == null) return null;
  const a = Array.isArray(v) ? v : parts(v);
  return a.map((x) => parseFloat(x));
};

class DicomError extends Error {}
export { DicomError };

/**
 * Parse one DICOM file.
 *
 * `headerOnly` exists for series discovery, which needs SequenceName (0018,0024)
 * and nothing else. That tag sits a few hundred bytes in, so discovery can read
 * an 8 KB prefix of each file instead of all 130 KB -- 16x less I/O across a
 * cohort. With it set, running off the end of a deliberately truncated buffer
 * is a normal stop rather than an error.
 *
 * @param {ArrayBuffer} buf
 * @param {{headerOnly?: boolean, name?: string}} opts
 * @returns {{tags: Object, pixelOffset: number, pixelLength: number,
 *            transferSyntax: string}}
 */
export function parse(buf, opts = {}) {
  const where = opts.name ? ` (${opts.name})` : '';
  const partial = !!opts.headerOnly;
  const dv = new DataView(buf);
  if (buf.byteLength < 132) throw new DicomError(`file is too short to be DICOM${where}`);
  if (ascii(buf, 128, 4) !== 'DICM') {
    throw new DicomError(
      `no DICM marker at byte 128${where} -- this is not a DICOM Part-10 file`);
  }

  const tags = {};
  let pixelOffset = -1, pixelLength = 0;

  // The file meta group (0002,xxxx) is ALWAYS Explicit VR Little Endian, no
  // matter which transfer syntax it declares for the rest of the file. So we
  // start explicit and switch once, at the first element outside group 2.
  let pos = 132;
  let explicit = true;
  let inMeta = true;
  let transferSyntax = UID.EXPLICIT_LE;

  while (pos + 8 <= buf.byteLength) {
    const tag = ((dv.getUint16(pos, true) << 16) | dv.getUint16(pos + 2, true)) >>> 0;

    if (inMeta && (tag >>> 16) !== 0x0002) {
      if (transferSyntax === UID.EXPLICIT_BE) {
        throw new DicomError(
          `${transferSyntax} (Explicit VR Big Endian) is not supported${where}. ` +
          `Nothing in this study uses it.`);
      }
      explicit = transferSyntax !== UID.IMPLICIT_LE;
      inMeta = false;
    }

    let vr, len, hdr;
    if (explicit) {
      if (pos + 12 > buf.byteLength && partial) break;
      vr = ascii(buf, pos + 4, 2);
      if (LONG_VR.has(vr)) { len = dv.getUint32(pos + 8, true); hdr = 12; }
      else { len = dv.getUint16(pos + 6, true); hdr = 8; }
    } else {
      vr = IMPLICIT_VR[tag] || 'UN';
      len = dv.getUint32(pos + 4, true);
      hdr = 8;
    }
    const vstart = pos + hdr;

    if (tag === TAG.PixelData) {
      if (len === 0xffffffff) {
        throw new DicomError(
          `pixel data is encapsulated (compressed) in ${transferSyntax}${where}. ` +
          `This reader only handles uncompressed DICOM, which is what the ` +
          `MRS3000 writes. Convert with dcmdjpeg, or use the Python tool.`);
      }
      // The declared length has to actually be there. Without this check a
      // file cut short mid-image sails through -- `parse` records the claimed
      // length, and the failure surfaces much later as a typed-array
      // constructor complaining about byte alignment, which tells the user
      // nothing about the real problem.
      if (!partial && vstart + len > buf.byteLength) {
        throw new DicomError(
          `pixel data claims ${len} bytes but only ${buf.byteLength - vstart} ` +
          `are in the file${where} -- it is truncated. A partial copy usually ` +
          `means the transfer was interrupted; re-copy it from the scanner.`);
      }
      pixelOffset = vstart;
      pixelLength = len;
      break;                          // pixel data is last; nothing after matters
    }

    if (vr === 'SQ' || len === 0xffffffff) {
      // Skip the whole sequence. Nothing this tool reads lives inside one, and
      // walking into them is where a hand-rolled parser goes wrong.
      pos = skipSequence(dv, buf, vstart, len);
      continue;
    }

    if (vstart + len > buf.byteLength) {
      if (partial) break;
      throw new DicomError(
        `element ${tagStr(tag)} claims ${len} bytes but only ` +
        `${buf.byteLength - vstart} remain${where} -- the file is truncated`);
    }

    if (tag === TAG.TransferSyntaxUID) transferSyntax = ascii(buf, vstart, len);

    if (TEXT_VR.has(vr)) {
      const s = ascii(buf, vstart, len);
      tags[tag] = s.includes('\\') ? parts(s) : s;
    } else if (vr === 'US') {
      tags[tag] = len >= 2 ? dv.getUint16(vstart, true) : null;
    } else if (vr === 'SS') {
      tags[tag] = len >= 2 ? dv.getInt16(vstart, true) : null;
    } else if (vr === 'UL') {
      tags[tag] = len >= 4 ? dv.getUint32(vstart, true) : null;
    } else if (vr === 'SL') {
      tags[tag] = len >= 4 ? dv.getInt32(vstart, true) : null;
    } else if (vr === 'FL') {
      tags[tag] = len >= 4 ? dv.getFloat32(vstart, true) : null;
    } else if (vr === 'FD') {
      tags[tag] = len >= 8 ? dv.getFloat64(vstart, true) : null;
    }
    // Anything else (OB/OW/UN payloads we do not use) is skipped by length.

    pos = vstart + len + (len % 2);   // elements are padded to even length
  }

  if (!partial && pixelOffset < 0) {
    throw new DicomError(`no pixel data in this file${where}`);
  }
  return { tags, pixelOffset, pixelLength, transferSyntax };
}

function skipSequence(dv, buf, start, len) {
  if (len !== 0xffffffff) return start + len;
  let p = start;
  while (p + 8 <= buf.byteLength) {
    const g = dv.getUint16(p, true), e = dv.getUint16(p + 2, true);
    const l = dv.getUint32(p + 4, true);
    p += 8;
    if (g === 0xfffe && e === 0xe0dd) return p;        // sequence delimiter
    if (l !== 0xffffffff) p += l;                      // defined-length item
    else p = skipSequence(dv, buf, p, 0xffffffff);     // nested undefined item
  }
  return buf.byteLength;
}

const tagStr = (t) =>
  `(${(t >>> 16).toString(16).padStart(4, '0')},` +
  `${(t & 0xffff).toString(16).padStart(4, '0')})`;

/**
 * The stored pixels of one slice, as written -- no rescale applied.
 *
 * Returns Int16Array when PixelRepresentation is 1 (signed) and Uint16Array
 * otherwise. This study is unsigned 12-bit stored in 16, but reading the flag
 * costs nothing and getting it wrong would wrap every bright voxel to negative.
 */
export function pixelArray(buf, parsed) {
  const t = parsed.tags;
  const rows = t[TAG.Rows], cols = t[TAG.Columns];
  const bits = t[TAG.BitsAllocated] ?? 16;
  const spp = t[TAG.SamplesPerPixel] ?? 1;
  const frames = parseInt(t[TAG.NumberOfFrames] ?? '1', 10) || 1;

  if (spp !== 1) {
    throw new DicomError(`SamplesPerPixel is ${spp}; this reader handles ` +
                         `single-channel greyscale only`);
  }
  if (frames !== 1) {
    throw new DicomError(`this is a multi-frame file (${frames} frames). The ` +
                         `MRS3000 writes one file per slice; a multi-frame ` +
                         `file means the data came from somewhere else.`);
  }
  if (bits !== 16 && bits !== 8) {
    throw new DicomError(`BitsAllocated is ${bits}; expected 8 or 16`);
  }

  const n = rows * cols;
  const need = n * (bits / 8);
  // Both the declared length and the bytes actually present. `parse` already
  // rejects a truncated file, so reaching either of these means the header is
  // internally inconsistent rather than the file being cut short.
  if (parsed.pixelLength < need) {
    throw new DicomError(`pixel data is ${parsed.pixelLength} bytes but ` +
                         `${rows}x${cols} at ${bits}-bit needs ${need}`);
  }
  if (parsed.pixelOffset + need > buf.byteLength) {
    throw new DicomError(`pixel data runs ${parsed.pixelOffset + need - buf.byteLength} ` +
                         `bytes past the end of the file -- it is truncated`);
  }

  const signed = t[TAG.PixelRepresentation] === 1;
  // The offset may be odd, and typed-array views require alignment, so copy
  // rather than view when it is not aligned. (It is aligned in practice; the
  // copy path exists so an odd-length private tag upstream cannot break it.)
  const src = buf.slice(parsed.pixelOffset, parsed.pixelOffset + need);
  if (bits === 8) {
    return signed ? new Int8Array(src) : new Uint8Array(src);
  }
  return signed ? new Int16Array(src) : new Uint16Array(src);
}

/** The subset of the header the rest of the tool asks about, by name. */
export function meta(parsed) {
  const t = parsed.tags;
  const g = (tag) => t[tag] ?? null;
  return {
    sequenceName: String(g(TAG.SequenceName) ?? ''),
    patientName: String(g(TAG.PatientName) ?? ''),
    patientId: String(g(TAG.PatientID) ?? ''),
    patientSex: String(g(TAG.PatientSex) ?? ''),
    studyDate: String(g(TAG.StudyDate) ?? ''),
    seriesTime: String(g(TAG.SeriesTime) ?? ''),
    seriesNumber: String(g(TAG.SeriesNumber) ?? ''),
    instanceNumber: num(g(TAG.InstanceNumber)),
    rows: g(TAG.Rows),
    columns: g(TAG.Columns),
    pixelSpacing: nums(g(TAG.PixelSpacing)),               // [row, column] mm
    sliceThickness: num(g(TAG.SliceThickness)),
    spacingBetweenSlices: num(g(TAG.SpacingBetweenSlices)),
    position: nums(g(TAG.ImagePositionPatient)),           // LPS mm
    orientation: nums(g(TAG.ImageOrientationPatient)),     // row cosines, col cosines
    rescaleSlope: num(g(TAG.RescaleSlope)) ?? 1,
    rescaleIntercept: num(g(TAG.RescaleIntercept)) ?? 0,
    TR: num(g(TAG.RepetitionTime)),
    TE: num(g(TAG.EchoTime)),
  };
}

export const T2_AXIAL_SEQUENCE_PREFIX = 'T2w FSE (axial';

/** Does this header belong to the series we segment? */
export function isT2Axial(m) {
  return m.sequenceName.startsWith(T2_AXIAL_SEQUENCE_PREFIX);
}
