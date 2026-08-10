/**
 * End-to-end self-test for the static build.
 *
 * Runs the whole pipeline -- DICOM in, mask, volume, QC image, storage, edit
 * tracking, interpolation, export -- against synthetic scans built by
 * fixture.js, inside a real browser, using the same modules the app uses.
 *
 * It exists because most of this code cannot run in node: IndexedDB, canvas and
 * CompressionStream are browser APIs, and the geometry handling is exactly the
 * kind of thing that is fine in isolation and wrong once it is wired together.
 *
 * Open web/test/selftest.html. Green means the build works on this browser;
 * that is also worth knowing, since Safari and Firefox differ from Chrome on
 * storage and on OffscreenCanvas.
 */

import { findT2AxialSeries, loadSeries, groupSessions, assertSameGrid } from '../lib/volume.js';
import { writeNifti, writeNiftiGz, readNifti } from '../lib/nifti.js';
import { gzip, gunzip, zip, crc32 } from '../lib/gz.js';
import { signedDistance } from '../lib/edt.js';
import { connectedComponents, removeSmallComponents, maskFacts } from '../lib/label.js';
import { StubPredictor, reviewScore, getPredictor } from '../lib/predictor.js';
import { montage, percentileWindow } from '../lib/qc.js';
import * as pipeline from '../lib/pipeline.js';
import * as store from '../lib/store.js';
import * as Backend from '../lib/backend.js';
import { makeSession, expectedGeometry, GEOMETRY } from './fixture.js';

const results = [];
let failures = 0;

function check(name, fn) {
  return (async () => {
    const t0 = performance.now();
    try {
      await fn();
      results.push({ name, ok: true, ms: performance.now() - t0 });
    } catch (e) {
      failures++;
      results.push({ name, ok: false, ms: performance.now() - t0, error: e.message,
                     stack: e.stack });
    }
    render();
  })();
}

const eq = (a, b, what) => {
  if (a !== b) throw new Error(`${what}: got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);
};
const close = (a, b, tol, what) => {
  if (Math.abs(a - b) > tol) throw new Error(`${what}: got ${a}, expected ${b} (±${tol})`);
};
const arrClose = (a, b, tol, what) => {
  if (a.length !== b.length) throw new Error(`${what}: length ${a.length} != ${b.length}`);
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i] - b[i]) > tol) {
      throw new Error(`${what}[${i}]: got ${a[i]}, expected ${b[i]} (±${tol})`);
    }
  }
};
const truthy = (v, what) => { if (!v) throw new Error(`${what} was falsy`); };

async function throws(fn, needle, what) {
  try { await fn(); } catch (e) {
    if (needle && !e.message.toLowerCase().includes(needle.toLowerCase())) {
      throw new Error(`${what}: threw "${e.message}", expected it to mention "${needle}"`);
    }
    return;
  }
  throw new Error(`${what}: did not throw`);
}

function render() {
  const el = document.getElementById('out');
  const done = results.length;
  el.innerHTML =
    `<p class="${failures ? 'bad' : 'ok'}"><strong>${done - failures} passed, ` +
    `${failures} failed</strong></p>` +
    results.map((r) => `<div class="row ${r.ok ? 'ok' : 'bad'}">
        <span class="mark">${r.ok ? '✓' : '✗'}</span>
        <span class="nm">${r.name}</span>
        <span class="ms">${r.ms.toFixed(0)} ms</span>
        ${r.ok ? '' : `<pre>${r.error}\n\n${r.stack || ''}</pre>`}
      </div>`).join('');
  document.title = failures ? `FAIL (${failures}) — self-test` : `PASS (${done}) — self-test`;
  document.body.dataset.state = failures ? 'fail' : 'pass';
}

/**
 * Load the real index.html in an iframe and wait for it to settle.
 *
 * "Settled" is defined as the storage label being filled in, which app.js does
 * at the end of its first refresh() -- so it is a signal that the whole
 * bootstrap ran, not just that the document parsed.
 */
function loadApp(timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const errors = [];
    const frame = document.createElement('iframe');
    frame.style.cssText = 'width:1200px;height:800px;position:fixed;left:-9999px';
    frame.src = '../index.html';
    document.body.appendChild(frame);

    frame.onload = () => {
      const w = frame.contentWindow;
      w.addEventListener('error', (e) => errors.push(`${e.message} (${e.filename}:${e.lineno})`));
      w.addEventListener('unhandledrejection', (e) => errors.push(`unhandled: ${e.reason}`));
      const t0 = performance.now();
      const poll = () => {
        const label = frame.contentDocument?.getElementById('outDirLabel');
        if (errors.length || (label && label.textContent.trim())) {
          resolve({ frame, errors });
        } else if (performance.now() - t0 > timeoutMs) {
          frame.remove();
          reject(new Error('index.html never finished its first refresh()'));
        } else setTimeout(poll, 50);
      };
      poll();
    };
    frame.onerror = () => { frame.remove(); reject(new Error('index.html failed to load')); };
  });
}

// ---------------------------------------------------------------------------

export async function run() {
  // A clean slate every time, or a previous run's cases make the counts wrong.
  await store.clearAll();
  await Backend.init('stub');

  const SESSION = '9001 TESTA Male d12';
  const entries = makeSession(SESSION);
  const expect = expectedGeometry();

  await check('gzip round-trips', async () => {
    const src = new Uint8Array(100000).map((_, i) => (i * 7) & 0xff);
    const back = await gunzip(await gzip(src));
    eq(back.length, src.length, 'length');
    for (let i = 0; i < src.length; i++) if (back[i] !== src[i]) throw new Error(`byte ${i}`);
  });

  await check('crc32 matches the known value for "123456789"', () => {
    eq(crc32(new TextEncoder().encode('123456789')), 0xcbf43926, 'crc32');
  });

  await check('sessions group by the folder above DICOM/', () => {
    const g = groupSessions(entries);
    eq(g.size, 1, 'session count');
    eq([...g.keys()][0], SESSION, 'session key');
  });

  await check('series discovery picks T2 axial by SequenceName, not description', async () => {
    const series = await findT2AxialSeries(entries);
    // Both series share SeriesDescription "MRI 'FSE26' Scan" and slice count,
    // so anything but SequenceName would return two, or the wrong one.
    eq(series.length, 1, 'T2 axial series found');
    eq(series[0].seriesLabel, '40004', 'series number');
  });

  let vol;
  await check('the volume has the right geometry', async () => {
    const series = await findT2AxialSeries(entries);
    ({ volume: vol } = await loadSeries(series[0].files));
    eq(vol.nx, expect.nx, 'nx'); eq(vol.ny, expect.ny, 'ny'); eq(vol.nz, expect.nz, 'nz');
    arrClose(vol.spacing, expect.spacing, 1e-9, 'spacing');
    arrClose(vol.origin, expect.origin, 1e-9, 'origin');
    arrClose(vol.direction, expect.direction, 1e-12, 'direction');
    close(vol.voxelVolumeMm3,
          expect.spacing[0] * expect.spacing[1] * expect.spacing[2], 1e-12, 'voxel volume');
  });

  await check('slices are ordered by position, not InstanceNumber', () => {
    // The fixture paints a gradient that increases with ascending z, and writes
    // InstanceNumber in the opposite direction. If the loader sorted by
    // InstanceNumber the stack would be upside down and this would decrease.
    const mean = (z) => {
      let s = 0;
      const off = z * vol.nx * vol.ny;
      for (let i = 0; i < vol.nx * vol.ny; i++) s += vol.data[off + i];
      return s / (vol.nx * vol.ny);
    };
    for (let z = 1; z < vol.nz; z++) {
      if (mean(z) <= mean(z - 1)) {
        throw new Error(`slice ${z} is not brighter than ${z - 1} — the stack is ` +
                        `z-flipped, which would put every mask at the wrong end`);
      }
    }
  });

  await check('rescale slope and intercept are applied exactly once', () => {
    // Voxel (0,0,0) of the fixture: the lowest-z slice is written last, so its
    // gradient base is zi = nz-1 ... the stored value is known exactly.
    const g = GEOMETRY;
    const stored = (200 + 0 * 3 + 0 * 2 + 0 * 40) & 0x0fff;  // zi = 0 at z index 0
    close(vol.data[0], stored * g.rescaleSlope + g.rescaleIntercept, 1e-3, 'voxel 0');
  });

  await check('NIfTI round-trips through gzip with the grid intact', async () => {
    const back = await readNifti(await writeNiftiGz(vol));
    const bad = back.sameGridAs(vol);
    if (bad.length) throw new Error(bad.join('; '));
    for (let i = 0; i < vol.data.length; i++) {
      if (back.data[i] !== vol.data[i]) throw new Error(`voxel ${i} changed`);
    }
  });

  await check('the NIfTI header is the one SimpleITK writes', () => {
    const nii = writeNifti(vol);
    const dv = new DataView(nii.buffer);
    eq(dv.getInt32(0, true), 348, 'sizeof_hdr');
    eq(dv.getInt16(40, true), 3, 'dim[0]');
    eq(dv.getInt16(42, true), vol.nx, 'dim[1]');
    eq(dv.getInt16(70, true), 16, 'datatype float32');
    eq(dv.getInt16(72, true), 32, 'bitpix');
    eq(Math.round(dv.getFloat32(108, true)), 352, 'vox_offset');
    eq(dv.getInt16(252, true), 1, 'qform_code');
    eq(dv.getInt16(254, true), 1, 'sform_code');
    eq(String.fromCharCode(...nii.subarray(344, 347)), 'n+1', 'magic');
    // LPS -> RAS: x and y negate, z does not. This is the flip that puts a mask
    // in the wrong place if it is missed.
    close(dv.getFloat32(280 + 12, true), -vol.origin[0], 1e-4, 'srow_x offset');
    close(dv.getFloat32(296 + 12, true), -vol.origin[1], 1e-4, 'srow_y offset');
    close(dv.getFloat32(312 + 12, true), vol.origin[2], 1e-4, 'srow_z offset');
  });

  await check('connected components are face-connected, matching SimpleITK', () => {
    const nx = 8, ny = 8, nz = 2;
    const m = new Uint8Array(nx * ny * nz);
    const at = (x, y, z) => (z * ny + y) * nx + x;
    m[at(1, 1, 0)] = 1;
    m[at(2, 2, 0)] = 1;          // touches the first only at a corner
    eq(connectedComponents(m, nx, ny, nz).sizes.length, 2,
       'corner-touching voxels must be two components');
    m[at(2, 1, 0)] = 1;          // now they share a face
    eq(connectedComponents(m, nx, ny, nz).sizes.length, 1, 'component count after joining');
  });

  await check('small components are dropped only above the threshold', () => {
    const nx = 10, ny = 10, nz = 1;
    const m = new Uint8Array(nx * ny * nz);
    for (let y = 1; y < 4; y++) for (let x = 1; x < 4; x++) m[y * nx + x] = 1;  // 9
    m[7 * nx + 7] = 1;                                                          // 1
    eq(removeSmallComponents(m, nx, ny, nz, 0).nComponents, 2, 'threshold 0 keeps both');
    const r = removeSmallComponents(m, nx, ny, nz, 2);
    eq(r.nComponents, 1, 'threshold 2 keeps one');
    eq(maskFacts(r.mask, nx, ny, nz).voxels, 9, 'voxels left');
  });

  await check('signed distance is zero on the boundary and negative inside', () => {
    const n = 9;
    const m = new Uint8Array(n * n);
    for (let y = 3; y < 6; y++) for (let x = 3; x < 6; x++) m[y * n + x] = 1;
    const d = signedDistance(m, n, n);
    close(d[4 * n + 4], -1, 1e-6, 'centre of a 3x3 square');
    close(d[3 * n + 4], 0, 1e-6, 'edge voxel');
    close(d[2 * n + 4], 1, 1e-6, 'one voxel outside');
    close(d[2 * n + 2], Math.SQRT2, 1e-6, 'diagonally outside');
  });

  await check('the stub is deterministic and content-derived', async () => {
    const p = new StubPredictor('varied');
    const a = await p.predict(vol);
    const b = await p.predict(vol);
    for (let i = 0; i < a.mask.data.length; i++) {
      if (a.mask.data[i] !== b.mask.data[i]) throw new Error(`voxel ${i} differs between runs`);
    }
    // Change one voxel and the fake tumour must move: that is what makes the
    // stub useful for catching a case-mix-up bug.
    const other = vol.withData(Float32Array.from(vol.data));
    other.data[0] += 1000;
    const c = await p.predict(other);
    let same = true;
    for (let i = 0; i < a.mask.data.length && same; i++) {
      if (a.mask.data[i] !== c.mask.data[i]) same = false;
    }
    if (same) throw new Error('changing the image did not change the stub output');
  });

  await check('the sphere stub lands where it says and has a soft edge', async () => {
    const { mask, prob } = await new StubPredictor('sphere').predict(vol);
    assertSameGrid(mask, vol, 'stub mask');
    const facts = maskFacts(mask.data, vol.nx, vol.ny, vol.nz);
    truthy(facts.voxels > 0, 'sphere stub produced a mask');
    let amb = 0;
    for (let i = 0; i < prob.data.length; i++) {
      if (prob.data[i] > 0.05 && prob.data[i] < 0.95) amb++;
    }
    truthy(amb > 0, 'probability map has an ambiguous band for the review score to find');
  });

  await check('an empty prediction is flagged rather than passed', () => {
    const m = new Uint8Array(vol.nx * vol.ny * vol.nz);
    const rs = reviewScore(m, null, 0, 0, vol.nx, vol.ny, vol.nz);
    eq(rs.signals.empty, true, 'empty signal');
    close(rs.score, 45, 1e-9, 'score for an empty prediction');
    truthy(rs.reasons[0].includes('missed small tumour'), 'reason mentions a missed tumour');
  });

  await check('a tumour on the last slice raises the coverage flag', () => {
    const m = new Uint8Array(vol.nx * vol.ny * vol.nz);
    const off = (vol.nz - 1) * vol.nx * vol.ny;
    for (let i = 0; i < 50; i++) m[off + i] = 1;
    const rs = reviewScore(m, null, 500, 1, vol.nx, vol.ny, vol.nz);
    eq(JSON.stringify(rs.signals.touches_edge_slice), '["last"]', 'edge signal');
    truthy(rs.score >= 35, 'score includes the coverage penalty');
  });

  await check('the QC montage renders to a PNG', async () => {
    const blob = await montage(vol, null, 'self-test');
    eq(blob.type, 'image/png', 'mime type');
    truthy(blob.size > 1000, 'PNG is not empty');
    const [lo, hi] = percentileWindow(vol.data);
    truthy(hi > lo, 'percentile window is non-degenerate');
  });

  // -------------------------------------------------------------------------
  // The pipeline, end to end
  // -------------------------------------------------------------------------

  let rec;
  await check('processSession stores a complete case', async () => {
    rec = await pipeline.processSession(SESSION, entries, getPredictor('stub:sphere'), {});
    eq(rec.case, SESSION, 'case name');
    eq(rec.series, '40004', 'series');
    eq(rec.n_slices, expect.nz, 'slice count');
    eq(rec.model, 'stub:sphere', 'model');
    eq(rec.model_is_real, false, 'model_is_real');
    eq(rec.edited, false, 'starts unedited');
    truthy(rec.tumor_present, 'sphere stub gives a tumour');
    close(rec.auto_volume_mm3, rec.auto_voxels * rec.voxel_volume_mm3, 1e-3,
          'volume equals voxels x voxel volume');
    for (const kind of ['image', 'auto_mask', 'mask', 'qc', 'workspace']) {
      truthy(await store.getFile(SESSION, kind), `stored ${kind}`);
    }
  });

  await check('the stored mask sits on the scan grid', async () => {
    const img = await readNifti(await store.getFile(SESSION, 'image'));
    const msk = await readNifti(await store.getFile(SESSION, 'mask'));
    const bad = msk.sameGridAs(img);
    if (bad.length) throw new Error(bad.join('; '));
    // The mask must be 0/1 only. ITK-SNAP will happily open anything, and a
    // stray value of 2 would silently become a second label.
    const seen = new Set(msk.data);
    for (const v of seen) if (v !== 0 && v !== 1) throw new Error(`mask contains ${v}`);
  });

  await check('re-running a hand-corrected case is refused, not silently redone', async () => {
    await Backend.reload();
    const before = Backend.STATE.cases.find((c) => c.case === SESSION);
    // Simulate an edit: flip some voxels in the working mask only.
    const img = await readNifti(await store.getFile(SESSION, 'image'));
    const msk = await readNifti(await store.getFile(SESSION, 'mask'));
    const edited = new Uint8Array(msk.data.length);
    for (let i = 0; i < edited.length; i++) edited[i] = msk.data[i] > 0 ? 1 : 0;
    let flipped = 0;
    for (let i = 0; i < edited.length && flipped < 40; i++) {
      if (!edited[i]) { edited[i] = 1; flipped++; }
    }
    await store.putFile(SESSION, 'mask', await writeNiftiGz(img.withData(edited)));
    await pipeline.refreshEdits([before]);
    eq(before.edited, true, 'edit detected');
    truthy(before.corrected_volume_mm3 > before.auto_volume_mm3,
           'corrected volume reflects the added voxels');
    truthy(before.corrected_at, 'corrected_at recorded');

    await throws(
      () => pipeline.processSession(SESSION, entries, getPredictor('stub:sphere'), {}),
      'corrected by hand', 're-running an edited case');

    // ...and the automated number is still there, unchanged. This is the whole
    // reason two masks are kept.
    eq(before.auto_volume_mm3, rec.auto_volume_mm3, 'automated volume untouched');
    eq(pipeline.finalVolume(before), before.corrected_volume_mm3, 'final volume uses the correction');
  });

  await check('revert restores the model mask and clears the edit', async () => {
    const c = Backend.STATE.cases.find((x) => x.case === SESSION);
    await pipeline.revertToAuto(c);
    eq(c.edited, false, 'edited cleared');
    eq(c.corrected_volume_mm3, null, 'corrected volume cleared');
    close(pipeline.finalVolume(c), c.auto_volume_mm3, 1e-9, 'final volume back to automated');
  });

  await check('editing through the backend writes whole slices', async () => {
    const { data: mask, meta } = await Backend.maskRaw(SESSION);
    const z = 1;
    const slice = new Uint8Array(meta.nx * meta.ny);
    for (let i = 0; i < 25; i++) slice[i] = 1;
    const before = mask.reduce((a, b) => a + (b ? 1 : 0), 0);
    let inSlice = 0;
    for (let i = 0; i < slice.length; i++) if (mask[z * slice.length + i]) inSlice++;

    const r = await Backend.saveMaskSlices(SESSION, { [z]: slice });
    eq(r.n_slices_written, 1, 'slices written');
    const after = await Backend.maskRaw(SESSION);
    const total = after.data.reduce((a, b) => a + (b ? 1 : 0), 0);
    eq(total, before - inSlice + 25, 'voxel count after replacing one slice');
    eq(r.edited, true, 'marked as edited');
  });

  await check('interpolation fills the slices between two drawn ones', async () => {
    const { meta } = await Backend.maskRaw(SESSION);
    const n = meta.nx * meta.ny;
    const disc = (cx, cy, r) => {
      const s = new Uint8Array(n);
      for (let y = 0; y < meta.ny; y++) {
        for (let x = 0; x < meta.nx; x++) {
          if (Math.hypot(x - cx, y - cy) <= r) s[y * meta.nx + x] = 1;
        }
      }
      return s;
    };
    const blank = new Uint8Array(n);
    const slices = {};
    for (let z = 0; z < meta.nz; z++) slices[z] = blank;
    slices[0] = disc(20, 20, 8);
    slices[3] = disc(24, 22, 6);
    await Backend.saveMaskSlices(SESSION, slices);

    const r = await Backend.interpolate(SESSION, 0, 3);
    eq(JSON.stringify(r.filled), '[1,2]', 'filled slices');
    const after = await Backend.maskRaw(SESSION);
    for (const z of [1, 2]) {
      let count = 0;
      for (let i = 0; i < n; i++) if (after.data[z * n + i]) count++;
      truthy(count > 50, `slice ${z} was filled (got ${count} voxels)`);
    }
  });

  await check('interpolation refuses disjoint shapes instead of writing nothing', async () => {
    const { meta } = await Backend.maskRaw(SESSION);
    const n = meta.nx * meta.ny;
    const dot = (cx, cy) => {
      const s = new Uint8Array(n);
      for (let y = cy - 2; y <= cy + 2; y++) {
        for (let x = cx - 2; x <= cx + 2; x++) s[y * meta.nx + x] = 1;
      }
      return s;
    };
    const blank = new Uint8Array(n);
    const slices = {};
    for (let z = 0; z < meta.nz; z++) slices[z] = blank;
    slices[0] = dot(6, 6);
    slices[4] = dot(meta.nx - 7, meta.ny - 7);   // nowhere near the first
    await Backend.saveMaskSlices(SESSION, slices);
    await throws(() => Backend.interpolate(SESSION, 0, 4), 'collapsed',
                 'interpolating disjoint shapes');
  });

  await check('adjacent slices are refused with a useful message', async () => {
    await throws(() => Backend.interpolate(SESSION, 2, 3), 'adjacent',
                 'interpolating adjacent slices');
  });

  await check('importing a mask on the wrong grid is refused', async () => {
    const c = Backend.STATE.cases.find((x) => x.case === SESSION);
    const wrong = await readNifti(await store.getFile(SESSION, 'image'));
    const shifted = new (wrong.constructor)({
      nx: wrong.nx, ny: wrong.ny, nz: wrong.nz,
      spacing: wrong.spacing,
      origin: [wrong.origin[0], wrong.origin[1], wrong.origin[2] + 5],
      direction: wrong.direction,
      data: new Uint8Array(wrong.data.length),
    });
    const bytes = await writeNiftiGz(shifted);
    await throws(() => pipeline.importCorrectedMask(c, bytes),
                 'grid mismatch', 'importing a shifted mask');
  });

  await check('re-importing an identical mask changes nothing', async () => {
    const c = Backend.STATE.cases.find((x) => x.case === SESSION);
    const current = await store.getFile(SESSION, 'mask');
    const before = { at: c.corrected_at, vol: c.corrected_volume_mm3, edited: c.edited };
    const r = await pipeline.importCorrectedMask(c, current, { when: Date.now() + 60000 });
    eq(r.changed, false, 'reported as unchanged');
    // The whole point: corrected_at must NOT move. The shared folder is re-read
    // in full on every check, so a bump here would rewrite the timestamp on
    // every scan nobody touched.
    eq(c.corrected_at, before.at, 'corrected_at unchanged');
    eq(c.corrected_volume_mm3, before.vol, 'corrected volume unchanged');
    eq(c.edited, before.edited, 'edited flag unchanged');
  });

  await check('an imported mask records the time the edit was made', async () => {
    const c = Backend.STATE.cases.find((x) => x.case === SESSION);
    const img = await readNifti(await store.getFile(SESSION, 'image'));
    const msk = await readNifti(await store.getFile(SESSION, 'mask'));
    const flipped = new Uint8Array(msk.data.length);
    for (let i = 0; i < flipped.length; i++) flipped[i] = msk.data[i] > 0 ? 1 : 0;
    for (let i = 0; i < 30; i++) flipped[i] = flipped[i] ? 0 : 1;
    const when = Date.UTC(2026, 0, 2, 3, 4, 5);
    const r = await pipeline.importCorrectedMask(c, await writeNiftiGz(img.withData(flipped)),
                                                 { when });
    eq(r.changed, true, 'reported as changed');
    eq(c.corrected_at, '2026-01-02T03:04:05', 'corrected_at came from the file, not now');
  });

  await check('the storage lifetime is stated, not left vague', async () => {
    const s = Backend.state().storage;
    truthy(s.policy, 'a policy was worked out');
    truthy(['ok', 'warn'].includes(s.policy.level), 'level is ok or warn');
    truthy(s.policy.lifetime && s.policy.lifetime.length > 5,
           `lifetime reads as a duration (got ${JSON.stringify(s.policy.lifetime)})`);
    // Safari's seven-day rule is the one that actually catches people out, so
    // check it is reachable rather than only ever reporting the happy answer.
    const safari = store.storagePolicy(true);
    const isSafariHere = /^((?!chrome|chromium|android|crios|fxios|edg).)*safari/i
      .test(navigator.userAgent);
    if (isSafariHere) {
      eq(safari.level, 'warn', 'Safari warns even when persistence is granted');
      truthy(safari.note.includes('seven days'), 'Safari note names the limit');
    } else {
      eq(safari.level, 'ok', 'a granted non-Safari browser is not warned at');
      eq(store.storagePolicy(false).level, 'warn', 'a refusal is warned at');
    }
  });

  await check('the folder API reports honestly on this browser', async () => {
    const s = await Backend.folderStatus();
    eq(typeof s.supported, 'boolean', 'supported is a boolean');
    eq(s.linked, false, 'nothing is linked in a fresh profile');
    if (!s.supported) {
      // Firefox and Safari land here, and must still be able to do the round
      // trip through a zip -- which the export tests below cover.
      await throws(() => Backend.exportToFolder(), 'no folder',
                   'exporting with no folder support');
    }
  });

  await check('a second scan is kept separately and both export', async () => {
    const other = makeSession('9002 TESTB Female d15');
    await Backend.run(other, {});
    eq(Backend.STATE.cases.length, 2, 'case count');

    const csv = pipeline.volumesCsv(Backend.STATE.cases);
    const lines = csv.trim().split('\n');
    eq(lines.length, 3, 'csv rows including the header');
    truthy(lines[0].startsWith('case,mouse_from_dicom,'), 'csv header');
    truthy(csv.includes('9002 TESTB Female d15'), 'second case is in the csv');
    truthy(lines[0].includes('auto_volume_mm3') && lines[0].includes('corrected_volume_mm3')
           && lines[0].includes('final_volume_mm3'),
           'automated and corrected volumes are separate columns');
  });

  await check('the bundle zip is well formed and holds every file', async () => {
    const blob = await Backend.bundleBlob();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const dv = new DataView(bytes.buffer);
    eq(dv.getUint32(0, true), 0x04034b50, 'local header signature');
    // Find the end-of-central-directory record and read the entry count.
    let eocd = -1;
    for (let i = bytes.length - 22; i >= 0; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    truthy(eocd >= 0, 'end of central directory found');
    const n = dv.getUint16(eocd + 10, true);
    // 4 top-level files + 5 per case x 2 cases.
    eq(n, 4 + 5 * 2, 'entries in the zip');
  });

  await check('results survive a reload of the page', async () => {
    // A fresh Backend.init is what a page reload does: nothing in memory, read
    // it all back from IndexedDB.
    Backend.STATE.cases = [];
    await Backend.init('stub');
    eq(Backend.STATE.cases.length, 2, 'cases restored from storage');
    const c = Backend.STATE.cases.find((x) => x.case === SESSION);
    truthy(c.review, 'review score survived');
    truthy((await Backend.volumeRaw(SESSION)).data.length > 0, 'volume readable after reload');
  });

  await check('a session with no T2 axial series fails clearly', async () => {
    const coronalOnly = makeSession('9003 TESTC Male d12',
      { series: [{ number: 40003, sequenceName: 'T2w FSE (cor,n)' }] });
    await throws(
      () => pipeline.processSession('9003 TESTC Male d12', coronalOnly, getPredictor('stub'), {}),
      'T2w axial', 'a session with only a coronal series');
  });

  await check('a truncated DICOM file is reported, not half-read', async () => {
    const [first] = makeSession('9004 TESTD Male d12');
    const full = new Uint8Array(await first.file.arrayBuffer());
    const cut = full.subarray(0, Math.floor(full.length * 0.6));
    const broken = [{ file: new File([cut], 'x.dcm'), path: '9004/DICOM/40004/1/x.dcm' }];
    await throws(() => loadSeries(broken), 'truncated', 'a truncated file');
  });

  // -------------------------------------------------------------------------
  // The real page
  // -------------------------------------------------------------------------
  // Everything above tests the modules. This tests app.js -- the ~1,900 lines of
  // viewer and editor that were ported by swapping their transport layer. A
  // typo in any of the rewritten call sites shows up only at runtime, so the
  // actual index.html is loaded in an iframe and inspected. Same origin, so the
  // iframe's document and its errors are both reachable.

  await check('index.html boots without a script error', async () => {
    const { frame, errors } = await loadApp();
    try {
      if (errors.length) throw new Error(errors.join(' | '));
      const doc = frame.contentDocument;
      truthy(doc.getElementById('list'), 'the case list exists');
      // Two cases are stored at this point, so the app must be showing the
      // review view rather than the empty-state setup card.
      eq(doc.getElementById('main').style.display, 'grid', 'main view is shown');
      eq(doc.getElementById('setup').style.display, 'none', 'setup card is hidden');
      const rows = doc.querySelectorAll('#list .case, #list .item, #list > div');
      truthy(rows.length >= 2, `the list rendered rows (found ${rows.length})`);
      truthy(doc.getElementById('hdrMeta').textContent.includes('2 scans'),
             'the header counts both scans');
      truthy(doc.getElementById('outDirLabel').textContent.includes('this browser'),
             'the storage label says where results live');
    } finally {
      frame.remove();
    }
  });

  /**
   * The banner has to track which model is actually running.
   *
   * This used to assert only that the banner was visible, because the stub was
   * the only thing there was. Now a build can ship with real weights, and the
   * check that matters is the pairing: synthetic masks must be labelled, and
   * real ones must not be -- a banner crying "STUB" over genuine predictions
   * teaches people to ignore it, which costs more than having no banner at all.
   */
  await check('the banner says stub only when the model really is a stub', async () => {
    const { frame, errors } = await loadApp();
    try {
      if (errors.length) throw new Error(errors.join(' | '));
      const doc = frame.contentDocument;
      const banner = doc.getElementById('stubBanner');
      const card = doc.getElementById('modelState');

      // Starting a model session takes a moment — fetching tens of megabytes
      // and letting the runtime build its graph — so the card is briefly
      // "loading". Wait for it to settle rather than read it mid-flight.
      const t0 = performance.now();
      while (card.dataset.state === 'loading' && performance.now() - t0 < 120000) {
        await new Promise((r) => setTimeout(r, 100));
      }
      const real = card.dataset.state === 'loaded';

      // Without this the check is vacuous: both branches pass, so a build where
      // the model silently failed to start would look identical to one that was
      // published without weights on purpose. If a model IS being served, it
      // has to have loaded.
      const onnx = await import('../lib/onnx.js');
      const index = await onnx.servedModelIndex('../model/');
      if (index) {
        eq(card.dataset.state, 'loaded',
           `${index.models.length} model(s) are served at model/ (default ` +
           `${index.default}) so one must load; the card says ` +
           `"${card.textContent.trim().slice(0, 120)}"`);
      }

      if (real) {
        eq(banner.style.display, 'none',
           'banner hidden while a trained model is loaded');
        truthy(doc.getElementById('modelState').textContent
                  .includes('Trained model loaded'),
               'the model card says a trained model is loaded');
      } else {
        eq(banner.style.display, 'block', 'stub banner visible');
        truthy(banner.textContent.includes('STUB MODEL'), 'banner text');
        truthy(banner.textContent.includes('Do not record these volumes'),
               'banner says not to record the volumes');
      }
    } finally {
      frame.remove();
    }
  });

  /**
   * The adapter between the app and the model, end to end.
   *
   * The dedicated parity test drives `OnnxModel.segment` directly against real
   * scans; what it does not touch is `OnnxPredictor`, which is what the app
   * actually calls -- and that is where the outputs get wrapped back onto the
   * scan's grid. Getting that wrong would put a correctly-computed mask on the
   * wrong geometry, which is the expensive kind of bug.
   *
   * The mask itself is meaningless here: the fixture is a synthetic gradient,
   * not anatomy. Shapes, grid and value range are the point.
   */
  /**
   * `modelReady()` must cover the WHOLE load, index fetch included.
   *
   * It did not. `STATE.modelReady` was assigned part-way through
   * `autoloadModel`, after the index had been fetched, so a caller that asked
   * before that assignment got nothing to wait on and carried on as if there
   * were no model. The app renders its model card on exactly that promise, so
   * losing the race meant a permanent "no trained model is loaded" on a page
   * that was in fact about to load one. Whether it lost depended on how quickly
   * IndexedDB opened, which is why it looked intermittent.
   */
  await check('modelReady() covers the whole load, index fetch included', async () => {
    const onnx = await import('../lib/onnx.js');
    if (!await onnx.servedModelIndex('../model/')) return;   // no weights published
    const p = Backend.autoloadModel();
    truthy(Backend.STATE.modelReady,
           'STATE.modelReady must be set synchronously, before the first await');
    await p;
    await Backend.modelReady();
    truthy(Backend.state().model_info,
           'once modelReady() resolves, a served model must actually be loaded');
  });

  await check('the trained model returns mask and probability on the scan grid',
    async () => {
      const onnx = await import('../lib/onnx.js');
      const index = await onnx.servedModelIndex('../model/');
      if (!index) return;                   // published without weights: nothing to check
      if (!await onnx.activeModel()) {
        const entry = index.models.find((m) => m.id === index.default);
        const base = `../model/${entry.path}`;
        const mf = await onnx.servedModelManifest(base);
        await onnx.setActiveBundle(await onnx.fetchBundle(mf, base), entry.id);
      }
      const pred = getPredictor('onnx');
      truthy(pred.isReal, 'the ONNX predictor reports itself as a real model');
      const { mask, prob } = await pred.predict(vol);

      eq(mask.nx, vol.nx, 'mask nx'); eq(mask.ny, vol.ny, 'mask ny');
      eq(mask.nz, vol.nz, 'mask nz');
      arrClose(mask.spacing, vol.spacing, 1e-12, 'mask spacing');
      arrClose(mask.origin, vol.origin, 1e-12, 'mask origin');
      arrClose(mask.direction, vol.direction, 1e-12, 'mask direction');
      eq(mask.data.length, vol.length, 'mask voxel count');
      eq(prob.data.length, vol.length, 'probability voxel count');

      for (let i = 0; i < mask.data.length; i++) {
        if (mask.data[i] !== 0 && mask.data[i] !== 1) {
          throw new Error(`mask voxel ${i} is ${mask.data[i]}, expected 0 or 1`);
        }
        if (!(prob.data[i] >= 0 && prob.data[i] <= 1)) {
          throw new Error(`probability voxel ${i} is ${prob.data[i]}, outside [0,1]`);
        }
      }
      // The label must be the argmax of the two logits, which for two classes
      // is the same as thresholding the softmax at a half. If these ever
      // disagree the two are being derived from different things.
      for (let i = 0; i < mask.data.length; i++) {
        if (mask.data[i] !== (prob.data[i] > 0.5 ? 1 : 0) && prob.data[i] !== 0.5) {
          throw new Error(`voxel ${i}: label ${mask.data[i]} disagrees with ` +
                          `probability ${prob.data[i]}`);
        }
      }
    });

  /**
   * Sliding-window origins, against values taken from the training framework.
   *
   * These are the shapes where `Math.round` gives the WRONG answer. The
   * framework rounds half to even; JavaScript rounds half up; and a step that
   * lands exactly on .5 is common, not exotic — across a sweep of 2,715
   * (size, patch) pairs, 516 of them diverge. Each divergence shifts a whole
   * window by one voxel, which produces a plausible mask that is quietly wrong
   * near the seam.
   *
   * The study this was built for happens to have integer steps, so none of
   * this bites there. It is here so that the next dataset does not have to
   * find out.
   */
  await check('sliding-window origins round half to even, not half up', async () => {
    const { windowStarts } = await import('../lib/onnx.js');
    const table = [
      // [size, patch, expected] -- verified against compute_steps_for_sliding_window
      [13, 8, [0, 2, 5]],                 // Math.round: [0, 3, 5]
      [21, 8, [0, 3, 6, 10, 13]],         //             [0, 3, 7, 10, 13]
      [22, 8, [0, 4, 7, 10, 14]],         //             [0, 4, 7, 11, 14]
      [29, 8, [0, 4, 7, 10, 14, 18, 21]], //             [0, 4, 7, 11, 14, 18, 21]
      // and the shapes this project actually sees, where the steps are integers
      [18, 20, null], [20, 20, [0]], [22, 20, [0, 2]], [24, 20, [0, 4]],
      [26, 20, [0, 6]], [30, 20, [0, 10]], [256, 256, [0]],
    ];
    for (const [size, patch, want] of table) {
      if (want === null) {          // shorter than the patch: must refuse, not guess
        let threw = false;
        try { windowStarts(size, patch, 0.5); } catch { threw = true; }
        truthy(threw, `windowStarts(${size}, ${patch}) must refuse an unpadded axis`);
        continue;
      }
      const got = windowStarts(size, patch, 0.5);
      eq(got.join(','), want.join(','), `windowStarts(${size}, ${patch}, 0.5)`);
    }
  });

  await check('a model bundle is rejected if its weights do not match the manifest',
    async () => {
      const onnx = await import('../lib/onnx.js');
      const bytes = new Uint8Array(64).fill(7);
      const manifest = {
        version: 'x', graph: 'model.onnx', weights_path: 'w.data',
        weights_bytes: 64, shards: [{ name: 'weights-000.bin', bytes: 64 }],
        // Deliberately not the digest of `bytes`.
        weights_sha256: '0'.repeat(64),
      };
      const files = [
        new File([JSON.stringify(manifest)], 'manifest.json'),
        new File([new Uint8Array(8)], 'model.onnx'),
        new File([bytes], 'weights-000.bin'),
      ];
      await throws(() => onnx.bundleFromFiles(files), 'checksum',
                   'a corrupted download must not be loaded as a model');
    });

  await check('a model folder missing a shard is refused by name', async () => {
    const onnx = await import('../lib/onnx.js');
    const manifest = {
      version: 'x', graph: 'model.onnx', weights_path: 'w.data',
      weights_bytes: 64,
      shards: [{ name: 'weights-000.bin', bytes: 32 },
               { name: 'weights-001.bin', bytes: 32 }],
      weights_sha256: '0'.repeat(64),
    };
    const files = [
      new File([JSON.stringify(manifest)], 'manifest.json'),
      new File([new Uint8Array(8)], 'model.onnx'),
      new File([new Uint8Array(32)], 'weights-000.bin'),
    ];
    await throws(() => onnx.bundleFromFiles(files), 'weights-001.bin',
                 'the missing shard is named, not just "failed"');
  });

  await check('cleanup leaves no cases behind', async () => {
    await Backend.clearWorkspace();
    eq((await store.allCases()).length, 0, 'cases after clearing');
  });

  render();
  return { passed: results.length - failures, failed: failures };
}

/**
 * Post the results back, so run_selftest.py can print them and set an exit
 * code. Only fires when the page was opened with `?report`, which is what the
 * runner does -- opening the page by hand stays a purely local affair.
 */
async function report() {
  if (!new URLSearchParams(location.search).has('report')) return;
  try {
    await fetch('/__selftest_result', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userAgent: navigator.userAgent,
        passed: results.length - failures,
        failed: failures,
        results,
      }),
    });
  } catch { /* the runner may already have gone; the page is still readable */ }
}

run()
  .catch((e) => {
    failures++;
    results.push({ name: 'the test harness itself', ok: false, ms: 0,
                   error: e.message, stack: e.stack });
    render();
  })
  .finally(report);
