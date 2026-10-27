"""Data safety: previous versions of each label, daily backups and the diagnostics bundle."""
from __future__ import annotations

import csv
import io
import json
import os
import platform
import shutil
import sqlite3
import sys
import tempfile
import time
import zipfile
from pathlib import Path

from .logs import LOG, log_dir

KEEP_VERSIONS = 30
VERSION_GAP = 600          # seconds; autosave keeps at most one version per 10 minutes
KEEP_BACKUPS = 14


class Versions:
    def __init__(self, data_dir: Path):
        self.root = data_dir / "versions"
        self.root.mkdir(parents=True, exist_ok=True)

    def _dir(self, uid: str) -> Path:
        safe = "".join(c for c in uid if c.isalnum())[:40] or "unknown"
        return self.root / safe

    def snapshot(self, uid: str, src: Path, force: bool = False) -> Path | None:
        """Keep the current file before it is overwritten."""
        if not uid or not src.is_file():
            return None
        d = self._dir(uid)
        d.mkdir(exist_ok=True)
        existing = sorted(d.glob("*.lbl"))
        if existing and not force and time.time() - existing[-1].stat().st_mtime < VERSION_GAP:
            return None
        dest = d / (time.strftime("%Y%m%d-%H%M%S") + ".lbl")
        n = 2
        while dest.exists():
            dest = d / (time.strftime("%Y%m%d-%H%M%S") + f"-{n}.lbl")
            n += 1
        shutil.copy2(src, dest)
        for old in sorted(d.glob("*.lbl"))[:-KEEP_VERSIONS]:
            old.unlink(missing_ok=True)
        return dest

    def list(self, uid: str) -> list[dict]:
        d = self._dir(uid)
        out = []
        for f in sorted(d.glob("*.lbl"), reverse=True) if d.is_dir() else []:
            st = f.stat()
            out.append({"id": f.stem, "time": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(st.st_mtime)),
                        "size": st.st_size})
        return out

    def read(self, uid: str, vid: str) -> dict:
        f = self._dir(uid) / (os.path.basename(vid) + ".lbl")
        with open(f, "r", encoding="utf-8") as fh:
            return json.load(fh)


def _db_copy(db_path: Path) -> bytes | None:
    """A consistent copy of the history database (sqlite's own backup API)."""
    if not db_path.exists():
        return None
    tmp = Path(tempfile.mkdtemp()) / "history.db"
    try:
        src = sqlite3.connect(str(db_path))
        dst = sqlite3.connect(str(tmp))
        with dst:
            src.backup(dst)
        src.close()
        dst.close()
        return tmp.read_bytes()
    finally:
        shutil.rmtree(tmp.parent, ignore_errors=True)


def make_backup(data_dir: Path, extra_dir: str | None = None, force: bool = False) -> Path | None:
    """Daily backup in data/backups (and, if set, a second folder)."""
    bdir = data_dir / "backups"
    bdir.mkdir(parents=True, exist_ok=True)
    day = time.strftime("%Y%m%d")
    if not force and any(bdir.glob(f"backup-{day}*.zip")):
        return None
    dest = bdir / (f"backup-{day}.zip" if not force else f"backup-{day}-{time.strftime('%H%M%S')}.zip")
    tmp = dest.with_suffix(".tmp")
    t0 = time.time()
    count = 0
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
        lib = data_dir / "library"
        for f in lib.rglob("*"):
            if f.is_file():
                z.write(f, "library/" + f.relative_to(lib).as_posix())
                count += 1
        db = _db_copy(data_dir / "history.db")
        if db:
            z.writestr("history.db", db)
        s = data_dir / "settings.json"
        if s.exists():
            z.write(s, "settings.json")
    os.replace(tmp, dest)
    for old in sorted(bdir.glob("backup-*.zip"))[:-KEEP_BACKUPS]:
        old.unlink(missing_ok=True)
    LOG.info("Backup created: %s (%d files, %.1f MB, %.1f s)", dest, count, dest.stat().st_size / 1e6, time.time() - t0)
    if extra_dir:
        try:
            ex = Path(extra_dir)
            ex.mkdir(parents=True, exist_ok=True)
            shutil.copy2(dest, ex / dest.name)
            for old in sorted(ex.glob("backup-*.zip"))[:-KEEP_BACKUPS]:
                old.unlink(missing_ok=True)
            LOG.info("Backup also copied to the second folder: %s", ex)
        except OSError as e:
            LOG.error("Could not copy the backup to the second folder (%s): %s", extra_dir, e)
    return dest


def list_backups(data_dir: Path) -> list[dict]:
    bdir = data_dir / "backups"
    return [{"name": f.name, "time": time.strftime("%Y-%m-%d %H:%M", time.localtime(f.stat().st_mtime)),
             "size": f.stat().st_size} for f in sorted(bdir.glob("backup-*.zip"), reverse=True)] if bdir.is_dir() else []


def desktop() -> Path:
    home = Path(os.environ.get("USERPROFILE", Path.home()))
    for cand in (home / "Desktop", home / "OneDrive" / "Desktop"):
        if cand.is_dir():
            return cand
    return home


def diagnostics(data_dir: Path, version: str, history=None, extra: dict | None = None) -> Path:
    """A zip with the logs, settings, a print-history summary and system info, saved on the Desktop."""
    dest = desktop() / f"label-designer-diagnostics-{time.strftime('%Y%m%d-%H%M%S')}.zip"
    with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED) as z:
        ld = log_dir()
        if ld and ld.is_dir():
            for f in sorted(ld.glob("app.log*")):
                z.write(f, "logs/" + f.name)
        s = data_dir / "settings.json"
        if s.exists():
            z.write(s, "settings.json")
        info = {
            "version": version, "python": sys.version, "platform": platform.platform(),
            "data_dir": str(data_dir), "time": time.strftime("%Y-%m-%d %H:%M:%S"), **(extra or {}),
        }
        z.writestr("system.json", json.dumps(info, ensure_ascii=False, indent=1))
        if history is not None:
            buf = io.StringIO()
            rows = history.jobs(limit=300)
            if rows:
                w = csv.DictWriter(buf, fieldnames=[k for k in rows[0] if k != "values_json"], extrasaction="ignore")
                w.writeheader()
                w.writerows(rows)
            z.writestr("print-jobs.csv", "\ufeff" + buf.getvalue())
        lib = data_dir / "library"
        listing = [f.relative_to(lib).as_posix() for f in lib.rglob("*.lbl")] if lib.is_dir() else []
        z.writestr("library-files.txt", "\n".join(sorted(listing)))
    LOG.info("Diagnostics bundle created: %s", dest)
    return dest
