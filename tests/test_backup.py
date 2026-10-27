import json
import os
import sys
import tempfile
import time
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app import backup, logs  # noqa: E402
from app.history import History  # noqa: E402
from app.library import Library  # noqa: E402


def test_versions_kept_and_restored():
    d = Path(tempfile.mkdtemp())
    lib = Library(d)
    p, uid = lib.save("a/x", {"elements": [], "v": 1})
    p2, uid2 = lib.save(p, {"uid": uid, "elements": [], "v": 2}, version="force")
    assert (p2, uid2) == (p, uid)
    vs = lib.versions.list(uid)
    assert len(vs) == 1
    # Autosaves in quick succession do not make a new version
    lib.save(p, {"uid": uid, "elements": [], "v": 3})
    assert len(lib.versions.list(uid)) == 1
    restored = lib.restore_version(p, vs[0]["id"])
    assert restored["v"] == 1 and restored["uid"] == uid
    assert len(lib.versions.list(uid)) == 2


def test_version_retention(monkeypatch):
    d = Path(tempfile.mkdtemp())
    v = backup.Versions(d)
    src = d / "x.lbl"
    for i in range(backup.KEEP_VERSIONS + 5):
        src.write_text(json.dumps({"i": i}), encoding="utf-8")
        assert v.snapshot("u1", src, force=True)
    assert len(v.list("u1")) == backup.KEEP_VERSIONS


def test_daily_backup_and_extra_dir():
    d = Path(tempfile.mkdtemp())
    lib = Library(d)
    lib.save("خاک/سبک", {"elements": []}, b"png")
    h = History(d / "history.db")
    h.finish(h.begin({"label_uid": "u", "planned": 0}))
    extra = Path(tempfile.mkdtemp()) / "flash"
    p = backup.make_backup(d, str(extra))
    assert p and p.exists() and (extra / p.name).exists()
    names = zipfile.ZipFile(p).namelist()
    assert "library/خاک/سبک.lbl" in names and "history.db" in names
    assert backup.make_backup(d) is None          # already made today
    assert backup.make_backup(d, force=True)       # manual backups always run


def test_logs_and_diagnostics(monkeypatch):
    d = Path(tempfile.mkdtemp())
    logs.setup(d)
    logs.LOG.info("سلام")
    try:
        raise ValueError("آزمون")
    except ValueError:
        logs.LOG.exception("خطای آزمایشی")
    lines = logs.tail(50)
    assert any("سلام" in ln for ln in lines)
    errs = logs.tail(50, errors_only=True)
    assert any("خطای آزمایشی" in ln for ln in errs) and any("ValueError" in ln for ln in errs)
    assert not any("سلام" in ln for ln in errs)
    monkeypatch.setattr(backup, "desktop", lambda: d)
    z = backup.diagnostics(d, "test", None)
    assert "logs/app.log" in zipfile.ZipFile(z).namelist()
