"""The whole server in a thread: logs, print jobs with history, versions."""
import base64
import json
import socket
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app import logs  # noqa: E402
from app.server import serve  # noqa: E402

DATA = Path(tempfile.mkdtemp())


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


PORT = free_port()
threading.Thread(target=serve, args=(DATA,), kwargs={"port": PORT}, daemon=True).start()
for _ in range(50):
    try:
        urllib.request.urlopen(f"http://127.0.0.1:{PORT}/api/health", timeout=1)
        break
    except OSError:
        time.sleep(0.1)


def call(path, body=None):
    req = urllib.request.Request(f"http://127.0.0.1:{PORT}{path}",
                                 data=None if body is None else json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def receiver():
    got = bytearray()
    srv = socket.socket()
    srv.bind(("127.0.0.1", 0))
    srv.listen(1)

    def run():
        c, _ = srv.accept()
        with c:
            while True:
                d = c.recv(65536)
                if not d:
                    break
                got.extend(d)
    t = threading.Thread(target=run, daemon=True)
    t.start()
    return srv.getsockname()[1], got, t, srv


def page():
    return {"w": 16, "h": 8, "bits": base64.b64encode(bytes(16)).decode(), "copies": 1}


def test_print_job_recorded_and_logged():
    st, saved = call("/api/library/save", {"path": "گل/فوتونیا", "label": {"elements": [], "variables": []}})
    uid = saved["uid"]
    st, b = call("/api/print/begin", {"label_uid": uid, "label_name": "فوتونیا", "counter": "شماره", "c_from": 1,
                                      "c_to": 3, "c_step": 1, "copies": 1, "planned": 3, "method": "network"})
    job = b["job"]
    port, got, t, srv = receiver()
    st, res = call("/api/print", {"job": job, "sent": 3, "last": 3, "pages": [page()] * 3,
                                  "settings": {"method": "network", "host": "127.0.0.1", "port": port}})
    t.join(5)
    srv.close()
    assert st == 200 and got.count(b"PRINT 1,1") == 3
    st, end = call("/api/print/end", {"job": job})
    assert end["status"] == "ok" and end["sent_to"] == 3
    st, h = call(f"/api/history/label?uid={uid}")
    assert h["summary"]["counters"]["شماره"]["last"] == 3 and h["jobs"][0]["status"] == "ok"
    st, tree = call("/api/library/tree")
    assert tree["printed"] == 3 and tree["folders"][0]["files"][0]["counters"] == {"شماره": 3}


def test_failed_print_marks_job():
    st, b = call("/api/print/begin", {"label_uid": "x", "counter": "شماره", "c_from": 1, "c_to": 2, "planned": 2})
    job = b["job"]
    st, err = call("/api/print", {"job": job, "sent": 2, "last": 2, "pages": [page()],
                                  "settings": {"method": "network", "host": "127.0.0.1", "port": free_port()}})
    assert st == 400 and err["code"] == "print.network_failed" and err["params"]["host"] == "127.0.0.1"
    st, end = call("/api/print/end", {"job": job})
    assert end["status"] == "error"


def test_client_log_and_request_log():
    call("/api/log", {"entries": [{"level": "error", "msg": "خطای صفحه", "ctx": {"stack": "at x"}}]})
    st, res = call("/api/library/file?path=nope.lbl")
    assert st == 400
    text = "\n".join(logs.tail(200))
    assert "[client] خطای صفحه" in text and "GET /api/library/file 400" in text and "POST /api/print/begin 200" in text
    st, errs = call("/api/logs/tail?errors=1")
    assert any("خطای صفحه" in ln for ln in errs["lines"])


def test_health_reports_app_identity():
    from app import meta
    st, h = call("/api/health")
    assert st == 200 and h["ok"] is True
    assert h["name"] == meta.APP_NAME and h["version"] == meta.VERSION and h["author"] == "Amirhossein Arani"
    assert h["repo"].startswith("https://github.com/")


def test_language_files_are_served_as_utf8_json():
    with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/i18n/fa.json", timeout=5) as r:
        assert "json" in r.headers["Content-Type"] and "utf-8" in r.headers["Content-Type"].lower()
        assert json.loads(r.read().decode("utf-8"))["app.name"]


def test_errors_carry_code_and_params():
    st, err = call("/api/library/file?path=" + urllib.parse.quote("nope/missing.lbl"))
    assert st == 400 and err["code"] == "lib.file_not_found" and err["error"]
    st, err = call("/api/no-such-endpoint", {})
    assert st == 404 and err["code"] == "req.not_found"
