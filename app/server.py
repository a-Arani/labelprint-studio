"""Local server: serves the web UI and the JSON API."""
from __future__ import annotations

import base64
import json
import mimetypes
import os
import platform
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from . import backup, fonts, logs, meta, printing, tables
from .errors import AppError
from .history import History
from .library import Library
from .logs import LOG
from .office_import import import_file

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
VERSION = meta.VERSION

mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("text/css", ".css")
mimetypes.add_type("image/svg+xml", ".svg")
mimetypes.add_type("application/json", ".json")

# Frequent requests are only logged with --debug
QUIET = {"/api/ping", "/api/bye", "/api/library/thumb", "/api/log", "/api/library/tree", "/api/fonts"}
DATA_FOLDERS = ("", "logs", "backups", "library", "trash")


class Settings:
    def __init__(self, path: Path):
        self.path = path
        self.lock = threading.Lock()

    def load(self) -> dict:
        try:
            with open(self.path, "r", encoding="utf-8") as fh:
                return json.load(fh)
        except (OSError, ValueError):
            return {}

    def save(self, data: dict):
        with self.lock:
            tmp = self.path.with_suffix(".tmp")
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump(data, fh, ensure_ascii=False, indent=1)
            os.replace(tmp, self.path)


class App:
    def __init__(self, data_dir: Path):
        self.data_dir = data_dir
        data_dir.mkdir(parents=True, exist_ok=True)
        logs.setup(data_dir)
        LOG.info("==== %s %s started | Python %s | %s | data: %s", meta.APP_NAME, VERSION, sys.version.split()[0],
                 platform.platform(), data_dir)
        self.library = Library(data_dir)
        self.settings = Settings(data_dir / "settings.json")
        self.history = History(data_dir / "history.db")
        # Open app windows: client id -> last ping. When the last window says goodbye, the server stops.
        self.clients: dict[str, float] = {}
        self.last_contact = time.time()
        self.said_bye = False
        threading.Thread(target=self._startup_report, name="startup", daemon=True).start()
        threading.Thread(target=self._backup_loop, name="backup", daemon=True).start()

    def _startup_report(self):
        try:
            f = fonts.list_fonts()
            LOG.info("Fonts: %d families (%d Arabic-script, %d CJK)", len(f), sum(1 for x in f if x["fa"]),
                     sum(1 for x in f if x["cjk"]))
            pr = printing.list_printers()
            LOG.info("Printers: %s | default: %s",
                     "; ".join(f"{p['name']} [{p['driver']} @ {p['port']}]" for p in pr["printers"]), pr["default"])
        except Exception:
            LOG.exception("Startup report failed")

    def _backup_loop(self):
        time.sleep(20)
        while True:
            try:
                backup.make_backup(self.data_dir, self.settings.load().get("backupDir") or None)
            except Exception:
                LOG.exception("Daily backup failed")
            time.sleep(3 * 3600)

    # ------------------------------------------------------------ routes
    def route(self, method: str, path: str, q: dict, body: dict):
        lib, hist = self.library, self.history
        if path == "/api/health":
            # Also a sign of life: a second start of the app checks here before it opens its window
            self.last_contact = time.time()
            return {"ok": True, **meta.as_dict()}
        if path == "/api/ping":
            self.clients[str(body.get("client", "?"))] = self.last_contact = time.time()
            self.said_bye = False
            return {"ok": True}
        if path == "/api/bye":
            self.clients.pop(str(body.get("client", "?")), None)
            self.last_contact = time.time()
            self.said_bye = not self.clients
            return {"ok": True}
        if path == "/api/fonts":
            return {"fonts": fonts.list_fonts(refresh=q.get("refresh") == "1")}
        if path == "/api/library/tree":
            return lib.tree(hist.totals())
        if path == "/api/library/file":
            label = lib.read(q.get("path", ""))
            LOG.info("Opened: %s", q.get("path"))
            return label
        if path == "/api/library/thumb":
            data = lib.thumb(q.get("path", ""))
            return None if data is None else (data, "image/png")
        if path == "/api/logs/tail":
            return {"lines": logs.tail(int(q.get("n", 400)), q.get("errors") == "1")}
        if path == "/api/history/label":
            uid = q.get("uid", "")
            return {"summary": hist.label_summary(uid), "jobs": hist.jobs(label_uid=uid, limit=300),
                    "adjustments": hist.adjustments(uid)}
        if path == "/api/history/jobs":
            rows = hist.jobs(since=q.get("since") or None, q=q.get("q") or None, limit=int(q.get("limit", 1000)))
            return {"jobs": rows}
        if path == "/api/versions":
            label = lib.read(q.get("path", ""))
            return {"versions": lib.versions.list(label["uid"])}
        if path == "/api/products":
            rows = lib.products(q.get("template", ""))
            tot = hist.totals()
            for r in rows:
                s = tot.get(r["uid"]) or {}
                r["printed"], r["counters"] = s.get("sent", 0), s.get("counters", {})
            return {"products": rows}
        if path == "/api/backup/list":
            return {"backups": backup.list_backups(self.data_dir), "dir": str(self.data_dir / "backups")}
        if method != "POST":
            return None
        if path == "/api/log":
            for e in body.get("entries", [])[:200]:
                lvl = {"error": 40, "warn": 30, "info": 20}.get(e.get("level"), 20)
                ctx = e.get("ctx")
                LOG.log(lvl, "[client] %s%s", str(e.get("msg", ""))[:4000],
                        (" | " + json.dumps(ctx, ensure_ascii=False)[:4000]) if ctx else "")
            return {"ok": True}
        if path == "/api/library/save":
            thumb = _b64(body.get("thumb"))
            p, uid = lib.save(body["path"], body["label"], thumb, overwrite=body.get("overwrite", True),
                              version=body.get("version", "auto"))
            return {"path": p, "uid": uid}
        if path == "/api/library/mkdir":
            return {"path": lib.mkdir(body["path"])}
        if path == "/api/library/rename":
            return {"path": lib.rename(body["path"], body["name"])}
        if path == "/api/library/move":
            return {"path": lib.move(body["path"], body.get("dest", ""))}
        if path == "/api/library/copy":
            return {"path": lib.copy(body["path"], body.get("dest"))}
        if path == "/api/library/delete":
            lib.delete(body["path"])
            return {"ok": True}
        if path == "/api/versions/restore":
            return lib.restore_version(body["path"], body["id"])
        if path == "/api/import":
            name = body.get("filename", "")
            data = _b64(body.get("data")) or b""
            t0 = time.time()
            labels = import_file(name, data)
            for lb in labels:
                LOG.info("Imported '%s' (%d bytes): %d elements, %.0fx%.0f mm, fonts=%s warnings=%s, %.2f s",
                         name, len(data), len(lb["elements"]), lb["page"]["w"], lb["page"]["h"],
                         lb["meta"]["fonts"], lb["meta"]["warnings"], time.time() - t0)
            return {"labels": labels}
        if path == "/api/table":
            return tables.read_table(body.get("filename", ""), _b64(body.get("data")) or b"")
        if path == "/api/printers":
            return printing.list_printers()
        if path == "/api/printer/command":
            return printing.send_command(body.get("cmd", ""), body.get("settings", {}))
        if path == "/api/printer/caps":
            return printing.printer_caps(printing.resolve_printer(body.get("printer", "")))
        if path == "/api/settings/get":
            return self.settings.load()
        if path == "/api/settings/set":
            data = self.settings.load()
            data.update(body)
            self.settings.save(data)
            LOG.info("Settings changed: %s", ", ".join(body.keys()))
            return {"ok": True}
        if path == "/api/print/begin":
            return {"job": hist.begin(body)}
        if path == "/api/print":
            pages = []
            for pg in body.get("pages", []):
                pages.append({"w": int(pg["w"]), "h": int(pg["h"]), "bits": _b64(pg["bits"]),
                              "copies": int(pg.get("copies", 1))})
            job = body.get("job")
            st = body.get("settings", {})
            try:
                res = printing.print_pages(pages, st, body.get("jobName", "Label"))
            except printing.PrintError as ex:
                if job:
                    hist.fail(int(job), str(ex))
                raise
            LOG.info("Print #%s batch: %d page(s) (%s labels, up to number %s) -> %s", job, len(pages),
                     body.get("sent"), body.get("last"), res)
            if job:
                hist.batch(int(job), int(body.get("sent") or sum(p["copies"] for p in pages)), body.get("last"))
            return res
        if path == "/api/print/end":
            if body.get("error"):  # a browser-side error, e.g. an invalid barcode
                hist.fail(int(body["job"]), str(body["error"]))
            return hist.finish(int(body["job"]), bool(body.get("cancelled")))
        if path == "/api/history/adjust":
            hist.adjust(body["uid"], body["counter"], body["value"], body.get("note", ""))
            return {"ok": True}
        if path == "/api/backup/now":
            p = backup.make_backup(self.data_dir, self.settings.load().get("backupDir") or None, force=True)
            return {"path": str(p)}
        if path == "/api/diagnostics":
            p = backup.diagnostics(self.data_dir, VERSION, hist, {"printers": printing.list_printers()})
            os.startfile(str(p.parent))
            return {"path": str(p)}
        if path == "/api/open-data":
            sub = body.get("sub", "")
            if sub not in DATA_FOLDERS:
                return None
            d = self.data_dir / sub
            d.mkdir(parents=True, exist_ok=True)
            os.startfile(str(d))  # local machine only
            return {"ok": True}
        return None


def _b64(s) -> bytes | None:
    if not s:
        return None
    if isinstance(s, str) and s.startswith("data:"):
        s = s.split(",", 1)[1]
    return base64.b64decode(s)


def make_handler(app: App):
    class Handler(BaseHTTPRequestHandler):
        server_version = f"{meta.APP_ID}/{VERSION}"

        def log_message(self, fmt, *args):
            LOG.debug("http: " + fmt, *args)

        def _send(self, code: int, data: bytes, ctype: str):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)
            self._out = len(data)

        def _json(self, code: int, obj):
            self._send(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")

        def _handle(self, method: str):
            t0 = time.time()
            url = urlparse(self.path)
            path = url.path
            self._out = 0
            if not path.startswith("/api/"):
                return self._static(path)
            q = {k: v[0] for k, v in parse_qs(url.query).items()}
            body, size = {}, 0
            if method == "POST":
                size = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(size) if size else b""
                try:
                    body = json.loads(raw.decode("utf-8")) if raw else {}
                except ValueError:
                    LOG.warning("Invalid request to %s", path)
                    return self._json(400, {"error": "Invalid request", "code": "req.bad"})
            code, err, res = 200, None, None
            try:
                res = app.route(method, path, q, body)
                if res is None:
                    code, err = 404, {"error": "Not found", "code": "req.not_found"}
            except AppError as ex:
                code, err = 400, ex.to_json()
                LOG.warning("%s %s -> error %s: %s", method, path, ex.code, ex)
            except Exception as ex:
                code, err = 500, {"error": f"Internal error: {ex}", "code": "req.internal", "params": {"error": str(ex)}}
                LOG.exception("%s %s -> internal error (params: %s)", method, path,
                              {k: (v if len(str(v)) < 200 else f"<{len(str(v))} chars>") for k, v in {**q, **body}.items()})
            try:
                if err is not None:
                    self._json(code, err)
                elif isinstance(res, tuple):
                    self._send(200, res[0], res[1])
                else:
                    self._json(200, res)
            except OSError as ex:  # the page went away before the answer
                LOG.warning("%s %s: could not send the response (%s)", method, path, ex)
            ms = (time.time() - t0) * 1000
            lvl = 10 if path in QUIET and code == 200 else 20
            LOG.log(lvl, "%s %s %d %.0fms in=%.1fKB out=%.1fKB", method, path, code, ms, size / 1024, self._out / 1024)

        def _static(self, path: str):
            if path in ("", "/"):
                path = "/index.html"
            target = (WEB / path.lstrip("/")).resolve()
            if WEB not in target.parents or not target.is_file():
                return self._json(404, {"error": "Not found", "code": "req.not_found"})
            ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
            if ctype.startswith("text/") or ctype.endswith(("javascript", "json")):
                ctype += "; charset=utf-8"
            self._send(200, target.read_bytes(), ctype)

        def do_GET(self):
            self._handle("GET")

        def do_POST(self):
            self._handle("POST")

    return Handler


def serve(data_dir: Path, host: str = "127.0.0.1", port: int = 8803, idle_exit: float = 0,
          bye_grace: float = 4, closed: threading.Event | None = None) -> None:
    """idle_exit: stop when no window has been heard from for this many seconds (0 = never).
    bye_grace: after the last window closes, wait this long (a reload or language switch comes straight back).
    closed: set by the launcher when its app window closes (with closed.at = the time); the server then stops
    within 2 seconds, unless the app was started again meanwhile."""
    app = App(data_dir)
    httpd = ThreadingHTTPServer((host, port), make_handler(app))
    httpd.daemon_threads = True
    if idle_exit or closed is not None:
        def watchdog():
            while True:
                time.sleep(0.5)
                now = time.time()
                if closed is not None and closed.is_set():
                    at = getattr(closed, "at", now)
                    if any(seen > at for seen in app.clients.values()):
                        closed.clear()          # a new window opened meanwhile
                    elif now - max(at, app.last_contact) > 2:
                        LOG.info("The app window was closed; stopping the server")
                        break
                if not idle_exit:
                    continue
                for cid, seen in list(app.clients.items()):
                    if now - seen > 45:
                        app.clients.pop(cid, None)
                if app.clients:
                    continue
                if now - app.last_contact > (bye_grace if app.said_bye else idle_exit):
                    LOG.info("No app window is open; stopping the server")
                    break
            httpd.shutdown()
        threading.Thread(target=watchdog, name="watchdog", daemon=True).start()
    LOG.info("Server ready at http://%s:%d", host, port)
    try:
        httpd.serve_forever()
    finally:
        httpd.server_close()
        app.history.close()
        LOG.info("==== %s stopped", meta.APP_NAME)
