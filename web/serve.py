#!/usr/bin/env python3
"""
Serve this folder the way the real host does.

    python3 web/serve.py            # http://localhost:8000
    python3 web/serve.py --port 9000

`python3 -m http.server` is enough to click around, but it cannot send headers,
and two of the ones in `_headers` change how the tool actually behaves:

  * COOP + COEP make the page cross-origin isolated, which is what allows
    SharedArrayBuffer and therefore multi-threaded inference. Without them the
    model still runs, on one thread, several times slower -- so a scan that
    takes 20 seconds on the deployed site can take a couple of minutes locally
    and look like a bug.
  * The Content-Security-Policy is what proves the page cannot phone home. If
    it is only ever exercised in production, a violation gets found by the lab
    rather than here.

So this serves the same headers, and testing locally means something.

It is a development server: single-threaded, no caching, listening on
localhost only. Do not host anything with it.
"""
from __future__ import annotations

import argparse
import functools
import http.server
import os
import socketserver
import sys

HERE = os.path.dirname(os.path.abspath(__file__))

# Kept deliberately in step with _headers. If you change one, change the other;
# the point of this file is that local and hosted behave the same.
HEADERS = {
    "Content-Security-Policy": (
        "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; "
        "worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; "
        "img-src 'self' blob: data:; connect-src 'self'; font-src 'self'; "
        "object-src 'none'; base-uri 'none'; form-action 'none'; "
        "frame-ancestors 'self'"
    ),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), interest-cohort=()",
}


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        for k, v in HEADERS.items():
            self.send_header(k, v)
        # A stale model or app.js served from cache while developing is a
        # spectacular waste of an afternoon.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def guess_type(self, path):
        # Python's mimetypes does not know .wasm on every platform, and the
        # runtime refuses to stream-compile anything not served as
        # application/wasm -- it falls back to a slower path, or fails outright.
        if path.endswith(".wasm"):
            return "application/wasm"
        if path.endswith(".mjs"):
            return "text/javascript"
        return super().guess_type(path)

    def log_message(self, fmt, *args):
        if "--verbose" in sys.argv:
            super().log_message(fmt, *args)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--dir", default=HERE)
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args()

    handler = functools.partial(Handler, directory=args.dir)
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("127.0.0.1", args.port), handler) as httpd:
        print(f"serving {args.dir} on http://localhost:{args.port}")
        print("cross-origin isolated, so inference runs multi-threaded")
        model = os.path.join(args.dir, "model", "manifest.json")
        print("model/: present — the page will load it on startup"
              if os.path.exists(model)
              else "model/: not present — the page will run on the stub until "
                   "you load a model folder")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nstopped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
