/**
 * The QC montage: every slice of a scan on one image, with the mask outlined.
 *
 * Port of `batch.qc_montage`, which uses matplotlib. There is no matplotlib
 * here, so this draws to a canvas -- and the point of the image is unchanged:
 * one glance tells you whether the mask is on tumour tissue or somewhere silly,
 * without opening anything.
 *
 * TWO THINGS ARE MATCHED TO THE PYTHON ON PURPOSE
 * -----------------------------------------------
 * The window is the 1st to 99.5th percentile of the whole volume, the same as
 * `derived/qc/` and the same as the browser viewer's auto-window. If these three
 * disagreed, a reviewer comparing a QC PNG against the live viewer would see
 * two different pictures of the same scan and have no way to tell which was
 * right.
 *
 * The layout is six columns, slice index labelled above each cell. That is
 * `derived/qc/montage/`'s layout, so a montage from either tool can be dropped
 * into the same folder and read the same way.
 *
 * The outline is drawn by marking voxels that have a non-mask neighbour, rather
 * than by tracing a contour. matplotlib's `contour` interpolates and draws a
 * smooth sub-voxel curve; this is a one-voxel-thick boundary. At these sizes
 * they look the same, and this one has the advantage that it cannot draw a
 * boundary somewhere there is no voxel.
 */

const CELL_W = 190;              // px; matches matplotlib's 2.0in at dpi 95
const LABEL_H = 14;
const PAD = 3;
const COLS = 6;
const TITLE_H = 20;

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

async function toBlob(canvas) {
  if (canvas.convertToBlob) return canvas.convertToBlob({ type: 'image/png' });
  return new Promise((res) => canvas.toBlob(res, 'image/png'));
}

/**
 * The intensity window, as numpy's `percentile` computes it: linear
 * interpolation between the two neighbouring order statistics.
 */
export function percentileWindow(data, loPct = 1, hiPct = 99.5) {
  const sorted = Float32Array.from(data).sort();
  const at = (p) => {
    const idx = (p / 100) * (sorted.length - 1);
    const i = Math.floor(idx), f = idx - i;
    return i + 1 < sorted.length ? sorted[i] * (1 - f) + sorted[i + 1] * f : sorted[i];
  };
  return [at(loPct), at(hiPct)];
}

/**
 * Render a montage.
 *
 * @param {Volume} vol       the scan
 * @param {Uint8Array|null} mask  outlined in red; pass null for no outline
 * @param {string} title
 * @returns {Promise<Blob>} a PNG
 */
export async function montage(vol, mask, title) {
  const { nx, ny, nz } = vol;
  const cellH = Math.round(CELL_W * ny / nx);
  const cols = Math.min(COLS, nz);
  const rows = Math.ceil(nz / cols);

  const W = cols * (CELL_W + PAD) + PAD;
  const H = TITLE_H + rows * (cellH + LABEL_H + PAD) + PAD;
  const canvas = makeCanvas(W, H);
  const g = canvas.getContext('2d');

  g.fillStyle = '#fff';
  g.fillRect(0, 0, W, H);
  g.fillStyle = '#222';
  g.font = '13px system-ui, sans-serif';
  g.textAlign = 'center';
  g.fillText(title, W / 2, 14);

  const [lo, hi] = percentileWindow(vol.data);
  const span = Math.max(hi - lo, 1e-6);
  const sliceSize = nx * ny;

  // One reusable buffer for the greyscale slice, then let the canvas do the
  // scaling. Drawing voxel by voxel at display size would be ~40x more work.
  const tile = makeCanvas(nx, ny);
  const tg = tile.getContext('2d');
  const img = tg.createImageData(nx, ny);

  for (let z = 0; z < nz; z++) {
    const off = z * sliceSize;
    for (let i = 0; i < sliceSize; i++) {
      const v = Math.max(0, Math.min(255,
        Math.round((vol.data[off + i] - lo) / span * 255)));
      const p = i * 4;
      img.data[p] = v; img.data[p + 1] = v; img.data[p + 2] = v; img.data[p + 3] = 255;
    }
    if (mask) {
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
          const i = y * nx + x;
          if (!mask[off + i]) continue;
          const edge =
            x === 0 || x === nx - 1 || y === 0 || y === ny - 1 ||
            !mask[off + i - 1] || !mask[off + i + 1] ||
            !mask[off + i - nx] || !mask[off + i + nx];
          if (edge) {
            const p = i * 4;
            img.data[p] = 255; img.data[p + 1] = 32; img.data[p + 2] = 32;
          }
        }
      }
    }
    tg.putImageData(img, 0, 0);

    const col = z % cols, row = Math.floor(z / cols);
    const x0 = PAD + col * (CELL_W + PAD);
    const y0 = TITLE_H + row * (cellH + LABEL_H + PAD);
    g.fillStyle = '#666';
    g.font = '10px system-ui, sans-serif';
    g.fillText(String(z), x0 + CELL_W / 2, y0 + 10);
    g.drawImage(tile, x0, y0 + LABEL_H, CELL_W, cellH);
  }

  return toBlob(canvas);
}
