"""Start LabelPrint Studio.

    python run.py              start the server and open the app window; closing the window stops the server
    python run.py --server     server only (development)
    python run.py --stop       stop every running part of the app (any installation), e.g. before deleting its folder
    python run.py --port 8804 --data D:\\labels    custom port and data folder
"""
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import urllib.request
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
os.chdir(ROOT)

from app import meta, procs  # noqa: E402
from app.server import serve  # noqa: E402


def _arg(name: str, default: str) -> str:
    """'--port 8804' or '--data D:\\x' on the command line; else the LABEL_PORT / LABEL_DATA variable; else default."""
    if name in sys.argv:
        i = sys.argv.index(name)
        if i + 1 < len(sys.argv):
            return sys.argv[i + 1]
    return os.environ.get("LABEL_" + name.strip("-").upper(), default)


def data_dir() -> Path:
    """`data` next to the app (portable); %LOCALAPPDATA%\\LabelPrintStudio if that folder is read-only."""
    explicit = _arg("--data", "")
    if explicit:
        return Path(explicit)
    local = ROOT / "data"
    try:
        local.mkdir(exist_ok=True)
        probe = local / ".write-test"
        probe.write_text("ok", encoding="ascii")
        probe.unlink()
        return local
    except OSError:
        return Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / meta.APP_ID


def health(port: int) -> dict | None:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=1.5) as r:
            return json.loads(r.read().decode())
    except Exception:
        return None


def profile_dir() -> Path:
    """The app window's own browser profile: it runs apart from the user's browser and fully exits when closed."""
    explicit = _arg("--profile", "")
    if explicit:
        return Path(explicit)
    return Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / meta.APP_ID / "browser"


def open_window(url: str):
    """A separate app window (Edge or Chrome in --app mode), returned as its process; otherwise the default browser."""
    candidates = [
        os.path.expandvars(r"%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"),
        os.path.expandvars(r"%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"),
        os.path.expandvars(r"%ProgramFiles%\Google\Chrome\Application\chrome.exe"),
        os.path.expandvars(r"%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"),
        os.path.expandvars(r"%LocalAppData%\Google\Chrome\Application\chrome.exe"),
        shutil.which("msedge") or "",
        shutil.which("chrome") or "",
    ]
    profile = profile_dir()
    profile.mkdir(parents=True, exist_ok=True)
    for exe in candidates:
        if exe and os.path.isfile(exe):
            # Started outside the app folder, so the browser never holds that folder open
            return subprocess.Popen([exe, f"--app={url}", f"--user-data-dir={profile}", "--no-first-run",
                                     "--no-default-browser-check", "--disable-background-mode", "--hide-crash-restore-bubble",
                                     "--start-maximized"],
                                    cwd=str(profile))
    webbrowser.open(url)
    return None


def stop_all():
    """`run.py --stop`: end every running part of the app, of any installation or version."""
    print(f"Stopping {meta.APP_NAME}...")
    found = procs.find()
    labels = {"server": "server", "window": "app window", "old-window": "app window of an older version (Microsoft Edge or Chrome)"}
    for p in procs.stop(found):
        print(f"  stopped: {labels[p['kind']]} (process {p['pid']}){'  ' + p['install'] if p['install'] else ''}")
    if not found:
        print("Nothing of the app is running.")
    else:
        print("Done. The app folder can now be moved or deleted.")


def replace_other(port: int) -> bool:
    """Stop a server of another installation or version that holds this port; True when the port is free again."""
    pid = procs.listening_pid(port)
    if pid is None or pid not in {p["pid"] for p in procs.find() if p["kind"] == "server"}:
        return False
    procs.stop([{"pid": pid}])
    for _ in range(50):
        if health(port) is None:
            return True
        time.sleep(0.1)
    return False


def same_app(h: dict) -> bool:
    """A server of this very installation and version."""
    return (h.get("name") == meta.APP_NAME and h.get("version") == meta.VERSION
            and os.path.normcase(h.get("root") or "") == os.path.normcase(str(ROOT)))


def main():
    if "--stop" in sys.argv:
        stop_all()
        return
    server_only = "--server" in sys.argv
    port = int(_arg("--port", "8803"))
    # Reuse a running copy of this app; replace one of another folder or version (such as an older copy still
    # running); skip ports taken by anything else
    for _ in range(10):
        h = health(port)
        if h is None:
            break
        if same_app(h):
            if not server_only:
                open_window(f"http://127.0.0.1:{port}/")
            return
        if replace_other(port):
            break
        port += 1
    url = f"http://127.0.0.1:{port}/"
    data = data_dir()
    if server_only:
        print(f"{meta.APP_NAME} {meta.VERSION}: {url} (data: {data})")
        serve(data, port=port)
        return

    closed = threading.Event()

    def opener():
        # An app window still open from an earlier start has lost its server; it is closed so the new window gets
        # a browser of its own (one an older version started could keep that version's folder in use)
        procs.stop([p for p in procs.find() if p["kind"] == "window"])
        for _ in range(50):
            if health(port):
                break
            time.sleep(0.1)
        proc = open_window(url)
        if proc is None:
            return
        started = time.time()
        proc.wait()
        # A browser that hands the window to an instance already running exits at once; then the window's pings decide
        if time.time() - started > 5:
            closed.at = time.time()
            closed.set()
    threading.Thread(target=opener, daemon=True).start()
    serve(data, port=port, idle_exit=60, closed=closed)
    # Nothing of the app stays behind: an app window that no longer answers goes with the server
    procs.stop([p for p in procs.find() if p["kind"] == "window"])


if __name__ == "__main__":
    main()
