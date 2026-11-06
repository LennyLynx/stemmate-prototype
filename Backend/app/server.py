"""HTTP layer: routing, JSON, token check, clean errors, static files for the web interface.
Never returns stack traces. Logs only the method, path and status (no tokens, no bodies)."""
import json
import mimetypes
import os
import re
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

from . import __version__, db
from .service import Service, ServiceError

MAX_BODY = 256 * 1024
STATIC_DIR = os.path.join(db.ROOT, "static")
CSP = ("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; "
       "connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
MIME = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
        ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".png": "image/png"}
ID_PATH = re.compile(r"^/api/lessons/(\d+)$")


def make_server(service, host="127.0.0.1", port=8000, static_dir=STATIC_DIR, cors_origins=None, quiet=False):
    cors = [o.strip() for o in (cors_origins if cors_origins is not None
                                else os.environ.get("STEMMATE_CORS_ORIGIN", "").split(",")) if o.strip()]

    class Handler(BaseHTTPRequestHandler):
        server_version = "STEMMate/" + __version__
        sys_version = ""

        # -- logging: method, path (no query string), status ------------------------------------
        def log_message(self, fmt, *args):
            if not quiet:
                sys.stderr.write("%s %s %s\n" % (self.command, urlsplit(self.path).path, args[1] if len(args) > 1 else ""))

        # -- response helpers ---------------------------------------------------------------------
        def _headers(self, status, ctype, length, extra=None, api=True):
            self.send_response(status)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(length))
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("Cache-Control", "no-store" if api else "no-cache")
            if not api:
                self.send_header("Content-Security-Policy", CSP)
            origin = self.headers.get("Origin")
            if origin and origin in cors:
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Vary", "Origin")
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()

        def _json(self, status, body, extra=None):
            raw = json.dumps(body, ensure_ascii=False).encode("utf-8")
            self._headers(status, "application/json; charset=utf-8", len(raw), extra)
            if self.command != "HEAD":
                self.wfile.write(raw)

        def _error(self, status, code, message, extra=None):
            self._json(status, {"error": {"code": code, "message": message}}, extra)

        def _read_json(self):
            """Return the parsed JSON object, or None after sending an error response."""
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                length = -1
            if length < 0:
                self._error(400, "bad_request", "The request could not be read.")
                return None
            if length > MAX_BODY:
                self.close_connection = True
                self._error(413, "too_large", "The request is too large.")
                return None
            raw = self.rfile.read(length) if length else b""
            try:
                body = json.loads(raw.decode("utf-8") or "{}")
            except (ValueError, UnicodeDecodeError):
                self._error(400, "bad_request", "The request body is not valid JSON.")
                return None
            if not isinstance(body, dict):
                self._error(400, "bad_request", "The request body must be a JSON object.")
                return None
            return body

        def _token(self):
            h = self.headers.get("Authorization", "")
            return h[7:].strip() if h.startswith("Bearer ") else None

        def _who(self):
            fid = service.authenticate(self._token())
            if fid is None:
                self._error(401, "unauthorised", "Please sign in again.")
            return fid

        # -- verbs ----------------------------------------------------------------------------------
        def do_OPTIONS(self):
            self._headers(204, "text/plain", 0, {
                "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
                "Access-Control-Allow-Headers": "Authorization, Content-Type",
                "Access-Control-Max-Age": "600"})

        def do_HEAD(self):
            self.do_GET()

        def do_GET(self):
            self._dispatch("GET")

        def do_POST(self):
            self._dispatch("POST")

        def do_PUT(self):
            self._dispatch("PUT")

        def do_DELETE(self):
            self._dispatch("DELETE")

        def _dispatch(self, method):
            parts = urlsplit(self.path)
            path, query = parts.path, parse_qs(parts.query)
            try:
                if not path.startswith("/api/"):
                    return self._static(method, path)
                self._route(method, path, query)
            except ServiceError as e:
                extra = {"Retry-After": str(e.extra["retryAfterSec"])} if "retryAfterSec" in e.extra else None
                self._json(e.status, e.body(), extra)
            except Exception as e:                # noqa: BLE001 - last resort, never leak details
                if not quiet:
                    sys.stderr.write("ERROR %s %s %s\n" % (method, path, type(e).__name__))
                self._error(500, "server_error", "Something went wrong on the server. Your data is still on your device; try again later.")

        # -- API routes -----------------------------------------------------------------------------
        def _route(self, method, path, query):
            if path == "/api/health" and method in ("GET", "HEAD"):
                return self._json(200, {"status": "ok", "version": __version__})
            if path == "/api/activities" and method in ("GET", "HEAD"):
                items = service.activities()
                return self._json(200, {"count": len(items), "activities": items})
            if path == "/api/auth/login" and method == "POST":
                body = self._read_json()
                if body is None:
                    return
                return self._json(200, service.login(body.get("facilitatorId"), body.get("pin")))

            known = (path in ("/api/auth/logout", "/api/me", "/api/me/delete-all", "/api/lessons", "/api/sync",
                              "/api/export") or ID_PATH.match(path))
            if not known:
                return self._error(404, "not_found", "Not found.")
            fid = self._who()
            if fid is None:
                return

            if path == "/api/auth/logout" and method == "POST":
                service.logout(self._token())
                return self._json(200, {"signedOut": True})
            if path == "/api/me" and method == "GET":
                return self._json(200, service.me(fid))
            if path == "/api/me/delete-all" and method == "POST":
                body = self._read_json()
                if body is None:
                    return
                return self._json(200, service.delete_all(fid, body.get("confirm")))
            if path == "/api/lessons" and method == "GET":
                return self._json(200, {"lessons": service.list_lessons(fid)})
            if path == "/api/lessons" and method == "POST":
                body = self._read_json()
                if body is None:
                    return
                status, lesson, duplicate = service.create_lesson(fid, body, body.get("clientId"))
                return self._json(status, {"lesson": lesson, "duplicate": duplicate})
            if path == "/api/sync" and method == "POST":
                body = self._read_json()
                if body is None:
                    return
                return self._json(200, service.sync(fid, body.get("ops")))
            if path == "/api/export" and method == "GET":
                ctype, name, raw = service.export(fid, (query.get("format") or ["json"])[0])
                self._headers(200, ctype, len(raw), {"Content-Disposition": 'attachment; filename="%s"' % name})
                self.wfile.write(raw)
                return
            m = ID_PATH.match(path)
            if m:
                lesson_id = int(m.group(1))
                if method == "GET":
                    return self._json(200, {"lesson": service.get_lesson(fid, lesson_id)})
                if method == "PUT":
                    body = self._read_json()
                    if body is None:
                        return
                    return self._json(200, {"lesson": service.update_lesson(fid, lesson_id, body, body.get("baseVersion"))})
                if method == "DELETE":
                    bv = (query.get("baseVersion") or [None])[0]
                    service.delete_lesson(fid, lesson_id, int(bv) if bv and bv.isdigit() else None)
                    return self._json(200, {"deleted": True})
            return self._error(405, "method_not_allowed", "That method is not allowed here.")

        # -- static files (whitelist: files that exist directly inside the static folder) -------------
        def _static(self, method, path):
            if method not in ("GET", "HEAD"):
                return self._error(405, "method_not_allowed", "That method is not allowed here.")
            name = "index.html" if path in ("/", "") else path.lstrip("/")
            if "/" in name or "\\" in name or name.startswith(".") or not os.path.isdir(static_dir) \
                    or name not in os.listdir(static_dir):
                return self._error(404, "not_found", "Not found.")
            with open(os.path.join(static_dir, name), "rb") as fh:
                raw = fh.read()
            ctype = MIME.get(os.path.splitext(name)[1]) or mimetypes.guess_type(name)[0] or "application/octet-stream"
            self._headers(200, ctype, len(raw), api=False)
            if method != "HEAD":
                self.wfile.write(raw)

    httpd = ThreadingHTTPServer((host, port), Handler)
    httpd.daemon_threads = True
    return httpd


def serve_in_thread(httpd):
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    return t
