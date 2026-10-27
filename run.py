"""Start LabelPrint Studio.

    python run.py              start the server and open the app window; closing the window stops the server
    python run.py --server     server only (development)
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

from app import meta  # noqa: E402
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


def open_window(url: str):
    """A separate app window (Edge or Chrome in --app mode); otherwise the default browser."""
    candidates = [
        os.path.expandvars(r"%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"),
        os.path.expandvars(r"%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"),
        os.path.expandvars(r"%ProgramFiles%\Google\Chrome\Application\chrome.exe"),
        os.path.expandvars(r"%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"),
        os.path.expandvars(r"%LocalAppData%\Google\Chrome\Application\chrome.exe"),
        shutil.which("msedge") or "",
        shutil.which("chrome") or "",
    ]
    for exe in candidates:
        if exe and os.path.isfile(exe):
            subprocess.Popen([exe, f"--app={url}", "--new-window", "--start-maximized"])
            return
    webbrowser.open(url)


def main():
    server_only = "--server" in sys.argv
    port = int(_arg("--port", "8803"))
    # Reuse a running copy of this app; skip ports taken by anything else
    for _ in range(10):
        h = health(port)
        if h is None:
            break
        if h.get("name") == meta.APP_NAME:
            if not server_only:
                open_window(f"http://127.0.0.1:{port}/")
            return
        port += 1
    url = f"http://127.0.0.1:{port}/"
    data = data_dir()
    if server_only:
        print(f"{meta.APP_NAME} {meta.VERSION}: {url} (data: {data})")
        serve(data, port=port)
        return

    def opener():
        for _ in range(50):
            if health(port):
                break
            time.sleep(0.1)
        open_window(url)
    threading.Thread(target=opener, daemon=True).start()
    serve(data, port=port, idle_exit=180)


if __name__ == "__main__":
    main()
