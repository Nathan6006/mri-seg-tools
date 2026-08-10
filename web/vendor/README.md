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
  one falls back to WebAssembly. **This is the first thing to re-test when
  bumping the version**, because it is the difference between seconds and a
  minute per scan.

  Note that the session *builds* fine and only fails inside the kernel, so
  `lib/onnx.js` pushes one empty patch through before accepting a backend.
  Without that probe the model appears to load and the first real scan throws.
  **The probe uses a throwaway session**: probing and then reusing the same
  WebGPU session left state behind that made real masks badly wrong (4,641
  foreground voxels against a correct 31,749). A fresh session restores normal
  behaviour.
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
model served. The CPU one must still be exact; if it is not, the new version
changed something numerical and that needs understanding before it ships. And
check whether WebGPU has learned the 3-D convolution above — if it has, that is
a large speed-up and worth taking.
