/**
 * The model layer, in the browser. Port of `src/predictor.py`.
 *
 * Everything downstream talks to a Predictor and never to a model directly.
 * That is what let the whole tool be built before a model existed, and it is
 * what will let a trained nnU-Net drop in without the UI noticing.
 *
 * A predictor returns TWO things:
 *
 *     mask   Uint8Array, 0/1, on exactly the input volume's grid
 *     prob   Float32Array in [0,1], per-voxel probability, or null
 *
 * `prob` is what makes the review-priority score possible. The stub synthesises
 * one with a realistic soft edge so the scoring code is exercised honestly
 * rather than fed a hard 0/1 mask that would make every case look perfectly
 * confident.
 *
 * ONE DIFFERENCE FROM THE PYTHON STUB, STATED PLAINLY
 * ---------------------------------------------------
 * The Python stub seeds numpy's PCG64 from a SHA-256 of the voxels. This one
 * seeds sfc32 from the same SHA-256 of the same voxels. The hash inputs are
 * identical -- the voxel decode is verified bit-identical to SimpleITK in
 * web/test/parity.mjs -- but the two generators are different, so the two
 * stubs draw DIFFERENT fake tumours for the same scan.
 *
 * That is deliberate rather than an oversight. Reproducing numpy's PCG64 plus
 * its Lemire bounded-integer draws in JavaScript is a few hundred lines of
 * BigInt, and it would make two throwaway fake models agree with each other
 * while proving nothing about either. What actually needs to agree between the
 * two tools is the geometry, the voxels and the mm3, and those are tested
 * directly and exactly. The stub disappears the day fold 0 lands.
 */

import { Volume } from './volume.js';
import { removeSmallComponents } from './label.js';

// ---------------------------------------------------------------------------
// Review priority
// ---------------------------------------------------------------------------
// Named constants rather than magic numbers, and every one is a judgement call
// that should be revisited once fold 0 has run and the model's real failure
// modes are known. Keep these in step with src/predictor.py.

export const AMBIGUOUS_LO = 0.25;
export const AMBIGUOUS_HI = 0.75;
export const SMALL_VOLUME_MM3 = 10.0;
export const CONFIDENT_MEAN_PROB = 0.90;

const band = (score) => (score >= 60 ? 'high' : score >= 30 ? 'medium' : 'low');
const round = (v, n) => Math.round(v * 10 ** n) / 10 ** n;

/**
 * How badly does this prediction need a human to look at it?
 *
 * The 0-100 number exists only to sort a worklist. The REASONS are the product:
 * "tumour touches the first slice, so it may extend beyond the scan" tells the
 * reviewer what to look at, and "0.62" tells them nothing.
 *
 * Nothing here measures correctness -- it cannot, there is no ground truth at
 * prediction time. It measures how much the prediction has the shape of
 * something worth checking.
 */
export function reviewScore(mask, prob, volumeMm3, nComponents, nx, ny, nz) {
  const reasons = [];
  const signals = {};
  let score = 0;

  const sliceSize = nx * ny;
  let any = false;
  for (let i = 0; i < mask.length && !any; i++) if (mask[i]) any = true;

  if (!any) {
    // An empty prediction is a real and meaningful result in this study --
    // tumour-free scans are concentrated in the treated arms. But a missed
    // small tumour looks exactly like this, so it always gets eyes on it.
    signals.empty = true;
    reasons.push('No tumour predicted. Confirm this is genuinely tumour-free ' +
                 'and not a missed small tumour.');
    return { score: 45.0, band: band(45), reasons, signals };
  }

  // --- 1. Coverage: does the tumour run off the end of the scan? ------------
  // 18 slices is thin, and the operator extended coverage on the big-tumour
  // timepoints -- which means they were sometimes close to the limit. A tumour
  // touching the first or last slice may be cut off, and a cut-off tumour has
  // an underestimated VOLUME, which is what the paper reports.
  const sliceHasMask = (z) => {
    const off = z * sliceSize;
    for (let i = 0; i < sliceSize; i++) if (mask[off + i]) return true;
    return false;
  };
  const touches = [];
  if (sliceHasMask(0)) touches.push('first');
  if (sliceHasMask(nz - 1)) touches.push('last');
  signals.touches_edge_slice = touches;
  if (touches.length) {
    score += 35;
    reasons.push(`Tumour reaches the ${touches.join(' and ')} slice, so it may ` +
                 `extend outside the scanned region and the volume may be an ` +
                 `underestimate.`);
  }

  // --- 2. Size: small tumours are where detection actually fails ------------
  signals.volume_mm3 = round(volumeMm3, 3);
  if (volumeMm3 < SMALL_VOLUME_MM3) {
    // A smooth ramp rather than a cliff, so a 9.9 mm3 tumour is not treated
    // completely differently from a 10.1 mm3 one.
    score += 30 * (1 - volumeMm3 / SMALL_VOLUME_MM3);
    reasons.push(`Small tumour (${volumeMm3.toFixed(1)} mm3). A quarter of this ` +
                 `study's tumours are under 7.7 mm3 and they are the hardest to ` +
                 `get right.`);
  }

  // --- 3. Multi-focality: real here, but worth confirming -------------------
  signals.n_components = nComponents;
  if (nComponents > 1) {
    score += 20;
    reasons.push(`${nComponents} separate components. Genuinely multi-focal ` +
                 `tumours exist in this study, so this may be correct -- but ` +
                 `check the small ones are not noise.`);
  }

  // --- 4. Model confidence, only if we were given probabilities -------------
  if (prob) {
    let sum = 0, n = 0;
    for (let i = 0; i < mask.length; i++) if (mask[i]) { sum += prob[i]; n++; }
    const meanConf = n ? sum / n : 0;
    signals.mean_foreground_prob = round(meanConf, 3);
    if (meanConf < CONFIDENT_MEAN_PROB) {
      score += 25 * (CONFIDENT_MEAN_PROB - meanConf) / CONFIDENT_MEAN_PROB;
      reasons.push(`Model is not confident about the voxels it did label ` +
                   `(mean probability ${meanConf.toFixed(2)}).`);
    }

    // A wide ambiguous band relative to the tumour means a fuzzy boundary,
    // which for a small tumour can be most of its volume.
    let considered = 0, amb = 0;
    for (let i = 0; i < prob.length; i++) {
      if (prob[i] > 0.05) {
        considered++;
        if (prob[i] >= AMBIGUOUS_LO && prob[i] <= AMBIGUOUS_HI) amb++;
      }
    }
    if (considered) {
      const frac = amb / considered;
      signals.ambiguous_fraction = round(frac, 3);
      if (frac > 0.35) {
        score += 20 * Math.min(1.0, (frac - 0.35) / 0.35);
        reasons.push(`Boundary is indistinct: ${Math.round(frac * 100)}% of the ` +
                     `considered region sits between probability ${AMBIGUOUS_LO} ` +
                     `and ${AMBIGUOUS_HI}.`);
      }
    }
  } else {
    signals.mean_foreground_prob = null;
  }

  if (!reasons.length) {
    reasons.push('Nothing unusual. Still worth a glance, but this one looks ' +
                 'straightforward.');
  }

  const clamped = Math.min(100, Math.max(0, score));
  return { score: round(clamped, 1), band: band(clamped), reasons, signals };
}

// ---------------------------------------------------------------------------
// Predictors
// ---------------------------------------------------------------------------

/** Interface. A predictor maps a Volume to {mask, prob}. */
export class Predictor {
  constructor() { this.name = 'abstract'; this.isReal = false; }
  async predict(_vol) { throw new Error('not implemented'); }
}

/**
 * sfc32 -- small, fast, well-distributed, and short enough to read.
 * Seeded from four 32-bit words taken off a SHA-256 digest.
 */
function sfc32(a, b, c, d) {
  return function next() {
    a |= 0; b |= 0; c |= 0; d |= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

/**
 * A deterministic fake model, for building and testing the tool without one.
 *
 * IT DOES NOT LOOK AT THE IMAGE CONTENT AT ALL. Every output is derived from a
 * hash of the voxels, which makes it reproducible (the same scan always gives
 * the same answer, so a change in output means the TOOL changed), predictable,
 * and varied -- it produces large, small, multi-focal, edge-touching and empty
 * results, so every branch of the QC and scoring code is exercised.
 *
 * Random weights would have been the obvious alternative and would have been
 * worse: the output would be noise, and noise is indistinguishable from a bug.
 * Here, if a mask comes out in the wrong place, that is a real defect in the
 * geometry handling and not the model being untrained.
 */
export class StubPredictor extends Predictor {
  constructor(mode = 'varied') {
    super();
    if (!['varied', 'empty', 'sphere'].includes(mode)) {
      throw new Error(`unknown stub mode ${JSON.stringify(mode)}`);
    }
    this.mode = mode;
    this.name = `stub:${mode}`;
    this.isReal = false;
  }

  /**
   * Seed from the pixel data, not just the geometry.
   *
   * Geometry alone is not distinguishing here: every scan in this study is
   * 248x256x18 at the same spacing and many share an origin, so hashing
   * geometry gave four different mice the identical fake tumour -- which made
   * the stub useless for spotting a bug where the tool mixes up cases.
   *
   * To be explicit about what this is NOT: the stub still does not segment
   * anything. The pixels are a source of entropy, used exactly the way a hash
   * function uses them, and the result has no relationship to where the tumour
   * actually is.
   */
  static async seed(vol) {
    const { nx, ny, nz, data } = vol;
    // Same subsampling as the Python: every 3rd slice, every 8th row and column.
    const zs = Math.ceil(nz / 3), ys = Math.ceil(ny / 8), xs = Math.ceil(nx / 8);
    const sub = new Float64Array(zs * ys * xs);
    let k = 0;
    for (let z = 0; z < nz; z += 3) {
      for (let y = 0; y < ny; y += 8) {
        const off = (z * ny + y) * nx;
        for (let x = 0; x < nx; x += 8) sub[k++] = data[off + x];
      }
    }
    const head = new TextEncoder().encode(`(${nx}, ${ny}, ${nz})`);
    const buf = new Uint8Array(head.length + sub.byteLength);
    buf.set(head, 0);
    buf.set(new Uint8Array(sub.buffer), head.length);

    const digest = new DataView(await crypto.subtle.digest('SHA-256', buf));
    return sfc32(digest.getUint32(0), digest.getUint32(4),
                 digest.getUint32(8), digest.getUint32(12));
  }

  async predict(vol) {
    const { nx, ny, nz } = vol;
    const n = nx * ny * nz;
    const rng = await StubPredictor.seed(vol);
    const uniform = (lo, hi) => lo + (hi - lo) * rng();
    const prob = new Float32Array(n);

    if (this.mode === 'empty') return this._package(vol, prob);

    const roll = rng();
    // ~15% empty, so the tumour-free path is genuinely exercised.
    if (this.mode === 'varied' && roll < 0.15) return this._package(vol, prob);

    let radius, centres;
    if (this.mode === 'sphere') {
      radius = [2.0, 18.0, 18.0];
      centres = [[nz / 2, ny / 2, nx / 2]];
    } else {
      // Size spanning the study's real range, log-uniform in plane because the
      // real distribution in a study like this covers several orders of magnitude.
      const rz = uniform(1.0, Math.min(6.0, nz / 3));
      const rxy = Math.exp(uniform(Math.log(4), Math.log(45)));
      radius = [rz, rxy, rxy];
      // Occasionally put it against an end slice, to exercise the coverage flag.
      const cz = roll > 0.30 ? uniform(1, nz - 2) : (rng() < 0.5 ? 1.0 : nz - 2.0);
      centres = [[cz, uniform(ny * 0.3, ny * 0.7), uniform(nx * 0.3, nx * 0.7)]];
      if (roll > 0.85) {                    // ~15% multi-focal
        centres.push([cz, uniform(ny * 0.3, ny * 0.7), uniform(nx * 0.3, nx * 0.7)]);
      }
    }

    for (const [cz, cy, cx] of centres) {
      for (let z = 0; z < nz; z++) {
        const dz = (z - cz) / radius[0], dz2 = dz * dz;
        for (let y = 0; y < ny; y++) {
          const dy = (y - cy) / radius[1], dy2 = dy * dy;
          const off = (z * ny + y) * nx;
          for (let x = 0; x < nx; x++) {
            const dx = (x - cx) / radius[2];
            const d = Math.sqrt(dz2 + dy2 + dx * dx);
            // Logistic falloff gives a soft edge, so there is a real ambiguous
            // band for the review score to find instead of a perfect step.
            const p = 1 / (1 + Math.exp((d - 1) * 6));
            if (p > prob[off + x]) prob[off + x] = p;
          }
        }
      }
    }
    return this._package(vol, prob);
  }

  _package(vol, prob) {
    const mask = new Uint8Array(prob.length);
    for (let i = 0; i < prob.length; i++) mask[i] = prob[i] >= 0.5 ? 1 : 0;
    return { mask: vol.withData(mask), prob: vol.withData(prob) };
  }
}

/**
 * The trained network, run in the tab.
 *
 * All of the actual work -- loading the weights, normalising, padding,
 * mirroring, argmax -- is in `onnx.js`, which is where it can be checked
 * against the Python reference implementation. This class is only the adapter
 * that makes it look like every other predictor, so that nothing else in the
 * tool has to know which kind is running.
 *
 * The model is registered once (see `onnx.setActiveBundle`) rather than passed
 * in, because loading it is a slow, user-visible, once-per-machine step and the
 * predictor is constructed fresh on every run.
 */
export class OnnxPredictor extends Predictor {
  constructor(opts = {}) {
    super();
    this.tta = opts.tta !== false;
    this.name = 'onnx';
    this.isReal = true;
  }

  async predict(vol, opts = {}) {
    const onnx = await import('./onnx.js');
    const model = await onnx.activeModel();
    if (!model) {
      throw new Error('no model is loaded. Load one in Settings, or the tool ' +
                      'will keep running on the stub.');
    }
    // The recorded name goes into results.json, which is what someone reads
    // months later to work out what produced a mask — so it names the
    // configuration, not just a digest.
    const cfg = model.meta?.config || `${model.dim}d`;
    // Mirroring is part of what produced the mask, not a preference — two runs
    // of the same weights with and without it give different volumes. Since it
    // is now off by default, a results file that does not say so is ambiguous.
    const how = this.tta ? '' : ', no mirroring';
    this.name = `onnx:${cfg}:${model.manifest.version} (${model.backend}${how})`;
    const { prob, mask } = await model.segment(vol, {
      tta: this.tta, onProgress: opts.onProgress,
    });
    return { mask: vol.withData(mask), prob: vol.withData(prob) };
  }
}

/**
 * Resolve a model spec.
 *
 *     null / "stub"     the varied deterministic fake
 *     "stub:empty"      always predicts tumour-free
 *     "stub:sphere"     one fixed centred blob, for exact assertions
 *     "onnx"            the trained model, if one has been loaded
 *     "onnx:no-tta"     the same, without test-time mirroring
 *
 * Which *network* is loaded is a separate question, handled by `onnx.js` and
 * the model picker — this only decides how it is driven. A 3D model mirrors
 * over three axes rather than two, so turning mirroring off saves 8 passes
 * instead of 4.
 */
export function getPredictor(spec) {
  if (spec == null || spec === 'stub') return new StubPredictor('varied');
  if (spec.startsWith('stub:')) return new StubPredictor(spec.slice(5));
  if (spec === 'onnx') return new OnnxPredictor();
  if (spec === 'onnx:no-tta') return new OnnxPredictor({ tta: false });
  throw new Error(`unknown model ${JSON.stringify(spec)}`);
}

export { removeSmallComponents };
