"""Installed Windows fonts.

Family names are read from each font's own `name` table, so they match what Word and the
browser use. The `cmap` table tells whether a font covers Arabic-script (Persian/Arabic/Urdu)
or CJK (Chinese/Japanese/Korean) text.
"""
from __future__ import annotations

import os
import struct
import threading
from pathlib import Path

try:
    import winreg
except ImportError:  # not Windows (tests)
    winreg = None

FONT_EXT = {".ttf", ".otf", ".ttc"}
_REG_KEY = r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts"
ARABIC_PROBE = (0x0627, 0x06A9)   # alef, keheh
CJK_PROBE = (0x4E2D, 0x6587)      # 中, 文

_cache: list[dict] | None = None
_lock = threading.Lock()


def _decode_name(platform_id: int, raw: bytes) -> str:
    if platform_id in (0, 3):
        return raw.decode("utf-16-be", errors="replace")
    return raw.decode("latin-1", errors="replace")


def _tables(data: bytes, offset: int) -> dict[bytes, tuple[int, int]]:
    num = struct.unpack_from(">H", data, offset + 4)[0]
    out = {}
    for i in range(num):
        tag, _chk, off, length = struct.unpack_from(">4sIII", data, offset + 12 + 16 * i)
        out[tag] = (off, length)
    return out


def _names(data: bytes, off: int) -> dict[int, str]:
    _fmt, count, str_off = struct.unpack_from(">HHH", data, off)
    best: dict[int, tuple[int, str]] = {}
    for i in range(count):
        pid, eid, lang, nid, length, noff = struct.unpack_from(">HHHHHH", data, off + 6 + 12 * i)
        if nid not in (1, 2, 4, 16, 17):
            continue
        raw = data[off + str_off + noff: off + str_off + noff + length]
        # Preference: Windows English, then any Windows, then Mac
        if pid == 3 and lang == 0x409:
            rank = 0
        elif pid == 3:
            rank = 1
        elif pid == 0:
            rank = 2
        else:
            rank = 3
        name = _decode_name(pid, raw).strip("\x00 ")
        if name and (nid not in best or rank < best[nid][0]):
            best[nid] = (rank, name)
    return {k: v[1] for k, v in best.items()}


def _covers(data: bytes, off: int, probes: tuple[int, ...]) -> bool:
    """Does the Unicode cmap map every code point in `probes`?"""
    try:
        _ver, num = struct.unpack_from(">HH", data, off)
        for i in range(num):
            pid, eid, sub_off = struct.unpack_from(">HHI", data, off + 4 + 8 * i)
            if pid != 3 or eid not in (1, 10):
                continue
            base = off + sub_off
            fmt = struct.unpack_from(">H", data, base)[0]
            if fmt == 4:
                seg2 = struct.unpack_from(">H", data, base + 6)[0]
                ends = struct.unpack_from(">%dH" % (seg2 // 2), data, base + 14)
                starts = struct.unpack_from(">%dH" % (seg2 // 2), data, base + 16 + seg2)
                return all(any(s <= cp <= e for s, e in zip(starts, ends)) for cp in probes)
            if fmt == 12:
                n = struct.unpack_from(">I", data, base + 12)[0]
                groups = [struct.unpack_from(">III", data, base + 16 + 12 * j)[:2] for j in range(n)]
                return all(any(s <= cp <= e for s, e in groups) for cp in probes)
    except struct.error:
        pass
    return False


def read_font_file(path: str) -> list[dict]:
    """Info about every font in a file (a .ttc collection may hold several)."""
    with open(path, "rb") as fh:
        data = fh.read()
    if data[:4] == b"ttcf":
        n = struct.unpack_from(">I", data, 8)[0]
        offsets = list(struct.unpack_from(">%dI" % n, data, 12))
    else:
        offsets = [0]
    out = []
    for o in offsets:
        try:
            tables = _tables(data, o)
            if b"name" not in tables:
                continue
            names = _names(data, tables[b"name"][0])
            cmap = tables.get(b"cmap")
            fa = _covers(data, cmap[0], ARABIC_PROBE) if cmap else False
            cjk = _covers(data, cmap[0], CJK_PROBE) if cmap else False
        except struct.error:
            continue
        family = names.get(1) or names.get(16)
        if not family:
            continue
        out.append({
            "family": family,
            "typoFamily": names.get(16) or family,
            "style": names.get(2) or "Regular",
            "full": names.get(4) or family,
            "fa": fa,
            "cjk": cjk,
        })
    return out


def _font_files() -> list[str]:
    files: list[str] = []
    seen: set[str] = set()
    windir = os.environ.get("WINDIR", r"C:\Windows")
    sys_dir = os.path.join(windir, "Fonts")
    user_dir = os.path.join(os.environ.get("LOCALAPPDATA", ""), "Microsoft", "Windows", "Fonts")

    def add(p: str):
        key = os.path.normcase(os.path.abspath(p))
        if key in seen or Path(p).suffix.lower() not in FONT_EXT or not os.path.isfile(p):
            return
        seen.add(key)
        files.append(p)

    if winreg is not None:
        for hive in (winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER):
            try:
                with winreg.OpenKey(hive, _REG_KEY) as k:
                    i = 0
                    while True:
                        try:
                            _name, value, _t = winreg.EnumValue(k, i)
                        except OSError:
                            break
                        i += 1
                        if isinstance(value, str) and value:
                            add(value if os.path.isabs(value) else os.path.join(sys_dir, value))
            except OSError:
                pass
    # Fonts that sit in the folders but are missing from the registry
    for d in (sys_dir, user_dir):
        if os.path.isdir(d):
            for name in os.listdir(d):
                add(os.path.join(d, name))
    return files


def list_fonts(refresh: bool = False) -> list[dict]:
    """[{family, styles:[...], fa:bool, cjk:bool}] sorted by family name."""
    global _cache
    with _lock:
        if _cache is not None and not refresh:
            return _cache
        fams: dict[str, dict] = {}
        for path in _font_files():
            try:
                infos = read_font_file(path)
            except OSError:
                continue
            for info in infos:
                fam = info["family"]
                if fam.startswith("@"):
                    continue  # East-Asian vertical variants
                entry = fams.setdefault(fam, {"family": fam, "styles": [], "fa": False, "cjk": False})
                if info["style"] not in entry["styles"]:
                    entry["styles"].append(info["style"])
                entry["fa"] = entry["fa"] or info["fa"]
                entry["cjk"] = entry["cjk"] or info["cjk"]
        _cache = sorted(fams.values(), key=lambda f: f["family"].lower())
        return _cache
