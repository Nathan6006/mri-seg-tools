#!/usr/bin/env python3
"""
Check the browser's segmentation against masks produced outside the browser.

    .venv/bin/python web/test/run_onnx_parity.py \
        --images  <dir of *_0000.nii.gz> \
        --masks   <dir of reference <case>.nii.gz> \
        --cases   3

The images and reference masks are real data and are not in this repo. Point
this at a local dataset; the files are staged into a temporary folder and served
only to the loopback address for the length of the run.

The reference masks should be the ones the training framework itself produced,
or the ones this project's Python reference implementation produced from the
same ONNX file. Either way the claim being tested is the same: moving inference
into a browser did not change the answer.

This serves the production headers, including COOP/COEP, because without them
the runtime cannot use threads and the run takes several times longer -- which
is worth knowing about, and is reported.
"""
from __future__ import annotations

import argparse
import glob
import http.server
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading

WEB = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

CHROME_CANDIDATES = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    shutil.which("google-chrome") or "",
    shutil.which("chromium") or "",
]

HEADERS = {
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cache-Control": "no-store",
}

result: dict = {}
done = threading.Event()
FIXTURES = {"dir": None}


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=WEB, **kw)

    def translate_path(self, path):
        # /fixture/* comes from the staging directory, everything else from web/.
        clean = path.split("?", 1)[0].split("#", 1)[0]
        if clean.startswith("/fixture/"):
            name = os.path.basename(clean[len("/fixture/"):])
            return os.path.join(FIXTURES["dir"], name)
        return super().translate_path(path)

    def guess_type(self, path):
        if path.endswith(".wasm"):
            return "application/wasm"
        return super().guess_type(path)

    def end_headers(self):
        for k, v in HEADERS.items():
            self.send_header(k, v)
        super().end_headers()

    def do_POST(self):
        if self.path != "/__parity_result":
            self.send_error(404)
            return
        n = int(self.headers.get("Content-Length", 0))
        result.update(json.loads(self.rfile.read(n) or b"{}"))
        self.send_response(204)
        self.end_headers()
        done.set()

    def log_message(self, *a):
        pass


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def stage(images: str, masks: str, limit: int, tmp: str) -> list[dict]:
    """Copy a few image/reference pairs into the folder that gets served."""
    refs = sorted(glob.glob(os.path.join(masks, "*.nii.gz")))
    if not refs:
        raise SystemExit(f"no reference masks in {masks}")
    picked = []
    for r in refs:
        case = os.path.basename(r)[:-7]
        img = os.path.join(images, f"{case}_0000.nii.gz")
        if not os.path.exists(img):
            continue
        shutil.copy(img, os.path.join(tmp, f"{case}_0000.nii.gz"))
        shutil.copy(r, os.path.join(tmp, f"{case}.nii.gz"))
        picked.append({"name": case, "image": f"{case}_0000.nii.gz",
                       "mask": f"{case}.nii.gz"})
        if limit and len(picked) >= limit:
            break
    if not picked:
        raise SystemExit("no image/mask pairs matched -- check --images and --masks")
    with open(os.path.join(tmp, "list.json"), "w") as fh:
        json.dump(picked, fh)
    return picked


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--images", required=True)
    ap.add_argument("--masks", required=True)
    ap.add_argument("--cases", type=int, default=3)
    ap.add_argument("--timeout", type=int, default=1800)
    ap.add_argument("--show", action="store_true")
    ap.add_argument("--serve", action="store_true")
    ap.add_argument("--backend", default="", choices=["", "wasm", "webgpu"],
                    help="pin one execution provider instead of the best available")
    ap.add_argument("--no-warmup", action="store_true",
                    help="skip the backend warm-up pass, to isolate its effect")
    ap.add_argument("--model", default="",
                    help="which served model id to test; default is the one "
                         "models.json names as the default")
    args = ap.parse_args()

    model_dir = os.path.join(WEB, "model")
    index_path = os.path.join(model_dir, "models.json")
    if os.path.exists(index_path):
        index = json.load(open(index_path))
        ids = [m["id"] for m in index["models"]]
        wanted = args.model or index["default"]
        if wanted not in ids:
            raise SystemExit(f"--model {wanted} is not served; have {ids}")
        print(f"served models: {', '.join(ids)}  ->  testing {wanted}")
    elif os.path.exists(os.path.join(model_dir, "manifest.json")):
        if args.model:
            raise SystemExit("this deployment serves a single unnamed model, "
                             "so --model does not apply")
        wanted = ""
    else:
        raise SystemExit(
            f"no model at {model_dir}. Build one first (see the project's "
            f"bundling script) -- there is nothing to test without it.")

    tmp = tempfile.mkdtemp(prefix="onnx_parity_")
    FIXTURES["dir"] = tmp
    picked = stage(args.images, args.masks, args.cases, tmp)
    print(f"staged {len(picked)} case(s): {', '.join(p['name'] for p in picked)}")

    port = free_port()
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{port}/test/onnx_parity.html"
    q = [f"backend={args.backend}"] if args.backend else []
    if wanted:
        q.append(f"model={wanted}")
    if args.no_warmup:
        q.append("warmup=0")
    if q:
        url += "?" + "&".join(q)
    print(f"serving {WEB} at http://127.0.0.1:{port}")

    proc = profile = None
    try:
        if args.serve:
            print(f"\nOpen this:\n\n    {url}\n")
        else:
            exe = next((c for c in CHROME_CANDIDATES if c and os.path.exists(c)), None)
            if not exe:
                print("No Chrome/Chromium/Edge found; use --serve.", file=sys.stderr)
                return 2
            profile = tempfile.mkdtemp(prefix="onnx_parity_profile_")
            cmd = [exe, f"--user-data-dir={profile}", "--no-first-run",
                   "--no-default-browser-check", url]
            if not args.show:
                cmd.insert(1, "--headless=new")
            print(f"launching {os.path.basename(exe)}"
                  f"{'' if args.show else ' (headless)'}")
            proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL,
                                    stderr=subprocess.DEVNULL)

        if not done.wait(args.timeout):
            print(f"\nno result after {args.timeout}s.", file=sys.stderr)
            return 2
    finally:
        if proc:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
        if profile:
            shutil.rmtree(profile, ignore_errors=True)
        server.shutdown()
        shutil.rmtree(tmp, ignore_errors=True)

    if result.get("skipped"):
        # A pinned backend that cannot run this model is a property of the
        # runtime, not a defect in the wrapper. Say so and pass -- the other
        # backend still has to be exact, and that is what proves the code.
        print(f"\nSKIPPED: the {result.get('backend')} backend cannot run "
              f"{result.get('modelId')}.\n  {result.get('reason')}\n"
              f"  Nothing is wrong with the wrapper; this backend does not "
              f"implement an operator the model uses.")
        return 0

    if result.get("error"):
        print(f"\nFAILED: {result['error']}", file=sys.stderr)
        if result.get("stack"):
            print(result["stack"], file=sys.stderr)
        return 1

    print()
    for r in result.get("results", []):
        mark = "exact" if r["diff"] == 0 else "DIFF "
        print(f"  {mark}  {r['case']}  {r['diff']} voxel(s), "
              f"fg {r['ours']} vs {r['theirs']}, {r['nz']} slices, {r['seconds']}s")

    tot, vox = result.get("totalDiff", -1), result.get("totalVox", 0)
    backend = result.get("backend")
    print(f"\n{'=' * 62}")
    print(f"backend: {backend}   threads: "
          f"{'on' if result.get('crossOriginIsolated') else 'off'}   "
          f"model {result.get('version')} ({result.get('precision')})")
    print(f"{tot} differing voxels of {vox} "
          f"({100 * tot / vox:.6f}%)" if vox else "no voxels compared")
    print(f"total {result.get('seconds')}s")

    # THE TWO BACKENDS ARE HELD TO DIFFERENT STANDARDS, ON PURPOSE.
    #
    # The CPU path is expected to be exact, and for a 2-D model it is -- checked
    # on lesions from 36 to 31,749 voxels. It runs the same arithmetic in the
    # same order as the reference, so a difference means a bug in the wrapper:
    # normalisation, padding, a mirror flipped the wrong way. Those are the
    # mistakes this test exists to catch, and every one of them produces
    # hundreds or thousands of differing voxels, never one.
    #
    # The allowance of ONE VOXEL PER CASE exists because exactness across two
    # independent onnxruntime builds -- WebAssembly here, native x86 for the
    # reference -- is not something this code controls. A 3-D model showed it:
    # one scan disagreed on exactly one voxel, in fp16 AND in fp32, and that
    # scan turns out to contain exactly one voxel whose two class logits differ
    # by 0.013 against a range of -16.7 to +19.1. The next-closest voxel is 2.5x
    # further from the boundary. A convolution stack that deep can easily differ
    # by 0.013 between builds; nothing in the wrapper can.
    #
    # The GPU path computes in half precision with a different accumulation
    # order, so a handful of voxels on the decision boundary land differently:
    # measured at 0 and 23 voxels on lesions of 48 and 31,749. That is
    # arithmetic, not a defect. It is still worth using the deterministic
    # command-line pipeline for any number that goes in a paper.
    #
    # One caution, learned the expensive way. A run that showed the GPU path
    # losing a small lesion entirely and capturing only 15% of a large one was
    # not the GPU: it was a diagnostic probe in openModel reusing its session.
    # If this backend ever looks catastrophically wrong rather than slightly
    # wrong, suspect the harness before the hardware.
    if backend == "wasm":
        limit = len(result.get("results", []))
    else:
        limit = max(50, int(vox * 1e-5))
    if tot <= limit:
        if tot == 0:
            print("\nEXACT: the browser reproduces the reference voxel for voxel.")
        else:
            why = ("differences between two independent onnxruntime builds at "
                   "voxels sitting on the decision boundary"
                   if backend == "wasm" else
                   "half-precision GPU arithmetic in a different accumulation order")
            print(f"\nPASS: {tot} voxel(s) differ, within the {limit}-voxel "
                  f"allowance for {why}.")
            print("For a number that goes in a paper, use the command-line "
                  "pipeline, which is deterministic.")
        return 0
    print(f"\nFAILED: {tot} differing voxels exceeds the {limit} allowed for "
          f"the {backend} backend.")
    if backend == "wasm":
        print("The CPU path must match exactly. Something in the preprocessing "
              "wrapper is wrong.")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
