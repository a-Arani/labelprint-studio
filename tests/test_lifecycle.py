"""The server stops soon after the last app window closes, but survives a reload (such as a language switch)."""
import json
import socket
import sys
import tempfile
import threading
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app.server import serve  # noqa: E402


def start(**kw):
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    t = threading.Thread(target=serve, args=(Path(tempfile.mkdtemp()),), kwargs={"port": port, **kw}, daemon=True)
    t.start()
    for _ in range(50):
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=1)
            break
        except OSError:
            time.sleep(0.1)
    return port, t


def call(port, path, body):
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=json.dumps(body).encode(),
                                 headers={"Content-Type": "text/plain"})
    with urllib.request.urlopen(req, timeout=5) as r:
        return json.loads(r.read())


def test_stops_after_last_window_says_goodbye():
    port, t = start(idle_exit=60, bye_grace=1)
    call(port, "/api/ping", {"client": "a"})
    call(port, "/api/ping", {"client": "b"})
    call(port, "/api/bye", {"client": "a"})
    time.sleep(2.5)
    assert t.is_alive(), "another window is still open"
    call(port, "/api/bye", {"client": "b"})
    t.join(10)  # returns as soon as the server stops; a busy CI machine can take a few seconds
    assert not t.is_alive()


def test_reload_within_grace_keeps_running():
    port, t = start(idle_exit=60, bye_grace=1.5)
    call(port, "/api/ping", {"client": "old"})
    call(port, "/api/bye", {"client": "old"})
    time.sleep(0.5)
    call(port, "/api/ping", {"client": "new"})   # the reloaded page
    time.sleep(2.5)
    assert t.is_alive()
    call(port, "/api/bye", {"client": "new"})
    t.join(10)
    assert not t.is_alive()


def test_launcher_window_closed():
    closed = threading.Event()
    port, t = start(idle_exit=60, closed=closed)
    call(port, "/api/ping", {"client": "w"})
    closed.at = time.time()
    closed.set()
    t.join(10)
    assert not t.is_alive()


def test_started_again_while_closing_keeps_running():
    closed = threading.Event()
    port, t = start(idle_exit=60, bye_grace=1, closed=closed)
    call(port, "/api/ping", {"client": "first"})
    call(port, "/api/bye", {"client": "first"})
    closed.at = time.time()
    closed.set()
    time.sleep(0.3)
    call(port, "/api/ping", {"client": "second"})   # the app was opened again at once
    time.sleep(3)
    assert t.is_alive() and not closed.is_set()
    call(port, "/api/bye", {"client": "second"})
    t.join(10)
    assert not t.is_alive()
