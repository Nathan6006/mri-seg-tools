/**
 * Running the trained model in the browser tab.
 *
 * The network runs as ONNX under onnxruntime-web. Everything around it --
 * normalisation, padding, test-time mirroring, argmax -- is here in readable
 * JavaScript rather than baked into the graph, because that wrapper is where
 * the mistakes live. A wrong normalisation or an off-by-four pad produces a
 * confident, plausible mask in slightly the wrong place, which is the one
 * failure mode nobody catches by looking.
 *
 * So the wrapper is specified twice: once here, and once in the project's
 * `verify_onnx.py`, which runs the identical steps in numpy and checks the
 * masks against the ones the training framework produced itself. The browser
 * self-test then checks this file against fixtures derived from that. If the
 * two implementations ever disagree, one of them is wrong and the test says so.
 *
 * WHAT THE PREPROCESSING IS, AND WHY IT IS THIS SHORT
 * ---------------------------------------------------
 * A segmentation framework normally preprocesses with crop -> resample ->
 * normalise, and reimplementing its resampler faithfully would be a project in
 * itself. Two properties of this dataset remove the need, and both are checked
 * by the exporter before it will write a model at all:
 *
 *   - every image is already at the configuration's target spacing, so
 *     resampling is the identity;
 *   - cropping to the non-zero region never crops, because MRI background is
 *     noise rather than exact zero.
 *
 * `manifest.json` records `resample: false` and `crop_to_nonzero: false`. If a
 * future model is exported without those, `assertCompatible` refuses to run it
 * rather than quietly segmenting a differently-shaped image.
 *
 * What remains is:
 *
 *   2D model:  z-score the whole volume -> centre-pad each slice to the patch
 *              -> network -> average logits over 4 mirrorings -> softmax ->
 *              argmax -> crop the padding back off
 *
 *   3D model:  z-score the whole volume -> centre-pad the volume to at least
 *              the patch -> for each sliding window: network, average logits
 *              over 8 mirrorings, accumulate weighted by a Gaussian ->
 *              divide by the accumulated weight -> argmax -> crop back
 *
 * The 3D path has two extra pieces, and neither is invented here:
 *
 *   - The sliding window. Almost every scan in a study like this is shorter
 *     than the patch in the through-plane direction, so there is one window and
 *     the whole mechanism collapses to "run the network once". It exists for
 *     the occasional scan acquired with extended coverage, and the window
 *     origins are computed with the same arithmetic the training framework uses
 *     (including its round-half-to-even, which JavaScript's Math.round is not).
 *
 *   - The Gaussian importance map, which weights a window's centre above its
 *     edges where windows overlap. The framework builds it by filtering a delta,
 *     which is exactly separable, so the exporter ships three 1-D vectors and
 *     this file takes their outer product. With a single window it cancels out
 *     of the division entirely.
 */

import * as store from './store.js';

const ORT_DIR = new URL('../vendor/', import.meta.url).href;
const ORT_MODULE = `${ORT_DIR}ort.webgpu.bundle.min.mjs`;

let _ort = null;

/** Load onnxruntime-web once, and point it at the vendored wasm. */
async function ort() {
  if (_ort) return _ort;
  const mod = await import(/* @vite-ignore */ ORT_MODULE);
  const o = mod.default ?? mod;

  // Everything is served from this origin. The runtime would otherwise reach
  // for a CDN, which the page's connect-src forbids -- and rightly: the whole
  // privacy claim is that the tab talks to nobody.
  o.env.wasm.wasmPaths = ORT_DIR;

  // Multi-threading needs SharedArrayBuffer, which needs the page to be
  // cross-origin isolated (COOP + COEP). When it is not -- opening index.html
  // straight off the filesystem, say -- ORT must be told to use one thread, or
  // it spawns workers that immediately fail.
  const isolated = typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated;
  o.env.wasm.numThreads = isolated
    ? Math.max(1, Math.min(4, navigator.hardwareConcurrency || 1))
    : 1;
  o.env.wasm.simd = true;
  o.env.logLevel = 'error';

  _ort = o;
  return o;
}

/** Is WebGPU actually usable, or only present as an object? */
async function webgpuUsable() {
  if (!navigator.gpu) return false;
  try {
    return !!(await navigator.gpu.requestAdapter());
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Getting the weights into the tab
// ---------------------------------------------------------------------------

// One cache entry per model, because more than one can be served and switching
// between them should not mean re-downloading the one you just left.
const cacheKey = (id) => `model.bundle.${id || 'default'}`;

async function sha256Hex(bytes) {
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Which models are served alongside the page, and which is the default?
 *
 * The weights are a derivative of whatever imaging the model was trained on, so
 * whether they are published with the site is a decision for whoever owns the
 * data. The tool therefore supports both: served from `model/` if it is there,
 * or handed over from a local folder by the user. This is how it finds out.
 *
 * A deployment can serve several models — a 2D and a 3D network usually differ
 * more in *how* they fail than in how well they score, so being able to switch
 * is worth more than picking a winner. Older deployments served exactly one, as
 * a bare `model/manifest.json`; that layout is still understood and appears as
 * a single unnamed entry.
 */
export async function servedModelIndex(base = './model/') {
  try {
    const res = await fetch(`${base}models.json`, { cache: 'no-cache' });
    if (res.ok) {
      const idx = await res.json();
      if (idx && Array.isArray(idx.models) && idx.models.length) {
        const ids = idx.models.map((m) => m.id);
        return {
          default: ids.includes(idx.default) ? idx.default : ids[0],
          models: idx.models.map((m) => ({ ...m, path: m.path || `${m.id}/` })),
        };
      }
    }
  } catch { /* fall through to the single-model layout */ }

  const one = await servedModelManifest(base);
  if (!one) return null;
  return { default: 'model', models: [{ id: 'model', path: '', label: 'Trained model' }] };
}

/** The manifest for one served model, or null if there is not one there. */
export async function servedModelManifest(base = './model/') {
  try {
    const res = await fetch(`${base}manifest.json`, { cache: 'no-cache' });
    if (!res.ok) return null;
    const m = await res.json();
    return m && m.shards ? m : null;
  } catch {
    return null;
  }
}

function joinShards(parts, total) {
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  if (at !== total) {
    throw new Error(`weights are ${at} bytes but the manifest says ${total} -- ` +
                    `a shard is missing or truncated`);
  }
  return out;
}

/**
 * Fetch the graph and the weight shards, verify, and cache.
 *
 * The weights are split because static hosts cap individual files (Pages at
 * 25 MB) and the weights are larger than that. The split is on raw bytes with
 * no framing, so joining the shards in order must reproduce the file exactly --
 * which is worth checking rather than assuming, since a half-written shard
 * would otherwise surface as a baffling model-load error.
 */
export async function fetchBundle(manifest, base = './model/', onProgress = null) {
  const graph = new Uint8Array(await (await fetch(`${base}${manifest.graph}`)).arrayBuffer());

  // The shards are fetched CONCURRENTLY and read as streams. Both matter, for
  // different reasons. One-at-a-time left the connection idle for a round trip
  // between every 20 MB piece, which on a home connection is most of a minute
  // of not downloading; a browser will happily run six requests at once and
  // HTTP/2 multiplexes them over the one connection anyway. Streaming is what
  // makes the progress readout move continuously rather than jumping in five
  // steps -- and a progress bar that sits still for twenty seconds is
  // indistinguishable, to the person waiting, from one that has hung.
  let done = 0;
  const tick = () => { if (onProgress) onProgress(done, manifest.weights_bytes); };
  tick();

  const parts = await Promise.all(manifest.shards.map(async (s) => {
    const res = await fetch(`${base}${s.name}`);
    if (!res.ok) throw new Error(`cannot fetch ${s.name}: HTTP ${res.status}`);
    if (!res.body) {                       // no streams: fall back to the whole body
      const buf = new Uint8Array(await res.arrayBuffer());
      done += buf.length;
      tick();
      return buf;
    }
    const out = new Uint8Array(s.bytes);
    const reader = res.body.getReader();
    let at = 0;
    for (;;) {
      const { value, done: end } = await reader.read();
      if (end) break;
      // A shard longer than the manifest says means the files and the manifest
      // disagree; joinShards would catch it later, but not before writing past
      // the end of this buffer.
      if (at + value.length > out.length) {
        throw new Error(`${s.name} is longer than the manifest says (${s.bytes} bytes)`);
      }
      out.set(value, at);
      at += value.length;
      done += value.length;
      tick();
    }
    return out.subarray(0, at);
  }));

  const weights = joinShards(parts, manifest.weights_bytes);
  const digest = await sha256Hex(weights);
  if (digest !== manifest.weights_sha256) {
    throw new Error(`downloaded weights do not match the manifest checksum ` +
                    `(${digest.slice(0, 16)} vs ${manifest.weights_sha256.slice(0, 16)}). ` +
                    `The download was corrupted or the files are mismatched.`);
  }
  return { manifest, graph, weights };
}

/** The same bundle, but from files the user picked off their own disk. */
export async function bundleFromFiles(fileList) {
  const byName = new Map();
  for (const f of fileList) byName.set(f.name, f);
  const mf = byName.get('manifest.json');
  if (!mf) {
    throw new Error('no manifest.json among the selected files -- pick the ' +
                    'whole model folder, not just the weights');
  }
  const manifest = JSON.parse(await mf.text());
  const need = [manifest.graph, ...manifest.shards.map((s) => s.name)];
  const missing = need.filter((n) => !byName.has(n));
  if (missing.length) throw new Error(`model folder is missing: ${missing.join(', ')}`);

  const graph = new Uint8Array(await byName.get(manifest.graph).arrayBuffer());
  const parts = [];
  for (const s of manifest.shards) {
    parts.push(new Uint8Array(await byName.get(s.name).arrayBuffer()));
  }
  const weights = joinShards(parts, manifest.weights_bytes);
  const digest = await sha256Hex(weights);
  if (digest !== manifest.weights_sha256) {
    throw new Error('the selected weight files do not match their manifest checksum');
  }
  return { manifest, graph, weights };
}

export async function cachedBundle(id = null) {
  const rec = await store.getKV(cacheKey(id), null);
  if (!rec || !rec.manifest || !rec.graph || !rec.weights) return null;
  return rec;
}

export async function cacheBundle(bundle, id = null) {
  // Tens of megabytes of weights in one IndexedDB value. Storing them as one
  // blob rather than per-shard keeps the read path a single get, and the
  // download is the slow part anyway.
  await store.setKV(cacheKey(id), bundle);
}

export async function clearCachedBundle(id = null) {
  await store.setKV(cacheKey(id), null);
}

/** Drop every cached model, whichever ids happen to be present. */
export async function clearAllCachedBundles(ids = []) {
  const all = new Set([null, 'model', ...ids]);
  for (const id of all) await store.setKV(cacheKey(id), null);
}

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

/**
 * numpy's `round`, which is half-to-even, not JavaScript's half-up.
 *
 * The window origins are `round(step * i)` and a half-integer step is entirely
 * possible, so the two rules can disagree by one voxel — which would shift a
 * whole window. Everything else here is integer arithmetic; this is the one
 * place the difference can bite.
 */
function rint(v) {
  const f = Math.floor(v);
  const d = v - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/**
 * Every subset of the allowed mirror axes, as [flipZ, flipY, flipX].
 *
 * This is what `itertools.combinations` over the axes enumerates: 8 passes for
 * axes (0,1,2), 4 for (0,1), and exactly one — the identity — when mirroring is
 * off. Order does not matter because the results are summed.
 */
function mirrorFlags(mirrorAxes) {
  const axes = [0, 1, 2].filter((a) => mirrorAxes.includes(a));
  const out = [];
  for (let m = 0; m < (1 << axes.length); m++) {
    const f = [false, false, false];
    axes.forEach((a, i) => { if (m & (1 << i)) f[a] = true; });
    out.push(f);
  }
  return out;
}

/** Window origins along one axis — `compute_steps_for_sliding_window`. */
export function windowStarts(size, patch, stepSize) {
  if (size < patch) throw new Error(`axis of ${size} is smaller than the patch ${patch}; pad first`);
  const target = patch * stepSize;
  const n = Math.ceil((size - patch) / target) + 1;
  if (n <= 1) return [0];
  const actual = (size - patch) / (n - 1);
  const out = [];
  for (let i = 0; i < n; i++) out.push(rint(actual * i));
  return out;
}

function assertCompatible(meta) {
  if (meta.resample) {
    throw new Error('this model expects resampling to its own spacing, which ' +
                    'the browser predictor does not do. Export a model whose ' +
                    'target spacing matches the data, or add resampling here.');
  }
  if (meta.crop_to_nonzero) {
    throw new Error('this model expects cropping to the non-zero region, which ' +
                    'the browser predictor does not do.');
  }
  if (meta.normalization !== 'zscore_whole_volume') {
    throw new Error(`unsupported normalisation ${JSON.stringify(meta.normalization)}`);
  }
  if (meta.num_classes !== 2) {
    throw new Error(`this tool handles one foreground label; the model has ` +
                    `${meta.num_classes} classes`);
  }
  const dim = meta.dim || 2;
  if (dim !== 2 && dim !== 3) {
    throw new Error(`unsupported model dimensionality ${dim}`);
  }
  if ((meta.patch_size || []).length !== dim) {
    throw new Error(`a ${dim}D model should have a ${dim}-element patch size, ` +
                    `got ${JSON.stringify(meta.patch_size)}`);
  }
  if (dim === 3) {
    // Without these the sliding window would silently run unweighted, which is
    // correct for one window and wrong for two — the worst kind of bug, since
    // it would pass on 97% of scans.
    if (!Array.isArray(meta.gaussian_1d) || meta.gaussian_1d.length !== 3) {
      throw new Error('3D model is missing its gaussian_1d vectors; re-export it');
    }
    meta.gaussian_1d.forEach((v, i) => {
      if (v.length !== meta.patch_size[i]) {
        throw new Error(`gaussian_1d[${i}] has ${v.length} entries but the patch ` +
                        `axis is ${meta.patch_size[i]}`);
      }
    });
    if (!(meta.tile_step_size > 0 && meta.tile_step_size <= 1)) {
      throw new Error(`tile_step_size ${meta.tile_step_size} is not in (0, 1]`);
    }
  }
}

export class OnnxModel {
  constructor(bundle) {
    this.bundle = bundle;
    this.manifest = bundle.manifest;
    this.meta = bundle.manifest.model;
    this.session = null;
    this.backend = null;
  }

  /**
   * Build the inference session, choosing a backend.
   *
   * NOTHING IS PUSHED THROUGH THE SESSION HERE, and that is a correction of an
   * earlier design. There used to be a probe -- one empty patch through a
   * throwaway session -- because a WebGPU session builds happily and then fails
   * inside a kernel it does not implement, so without it the model appeared to
   * load and the first real scan threw.
   *
   * The probe itself corrupts the backend. Measured, repeatably: with the probe
   * enabled, a 2D model on WebGPU returned an EMPTY MASK on two scans whose
   * lesions are 48 and 36 voxels; with the probe skipped the same scans came back
   * voxel-for-voxel exact. Giving the probe its own throwaway session was
   * supposed to have fixed that and does not -- whatever state it leaves behind
   * outlives the session object. A diagnostic that silently blanks the output it
   * is diagnosing is worse than the failure it was added to catch, because an
   * empty mask on a small lesion looks exactly like a model that missed one.
   *
   * So the backend is chosen from what is known rather than tested for:
   *
   *   - A 3D model never asks for WebGPU. The runtime either refuses its
   *     convolutions outright or, in versions that accept them, runs them about
   *     ten times slower than the CPU. There is no version in which this is the
   *     wrong call.
   *   - A 2D model takes WebGPU when the adapter is there, which is where the
   *     ~10x speed-up lives.
   *   - If a run fails anyway, `_sessionRun` rebuilds on WebAssembly and retries
   *     once. Discovering an unsupported operator costs one wasted attempt on
   *     the first scan instead of a wasted pass on every load.
   */
  async init(force = null) {
    assertCompatible(this.meta);
    const o = await ort();

    // The graph refers to its weights by the relative path recorded at export
    // time. Hand the joined buffer back under exactly that name or the weights
    // are silently not found and the session fails to build.
    const external = [{ path: this.manifest.weights_path, data: this.bundle.weights }];

    // `force` exists for the parity test, which needs to compare the backends
    // against each other rather than take whichever one the machine offers.
    const attempts = force ? [force] : [];
    if (!force) {
      if (this.dim === 2 && await webgpuUsable()) attempts.push('webgpu');
      attempts.push('wasm');
    }

    this._build = (ep) => o.InferenceSession.create(this.bundle.graph, {
      executionProviders: [ep],
      graphOptimizationLevel: 'all',
      externalData: external,
    });

    let lastErr = null;
    for (const ep of attempts) {
      try {
        this.session = await this._build(ep);
        this.backend = ep;
        return this;
      } catch (err) {
        lastErr = err;
        // WebGPU is the fast path but is newer and can fail on a driver or on
        // an op it does not implement. Falling through to wasm is slow but
        // always works, and is far better than refusing to run.
        console.warn(`onnxruntime: ${ep} backend unusable (${err.message})`);
        this.session = null;
      }
    }
    throw new Error(`could not run the model on any backend. Last error: ${lastErr?.message}`);
  }

  /**
   * Run the session, falling back to WebAssembly once if the backend cannot.
   *
   * The failure this catches is a kernel the execution provider does not
   * implement, which surfaces on the first run rather than at build time. It is
   * deliberately not silent: the backend is renamed so `results.json` records
   * what actually ran.
   *
   * In principle a scan could straddle the switch -- some passes on one backend,
   * the rest on the other -- if the unsupported kernel only appeared part way
   * through. In practice an unimplemented operator fails on the very first pass,
   * and the two backends agree to a handful of boundary voxels anyway, so this
   * is not worth restarting the scan for.
   */
  async _sessionRun(feeds) {
    try {
      return await this.session.run(feeds);
    } catch (err) {
      if (this.backend === 'wasm' || this._pinned) throw err;
      console.warn(`onnxruntime: ${this.backend} failed mid-run (${err.message}); ` +
                   `rebuilding on wasm`);
      this.session = await this._build('wasm');
      this.backend = 'wasm';
      return this.session.run(feeds);
    }
  }

  get patch() { return this.meta.patch_size; }

  get dim() { return this.meta.dim || 2; }

  /**
   * The 3D importance map, as the outer product of the exported 1-D vectors.
   *
   * Built once and kept: it is patch-sized (about 1.3 M floats here) and is
   * reused by every window of every scan.
   */
  gaussian() {
    if (this._gauss) return this._gauss;
    const [pz, py, px] = this.patch;
    const [gz, gy, gx] = this.meta.gaussian_1d;
    const floor = this.meta.gaussian_floor || 0;
    const g = new Float32Array(pz * py * px);
    for (let z = 0; z < pz; z++) {
      for (let y = 0; y < py; y++) {
        const row = (z * py + y) * px;
        const zy = gz[z] * gy[y];
        for (let x = 0; x < px; x++) g[row + x] = Math.max(zy * gx[x], floor);
      }
    }
    this._gauss = g;
    return g;
  }

  /**
   * Mean and standard deviation over the whole stack.
   *
   * Not per slice: the plan normalises per image, and doing it per slice would
   * rescale every slice differently and change what the network sees.
   *
   * Accumulating in JS numbers means these are computed in double precision,
   * which is if anything more accurate than the float32 the training-time
   * preprocessing used. The difference is ~1e-7 relative and cannot move a
   * z-score meaningfully.
   */
  _stats(data) {
    const n = data.length;
    let sum = 0;
    for (let i = 0; i < n; i++) sum += data[i];
    const mean = sum / n;
    let ss = 0;
    for (let i = 0; i < n; i++) { const d = data[i] - mean; ss += d * d; }
    return { mean, std: Math.max(Math.sqrt(ss / n), 1e-8) };
  }

  /**
   * z-score the whole volume and centre-pad each slice to the patch size.
   *
   * Normalisation is over the entire stack, not per slice: the plan's
   * normalisation is per image, and doing it per slice would rescale every
   * slice differently and change what the network sees.
   *
   * Accumulating in JS numbers means the mean and variance are computed in
   * double precision, which is if anything more accurate than the float32 the
   * training-time preprocessing used. The difference is ~1e-7 relative and
   * cannot move a z-score meaningfully.
   */
  preprocess(vol) {
    const { nx, ny, nz, data } = vol;
    const [ph, pw] = this.patch;
    if (ny > ph || nx > pw) {
      throw new Error(`a ${ny}x${nx} slice does not fit the model's ${ph}x${pw} ` +
                      `patch. The 2D path runs one window per slice and has no ` +
                      `sliding-window path.`);
    }
    const { mean, std } = this._stats(data);

    const y0 = (ph - ny) >> 1;
    const x0 = (pw - nx) >> 1;
    const out = new Float32Array(nz * ph * pw);          // zeros = padding
    for (let z = 0; z < nz; z++) {
      const zo = z * ph * pw;
      for (let y = 0; y < ny; y++) {
        const src = (z * ny + y) * nx;
        const dst = zo + (y + y0) * pw + x0;
        for (let x = 0; x < nx; x++) out[dst + x] = (data[src + x] - mean) / std;
      }
    }
    return { input: out, y0, x0 };
  }

  /**
   * z-score the whole volume and centre-pad it to at least the patch size.
   *
   * Padding is centred, and where the total is odd the larger half goes
   * *after* — matching `pad_nd_image`. Getting that backwards shifts the whole
   * mask by one voxel, which looks like nothing and is wrong everywhere.
   *
   * An axis already at or above the patch size is left alone: `new_shape` is a
   * new *minimum*, and the sliding window covers whatever is longer.
   */
  preprocess3d(vol) {
    const { nx, ny, nz, data } = vol;
    const [pz, py, px] = this.patch;
    const { mean, std } = this._stats(data);

    const Pz = Math.max(nz, pz), Py = Math.max(ny, py), Px = Math.max(nx, px);
    const z0 = (Pz - nz) >> 1, y0 = (Py - ny) >> 1, x0 = (Px - nx) >> 1;
    const out = new Float32Array(Pz * Py * Px);          // zeros = padding
    for (let z = 0; z < nz; z++) {
      for (let y = 0; y < ny; y++) {
        const src = (z * ny + y) * nx;
        const dst = ((z + z0) * Py + (y + y0)) * Px + x0;
        for (let x = 0; x < nx; x++) out[dst + x] = (data[src + x] - mean) / std;
      }
    }
    return { input: out, shape: [Pz, Py, Px], off: [z0, y0, x0] };
  }

  /**
   * Average the network's logits over the mirrorings.
   *
   * Logits, not probabilities: the training framework sums raw network outputs
   * across flips and divides, applying softmax only at the end. Averaging
   * probabilities instead gives slightly different answers, which would show up
   * as a handful of boundary voxels and be very tiresome to track down.
   */
  async _runBatch(o, chunk, count, ph, pw, mirrorAxes) {
    const combos = [[]];
    if (mirrorAxes.includes(0)) combos.push([2]);
    if (mirrorAxes.includes(1)) combos.push([3]);
    if (mirrorAxes.includes(0) && mirrorAxes.includes(1)) combos.push([2, 3]);

    const plane = ph * pw;
    const acc = new Float32Array(count * 2 * plane);
    const inName = this.session.inputNames[0];

    for (const axes of combos) {
      const flipH = axes.includes(2);
      const flipW = axes.includes(3);
      let fed = chunk;
      if (flipH || flipW) {
        fed = new Float32Array(chunk.length);
        for (let b = 0; b < count; b++) {
          const bo = b * plane;
          for (let y = 0; y < ph; y++) {
            const sy = flipH ? ph - 1 - y : y;
            for (let x = 0; x < pw; x++) {
              const sx = flipW ? pw - 1 - x : x;
              fed[bo + y * pw + x] = chunk[bo + sy * pw + sx];
            }
          }
        }
      }
      const t = new o.Tensor('float32', fed, [count, 1, ph, pw]);
      const res = await this._sessionRun({ [inName]: t });
      const logits = res[this.session.outputNames[0]].data;

      // Unflip on the way back, so every mirroring is accumulated in the
      // original orientation.
      for (let b = 0; b < count; b++) {
        for (let c = 0; c < 2; c++) {
          const base = (b * 2 + c) * plane;
          for (let y = 0; y < ph; y++) {
            const sy = flipH ? ph - 1 - y : y;
            for (let x = 0; x < pw; x++) {
              const sx = flipW ? pw - 1 - x : x;
              acc[base + y * pw + x] += logits[base + sy * pw + sx];
            }
          }
        }
      }
    }
    for (let i = 0; i < acc.length; i++) acc[i] /= combos.length;
    return acc;
  }

  /**
   * One sliding window through the network, averaged over the mirrorings.
   *
   * `win` is a single patch, already extracted. Returns the two logit volumes
   * concatenated, patch-shaped, in the original (unflipped) orientation.
   */
  async _runWindow3d(o, win, mirrorAxes, onPass = null) {
    const [pz, py, px] = this.patch;
    const vox = pz * py * px;
    const flags = mirrorFlags(mirrorAxes);

    const acc = new Float32Array(2 * vox);
    const inName = this.session.inputNames[0];
    // One scratch buffer for all eight passes rather than eight allocations of
    // several megabytes. Safe because the tensor wraps it without copying and
    // `run` is awaited before the next pass overwrites it.
    const buf = new Float32Array(vox);

    for (const [fz, fy, fx] of flags) {
      let fed = win;
      if (fz || fy || fx) {
        for (let z = 0; z < pz; z++) {
          const sz = fz ? pz - 1 - z : z;
          for (let y = 0; y < py; y++) {
            const sy = fy ? py - 1 - y : y;
            const d = (z * py + y) * px, s = (sz * py + sy) * px;
            if (fx) for (let x = 0; x < px; x++) buf[d + x] = win[s + px - 1 - x];
            else buf.set(win.subarray(s, s + px), d);
          }
        }
        fed = buf;
      }
      const t = new o.Tensor('float32', fed, [1, 1, pz, py, px]);
      const res = await this._sessionRun({ [inName]: t });
      const logits = res[this.session.outputNames[0]].data;

      // Unflip on the way back, so every mirroring is accumulated in the
      // original orientation before being summed.
      for (let c = 0; c < 2; c++) {
        const base = c * vox;
        for (let z = 0; z < pz; z++) {
          const sz = fz ? pz - 1 - z : z;
          for (let y = 0; y < py; y++) {
            const sy = fy ? py - 1 - y : y;
            const d = base + (z * py + y) * px, s = base + (sz * py + sy) * px;
            if (fx) for (let x = 0; x < px; x++) acc[d + x] += logits[s + px - 1 - x];
            else for (let x = 0; x < px; x++) acc[d + x] += logits[s + x];
          }
        }
      }
      if (onPass) onPass();
    }
    for (let i = 0; i < acc.length; i++) acc[i] /= flags.length;
    return acc;
  }

  /**
   * Sliding-window segmentation for a 3D model.
   *
   * Logits are accumulated weighted by the Gaussian and divided by the summed
   * weight at the end. With one window that division cancels exactly, which is
   * why this reduces to "run the network once" for a scan shorter than the
   * patch — the common case by a wide margin.
   */
  async _segment3d(vol, { tta = true, onProgress = null } = {}) {
    const o = await ort();
    const { nx, ny, nz } = vol;
    const [pz, py, px] = this.patch;
    const { input, shape, off } = this.preprocess3d(vol);
    const [Pz, Py, Px] = shape;
    const [oz, oy, ox] = off;
    const mirrorAxes = tta ? (this.meta.mirror_axes || []) : [];
    const step = this.meta.tile_step_size;

    const zs = windowStarts(Pz, pz, step);
    const ys = windowStarts(Py, py, step);
    const xs = windowStarts(Px, px, step);
    const nWin = zs.length * ys.length * xs.length;
    // One network pass is the unit of progress. A whole-stack scan is one
    // window, so counting windows would show 0% and then 100%.
    const nPass = nWin * mirrorFlags(mirrorAxes).length;

    const patchVox = pz * py * px;
    const vol3 = Pz * Py * Px;
    const acc = new Float32Array(2 * vol3);
    const wsum = new Float32Array(vol3);
    const gauss = this.gaussian();
    const win = new Float32Array(patchVox);

    let pass = 0;
    const tick = onProgress ? () => onProgress(++pass, nPass) : null;

    for (const z0 of zs) for (const y0 of ys) for (const x0 of xs) {
      for (let z = 0; z < pz; z++) {
        for (let y = 0; y < py; y++) {
          const s = ((z0 + z) * Py + (y0 + y)) * Px + x0;
          win.set(input.subarray(s, s + px), (z * py + y) * px);
        }
      }
      const out = await this._runWindow3d(o, win, mirrorAxes, tick);

      for (let z = 0; z < pz; z++) {
        for (let y = 0; y < py; y++) {
          const src = (z * py + y) * px;
          const dst = ((z0 + z) * Py + (y0 + y)) * Px + x0;
          for (let x = 0; x < px; x++) {
            const g = gauss[src + x];
            // fround because the reference multiplies two float32 arrays and
            // rounds the PRODUCT before adding. JavaScript would compute the
            // product in double and round only on the store into acc — one
            // rounding instead of two. That is a fraction of an ulp, and it
            // flipped exactly one voxel out of 2.3 M where the two logits were
            // otherwise tied. See the note above _segment3d.
            acc[dst + x] += Math.fround(out[src + x] * g);
            acc[vol3 + dst + x] += Math.fround(out[patchVox + src + x] * g);
            wsum[dst + x] += g;
          }
        }
      }
    }

    const prob = new Float32Array(nx * ny * nz);
    const mask = new Uint8Array(nx * ny * nz);
    for (let z = 0; z < nz; z++) {
      for (let y = 0; y < ny; y++) {
        const src = ((z + oz) * Py + (y + oy)) * Px + ox;
        const drow = (z * ny + y) * nx;
        for (let x = 0; x < nx; x++) {
          const w = wsum[src + x];
          // fround for the same reason: the reference divides a float32 array
          // in place, so the quotient is rounded to float32 before the argmax
          // looks at it.
          const a = Math.fround(acc[src + x] / w);
          const c = Math.fround(acc[vol3 + src + x] / w);
          // Softmax of two logits, as a logistic on the difference so a large
          // logit cannot overflow the exponential.
          prob[drow + x] = 1 / (1 + Math.exp(a - c));
          // argmax, not p >= 0.5 — they agree for two classes, and argmax is
          // what the training framework does.
          mask[drow + x] = c > a ? 1 : 0;
        }
      }
    }
    return { prob, mask };
  }

  /**
   * Segment a volume. Returns foreground probability and the argmax label,
   * both on the input grid.
   */
  async segment(vol, opts = {}) {
    if (this.dim === 3) return this._segment3d(vol, opts);
    return this._segment2d(vol, opts);
  }

  async _segment2d(vol, { tta = true, batch = 8, onProgress = null } = {}) {
    const o = await ort();
    const { nx, ny, nz } = vol;
    const [ph, pw] = this.patch;
    const { input, y0, x0 } = this.preprocess(vol);
    const mirrorAxes = tta ? (this.meta.mirror_axes || []) : [];

    const prob = new Float32Array(nx * ny * nz);
    const mask = new Uint8Array(nx * ny * nz);
    const plane = ph * pw;

    for (let z0 = 0; z0 < nz; z0 += batch) {
      const count = Math.min(batch, nz - z0);
      const chunk = input.subarray(z0 * plane, (z0 + count) * plane);
      const acc = await this._runBatch(o, chunk, count, ph, pw, mirrorAxes);

      for (let b = 0; b < count; b++) {
        const z = z0 + b;
        const bg = (b * 2 + 0) * plane;
        const fg = (b * 2 + 1) * plane;
        for (let y = 0; y < ny; y++) {
          const srow = (y + y0) * pw + x0;
          const drow = (z * ny + y) * nx;
          for (let x = 0; x < nx; x++) {
            const a = acc[bg + srow + x];
            const c = acc[fg + srow + x];
            // Softmax of two logits, written as a logistic on the difference
            // so a large logit cannot overflow the exponential.
            const p = 1 / (1 + Math.exp(a - c));
            prob[drow + x] = p;
            // argmax, not p >= 0.5 -- they agree for two classes, and argmax is
            // what the training framework does.
            mask[drow + x] = c > a ? 1 : 0;
          }
        }
      }
      if (onProgress) onProgress(Math.min(z0 + count, nz), nz);
    }
    return { prob, mask };
  }
}

/** Build and start a model from whatever source is available. */
export async function openModel(bundle, force = null) {
  const m = new OnnxModel(bundle);
  // A pinned backend is answering the question "what does THIS one do", so it
  // must not quietly become another one mid-run.
  m._pinned = !!force;
  await m.init(force);
  return m;
}

// ---------------------------------------------------------------------------
// The one loaded model
// ---------------------------------------------------------------------------

// Starting a session means handing ~67 MB to the runtime and letting it build
// its graph, which takes seconds. Doing that per scan would make a 40-scan run
// unusable, so exactly one model is held here for the life of the page.
let _active = null;
let _loading = null;
let _activeId = null;

export async function setActiveBundle(bundle, id = null) {
  _active = null;
  _activeId = id;
  _loading = openModel(bundle).then((m) => { _active = m; return m; });
  return _loading;
}

export function activeModelId() { return _activeId; }

export async function activeModel() {
  if (_active) return _active;
  if (_loading) return _loading;
  return null;
}

export function activeModelInfo() {
  if (!_active) return null;
  return {
    id: _activeId,
    version: _active.manifest.version,
    precision: _active.manifest.precision,
    backend: _active.backend,
    bytes: _active.manifest.weights_bytes,
    ...(_active.meta || {}),
  };
}

export function forgetActiveModel() {
  _active = null;
  _loading = null;
  _activeId = null;
}

/**
 * Fetch one served model by id, preferring the cached copy.
 *
 * A served model whose version differs from the cached one wins, or a
 * redeployed model would never reach anyone who had already used the tool.
 */
export async function loadServedBundle(entry, base = './model/', onProgress = null) {
  const sub = `${base}${entry.path}`;
  const cached = await cachedBundle(entry.id);
  const served = await servedModelManifest(sub);
  if (cached && (!served || served.version === cached.manifest.version)) return cached;
  if (!served) return cached;
  const bundle = await fetchBundle(served, sub, onProgress);
  await cacheBundle(bundle, entry.id);
  return bundle;
}

/**
 * Find a model without asking the user: the cache first, then one served
 * beside the page. Returns `{ bundle, index, id }`, with a null bundle if
 * nothing is available and the user has to supply a folder.
 */
export async function autoloadBundle(base = './model/', preferId = null,
                                     onProgress = null) {
  const index = await servedModelIndex(base);
  if (!index) {
    // Nothing served. A previous session may still have cached one, either
    // under a served id or from a folder the user picked.
    for (const id of [preferId, null, 'model']) {
      const c = await cachedBundle(id);
      if (c) return { bundle: c, index: null, id };
    }
    return { bundle: null, index: null, id: null };
  }
  const wanted = index.models.find((m) => m.id === preferId)
    || index.models.find((m) => m.id === index.default)
    || index.models[0];
  return { bundle: await loadServedBundle(wanted, base, onProgress), index, id: wanted.id };
}
