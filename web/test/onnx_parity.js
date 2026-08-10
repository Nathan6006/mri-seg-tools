/**
 * Does the browser produce the same segmentation as the reference?
 *
 * This is the load-bearing test for running a model client-side. The network
 * itself is ONNX and behaves the same everywhere; what can differ is the
 * wrapper -- normalisation, padding, the direction of a mirror, the argmax --
 * and every one of those failures produces a confident mask in slightly the
 * wrong place rather than an error.
 *
 * So: run the real scans through `lib/onnx.js` in a real browser, and compare
 * voxel by voxel against masks produced outside the browser by the project's
 * Python reference (which is itself checked against the training framework's
 * own validation output). Three implementations, one answer.
 *
 * The fixtures are real images and are not part of this repo. `run_onnx_parity.py`
 * stages them from a local dataset and serves them under /fixture/.
 */

import { readNifti } from '../lib/nifti.js';
import * as onnx from '../lib/onnx.js';

const out = document.getElementById('out');
const lines = [];
function say(s, cls) {
  lines.push(cls ? `<span class="${cls}">${s}</span>` : s);
  out.innerHTML = lines.join('\n');
}

const report = (payload) => fetch('/__parity_result', {
  method: 'POST', body: JSON.stringify(payload),
});

async function main() {
  const t0 = performance.now();
  const cases = await (await fetch('/fixture/list.json')).json();
  say(`${cases.length} case(s) to check`);
  say(`cross-origin isolated: ${self.crossOriginIsolated} ` +
      `(threads ${self.crossOriginIsolated ? 'enabled' : 'disabled'})`);

  // ?model=<id> picks one of several served networks; without it the site's
  // own default is tested, which is what a visitor would get.
  const params = new URLSearchParams(location.search);
  const index = await onnx.servedModelIndex('/model/');
  if (!index) {
    say('no model served at /model/ — nothing to check', 'bad');
    await report({ error: 'no model at /model/' });
    return;
  }
  const wantId = params.get('model') || index.default;
  const entry = index.models.find((m) => m.id === wantId);
  if (!entry) {
    const have = index.models.map((m) => m.id).join(', ');
    say(`no served model "${wantId}" — have ${have}`, 'bad');
    await report({ error: `no served model ${wantId}; have ${have}` });
    return;
  }
  const base = `/model/${entry.path}`;
  const manifest = await onnx.servedModelManifest(base);
  say(`model ${entry.id} (${entry.label || ''}) ${manifest.version}, ` +
      `${manifest.precision}, ${(manifest.weights_bytes / 1e6).toFixed(0)} MB ` +
      `in ${manifest.shards.length} shards`);

  const tFetch = performance.now();
  const bundle = await onnx.fetchBundle(manifest, base);
  say(`weights fetched and checksum verified in ${((performance.now() - tFetch) / 1000).toFixed(1)}s`);

  const tInit = performance.now();
  // ?backend=wasm / ?backend=webgpu pins one, so the two can be compared.
  const model = await onnx.openModel(bundle, params.get('backend'));
  say(`session started on "${model.backend}" in ${((performance.now() - tInit) / 1000).toFixed(1)}s`);
  say(`${model.dim}D model, patch ${model.patch.join('x')}, ` +
      `mirror axes [${(model.meta.mirror_axes || []).join(',')}]`);

  const results = [];
  let totalDiff = 0, totalVox = 0;
  for (const c of cases) {
    const t = performance.now();
    const img = await readNifti(new Uint8Array(
      await (await fetch(`/fixture/${c.image}`)).arrayBuffer()));
    const ref = await readNifti(new Uint8Array(
      await (await fetch(`/fixture/${c.mask}`)).arrayBuffer()));

    const { mask } = await model.segment(img, { tta: c.tta !== false });

    let diff = 0, ours = 0, theirs = 0;
    for (let i = 0; i < mask.length; i++) {
      const a = mask[i] ? 1 : 0;
      const b = ref.data[i] > 0 ? 1 : 0;
      if (a !== b) diff++;
      ours += a; theirs += b;
    }
    totalDiff += diff; totalVox += mask.length;
    const secs = (performance.now() - t) / 1000;
    results.push({ case: c.name, diff, ours, theirs, seconds: +secs.toFixed(1),
                   nz: img.nz });
    say(`  ${diff === 0 ? 'exact ' : 'DIFF  '}${c.name}  ` +
        `${diff} voxel(s) differ, fg ${ours} vs ${theirs}, ` +
        `${img.nz} slices in ${secs.toFixed(1)}s`,
        diff === 0 ? 'ok' : 'bad');
  }

  say(`\n${results.length} case(s), ${totalDiff} differing voxels of ${totalVox}`,
      totalDiff === 0 ? 'ok' : 'bad');
  await report({
    backend: model.backend,
    crossOriginIsolated: self.crossOriginIsolated,
    modelId: entry.id,
    dim: model.dim,
    version: manifest.version,
    precision: manifest.precision,
    results,
    totalDiff,
    totalVox,
    seconds: +((performance.now() - t0) / 1000).toFixed(1),
    userAgent: navigator.userAgent,
  });
}

main().catch(async (e) => {
  say(`\nERROR ${e.stack || e.message}`, 'bad');
  await report({ error: e.message, stack: e.stack });
});
