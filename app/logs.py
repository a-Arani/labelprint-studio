"""Application log in data/logs/app.log (rotating, UTF-8).

Every module logs through LOG. Browser-side events arrive through /api/log tagged [client].
"""
from __future__ import annotations

import logging
import logging.handlers
import re
import sys
import threading
from pathlib import Path

LOG = logging.getLogger("label")
_LINE_START = re.compile(r"^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d")
_ERR = re.compile(r"^\S+ \S+ (WARNING|ERROR|CRITICAL)")
_path: Path | None = None


def setup(data_dir: Path) -> Path:
    global _path
    d = data_dir / "logs"
    d.mkdir(parents=True, exist_ok=True)
    _path = d / "app.log"
    for h in list(LOG.handlers):
        LOG.removeHandler(h)
        h.close()
    fh = logging.handlers.RotatingFileHandler(_path, maxBytes=5 * 1024 * 1024, backupCount=10, encoding="utf-8")
    fh.setFormatter(logging.Formatter("%(asctime)s.%(msecs)03d %(levelname)-8s [%(threadName)s] %(message)s",
                                      "%Y-%m-%d %H:%M:%S"))
    LOG.addHandler(fh)
    if sys.stderr is not None:  # pythonw has no console
        ch = logging.StreamHandler(sys.stderr)
        ch.setLevel(logging.WARNING)
        ch.setFormatter(logging.Formatter("%(levelname)s %(message)s"))
        LOG.addHandler(ch)
    LOG.setLevel(logging.DEBUG if "--debug" in sys.argv else logging.INFO)
    LOG.propagate = False

    def hook(exc_type, exc, tb):
        LOG.critical("Unhandled error", exc_info=(exc_type, exc, tb))

    def thread_hook(args):
        LOG.critical("Unhandled error in thread %s", args.thread.name if args.thread else "?",
                     exc_info=(args.exc_type, args.exc_value, args.exc_traceback))
    sys.excepthook = hook
    threading.excepthook = thread_hook
    return _path


def log_dir() -> Path | None:
    return _path.parent if _path else None


def tail(n: int = 400, errors_only: bool = False) -> list[str]:
    """Last lines of the log; with errors_only, only warnings and errors (with their tracebacks)."""
    if not _path or not _path.exists():
        return []
    files = [_path] + [Path(f"{_path}.{i}") for i in range(1, 3)]
    lines: list[str] = []
    for f in reversed([f for f in files if f.exists()]):
        with open(f, "r", encoding="utf-8", errors="replace") as fh:
            lines.extend(fh.read().splitlines())
    if errors_only:
        out, keep = [], False
        for ln in lines:
            if _LINE_START.match(ln):
                keep = bool(_ERR.match(ln))
            if keep:
                out.append(ln)
        lines = out
    return lines[-n:]
