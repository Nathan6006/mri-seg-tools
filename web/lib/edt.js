/**
 * Exact Euclidean distance transform, and the signed version the interpolation
 * needs.
 *
 * WHY EXACT, AND WHY NOT A CHAMFER APPROXIMATION
 * ---------------------------------------------
 * Slice interpolation works by turning each drawn slice into a signed distance
 * field, blending the two linearly and thresholding at zero. That interpolates
 * the SHAPE. Interpolating the two binary masks directly just cross-fades them
 * and produces garbage wherever they do not overlap.
 *
 * The blend is only as good as the fields, and the cheap chamfer/3-4 distance
 * approximations have direction-dependent error of a few percent -- which shows
 * up as a contour that bulges along the diagonals. Felzenszwalb & Huttenlocher's
 * algorithm is exact, and it is O(n) per row, so there is no reason to
 * approximate: a 256x248 slice transforms in about a millisecond.
 *
 * MATCHING ITK, AND THE TRAP IN CHECKING IT
 * -----------------------------------------
 * `src/app.py` uses `sitk.SignedMaurerDistanceMap(insideIsPositive=False,
 * useImageSpacing=False)`. Its convention is:
 *
 *     d(p) = +/- (Euclidean distance from p to the nearest BORDER voxel)
 *
 * where a border voxel is an OBJECT voxel with at least one background
 * neighbour under FULL connectivity -- 8 neighbours in 2-D, diagonals
 * included -- and the sign is negative inside the object. So the ring of voxels
 * just inside an edge is exactly 0, and the centre of a 3x3 square is -1.
 *
 * The first version of this file used a different rule -- "object voxel:
 * 1 minus the distance to the nearest background voxel" -- which gives
 * identical answers on a convex shape and was therefore verified against a
 * square and declared correct. It is wrong on a concave one: at the inner
 * corner of a C, the nearest background voxel is diagonal, and the two rules
 * differ by sqrt(2) - 1. That is why web/test/parity.mjs now checks a concave
 * fixture as well as a square, and why the fixture list is worth keeping.
 *
 * The convention matters rather than being pedantry: a constant offset in both
 * fields survives the linear blend, so every interpolated contour would come
 * out systematically too large or too small.
 */

const INF = 1e20;

/**
 * Felzenszwalb & Huttenlocher's 1D squared distance transform, in place.
 *
 * `f` is the sampled function, `d` receives the result. `v` and `z` are the
 * parabola-hull scratch arrays, passed in so a 2D pass does not allocate per
 * row -- that allocation dominated the runtime when it was inside the loop.
 */
function edt1d(f, d, v, z, n) {
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dx = q - v[k];
    d[q] = dx * dx + f[v[k]];
  }
}

/**
 * Squared Euclidean distance from every voxel to the nearest set voxel.
 *
 * @param {Uint8Array} seeds  non-zero marks a seed
 * @param {number} nx @param {number} ny
 * @returns {Float64Array} squared distances, INF where there are no seeds
 */
export function edt2dSquared(seeds, nx, ny) {
  const out = new Float64Array(nx * ny);
  for (let i = 0; i < out.length; i++) out[i] = seeds[i] ? 0 : INF;

  const m = Math.max(nx, ny);
  const f = new Float64Array(m), d = new Float64Array(m);
  const v = new Int32Array(m), z = new Float64Array(m + 1);

  for (let x = 0; x < nx; x++) {                    // columns
    for (let y = 0; y < ny; y++) f[y] = out[y * nx + x];
    edt1d(f, d, v, z, ny);
    for (let y = 0; y < ny; y++) out[y * nx + x] = d[y];
  }
  for (let y = 0; y < ny; y++) {                    // rows
    const off = y * nx;
    for (let x = 0; x < nx; x++) f[x] = out[off + x];
    edt1d(f, d, v, z, nx);
    for (let x = 0; x < nx; x++) out[off + x] = d[x];
  }
  return out;
}

/**
 * The object voxels that touch background, under full (8-) connectivity.
 *
 * Out-of-bounds does NOT count as background. An object running off the edge of
 * the image therefore has no border along that edge, and voxels there get large
 * negative distances measured from wherever the real boundary is. That is
 * measurably what ITK does -- a 9x7 block in the corner of a 12x12 image gets
 * -6 at (0,0), not 0 -- and matching it is the point, since the Python build
 * uses ITK and the two must agree.
 *
 * It is also academic for this study: the mouse sits in the middle of a
 * 40 x 40 mm field of view, so a tumour reaching the in-plane image edge does
 * not happen. Reaching the first or last SLICE does happen, and is handled
 * somewhere else entirely -- it is one of the review-priority reasons.
 */
function borderVoxels(mask, nx, ny) {
  const border = new Uint8Array(nx * ny);
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      const i = y * nx + x;
      if (!mask[i]) continue;
      const y0 = Math.max(0, y - 1), y1 = Math.min(ny - 1, y + 1);
      const x0 = Math.max(0, x - 1), x1 = Math.min(nx - 1, x + 1);
      outer:
      for (let yy = y0; yy <= y1; yy++) {
        for (let xx = x0; xx <= x1; xx++) {
          if (!mask[yy * nx + xx]) { border[i] = 1; break outer; }
        }
      }
    }
  }
  return border;
}

/**
 * ITK's signed Maurer distance, in voxel units, for one slice.
 *
 * Negative inside the mask, positive outside, zero on the outermost ring of
 * object voxels -- exactly what `sitk.SignedMaurerDistanceMap` produces with
 * `insideIsPositive=False, useImageSpacing=False`. Verified against SimpleITK
 * on convex, concave, disjoint, single-voxel and edge-touching shapes.
 *
 * An all-background or all-object slice has no border and therefore no
 * meaningful distance; both come back as a large constant of the right sign.
 * The caller (interpolation) has already refused those cases for its own
 * reasons, and a constant field would collapse its output to nothing anyway,
 * which the endpoint reports rather than writing empty slices.
 */
export function signedDistance(mask, nx, ny) {
  const d2 = edt2dSquared(borderVoxels(mask, nx, ny), nx, ny);
  const out = new Float32Array(nx * ny);
  for (let i = 0; i < out.length; i++) {
    const d = Math.sqrt(d2[i]);
    out[i] = mask[i] ? -d : d;
  }
  return out;
}
