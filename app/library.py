"""Label library on disk: folders, `.lbl` files (JSON) and a thumbnail per label.

Paths are relative and use "/", e.g. "Soil/Light mix 16.lbl". Nothing is ever deleted for good;
"delete" moves things to data/trash. Every label has a permanent uid that print history is keyed
by, so renaming or moving a label keeps its statistics.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import threading
import time
import uuid
from pathlib import Path

from .backup import Versions
from .errors import AppError
from .logs import LOG

EXT = ".lbl"
THUMBS = ".thumbs"
COPY_SUFFIX = " (copy)"
_BAD_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


class LibraryError(AppError):
    pass


def new_uid() -> str:
    return uuid.uuid4().hex[:16]


class Library:
    def __init__(self, data_dir: Path):
        self.root = (data_dir / "library").resolve()
        self.trash = (data_dir / "trash").resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.trash.mkdir(parents=True, exist_ok=True)
        self.versions = Versions(data_dir)
        self._meta: dict[str, tuple] = {}
        self._lock = threading.RLock()

    # ---------- paths ----------
    def _abs(self, rel: str) -> Path:
        rel = (rel or "").replace("\\", "/").strip("/")
        parts = [p for p in rel.split("/") if p not in ("", ".")]
        if any(p == ".." or p.startswith(".") for p in parts):
            raise LibraryError("lib.bad_path", "Invalid path")
        p = self.root.joinpath(*parts).resolve() if parts else self.root
        if p != self.root and self.root not in p.parents:
            raise LibraryError("lib.bad_path", "Invalid path")
        return p

    def _rel(self, p: Path) -> str:
        return p.resolve().relative_to(self.root).as_posix() if p.resolve() != self.root else ""

    @staticmethod
    def clean_name(name: str) -> str:
        name = _BAD_CHARS.sub(" ", (name or "").strip())
        name = re.sub(r"\s+", " ", name).strip(" .")
        if not name:
            raise LibraryError("lib.empty_name", "Name is empty")
        return name[:120]

    def _thumb_path(self, file_abs: Path) -> Path:
        return file_abs.parent / THUMBS / (file_abs.stem + ".png")

    def _unique(self, folder: Path, stem: str, ext: str) -> Path:
        cand = folder / f"{stem}{ext}"
        n = 2
        while cand.exists():
            cand = folder / f"{stem} ({n}){ext}"
            n += 1
        return cand

    # ---------- per-file summary (cached by mtime/size) ----------
    def meta(self, p: Path) -> dict:
        st = p.stat()
        key = str(p)
        with self._lock:
            hit = self._meta.get(key)
            if hit and hit[0] == st.st_mtime_ns and hit[1] == st.st_size:
                return hit[2]
        try:
            with open(p, "r", encoding="utf-8") as fh:
                d = json.load(fh)
        except (OSError, ValueError) as e:
            LOG.error("Could not read %s: %s", p, e)
            d = {}
        fields = {v.get("name"): v.get("value", "") for v in d.get("variables") or [] if v.get("type") == "field"}
        m = {"uid": d.get("uid"), "kind": d.get("kind") or "label", "fromTemplate": d.get("fromTemplate"),
             "fields": fields, "broken": not d}
        with self._lock:
            self._meta[key] = (st.st_mtime_ns, st.st_size, m)
        return m

    def all_files(self):
        for p in self.root.rglob("*" + EXT):
            if not any(part.startswith(".") for part in p.relative_to(self.root).parts):
                yield p

    def path_of_uid(self, uid: str) -> str | None:
        for p in self.all_files():
            if self.meta(p).get("uid") == uid:
                return self._rel(p)
        return None

    # ---------- reading ----------
    def tree(self, stats: dict | None = None) -> dict:
        stats = stats or {}

        def walk(d: Path) -> dict:
            node = {"name": d.name if d != self.root else "", "path": self._rel(d), "folders": [], "files": [],
                    "printed": 0}
            try:
                entries = sorted(d.iterdir(), key=lambda e: e.name.lower())
            except OSError:
                entries = []
            for e in entries:
                if e.name.startswith("."):
                    continue
                if e.is_dir():
                    sub = walk(e)
                    node["folders"].append(sub)
                    node["printed"] += sub["printed"]
                elif e.suffix.lower() == EXT:
                    st = e.stat()
                    m = self.meta(e)
                    s = stats.get(m.get("uid")) or {}
                    node["files"].append({
                        "name": e.stem, "path": self._rel(e), "mtime": int(st.st_mtime), "size": st.st_size,
                        "thumb": self._thumb_path(e).exists(), "uid": m.get("uid"), "kind": m.get("kind"),
                        "template": (m.get("fromTemplate") or {}).get("name"),
                        "printed": s.get("sent", 0), "counters": s.get("counters", {}), "lastPrint": s.get("lastPrint"),
                    })
                    node["printed"] += s.get("sent", 0)
            return node
        return walk(self.root)

    def read(self, rel: str) -> dict:
        p = self._abs(rel)
        if not p.is_file() or p.suffix.lower() != EXT:
            raise LibraryError("lib.file_not_found", "File not found")
        with open(p, "r", encoding="utf-8") as fh:
            label = json.load(fh)
        if not label.get("uid"):
            # Files from older versions get their uid the first time they are opened
            label["uid"] = new_uid()
            self._write(p, label)
            LOG.info("New uid for %s: %s", rel, label["uid"])
        label["name"] = p.stem
        return label

    def thumb(self, rel: str) -> bytes | None:
        t = self._thumb_path(self._abs(rel))
        return t.read_bytes() if t.is_file() else None

    def products(self, template_uid: str) -> list[dict]:
        out = []
        for p in self.all_files():
            m = self.meta(p)
            if (m.get("fromTemplate") or {}).get("uid") == template_uid:
                out.append({"path": self._rel(p), "name": p.stem, "uid": m.get("uid"), "fields": m.get("fields", {}),
                            "mtime": int(p.stat().st_mtime)})
        return sorted(out, key=lambda r: r["path"])

    # ---------- writing ----------
    def _write(self, p: Path, label: dict):
        tmp = p.with_name(p.name + ".tmp")
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(label, fh, ensure_ascii=False, separators=(",", ":"))
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, p)

    def save(self, rel: str, label: dict, thumb_png: bytes | None = None, overwrite: bool = True,
             version: str = "auto") -> tuple[str, str]:
        """Returns (path, uid). version: auto (at most one per 10 minutes), force, none."""
        rel = (rel or "").replace("\\", "/").strip("/")
        if not rel.lower().endswith(EXT):
            rel += EXT
        folder_rel, _, name = rel.rpartition("/")
        stem = self.clean_name(name[: -len(EXT)])
        folder = self._abs(folder_rel)
        folder.mkdir(parents=True, exist_ok=True)
        p = folder / f"{stem}{EXT}"
        if p.exists() and not overwrite:
            p = self._unique(folder, stem, EXT)
        label = dict(label)
        label["name"] = p.stem
        uid = label.get("uid")
        if not uid:
            uid = new_uid()
        else:
            other = self.path_of_uid(uid)
            if other and self._abs(other) != p:
                uid = new_uid()  # a copy of another label: separate uid so print stats don't mix
        label["uid"] = uid
        label["saved"] = time.strftime("%Y-%m-%d %H:%M:%S")
        if p.exists() and version != "none":
            try:
                old_uid = self.meta(p).get("uid") or uid
                if self.versions.snapshot(old_uid, p, force=version == "force"):
                    LOG.info("Kept previous version of %s", self._rel(p))
            except OSError as e:
                LOG.error("Could not keep the previous version of %s: %s", p, e)
        self._write(p, label)
        if thumb_png:
            tp = self._thumb_path(p)
            tp.parent.mkdir(exist_ok=True)
            tp.write_bytes(thumb_png)
        LOG.info("Saved: %s uid=%s kind=%s (%d elements)", self._rel(p), uid, label.get("kind", "label"),
                 len(label.get("elements") or []))
        return self._rel(p), uid

    def mkdir(self, rel: str) -> str:
        folder_rel, _, name = (rel or "").replace("\\", "/").strip("/").rpartition("/")
        parent = self._abs(folder_rel)
        p = self._unique(parent, self.clean_name(name), "")
        p.mkdir(parents=True)
        LOG.info("New folder: %s", self._rel(p))
        return self._rel(p)

    def rename(self, rel: str, new_name: str) -> str:
        p = self._abs(rel)
        if p == self.root or not p.exists():
            raise LibraryError("lib.not_found", "Not found")
        stem = self.clean_name(new_name)
        dest = p.parent / stem if p.is_dir() else p.parent / f"{stem}{EXT}"
        if dest.exists() and dest.resolve() != p.resolve():
            raise LibraryError("lib.name_exists", "This name already exists")
        old_thumb = self._thumb_path(p) if p.is_file() else None
        p.rename(dest)
        if old_thumb and old_thumb.exists():
            old_thumb.rename(self._thumb_path(dest))
        LOG.info("Renamed: %s -> %s", rel, self._rel(dest))
        return self._rel(dest)

    def move(self, rel: str, dest_folder: str) -> str:
        p = self._abs(rel)
        dest_dir = self._abs(dest_folder)
        if p == self.root or not p.exists():
            raise LibraryError("lib.not_found", "Not found")
        if not dest_dir.is_dir():
            raise LibraryError("lib.dest_not_found", "Destination folder not found")
        if p.is_dir() and (dest_dir == p or p in dest_dir.parents):
            raise LibraryError("lib.move_into_self", "A folder cannot be moved into itself")
        if p.parent == dest_dir:
            return self._rel(p)
        if p.is_dir():
            dest = self._unique(dest_dir, p.name, "")
            shutil.move(str(p), str(dest))
        else:
            dest = self._unique(dest_dir, p.stem, EXT)
            thumb = self._thumb_path(p)
            shutil.move(str(p), str(dest))
            if thumb.exists():
                self._thumb_path(dest).parent.mkdir(exist_ok=True)
                shutil.move(str(thumb), str(self._thumb_path(dest)))
        LOG.info("Moved: %s -> %s", rel, self._rel(dest))
        return self._rel(dest)

    def _reassign_uids(self, path: Path):
        files = [path] if path.is_file() else [f for f in path.rglob("*" + EXT)]
        for f in files:
            try:
                with open(f, "r", encoding="utf-8") as fh:
                    d = json.load(fh)
                d["uid"] = new_uid()
                self._write(f, d)
            except (OSError, ValueError) as e:
                LOG.error("Could not give a new uid to copy %s: %s", f, e)

    def copy(self, rel: str, dest_folder: str | None = None) -> str:
        p = self._abs(rel)
        if p == self.root or not p.exists():
            raise LibraryError("lib.not_found", "Not found")
        dest_dir = self._abs(dest_folder) if dest_folder is not None else p.parent
        if p.is_dir():
            if dest_dir == p or p in dest_dir.parents:
                raise LibraryError("lib.copy_into_self", "A folder cannot be copied into itself")
            dest = self._unique(dest_dir, p.name + (COPY_SUFFIX if dest_dir == p.parent else ""), "")
            shutil.copytree(p, dest)
        else:
            stem = p.stem + (COPY_SUFFIX if dest_dir == p.parent else "")
            dest = self._unique(dest_dir, stem, EXT)
            shutil.copy2(p, dest)
            thumb = self._thumb_path(p)
            if thumb.exists():
                self._thumb_path(dest).parent.mkdir(exist_ok=True)
                shutil.copy2(thumb, self._thumb_path(dest))
        self._reassign_uids(dest)
        LOG.info("Copied: %s -> %s", rel, self._rel(dest))
        return self._rel(dest)

    def delete(self, rel: str) -> str:
        """Move to the recycle bin (data/trash/<time>/<path>)."""
        p = self._abs(rel)
        if p == self.root or not p.exists():
            raise LibraryError("lib.not_found", "Not found")
        stamp = time.strftime("%Y%m%d-%H%M%S")
        dest = self.trash / stamp / self._rel(p)
        dest.parent.mkdir(parents=True, exist_ok=True)
        thumb = self._thumb_path(p) if p.is_file() else None
        shutil.move(str(p), str(dest))
        if thumb and thumb.exists():
            (dest.parent / THUMBS).mkdir(exist_ok=True)
            shutil.move(str(thumb), str(dest.parent / THUMBS / thumb.name))
        LOG.info("Deleted (moved to trash): %s -> %s", rel, dest)
        return str(dest)

    def restore_version(self, rel: str, vid: str) -> dict:
        p = self._abs(rel)
        cur = self.read(rel)
        old = self.versions.read(cur["uid"], vid)
        old["uid"] = cur["uid"]
        self.versions.snapshot(cur["uid"], p, force=True)
        self._write(p, old)
        LOG.info("Restored version %s of %s", vid, rel)
        return self.read(rel)
