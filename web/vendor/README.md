# Vendored third-party code

| File | What | Version | Licence |
|---|---|---|---|
| `ort.webgpu.bundle.min.mjs` | onnxruntime-web, WebGPU + WASM build | 1.20.1 | MIT |
| `ort-wasm-simd-threaded.jsep.wasm` | its WebAssembly binary | 1.20.1 | MIT |

Copied verbatim from the `onnxruntime-web` npm package. Not modified.

## Why these are committed rather than fetched

`_headers` sets `connect-src 'self'`, so the page is not permitted to contact
any other host. That is the whole privacy claim — the tab talks to nobody — and
loading the runtime from a CDN would either break it or require punching a hole
in it. Self-hosting keeps the claim absolute and the site working offline.

`lib/onnx.js` sets `ort.env.wasm.wasmPaths` to this folder for the same reason:
without it the runtime looks for its `.wasm` on a CDN by default.

## Which build, and why

The `webgpu.bundle` variant, because:

* **webgpu** — it carries both execution providers, so one file covers Chrome
  and Edge (GPU, ~9× faster) and every other browser (WebAssembly). Shipping
  the WASM-only build would give up the fast path; shipping both would be two
  copies of a 20 MB binary.

  **The WebGPU provider does not implement every operator.** At 1.20.1 it
  refuses a 3-D convolution with asymmetric padding —
  `Unsupported padding parameter: 0,1,1,0,1,1` — which is what a 3-D U-Net with
  anisotropy-aware `(1,3,3)` kernels produces. A 2-D model runs on WebGPU; a 3-D
  one falls back to WebAssembly.

  **Do not treat that as a bug waiting to be fixed.** It was chased to the end.
  Version 1.27 lifts the padding restriction, and the one operator still missing
  after it — a 3-D `ConvTranspose` — can be removed from the graph exactly,
  because a transposed convolution with kernel == stride is a 1×1×1 convolution
  plus a 3-D pixel shuffle (verified: max absolute difference 0.0 against the
  original graph). With that done the model runs on WebGPU **about ten times
  slower than on the CPU** — 63 s per pass against 5.9 s. The 3-D convolution
  kernels are a naive fallback.

  So when bumping the version, **measure throughput rather than checking whether
  it runs.** A build that newly runs a 3-D model on WebGPU, without also making
  it fast, is a regression and the probe below will not catch it.

  Note that the session *builds* fine and only fails inside the kernel. That
  used to be handled by pushing one empty patch through before accepting a
  backend — **do not put that probe back.** Running anything through a WebGPU
  session before the real input corrupts it, and a throwaway session does not
  help: measured repeatably, a 2-D model with the probe returns an empty mask on
  small lesions that it segments exactly without it. `lib/onnx.js` now picks the
  backend from the model's dimensionality and falls back to WebAssembly if a run
  fails.
* **bundle** — the worker script is inlined rather than loaded as a separate
  file, which keeps the Content-Security-Policy to a single `worker-src` blob
  allowance instead of several script paths.

The `.wasm` is 21.7 MB, under the 25 MB per-file limit static hosts impose.
That is not much headroom, so check it if the version is ever bumped.

## Updating

```bash
npm install onnxruntime-web@<version>
cp node_modules/onnxruntime-web/dist/ort.webgpu.bundle.min.mjs        web/vendor/
cp node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm web/vendor/
```

Then re-run `web/test/run_onnx_parity.py` on **both** backends, for **each**
model served, and **with `--no-tta`**, since that is how the tool runs by
default. The CPU one must still be exact; if it is not, the new version changed
something numerical and that needs understanding before it ships.
