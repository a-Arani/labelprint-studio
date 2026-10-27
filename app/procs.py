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
    """The installation a Python process runs: from the run.py on its command line, or its bundled python folder."""
    m = _RUN_PY.search(row.get("CommandLine") or "")
    if not m:
        return None
    script = Path(m.group(1) or m.group(2))
    folders = ([script.parent] if script.is_absolute() else []) + [Path(row.get("ExecutablePath") or ".").parent.parent]
    for folder in folders:
        if is_install(folder):
            return folder.resolve()
    return None


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


def listening_pid(port: int) -> int | None:
    """The process that listens on this local TCP port."""
    if not IS_WIN:
        return None
    try:
        out = subprocess.run(["netstat", "-ano", "-p", "TCP"], capture_output=True, timeout=30,
                             creationflags=NO_WINDOW).stdout.decode("ascii", "replace")
    except (OSError, subprocess.SubprocessError):
        return None
    for line in out.splitlines():
        parts = line.split()
        # Only a listening socket has no remote end (the state's name depends on the Windows language)
        if len(parts) >= 5 and parts[1].endswith(f":{port}") and parts[2] in ("0.0.0.0:0", "[::]:0") and parts[-1].isdigit():
            return int(parts[-1])
    return None
