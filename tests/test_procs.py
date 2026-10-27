"""Finding every running part of the app: servers of any installation, app windows, and nothing else."""
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app import procs  # noqa: E402


def install(base: Path) -> Path:
    for p in ("run.py", "app/server.py", "web/index.html"):
        (base / p).parent.mkdir(parents=True, exist_ok=True)
        (base / p).write_text("", encoding="utf-8")
    return base


def test_find_servers_and_windows_only(monkeypatch):
    tmp = Path(tempfile.mkdtemp())
    old = install(tmp / "old copy")
    new = install(tmp / "LabelPrintStudio")
    other = tmp / "other project"
    (other / "python").mkdir(parents=True)
    rows = [
        # an older copy started from its desktop shortcut
        {"ProcessId": 11, "Name": "pythonw.exe", "ExecutablePath": str(old / "python" / "pythonw.exe"),
         "CommandLine": f'"{old / "python" / "pythonw.exe"}" "{old / "run.py"}"'},
        # a copy started with a relative run.py from its own bundled Python
        {"ProcessId": 12, "Name": "python.exe", "ExecutablePath": str(new / "python" / "python.exe"),
         "CommandLine": "python.exe run.py --server"},
        # someone else's run.py
        {"ProcessId": 13, "Name": "python.exe", "ExecutablePath": str(other / "python" / "python.exe"),
         "CommandLine": f'python.exe "{other / "run.py"}"'},
        # the app window (its own profile) and one of its helper processes
        {"ProcessId": 21, "Name": "msedge.exe", "ExecutablePath": "C:\\Edge\\msedge.exe",
         "CommandLine": "msedge.exe --app=http://127.0.0.1:8803/ --user-data-dir=C:\\Users\\a\\AppData\\Local\\LabelPrintStudio\\browser"},
        {"ProcessId": 22, "Name": "msedge.exe", "ExecutablePath": "C:\\Edge\\msedge.exe",
         "CommandLine": "msedge.exe --type=renderer --user-data-dir=C:\\Users\\a\\AppData\\Local\\LabelPrintStudio\\browser"},
        # an app window that an older version opened in the normal browser
        {"ProcessId": 23, "Name": "msedge.exe", "ExecutablePath": "C:\\Edge\\msedge.exe",
         "CommandLine": "\"C:\\Edge\\msedge.exe\" --app=http://127.0.0.1:8803/ --start-maximized"},
        # the user's own browsing
        {"ProcessId": 24, "Name": "msedge.exe", "ExecutablePath": "C:\\Edge\\msedge.exe", "CommandLine": "msedge.exe"},
        {"ProcessId": 25, "Name": "chrome.exe", "ExecutablePath": "C:\\Chrome\\chrome.exe",
         "CommandLine": "chrome.exe --type=renderer --app=http://127.0.0.1:8803/"},
        # this very process is never included
        {"ProcessId": 99, "Name": "python.exe", "ExecutablePath": str(new / "python" / "python.exe"),
         "CommandLine": f'"{new / "python" / "python.exe"}" "{new / "run.py"}" --stop'},
    ]
    monkeypatch.setattr(procs, "_list", lambda: rows)
    found = {p["pid"]: p for p in procs.find(exclude=99)}
    assert sorted(found) == [11, 12, 21, 22, 23]
    assert found[11]["kind"] == "server" and found[11]["install"] == str(old.resolve())
    assert found[12]["install"] == str(new.resolve())
    assert [found[p]["kind"] for p in (21, 22, 23)] == ["window", "window", "old-window"]


def test_listening_pid(monkeypatch):
    out = ("\r\nActive Connections\r\n\r\n  Proto  Local Address          Foreign Address        State           PID\r\n"
           "  TCP    127.0.0.1:8803         127.0.0.1:52000        ESTABLISHED     700\r\n"
           "  TCP    127.0.0.1:18803        0.0.0.0:0              LISTENING       800\r\n"
           "  TCP    127.0.0.1:8803         0.0.0.0:0              ABH\x99REN         900\r\n")

    class Done:
        stdout = out.encode("latin-1")

    monkeypatch.setattr(procs, "IS_WIN", True)
    monkeypatch.setattr(procs.subprocess, "run", lambda *a, **kw: Done())
    assert procs.listening_pid(8803) == 900
    assert procs.listening_pid(8804) is None


def test_real_process_list_includes_this_test_run():
    """On Windows the process list is read for real: a server-like Python started here is found and stopped."""
    if not procs.IS_WIN:
        return
    folder = install(Path(tempfile.mkdtemp()) / "copy")
    (folder / "run.py").write_text("import time\ntime.sleep(60)\n", encoding="utf-8")
    p = subprocess.Popen([sys.executable, str(folder / "run.py")])
    try:
        mine = [f for f in procs.find() if f["pid"] == p.pid]
        assert mine and mine[0]["kind"] == "server" and mine[0]["install"] == str(folder.resolve())
        assert procs.stop(mine) == mine
        assert p.wait(10) is not None
    finally:
        if p.poll() is None:
            p.kill()


def test_copy_with_deleted_files_is_found_by_its_answer(monkeypatch):
    """Only the running python of a copy is left (the rest was deleted): its server's answer identifies it."""
    import socket
    import threading
    import time
    import urllib.request

    from app.server import serve

    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    threading.Thread(target=serve, args=(Path(tempfile.mkdtemp()),), kwargs={"port": port}, daemon=True).start()
    for _ in range(50):
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=1)
            break
        except OSError:
            time.sleep(0.1)
    gone = Path(tempfile.mkdtemp()) / "deleted copy"
    rows = [{"ProcessId": 31, "Name": "pythonw.exe", "ExecutablePath": str(gone / "python" / "pythonw.exe"),
             "CommandLine": f'"{gone / "python" / "pythonw.exe"}" "{gone / "run.py"}"'},
            {"ProcessId": 32, "Name": "pythonw.exe", "ExecutablePath": str(gone / "python" / "pythonw.exe"),
             "CommandLine": f'"{gone / "python" / "pythonw.exe"}" "{gone / "run.py"}"'}]
    monkeypatch.setattr(procs, "_list", lambda: rows)
    monkeypatch.setattr(procs, "_listeners", lambda: {port: 31, 1: 32})   # 32 listens where nothing answers
    found = procs.find(exclude=0)
    assert [(p["pid"], p["install"]) for p in found] == [(31, str(gone))]
