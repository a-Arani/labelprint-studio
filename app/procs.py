"""Every running part of LabelPrint Studio on this computer: servers of any installation or version, and app windows.

Used by `run.py --stop` (the "Stop LabelPrint Studio" file in the app folder) and by the launcher, which replaces
a server of another installation or version that holds its port. Windows only; elsewhere nothing is found.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import urllib.request
from pathlib import Path

from . import meta

IS_WIN = sys.platform == "win32"
NO_WINDOW = 0x08000000 if IS_WIN else 0  # CREATE_NO_WINDOW: no console flashes up from the windowless app
PYTHONS = ("python.exe", "pythonw.exe")
BROWSERS = ("msedge.exe", "chrome.exe")
_RUN_PY = re.compile(r'"([^"]*run\.py)"|(\S*run\.py)', re.I)


def is_install(folder: Path) -> bool:
    """A LabelPrint Studio folder of any version: run.py next to app/server.py and web/index.html."""
    return all((folder / p).is_file() for p in ("run.py", "app/server.py", "web/index.html"))


def _list() -> list[dict]:
    """Python and browser processes with their command lines (from Windows' process list)."""
    if not IS_WIN:
        return []
    names = " or ".join(f"Name='{n}'" for n in PYTHONS + BROWSERS)
    ps = ("[Console]::OutputEncoding = [Text.Encoding]::UTF8; "
          f'Get-CimInstance Win32_Process -Filter "{names}" | '
          "Select-Object ProcessId, Name, ExecutablePath, CommandLine | ConvertTo-Json -Compress")
    try:
        out = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", ps], capture_output=True,
                             timeout=60, creationflags=NO_WINDOW).stdout.decode("utf-8", "replace").strip()
        rows = json.loads(out) if out else []
    except (OSError, ValueError, subprocess.SubprocessError):
        return []
    return rows if isinstance(rows, list) else [rows]


def _install_of(row: dict) -> Path | None:
    """The installation a Python process runs: from the run.py on its command line, or its bundled python folder.
    A copy whose files were deleted while it ran still counts when its server answers as this app."""
    m = _RUN_PY.search(row.get("CommandLine") or "")
    if not m:
        return None
    script = Path(m.group(1) or m.group(2))
    exe = Path(row.get("ExecutablePath") or ".")
    folders = ([script.parent] if script.is_absolute() else []) + [exe.parent.parent]
    for folder in folders:
        if is_install(folder):
            return folder.resolve()
    if exe.parent.name.lower() == "python" and _answers_as_app(int(row.get("ProcessId") or 0)):
        return exe.parent.parent
    return None


def _answers_as_app(pid: int) -> bool:
    """The process listens on a port where this app's server answers."""
    for port, owner in _listeners().items():
        if owner != pid:
            continue
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=2) as r:
                h = json.loads(r.read().decode("utf-8"))
        except (OSError, ValueError):
            continue
        if isinstance(h, dict) and str(h.get("name", "")).replace(" ", "").lower() in ("labelprintstudio", "labelstudio"):
            return True
    return False


def find(exclude: int | None = None) -> list[dict]:
    """[{pid, kind, install}]: kind "server" (with its installation folder), "window" (the app window's own browser
    profile) or "old-window" (an app window an older version opened in the user's normal browser)."""
    exclude = os.getpid() if exclude is None else exclude
    profile = f"\\{meta.APP_ID}\\browser".lower()
    found = []
    for row in _list():
        pid, name = int(row.get("ProcessId") or 0), (row.get("Name") or "").lower()
        cmd = (row.get("CommandLine") or "").lower()
        if pid == exclude:
            continue
        if name in PYTHONS:
            inst = _install_of(row)
            if inst:
                found.append({"pid": pid, "kind": "server", "install": str(inst)})
        elif name in BROWSERS:
            if profile in cmd.replace("/", "\\"):
                found.append({"pid": pid, "kind": "window", "install": ""})
            elif "--app=http://127.0.0.1:" in cmd and "--type=" not in cmd and "--user-data-dir" not in cmd:
                found.append({"pid": pid, "kind": "old-window", "install": ""})
    return found


def stop(found: list[dict]) -> list[dict]:
    """End these processes and everything they started; returns the ones that were still running."""
    done = []
    for p in found:
        try:
            r = subprocess.run(["taskkill", "/PID", str(p["pid"]), "/T", "/F"], capture_output=True, timeout=30,
                               creationflags=NO_WINDOW)
        except (OSError, subprocess.SubprocessError):
            continue
        if r.returncode == 0:
            done.append(p)
    return done


def _listeners() -> dict[int, int]:
    """Local TCP ports being listened on, with the process listening on each."""
    if not IS_WIN:
        return {}
    try:
        out = subprocess.run(["netstat", "-ano", "-p", "TCP"], capture_output=True, timeout=30,
                             creationflags=NO_WINDOW).stdout.decode("ascii", "replace")
    except (OSError, subprocess.SubprocessError):
        return {}
    found = {}
    for line in out.splitlines():
        parts = line.split()
        # Only a listening socket has no remote end (the state's name depends on the Windows language)
        if len(parts) >= 5 and parts[2] in ("0.0.0.0:0", "[::]:0") and parts[-1].isdigit():
            port = parts[1].rsplit(":", 1)[-1]
            if port.isdigit():
                found.setdefault(int(port), int(parts[-1]))
    return found


def listening_pid(port: int) -> int | None:
    """The process that listens on this local TCP port."""
    return _listeners().get(port)
