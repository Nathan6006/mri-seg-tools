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

THE ITK-SNAP HELPER
-------------------
    python3 web/serve.py --itksnap ~/mri-review

A page cannot launch a program -- that is the browser sandbox doing its job --
so the review tool's "Download for ITK-SNAP" button normally ends at writing
files into the linked folder. When this server is started with `--itksnap`
pointing at THAT SAME folder, it exposes one extra endpoint the page can call,
and the button becomes "Open in ITK-SNAP": the case is written to the folder as
before, and then this process launches ITK-SNAP on the workspace. The sandbox
is respected -- the launching happens here, in a program you started, exactly
like the old Flask build did.

Deliberately narrow: flag-gated, localhost only, the request carries only a
case NAME (never a path), the name must resolve to a directory inside the
`--itksnap` folder, and the only thing that can be opened is a `.itksnap` file
found there. On the deployed site the endpoint does not exist, so the page
falls back to download-a-zip by itself.

The launch command is `ITK-SNAP -w <workspace>`, which is the documented CLI
and the one that verifiably works on macOS -- `open -a ITK-SNAP <file>` starts
the app but silently drops the document (same unregistered-UTI problem that
breaks double-clicking `.itksnap` files, see the project notes).
"""
from __future__ import annotations

import argparse
import functools
import http.server
import json
import os
import re
import shutil
import socketserver
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))

# Filled in by main() when --itksnap is given: {"dir": ..., "app": ...}
ITKSNAP = None

_MAC_APP = "/Applications/ITK-SNAP.app/Contents/MacOS/ITK-SNAP"


def find_itksnap() -> str | None:
    """The ITK-SNAP binary: $ITKSNAP override, then PATH, then the macOS app."""
    for cand in (os.environ.get("ITKSNAP"), shutil.which("itksnap"), _MAC_APP):
        if cand and os.path.isfile(cand) and os.access(cand, os.X_OK):
            return cand
    return None

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

    # ---- the ITK-SNAP helper endpoints ------------------------------------

    def _json(self, code: int, payload: dict):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _same_origin(self) -> bool:
        """
        Reject a request another website made the browser send. fetch() always
        attaches Origin to a POST; a bare curl from the terminal sends none,
        and that is the local user, who is allowed.
        """
        origin = self.headers.get("Origin")
        if origin is None:
            return True
        host = self.headers.get("Host", "")
        return origin in (f"http://{host}", f"http://localhost:{host.split(':')[-1]}",
                          f"http://127.0.0.1:{host.split(':')[-1]}")

    def do_GET(self):
        if self.path == "/itksnap/status":
            if ITKSNAP is None:
                return self._json(404, {"error": "helper not enabled"})
            return self._json(200, {"helper": True,
                                    "dir": os.path.basename(ITKSNAP["dir"])})
        return super().do_GET()

    def do_POST(self):
        if self.path != "/itksnap/open":
            return self._json(404, {"error": "no such endpoint"})
        if ITKSNAP is None:
            return self._json(404, {"error": "helper not enabled; start serve.py "
                                             "with --itksnap <folder>"})
        if not self._same_origin():
            return self._json(403, {"error": "cross-origin request refused"})
        try:
            n = int(self.headers.get("Content-Length", 0))
            case = str(json.loads(self.rfile.read(n) or b"{}").get("case", ""))
        except (ValueError, json.JSONDecodeError):
            return self._json(400, {"error": "body must be JSON: {\"case\": name}"})

        # The case is a NAME the page chose; it must never traverse anywhere.
        if not case or len(case) > 200 or re.search(r'[/\\]|\.\.', case):
            return self._json(400, {"error": f"invalid case name: {case!r}"})
        root = os.path.realpath(ITKSNAP["dir"])
        case_dir = os.path.realpath(os.path.join(root, case))
        if os.path.dirname(case_dir) != root or not os.path.isdir(case_dir):
            return self._json(404, {"error":
                f'no folder named "{case}" inside {root} -- the folder linked in '
                f'the browser must be the same one serve.py was started with'})
        workspaces = sorted(f for f in os.listdir(case_dir) if f.endswith(".itksnap"))
        if not workspaces:
            return self._json(404, {"error": f'no .itksnap workspace in "{case}"'})

        ws = os.path.join(case_dir, workspaces[0])
        # A new session per case, detached, so closing this server does not
        # take the reviewer's ITK-SNAP down with it.
        subprocess.Popen([ITKSNAP["app"], "-w", ws], cwd=case_dir,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         start_new_session=True)
        return self._json(200, {"opened": workspaces[0]})


def main() -> int:
    global ITKSNAP
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--dir", default=HERE)
    ap.add_argument("--verbose", action="store_true")
    ap.add_argument("--itksnap", metavar="FOLDER", default=None,
                    help="enable the Open-in-ITK-SNAP helper on the folder the "
                         "browser's ITK-SNAP round trip is linked to")
    args = ap.parse_args()

    if args.itksnap:
        folder = os.path.abspath(os.path.expanduser(args.itksnap))
        if not os.path.isdir(folder):
            sys.exit(f"--itksnap: {folder} is not a directory. Create it first, "
                     "and link the same folder in the browser.")
        app = find_itksnap()
        if app is None:
            sys.exit("--itksnap: could not find ITK-SNAP. Install it, or point "
                     "the ITKSNAP environment variable at the binary "
                     f"(looked at $ITKSNAP, PATH, {_MAC_APP}).")
        ITKSNAP = {"dir": folder, "app": app}

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
        if ITKSNAP:
            print(f"itksnap helper: ON — cases in {ITKSNAP['dir']} open with "
                  f"{ITKSNAP['app']}")
            print("  link that same folder in the browser (\"ITK-SNAP folder…\") "
                  "and the button becomes \"Open in ITK-SNAP\"")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nstopped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
