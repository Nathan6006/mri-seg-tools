/**
 * Connected components on a 3-D mask.
 *
 * Port of the `sitk.ConnectedComponent` / `LabelShapeStatisticsImageFilter`
 * pair used in `src/predictor.py`. SimpleITK's default is
 * `fullyConnected=False`, which in 3-D means FACE connectivity -- six
 * neighbours, not twenty-six. That is not a detail to gloss over here: two
 * tumour lobes that touch only at a corner count as two components under face
 * connectivity and one under full, and `n_components > 1` is one of the
 * review-priority reasons a human acts on. Multi-focal masks do occur in real
 * studies -- two separate components on the same slice.
 */

const NEIGHBOURS = [
  [0, 0, -1], [0, 0, 1],
  [0, -1, 0], [0, 1, 0],
  [-1, 0, 0], [1, 0, 0],
];

/**
 * Label every 6-connected component of a binary volume.
 *
 * @param {Uint8Array} mask z-major, non-zero is foreground
 * @returns {{labels: Int32Array, sizes: number[]}} labels are 1-based, 0 is
 *          background; `sizes[i]` is the voxel count of label i+1.
 */
export function connectedComponents(mask, nx, ny, nz) {
  const labels = new Int32Array(mask.length);
  const sizes = [];
  const sliceSize = nx * ny;
  // Int32Array stack rather than a JS array: a single large tumour can push
  // hundreds of thousands of voxels, and array push/pop on that is markedly
  // slower and allocates as it grows.
  const stack = new Int32Array(mask.length);

  let current = 0;
  for (let seed = 0; seed < mask.length; seed++) {
    if (!mask[seed] || labels[seed]) continue;
    current++;
    let top = 0, count = 0;
    stack[top++] = seed;
    labels[seed] = current;

    while (top > 0) {
      const i = stack[--top];
      count++;
      const z = (i / sliceSize) | 0;
      const rem = i - z * sliceSize;
      const y = (rem / nx) | 0;
      const x = rem - y * nx;

      for (let k = 0; k < 6; k++) {
        const nzi = z + NEIGHBOURS[k][0];
        const nyi = y + NEIGHBOURS[k][1];
        const nxi = x + NEIGHBOURS[k][2];
        if (nxi < 0 || nxi >= nx || nyi < 0 || nyi >= ny || nzi < 0 || nzi >= nz) continue;
        const j = (nzi * ny + nyi) * nx + nxi;
        if (mask[j] && !labels[j]) {
          labels[j] = current;
          stack[top++] = j;
        }
      }
    }
    sizes.push(count);
  }
  return { labels, sizes };
}

/** Just the count, which is all `refresh_edits` needs. */
export function countComponents(mask, nx, ny, nz) {
  return connectedComponents(mask, nx, ny, nz).sizes.length;
}

/**
 * Drop connected components smaller than `minVoxels`.
 *
 * Port of `predictor.remove_small_components`, including its default of 0 =
 * keep everything. From the Python, and it is worth repeating because it is a
 * judgement call rather than a free win: the smallest real tumour in this study
 * is 22 voxels, so any threshold that removes false positives will eventually
 * remove true ones. Tune it on cross-validation, never on the test set, and
 * report the value used.
 *
 * @returns {{mask: Uint8Array, nComponents: number}}
 */
export function removeSmallComponents(mask, nx, ny, nz, minVoxels = 0) {
  const { labels, sizes } = connectedComponents(mask, nx, ny, nz);
  if (minVoxels <= 0) return { mask, nComponents: sizes.length };

  const keep = new Uint8Array(sizes.length + 1);
  let kept = 0;
  for (let l = 1; l <= sizes.length; l++) {
    if (sizes[l - 1] >= minVoxels) { keep[l] = 1; kept++; }
  }
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < out.length; i++) out[i] = keep[labels[i]] ? 1 : 0;
  return { mask: out, nComponents: kept };
}

/** Which slice indices contain any mask, and how many voxels in total. */
export function maskFacts(mask, nx, ny, nz) {
  const sliceSize = nx * ny;
  const slices = [];
  let voxels = 0;
  for (let z = 0; z < nz; z++) {
    const off = z * sliceSize;
    let any = 0;
    for (let i = 0; i < sliceSize; i++) if (mask[off + i]) { any++; }
    if (any) slices.push(z);
    voxels += any;
  }
  return { tumorSlices: slices, voxels, nTumorSlices: slices.length };
}
