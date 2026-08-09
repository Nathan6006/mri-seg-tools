#!/usr/bin/env python3
"""
Run web/test/selftest.html in a real browser and report the result.

    .venv/bin/python web/test/run_selftest.py            # headless Chrome
    .venv/bin/python web/test/run_selftest.py --show     # a visible window
    .venv/bin/python web/test/run_selftest.py --serve    # just serve; open it yourself

Why a browser at all: most of the static build cannot run under node. IndexedDB,
canvas and CompressionStream are browser APIs, and Safari and Firefox differ
from Chrome on storage in ways worth catching. `--serve` prints a URL so the
same suite can be pointed at any browser on the machine.

Chrome's own `--virtual-time-budget --dump-dom` does not work here: it hangs on
the IndexedDB transactions rather than fast-forwarding them. So the page posts
its results back to this server instead, which is more reliable and also gives
a readable failure list rather than a wall of DOM.
"""
from __future__ import annotations

import argparse
import http.server
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time

WEB = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

CHROME_CANDIDATES = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    shutil.which("google-chrome") or "",
    shutil.which("chromium") or "",
    shutil.which("chromium-browser") or "",
]

result: dict = {}
done = threading.Event()


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=WEB, **kw)

    def do_POST(self):
        if self.path != "/__selftest_result":
            self.send_error(404)
            return
        n = int(self.headers.get("Content-Length", 0))
        result.update(json.loads(self.rfile.read(n) or b"{}"))
        self.send_response(204)
        self.end_headers()
        done.set()

    def log_message(self, *a):
        pass                      # the access log is noise here


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--show", action="store_true",
                    help="run in a visible browser window instead of headless")
    ap.add_argument("--serve", action="store_true",
                    help="serve and wait; open the URL in whatever browser you like")
    ap.add_argument("--timeout", type=int, default=180)
    args = ap.parse_args()

    port = free_port()
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{port}/test/selftest.html?report"
    print(f"serving {WEB} at http://127.0.0.1:{port}")

    proc = None
    profile = None
    if args.serve:
        print(f"\nOpen this, in any browser:\n\n    {url}\n")
    else:
        exe = next((c for c in CHROME_CANDIDATES if c and os.path.exists(c)), None)
        if not exe:
            print("No Chrome, Chromium or Edge found. Use --serve and open the "
                  "URL yourself.", file=sys.stderr)
            return 2
        profile = tempfile.mkdtemp(prefix="selftest_")
        cmd = [exe, f"--user-data-dir={profile}", "--no-first-run",
               "--no-default-browser-check", "--disable-gpu", url]
        if not args.show:
            cmd.insert(1, "--headless=new")
        print(f"launching {os.path.basename(exe)}"
              f"{'' if args.show else ' (headless)'}")
        proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL)

    try:
        if not done.wait(args.timeout):
            print(f"\nno result after {args.timeout}s.", file=sys.stderr)
            if not args.serve:
                print("Try --show to watch it, or --serve and open it yourself.",
                      file=sys.stderr)
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

    print()
    for r in result.get("results", []):
        mark = "ok  " if r["ok"] else "FAIL"
        print(f"  {mark}  {r['name']}  ({r['ms']:.0f} ms)")
        if not r["ok"]:
            for line in (r.get("error") or "").splitlines():
                print(f"          {line}")

    ua = result.get("userAgent", "")
    passed, failed = result.get("passed", 0), result.get("failed", 1)
    print(f"\n{'=' * 62}")
    print(f"{passed} passed, {failed} failed")
    if ua:
        print(ua)
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
