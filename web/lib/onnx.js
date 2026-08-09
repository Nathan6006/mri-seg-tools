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
 *     z-score over the whole volume -> centre-pad each slice to the patch ->
 *     network -> average logits over the mirrorings -> softmax -> argmax ->
 *     crop the padding back off
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

const CACHE_KEY = 'model.bundle';

async function sha256Hex(bytes) {
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Is a model being served alongside the page?
 *
 * The weights are a derivative of the study's imaging, so whether they are
 * published with the site is a decision for whoever owns the data. The tool
 * therefore supports both: served from `model/` if it is there, or handed over
 * from a local folder by the user. This is how it finds out which.
 */
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
  const parts = [];
  let done = 0;
  for (const s of manifest.shards) {
    const res = await fetch(`${base}${s.name}`);
    if (!res.ok) throw new Error(`cannot fetch ${s.name}: HTTP ${res.status}`);
    parts.push(new Uint8Array(await res.arrayBuffer()));
    done += s.bytes;
    if (onProgress) onProgress(done, manifest.weights_bytes);
  }
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

export async function cachedBundle() {
  const rec = await store.getKV(CACHE_KEY, null);
  if (!rec || !rec.manifest || !rec.graph || !rec.weights) return null;
  return rec;
}

export async function cacheBundle(bundle) {
  // 67 MB of weights in one IndexedDB value. Storing them as one blob rather
  // than per-shard keeps the read path a single get, and the download is the
  // slow part anyway.
  await store.setKV(CACHE_KEY, bundle);
}

export async function clearCachedBundle() {
  await store.setKV(CACHE_KEY, null);
}

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

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
}

export class OnnxModel {
  constructor(bundle) {
    this.bundle = bundle;
    this.manifest = bundle.manifest;
    this.meta = bundle.manifest.model;
    this.session = null;
    this.backend = null;
  }

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
      if (await webgpuUsable()) attempts.push('webgpu');
      attempts.push('wasm');
    }

    let lastErr = null;
    for (const ep of attempts) {
      try {
        this.session = await o.InferenceSession.create(this.bundle.graph, {
          executionProviders: [ep],
          graphOptimizationLevel: 'all',
          externalData: external,
        });
        this.backend = ep;
        return this;
      } catch (err) {
        lastErr = err;
        // WebGPU is the fast path but is newer and can fail on a driver or on
        // an op it does not implement. Falling through to wasm is slow but
        // always works, and is far better than refusing to run.
        console.warn(`onnxruntime: ${ep} backend unavailable (${err.message})`);
      }
    }
    throw new Error(`could not start the model on any backend. Last error: ${lastErr?.message}`);
  }

  get patch() { return this.meta.patch_size; }

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
                      `patch. This build runs one window per slice and has no ` +
                      `sliding-window path.`);
    }
    const n = data.length;
    let sum = 0;
    for (let i = 0; i < n; i++) sum += data[i];
    const mean = sum / n;
    let ss = 0;
    for (let i = 0; i < n; i++) { const d = data[i] - mean; ss += d * d; }
    const std = Math.max(Math.sqrt(ss / n), 1e-8);

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
      const res = await this.session.run({ [inName]: t });
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
   * Segment a volume. Returns foreground probability and the argmax label,
   * both on the input grid.
   */
  async segment(vol, { tta = true, batch = 8, onProgress = null } = {}) {
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

export async function setActiveBundle(bundle) {
  _active = null;
  _loading = openModel(bundle).then((m) => { _active = m; return m; });
  return _loading;
}

export async function activeModel() {
  if (_active) return _active;
  if (_loading) return _loading;
  return null;
}

export function activeModelInfo() {
  if (!_active) return null;
  return {
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
}

/**
 * Find a model without asking the user: the cache first, then one served
 * beside the page. Returns the bundle, or null if neither is there.
 */
export async function autoloadBundle(base = './model/') {
  const cached = await cachedBundle();
  const served = await servedModelManifest(base);

  // A served model that is newer than the cached one should win, or a
  // redeployed model would never reach anyone who had already used the tool.
  if (cached && (!served || served.version === cached.manifest.version)) {
    return cached;
  }
  if (served) {
    const bundle = await fetchBundle(served, base);
    await cacheBundle(bundle);
    return bundle;
  }
  return cached;
}
