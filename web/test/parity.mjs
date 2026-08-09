/**
 * Does the browser pipeline read a scan the same way SimpleITK does?
 *
 * This is the test that matters. Everything the static build produces -- the
 * volume in mm3, the mask, the file ITK-SNAP opens -- rests on the DICOM
 * reader and the NIfTI writer in web/lib/ agreeing with the Python tool that
 * has already been validated against the operator's own recorded volumes.
 *
 * Run:
 *     node web/test/parity.mjs [session ...]
 *     .venv/bin/python web/test/parity_check.py      # the other half
 *
 * The node half writes what it read to a scratch folder; the python half loads
 * the same sessions through src/loader.py and compares. Split in two because
 * only one of them can import SimpleITK and only one of them is the code that
 * actually ships.
 */
import { readdir, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

import { findT2AxialSeries, loadSeries, groupSessions } from '../lib/volume.js';
import { writeNifti, readNifti } from '../lib/nifti.js';
import { signedDistance } from '../lib/edt.js';
import { connectedComponents } from '../lib/label.js';

const ROOT = resolve(import.meta.dirname, '../..');
const RAW = join(ROOT, 'raw');
// Scratch, not output: this holds a few hundred MB of converted scans while the
// python half compares them, and they are regenerable in seconds. Override with
// PARITY_OUT if the temp directory is small.
const OUT = process.env.PARITY_OUT || join(tmpdir(), 'mri-parity');

/** Every file under `dir`, as the {file, path} pairs the browser hands over. */
async function collect(dir, base) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...await collect(p, base));
    else if (e.name.toLowerCase().endsWith('.dcm')) {
      const bytes = await readFile(p);
      out.push({ file: new Blob([bytes]), path: relative(base, p) });
    }
  }
  return out;
}

const sha = (u8) => createHash('sha256').update(u8).digest('hex').slice(0, 16);

/** min/max/sum in one pass. Math.min(...a) blows the stack past ~120k values. */
function range(a) {
  let min = Infinity, max = -Infinity, sum = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] < min) min = a[i];
    if (a[i] > max) max = a[i];
    sum += a[i];
  }
  return { min, max, sum };
}

async function main() {
  let sessions = process.argv.slice(2);

  // `--sweep N` samples N sessions evenly across raw/. Passing them on the
  // command line does not work: most session folders have spaces in the name
  // ("0001 SUBJ-A Male d12"), so a shell loop splits each one into four
  // arguments and every session comes back "not on disk".
  const sweep = sessions.indexOf('--sweep');
  if (sweep >= 0) {
    const n = parseInt(sessions[sweep + 1], 10) || 12;
    const all = (await readdir(RAW, { withFileTypes: true }))
      .filter((e) => e.isDirectory()).map((e) => e.name).sort();
    const step = Math.max(1, Math.floor(all.length / n));
    sessions = all.filter((_, i) => i % step === 0).slice(0, n);
    console.log(`sweeping ${sessions.length} of ${all.length} sessions\n`);
  }

  if (!sessions.length) {
    // Sample across the study rather than taking the first few alphabetically,
    // which would all be the same cohort on the same day. Name sessions
    // explicitly to target awkward ones -- extra slices, multi-focal masks, or
    // a batch folder holding a whole day of scanning.
    const all = (await readdir(RAW, { withFileTypes: true }))
      .filter((e) => e.isDirectory()).map((e) => e.name).sort();
    const step = Math.max(1, Math.floor(all.length / 4));
    sessions = all.filter((_, i) => i % step === 0).slice(0, 4);
  }

  await mkdir(OUT, { recursive: true });
  const report = [];

  for (const name of sessions) {
    const dir = join(RAW, name);
    try { await stat(dir); } catch { console.log(`skip ${name}: not on disk`); continue; }

    const entries = await collect(dir, RAW);
    const grouped = groupSessions(entries);
    const series = await findT2AxialSeries(entries);
    if (!series.length) { console.log(`skip ${name}: no T2 axial series`); continue; }

    // batch.process_session takes the highest series number: the last
    // acquisition, which is the redo when there was one.
    const chosen = series[series.length - 1];
    const { volume: vol, meta } = await loadSeries(chosen.files);

    const nii = writeNifti(vol);
    const outPath = join(OUT, `${name.replace(/[ /]/g, '_')}.nii`);
    await writeFile(outPath, nii);

    // Round-trip through our own reader too: a writer and reader that agree
    // with each other but not with ITK would still fail the python half, so
    // this only catches the narrower bug of losing data on the way back in.
    const back = await readNifti(nii);
    const rt = back.sameGridAs(vol);
    if (rt.length) throw new Error(`round trip changed the grid: ${rt.join('; ')}`);
    for (let i = 0; i < vol.data.length; i++) {
      if (back.data[i] !== vol.data[i]) throw new Error(`round trip changed voxel ${i}`);
    }

    report.push({
      session: name,
      sessionsFound: [...grouped.keys()],
      seriesNumbers: series.map((s) => s.seriesNumber),
      chosenSeries: chosen.seriesLabel,
      size: [vol.nx, vol.ny, vol.nz],
      spacing: vol.spacing,
      origin: vol.origin,
      direction: vol.direction,
      voxelVolumeMm3: vol.voxelVolumeMm3,
      dataSha256: sha(new Uint8Array(vol.data.buffer)),
      ...range(vol.data),
      patientName: meta.patientName,
      studyDate: meta.studyDate,
      niiPath: outPath,
    });
    console.log(`${name}: ${vol.nx}x${vol.ny}x${vol.nz} ` +
                `spacing ${vol.spacing.map((v) => v.toFixed(4))} ` +
                `series ${chosen.seriesLabel} -> ${outPath}`);
  }

  await writeFile(join(OUT, 'js_report.json'), JSON.stringify(report, null, 2));
  await writeFile(join(OUT, 'js_numerics.json'), JSON.stringify(numerics(), null, 2));
  console.log(`\nwrote ${join(OUT, 'js_report.json')}`);
  console.log('now run:  .venv/bin/python web/test/parity_check.py');
}

/**
 * The two numeric ports that are not covered by reading a scan: the signed
 * distance transform behind slice interpolation, and connected-component
 * labelling behind `n_components`.
 *
 * Both are checked against SimpleITK on shapes chosen to catch the specific
 * ways each could be wrong -- a concave shape and two shapes touching only at a
 * corner, which is the case where 6- and 26-connectivity disagree and where
 * getting SimpleITK's `fullyConnected=False` default wrong would show up.
 */
function numerics() {
  const NX = 32, NY = 28, NZ = 6;
  const shapes = {};

  const blank = () => new Uint8Array(NX * NY);
  const box = (m, x0, y0, x1, y1) => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) m[y * NX + x] = 1;
    return m;
  };

  const unbox = (m, x0, y0, x1, y1) => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) m[y * NX + x] = 0;
    return m;
  };

  shapes.square = box(blank(), 8, 8, 20, 20);
  // A C shape: concave, so the nearest boundary is not the nearest edge of the
  // bounding box. A chamfer approximation would visibly differ here.
  shapes.concave = unbox(box(blank(), 5, 5, 25, 22), 12, 9, 25, 18);
  shapes.twoBlobs = (() => {
    const m = box(blank(), 3, 3, 9, 9);
    return box(m, 9, 9, 15, 15);           // touches the first only at a corner
  })();
  shapes.single = (() => { const m = blank(); m[14 * NX + 16] = 1; return m; })();
  // Running off the edge of the image: is the field of view a boundary?
  shapes.edgeTouching = box(blank(), 0, 0, 7, 9);
  // A ring, so the inside hole and the outside are both positive but are not
  // connected to each other.
  shapes.ring = unbox(box(blank(), 6, 6, 24, 22), 10, 10, 20, 18);

  const sdf = {};
  for (const [name, m] of Object.entries(shapes)) {
    sdf[name] = { nx: NX, ny: NY, mask: [...m], d: [...signedDistance(m, NX, NY)] };
  }

  // A 3-D volume with a corner-touching pair, which must count as TWO under
  // face connectivity and ONE under full.
  const vol = new Uint8Array(NX * NY * NZ);
  const at = (x, y, z) => (z * NY + y) * NX + x;
  for (let z = 1; z < 3; z++) for (let y = 4; y < 8; y++) for (let x = 4; x < 8; x++) vol[at(x, y, z)] = 1;
  for (let z = 3; z < 5; z++) for (let y = 8; y < 12; y++) for (let x = 8; x < 12; x++) vol[at(x, y, z)] = 1;
  vol[at(20, 20, 0)] = 1;                  // a lone voxel, the small-component case
  const cc = connectedComponents(vol, NX, NY, NZ);

  return {
    sdf,
    cc: { nx: NX, ny: NY, nz: NZ, mask: [...vol], nComponents: cc.sizes.length,
          sizes: [...cc.sizes].sort((a, b) => a - b) },
  };
}

main().catch((e) => { console.error(e); process.exit(1); });
