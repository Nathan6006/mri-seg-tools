/**
 * gzip, and the pieces of a ZIP file we need.
 *
 * The browser can already do gzip -- CompressionStream landed in Chrome 80,
 * Firefox 113 and Safari 16.4 -- so there is no reason to ship a copy of zlib.
 * Everything here is a thin wrapper that turns those streams into the plain
 * Uint8Array-in, Uint8Array-out shape the rest of the code wants.
 *
 * WHY THIS MATTERS FOR THIS PROJECT
 * ---------------------------------
 * The masks are `.nii.gz`, and they must stay `.nii.gz`: the deliverable is a
 * file that opens in ITK-SNAP. Writing an uncompressed `.nii` would work in
 * ITK-SNAP too, but the lab's existing masks are all `.nii.gz` and mixing the
 * two is the kind of small inconsistency that turns into a bug report six
 * months later.
 */

function assertStreams() {
  if (typeof CompressionStream === 'undefined' ||
      typeof DecompressionStream === 'undefined') {
    throw new Error(
      'This browser has no CompressionStream, so it cannot read or write ' +
      '.nii.gz files. Chrome 80+, Firefox 113+ or Safari 16.4+ are needed. ' +
      'Everything else in the tool would work; the mask files would not.');
  }
}

async function pipe(bytes, stream) {
  const src = new Blob([bytes]).stream().pipeThrough(stream);
  const buf = await new Response(src).arrayBuffer();
  return new Uint8Array(buf);
}

/** Uint8Array -> gzip-compressed Uint8Array. */
export async function gzip(bytes) {
  assertStreams();
  return pipe(bytes, new CompressionStream('gzip'));
}

/** gzip-compressed Uint8Array -> Uint8Array. */
export async function gunzip(bytes) {
  assertStreams();
  return pipe(bytes, new DecompressionStream('gzip'));
}

/** True if these bytes start with the gzip magic number. */
export function isGzip(bytes) {
  return bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

// ---------------------------------------------------------------------------
// ZIP
// ---------------------------------------------------------------------------
// Written with the STORE method -- no compression at all. That looks lazy and
// is actually correct here: every file going into the bundle is either a
// `.nii.gz` (already deflated) or a `.png` (already deflated). Deflating them
// again costs CPU and typically makes them very slightly larger. The two
// exceptions, `volumes.csv` and `results.json`, are a few kilobytes.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Build a ZIP from [{name, bytes}].
 *
 * ZIP64 is not implemented, so this caps out at 4 GB and 65,535 entries. A
 * results folder for a whole cohort is a couple of hundred megabytes and a few
 * hundred files, so the limit is nowhere near. It throws rather than writing a
 * silently truncated archive if that ever changes -- a corrupt bundle that
 * looks fine until someone tries to open it months later is the worst outcome.
 */
export function zip(entries) {
  if (entries.length > 0xffff) {
    throw new Error(`${entries.length} files is past the 65,535 the plain ZIP ` +
                    `format allows. This needs ZIP64.`);
  }
  const enc = new TextEncoder();
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const e of entries) {
    const name = enc.encode(e.name);
    const data = e.bytes;
    const crc = crc32(data);

    const lh = new Uint8Array(30 + name.length);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true);   // local file header signature
    lv.setUint16(4, 20, true);           // version needed
    lv.setUint16(6, 0, true);            // flags
    lv.setUint16(8, 0, true);            // method 0 = stored
    lv.setUint16(10, 0, true);           // mod time
    lv.setUint16(12, 0, true);           // mod date
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true); // compressed size
    lv.setUint32(22, data.length, true); // uncompressed size
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);           // extra length
    lh.set(name, 30);

    const ch = new Uint8Array(46 + name.length);
    const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true);   // central directory signature
    cv.setUint16(4, 20, true);           // version made by
    cv.setUint16(6, 20, true);           // version needed
    cv.setUint16(8, 0, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, offset, true);      // where the local header sits
    ch.set(name, 46);

    locals.push(lh, data);
    centrals.push(ch);
    offset += lh.length + data.length;
  }

  const centralSize = centrals.reduce((s, c) => s + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);     // end of central directory
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  return new Blob([...locals, ...centrals, end], { type: 'application/zip' });
}
