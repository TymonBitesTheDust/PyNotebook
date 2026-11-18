"""Development server that mimics the Android app's request handling.

/app/*      -> web/dist
/pyodide/*  -> bundled Pyodide files (no CDN here, so extra packages 404 like offline)
/__stdin    -> blocks until /__stdin_reply posts the answer (non-SharedArrayBuffer input path)

Usage: python3 devserver.py PORT [--no-coi]
"""
import json
import mimetypes
import os
import queue
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

ROOT = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(ROOT, "..", "web", "dist")
PYODIDE = os.path.expanduser("~/vendor/pyodide/package")
COI = "--no-coi" not in sys.argv
PORT = int(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1].isdigit() else 8765

mimetypes.add_type("text/javascript", ".mjs")
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("application/wasm", ".wasm")
mimetypes.add_type("application/json", ".ipynb")
mimetypes.add_type("font/woff2", ".woff2")

stdin_waiters = {}
lock = threading.Lock()


def waiter(key):
    with lock:
        if key not in stdin_waiters:
            stdin_waiters[key] = queue.Queue(maxsize=1)
        return stdin_waiters[key]


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _headers(self, code, ctype, length=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        if length is not None:
            self.send_header("Content-Length", str(length))
        self.send_header("Cache-Control", "no-store")
        if COI:
            self.send_header("Cross-Origin-Opener-Policy", "same-origin")
            self.send_header("Cross-Origin-Embedder-Policy", "credentialless")
        self.send_header("Cross-Origin-Resource-Policy", "cross-origin")
        self.end_headers()

    def do_GET(self):
        u = urlparse(self.path)
        p = u.path
        if p == "/__stdin":
            key = parse_qs(u.query).get("id", [""])[0]
            text = waiter(key).get()
            with lock:
                stdin_waiters.pop(key, None)
            body = json.dumps({"text": text}).encode()
            self._headers(200, "application/json", len(body))
            self.wfile.write(body)
            return
        if p.startswith("/app/"):
            base, rel = WEB, p[5:] or "index.html"
        elif p.startswith("/fixtures/"):
            base, rel = os.path.join(ROOT, "fixtures"), p[10:]
        elif p.startswith("/pyodide/"):
            base, rel = PYODIDE, p[9:]
        elif p == "/":
            self.send_response(302)
            self.send_header("Location", "/app/index.html")
            self.end_headers()
            return
        else:
            return self._404()
        full = os.path.normpath(os.path.join(base, rel))
        if not full.startswith(os.path.normpath(base)) or not os.path.isfile(full):
            return self._404()
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        with open(full, "rb") as f:
            data = f.read()
        self._headers(200, ctype, len(data))
        self.wfile.write(data)

    def do_POST(self):
        if self.path == "/__stdin_reply":
            n = int(self.headers.get("Content-Length", "0"))
            m = json.loads(self.rfile.read(n) or b"{}")
            waiter(m.get("id", "")).put(m.get("text"))
            self._headers(200, "application/json", 2)
            self.wfile.write(b"{}")
            return
        self._404()

    def _404(self):
        body = b"not found"
        self._headers(404, "text/plain", len(body))
        self.wfile.write(body)


if __name__ == "__main__":
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), H)
    srv.daemon_threads = True
    print(f"serving on http://127.0.0.1:{PORT} coi={COI}", flush=True)
    srv.serve_forever()
