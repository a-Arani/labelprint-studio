"""Convert Word (.docx) and PowerPoint (.pptx) files to the label model.

Each file yields a list of labels (one per slide). All sizes are in millimetres, font sizes in
points and rotation in degrees (clockwise). Text becomes simple HTML (div + span) so the editor
and the printer show exactly the same thing.
"""
from __future__ import annotations

import base64
import colorsys
import html
import io
import math
import posixpath
import re
import secrets
import zipfile
from xml.etree import ElementTree as ET

from .errors import AppError

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
A = "http://schemas.openxmlformats.org/drawingml/2006/main"
WP = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
WP14 = "http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
P = "http://schemas.openxmlformats.org/presentationml/2006/main"
PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships"

EMU_MM = 36000.0
TWIP_MM = 25.4 / 1440.0
PT_MM = 25.4 / 72.0

ARABIC_RE = re.compile("[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]")
LATIN_RE = re.compile("[A-Za-z\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF]")

PRESET_COLORS = {
    "black": "000000", "white": "FFFFFF", "red": "FF0000", "green": "008000", "blue": "0000FF",
    "yellow": "FFFF00", "gray": "808080", "grey": "808080", "darkGray": "A9A9A9", "lightGray": "D3D3D3",
}
HIGHLIGHT = {
    "yellow": "#FFFF00", "green": "#00FF00", "cyan": "#00FFFF", "magenta": "#FF00FF", "blue": "#0000FF",
    "red": "#FF0000", "darkBlue": "#000080", "darkCyan": "#008080", "darkGreen": "#008000",
    "darkMagenta": "#800080", "darkRed": "#800000", "darkYellow": "#808000", "darkGray": "#808080",
    "lightGray": "#C0C0C0", "black": "#000000", "white": "#FFFFFF",
}
WORD_THEME_COLOR = {
    "text1": "dk1", "background1": "lt1", "text2": "dk2", "background2": "lt2", "dark1": "dk1",
    "light1": "lt1", "dark2": "dk2", "light2": "lt2", "hyperlink": "hlink", "followedHyperlink": "folHlink",
}
DEFAULT_CLRMAP = {"bg1": "lt1", "tx1": "dk1", "bg2": "lt2", "tx2": "dk2"}
SHAPES = {
    "rect": "rect", "roundRect": "roundRect", "ellipse": "ellipse", "triangle": "triangle",
    "rtTriangle": "rtTriangle", "diamond": "diamond", "hexagon": "hexagon", "octagon": "octagon",
    "flowChartProcess": "rect", "flowChartAlternateProcess": "roundRect", "flowChartConnector": "ellipse",
    "snip1Rect": "rect", "round1Rect": "roundRect", "round2SameRect": "roundRect", "frame": "rect",
    "plaque": "roundRect", "flowChartTerminator": "roundRect",
}
LINE_GEOMS = {"line", "straightConnector1", "bentConnector2", "bentConnector3", "curvedConnector3"}
IMG_MIME = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
            ".bmp": "image/bmp", ".webp": "image/webp", ".svg": "image/svg+xml"}


class ImportError_(AppError):
    pass


# ---------------------------------------------------------------- helpers
def ln(el) -> str:
    t = el.tag
    return t.rsplit("}", 1)[-1] if isinstance(t, str) else ""


def child(el, name: str):
    if el is None:
        return None
    for c in el:
        if ln(c) == name:
            return c
    return None


def children(el, name: str):
    return [c for c in el if ln(c) == name] if el is not None else []


def find_path(el, *names):
    for n in names:
        el = child(el, n)
        if el is None:
            return None
    return el


def num(v, default=None):
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def r2(v: float) -> float:
    return round(float(v), 2)


def uid() -> str:
    return secrets.token_hex(4)


def fmt(v: float) -> str:
    s = f"{v:.2f}".rstrip("0").rstrip(".")
    return s or "0"


def esc(s: str) -> str:
    return html.escape(s, quote=False)


def css_fonts(fonts: list[str]) -> str:
    out = []
    for f in fonts:
        f = (f or "").replace("'", "").replace('"', "").strip()
        if f and f not in out:
            out.append(f)
    return ",".join(f"'{f}'" for f in out) or "inherit"


def rgb_hex(rgb) -> str:
    return "#" + "".join(f"{max(0, min(255, round(c * 255))):02X}" for c in rgb)


def apply_mods(hexval: str, el) -> str:
    """Apply lumMod/lumOff/tint/shade/satMod to a colour."""
    try:
        r, g, b = (int(hexval[i:i + 2], 16) / 255 for i in (0, 2, 4))
    except (ValueError, TypeError):
        return "#000000"
    for m in el:
        name, val = ln(m), num(m.get("val"), 100000) / 100000
        if name == "lumMod" or name == "lumOff" or name == "satMod":
            h, l, s = colorsys.rgb_to_hls(r, g, b)
            if name == "lumMod":
                l *= val
            elif name == "lumOff":
                l += val
            else:
                s *= val
            r, g, b = colorsys.hls_to_rgb(h, max(0, min(1, l)), max(0, min(1, s)))
        elif name == "tint":
            r, g, b = (c * val + (1 - val) for c in (r, g, b))
        elif name == "shade":
            r, g, b = (c * val for c in (r, g, b))
    return rgb_hex((r, g, b))


class Theme:
    def __init__(self, xml: bytes | None):
        self.colors = {"dk1": "000000", "lt1": "FFFFFF", "dk2": "44546A", "lt2": "E7E6E6",
                       "accent1": "4472C4", "accent2": "ED7D31", "accent3": "A5A5A5", "accent4": "FFC000",
                       "accent5": "5B9BD5", "accent6": "70AD47", "hlink": "0563C1", "folHlink": "954F72"}
        self.fonts = {"major_latin": "Calibri Light", "minor_latin": "Calibri", "major_cs": "Times New Roman",
                      "minor_cs": "Arial", "major_ea": "", "minor_ea": ""}
        self.line_widths = [9525, 12700, 19050]
        if not xml:
            return
        root = ET.fromstring(xml)
        te = child(root, "themeElements")
        cs = child(te, "clrScheme")
        for c in (cs if cs is not None else []):
            v = child(c, "srgbClr")
            if v is not None:
                self.colors[ln(c)] = v.get("val", "000000")
            else:
                v = child(c, "sysClr")
                if v is not None:
                    self.colors[ln(c)] = v.get("lastClr") or ("000000" if v.get("val") == "windowText" else "FFFFFF")
        fs = child(te, "fontScheme")
        for kind in ("major", "minor"):
            f = child(fs, kind + "Font")
            if f is None:
                continue
            lat = child(f, "latin")
            if lat is not None and lat.get("typeface"):
                self.fonts[kind + "_latin"] = lat.get("typeface")
            ea = child(f, "ea")
            if ea is not None:
                self.fonts[kind + "_ea"] = ea.get("typeface", "")
            cs_ = child(f, "cs")
            arab = next((x.get("typeface") for x in children(f, "font") if x.get("script") == "Arab"), None)
            if cs_ is not None and cs_.get("typeface"):
                self.fonts[kind + "_cs"] = cs_.get("typeface")
            elif arab:
                self.fonts[kind + "_cs"] = arab
        fmt_ = child(te, "fmtScheme")
        lns = child(fmt_, "lnStyleLst")
        if lns is not None:
            ws = [num(x.get("w"), 9525) for x in children(lns, "ln")]
            if ws:
                self.line_widths = ws

    def font(self, typeface: str | None) -> str | None:
        if not typeface:
            return None
        m = re.match(r"\+(mn|mj)-(lt|cs|ea)$", typeface)
        if m:
            kind = "minor" if m.group(1) == "mn" else "major"
            part = {"lt": "latin", "cs": "cs", "ea": "ea"}[m.group(2)]
            return self.fonts.get(f"{kind}_{part}") or None
        return typeface

    def color(self, parent, clrmap=None, ph_color: str | None = None) -> str | None:
        """The colour inside an element (srgbClr/schemeClr/...)."""
        if parent is None:
            return None
        clrmap = clrmap or DEFAULT_CLRMAP
        for c in parent:
            name = ln(c)
            base = None
            if name == "srgbClr":
                base = c.get("val")
            elif name == "schemeClr":
                v = c.get("val")
                if v == "phClr":
                    base = (ph_color or "#000000").lstrip("#")
                else:
                    base = self.colors.get(clrmap.get(v, v)) or self.colors.get(v)
            elif name == "sysClr":
                base = c.get("lastClr") or ("000000" if c.get("val") == "windowText" else "FFFFFF")
            elif name == "prstClr":
                base = PRESET_COLORS.get(c.get("val"), "000000")
            elif name == "scrgbClr":
                base = rgb_hex([num(c.get(k), 0) / 100000 for k in ("r", "g", "b")]).lstrip("#")
            if base:
                return apply_mods(base, c)
        return None


def read_rels(z: zipfile.ZipFile, part: str) -> dict:
    d, name = posixpath.split(part)
    rp = posixpath.join(d, "_rels", name + ".rels")
    out = {}
    if rp not in z.namelist():
        return out
    root = ET.fromstring(z.read(rp))
    for rel in root:
        if rel.get("TargetMode") == "External":
            continue
        tgt = rel.get("Target", "")
        full = posixpath.normpath(tgt.lstrip("/") if tgt.startswith("/") else posixpath.join(d, tgt))
        out[rel.get("Id")] = (full, rel.get("Type", "").rsplit("/", 1)[-1])
    return out


class Ctx:
    """Shared state of one conversion."""

    def __init__(self, z, theme: Theme, clrmap=None):
        self.z = z
        self.theme = theme
        self.clrmap = clrmap or DEFAULT_CLRMAP
        self.warnings: list[str] = []
        self.fonts: set[str] = set()
        self._img_cache: dict[str, str | None] = {}

    def warn(self, msg: str):
        if msg not in self.warnings:
            self.warnings.append(msg)

    def image(self, path: str) -> str | None:
        if path in self._img_cache:
            return self._img_cache[path]
        url = None
        try:
            data = self.z.read(path)
        except KeyError:
            data = None
        if data:
            ext = posixpath.splitext(path)[1].lower()
            mime = IMG_MIME.get(ext)
            if mime:
                url = f"data:{mime};base64," + base64.b64encode(data).decode()
            else:
                try:
                    from PIL import Image  # optional; for emf/wmf/tiff
                    im = Image.open(io.BytesIO(data))
                    buf = io.BytesIO()
                    im.save(buf, "PNG")
                    url = "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()
                except Exception:
                    self.warn(f"An image in {ext} format was not imported")
        self._img_cache[path] = url
        return url


# ---------------------------------------------------------------- text HTML
def split_script(text: str, neutral_cs: bool) -> list[tuple[str, bool]]:
    """Split text into Arabic-script (True) and Latin (False) pieces."""
    out: list[list] = []
    cur = None
    for ch in text:
        if ARABIC_RE.match(ch) or ch == "\u200C":
            k = True
        elif LATIN_RE.match(ch):
            k = False
        else:
            k = cur if cur is not None else (True if neutral_cs else None)
        if out and (k is None or out[-1][1] == k or out[-1][1] is None):
            if out[-1][1] is None:
                out[-1][1] = k
            out[-1][0] += ch
        else:
            out.append([ch, k])
        cur = k if k is not None else cur
    return [(t, bool(k) if k is not None else neutral_cs) for t, k in out]


def seg_css(s: dict) -> str:
    size = s["size"]
    parts = [f"font-family:{css_fonts(s['fonts'])}"]
    if s.get("vert") in ("superscript", "subscript"):
        parts.append(f"font-size:{fmt(size * 0.65)}pt")
        parts.append("vertical-align:" + ("super" if s["vert"] == "superscript" else "sub"))
    else:
        parts.append(f"font-size:{fmt(size)}pt")
    if s.get("bold"):
        parts.append("font-weight:700")
    if s.get("italic"):
        parts.append("font-style:italic")
    deco = [d for d, on in (("underline", s.get("underline")), ("line-through", s.get("strike"))) if on]
    if deco:
        parts.append("text-decoration:" + " ".join(deco))
    if s.get("color"):
        parts.append(f"color:{s['color']}")
    if s.get("bg"):
        parts.append(f"background-color:{s['bg']}")
    if s.get("spacing"):
        parts.append(f"letter-spacing:{fmt(s['spacing'])}pt")
    return ";".join(parts)


def para_html(p: dict) -> str:
    """p = {dir, align, before, after, line, indL, indR, first, mark_size, segs:[...]}"""
    rtl = p.get("dir") == "rtl"
    st = ["margin:0"]
    if p.get("before"):
        st.append(f"margin-top:{fmt(p['before'])}pt")
    if p.get("after"):
        st.append(f"margin-bottom:{fmt(p['after'])}pt")
    if p.get("align"):
        st.append(f"text-align:{p['align']}")
    if p.get("line"):
        st.append(f"line-height:{p['line']}")
    if p.get("indL"):
        st.append(f"padding-left:{fmt(p['indL'])}mm")
    if p.get("indR"):
        st.append(f"padding-right:{fmt(p['indR'])}mm")
    if p.get("first"):
        st.append(f"text-indent:{fmt(p['first'])}mm")
    if p.get("mark_size"):
        st.append(f"font-size:{fmt(p['mark_size'])}pt")
    # Merge consecutive pieces that have the same style
    merged: list[dict] = []
    for s in p["segs"]:
        if s.get("text") is not None and merged and merged[-1].get("text") is not None \
                and seg_css(merged[-1]) == seg_css(s) and merged[-1].get("rtl") == s.get("rtl"):
            merged[-1] = dict(merged[-1], text=merged[-1]["text"] + s["text"])
        else:
            merged.append(dict(s))

    def one(s):
        if s.get("br"):
            return "<br>"
        if s.get("img"):
            return (f'<img src="{s["img"]}" style="width:{fmt(s["w"])}mm;height:{fmt(s["h"])}mm;'
                    f'vertical-align:bottom">')
        return f'<span style="{seg_css(s)}">{esc(s["text"])}</span>'

    # Word lays out each group of runs with the same w:rtl flag as a separate unit; e.g. "000", ","
    # and "12" typed with different keyboards show as "12,000,000" in a right-to-left paragraph.
    kinds = {bool(s.get("rtl")) for s in merged if s.get("text") is not None}
    mixed = len(kinds) == 2
    inner = []
    i = 0
    while i < len(merged):
        s = merged[i]
        if s.get("text") is None:
            inner.append(one(s))
            i += 1
            continue
        flag = bool(s.get("rtl"))
        group = []
        while i < len(merged) and merged[i].get("text") is not None and bool(merged[i].get("rtl")) == flag:
            group.append(one(merged[i]))
            i += 1
        if flag != rtl and (mixed or flag):
            inner.append(f'<span dir="{"rtl" if flag else "ltr"}">' + "".join(group) + "</span>")
        else:
            inner += group
    has_visible = any((s.get("text") or "").strip() or s.get("img") for s in merged)
    body = "".join(inner) if merged else ""
    if not has_visible and not any(s.get("br") for s in merged):
        body = (body + "<br>") if body else "<br>"
    elif merged and merged[-1].get("br"):
        body += "<br>"
    return f'<div dir="{"rtl" if rtl else "ltr"}" style="{";".join(st)}">{body}</div>'


def text_summary(paras: list[dict]) -> dict:
    """Dominant text properties, used for the element-level settings."""
    best: dict[tuple, int] = {}
    for p in paras:
        for s in p["segs"]:
            if s.get("text"):
                key = ((s["fonts"] or ["Tahoma"])[0], s["size"], s.get("color") or "#000000", bool(s.get("bold")))
                best[key] = best.get(key, 0) + len(s["text"].strip())
    if best:
        font, size, color, bold = max(best.items(), key=lambda kv: kv[1])[0]
    else:
        font, size, color, bold = "Tahoma", (paras[0].get("mark_size") if paras else None) or 12, "#000000", False
    first = paras[0] if paras else {}
    d = first.get("dir", "rtl")
    a = first.get("align") or "start"
    vis = {"start": "right" if d == "rtl" else "left", "end": "left" if d == "rtl" else "right"}.get(a, a)
    return {"font": font, "size": size, "color": color, "bold": bold, "dir": d, "align": vis}


def text_element(box, rot, paras, body: dict, fill=None, stroke=None, stroke_w=0.0, radius=0.0) -> dict:
    x, y, w, h = box
    vert = body.get("vert")
    if vert in ("vert", "eaVert", "wordArtVert", "vert270", "mongolianVert"):
        cx, cy = x + w / 2, y + h / 2
        w, h = h, w
        x, y = cx - w / 2, cy - h / 2
        rot = (rot + (270 if vert == "vert270" else 90)) % 360
    summ = text_summary(paras)
    return {
        "id": uid(), "type": "text", "x": r2(x), "y": r2(y), "w": r2(max(w, 1)), "h": r2(max(h, 1)), "rot": r2(rot),
        "html": "".join(para_html(p) for p in paras),
        "font": summ["font"], "size": summ["size"], "color": summ["color"], "bold": summ["bold"],
        "italic": False, "underline": False, "align": summ["align"], "dir": summ["dir"],
        "valign": body.get("valign", "top"), "lineHeight": 0, "letterSpacing": 0,
        "pad": [r2(v) for v in body.get("pad", [1.27, 2.54, 1.27, 2.54])],
        "wrap": body.get("wrap", True), "fit": False,
        "fill": fill, "stroke": stroke, "strokeW": r2(stroke_w), "radius": r2(radius),
    }


def shape_elements(ctx: Ctx, box, rot, flip_h, flip_v, geom, fill, stroke, stroke_w, dash,
                   paras=None, body=None, img=None, crop=None) -> list[dict]:
    """Convert one DrawingML shape to label element(s)."""
    x, y, w, h = box
    out = []
    has_text = bool(paras) and any(
        (s.get("text") or "").strip() or s.get("img") for p in paras for s in p["segs"])
    if img:
        out.append({"id": uid(), "type": "image", "x": r2(x), "y": r2(y), "w": r2(max(w, 0.5)),
                    "h": r2(max(h, 0.5)), "rot": r2(rot), "src": img, "fit": "fill",
                    "crop": [round(c, 4) for c in (crop or [0, 0, 0, 0])],
                    "flipH": flip_h, "flipV": flip_v, "invert": False, "dither": False,
                    "stroke": stroke, "strokeW": r2(stroke_w)})
    elif geom in LINE_GEOMS:
        x1, y1, x2, y2 = x, y, x + w, y + h
        if flip_h:
            x1, x2 = x2, x1
        if flip_v:
            y1, y2 = y2, y1
        if rot:
            cx, cy = x + w / 2, y + h / 2
            a = math.radians(rot)
            ca, sa = math.cos(a), math.sin(a)

            def rp(px, py):
                dx, dy = px - cx, py - cy
                return cx + dx * ca - dy * sa, cy + dx * sa + dy * ca
            (x1, y1), (x2, y2) = rp(x1, y1), rp(x2, y2)
        if stroke:
            out.append({"id": uid(), "type": "line", "x1": r2(x1), "y1": r2(y1), "x2": r2(x2), "y2": r2(y2),
                        "stroke": stroke, "strokeW": r2(max(stroke_w, 0.1)), "dash": dash})
        return out
    else:
        kind = SHAPES.get(geom or "rect")
        if kind is None:
            ctx.warn(f"Shape '{geom}' was converted to a rectangle")
            kind = "rect"
        radius = min(w, h) * 0.16667 if kind == "roundRect" else 0.0
        if kind == "roundRect":
            kind = "rect"
        if has_text and kind == "rect":
            out.append(text_element(box, rot, paras, body or {}, fill, stroke, stroke_w, radius))
            return out
        if fill or stroke:
            out.append({"id": uid(), "type": "shape", "shape": kind, "x": r2(x), "y": r2(y), "w": r2(max(w, 0.2)),
                        "h": r2(max(h, 0.2)), "rot": r2(rot), "fill": fill, "stroke": stroke,
                        "strokeW": r2(stroke_w), "radius": r2(radius), "dash": dash,
                        "flipH": flip_h, "flipV": flip_v})
    if has_text:
        out.append(text_element(box, rot, paras, body or {}))
    return out


def body_props(bp, defaults=(91440, 45720, 91440, 45720)) -> dict:
    """DrawingML bodyPr -> padding, vertical alignment, direction and wrapping."""
    if bp is None:
        bp = ET.Element("bodyPr")
    l, t, r, b = (num(bp.get(k), d) / EMU_MM for k, d in zip(("lIns", "tIns", "rIns", "bIns"), defaults))
    anchor = {"t": "top", "ctr": "middle", "b": "bottom"}.get(bp.get("anchor", "t"), "top")
    out = {"pad": [t, r, b, l], "valign": anchor, "vert": bp.get("vert"), "wrap": bp.get("wrap") != "none"}
    na = child(bp, "normAutofit")
    if na is not None:
        out["fontScale"] = num(na.get("fontScale"), 100000) / 100000
        out["lnReduce"] = num(na.get("lnSpcReduction"), 0) / 100000
    return out


def line_props(ctx: Ctx, ln_el, style_ln_color=None, style_ln_idx=0, clrmap=None):
    """Outline colour, width (mm) and dash style."""
    color, width, dash = None, 0.0, None
    if ln_el is not None:
        if child(ln_el, "noFill") is not None:
            return None, 0.0, None
        sf = child(ln_el, "solidFill")
        if sf is not None:
            color = ctx.theme.color(sf, clrmap)
        elif child(ln_el, "gradFill") is not None:
            gs = find_path(ln_el, "gradFill", "gsLst", "gs")
            color = ctx.theme.color(gs, clrmap)
        elif style_ln_idx:
            color = style_ln_color
        if ln_el.get("w"):
            width = num(ln_el.get("w"), 9525) / EMU_MM
        pd = child(ln_el, "prstDash")
        if pd is not None and pd.get("val") not in (None, "solid"):
            dash = pd.get("val")
    elif style_ln_idx:
        color = style_ln_color
    if color and not width:
        idx = max(1, style_ln_idx or 1)
        lw = ctx.theme.line_widths
        width = lw[min(idx, len(lw)) - 1] / EMU_MM
    return color, width, dash


def fill_props(ctx: Ctx, sppr, style_fill_color=None, style_fill_idx=0, clrmap=None):
    """(fill colour or None, picture-fill element or None)"""
    if sppr is not None:
        for c in sppr:
            n = ln(c)
            if n == "noFill":
                return None, None
            if n == "solidFill":
                return ctx.theme.color(c, clrmap), None
            if n == "gradFill":
                return ctx.theme.color(find_path(c, "gsLst", "gs"), clrmap), None
            if n == "pattFill":
                return ctx.theme.color(child(c, "fgClr"), clrmap), None
            if n == "blipFill":
                return None, c
    if style_fill_idx:
        return style_fill_color, None
    return None, None


def style_refs(ctx: Ctx, style_el, clrmap=None):
    """(line colour, line index, fill colour, fill index, text colour)"""
    if style_el is None:
        return None, 0, None, 0, None
    lr, fr, fo = child(style_el, "lnRef"), child(style_el, "fillRef"), child(style_el, "fontRef")
    lc = ctx.theme.color(lr, clrmap) if lr is not None else None
    fc = ctx.theme.color(fr, clrmap) if fr is not None else None
    tc = ctx.theme.color(fo, clrmap) if fo is not None else None
    li = int(num(lr.get("idx"), 0)) if lr is not None else 0
    fi = int(num(fr.get("idx"), 0)) if fr is not None else 0
    return lc, li, fc, fi, tc


def blip_image(ctx: Ctx, blip_fill, rels: dict):
    """(data url, crop [l, t, r, b])"""
    blip = child(blip_fill, "blip")
    if blip is None:
        return None, None
    rid = blip.get(f"{{{R}}}embed") or blip.get(f"{{{R}}}link")
    target = rels.get(rid, (None,))[0]
    url = ctx.image(target) if target else None
    crop = [0.0, 0.0, 0.0, 0.0]
    sr = child(blip_fill, "srcRect")
    if sr is not None:
        crop = [max(0.0, num(sr.get(k), 0) / 100000) for k in ("l", "t", "r", "b")]
    return url, crop


def xfrm_box(xfrm, tf=None):
    """(x, y, w, h, rot, flipH, flipV) in millimetres, with the group transform applied."""
    if xfrm is None:
        return None
    off, ext = child(xfrm, "off"), child(xfrm, "ext")
    x = num(off.get("x"), 0) if off is not None else 0
    y = num(off.get("y"), 0) if off is not None else 0
    w = num(ext.get("cx"), 0) if ext is not None else 0
    h = num(ext.get("cy"), 0) if ext is not None else 0
    if tf:
        x, y, w, h = tf(x, y, w, h)
    rot = num(xfrm.get("rot"), 0) / 60000
    return (x / EMU_MM, y / EMU_MM, w / EMU_MM, h / EMU_MM, rot % 360,
            xfrm.get("flipH") in ("1", "true"), xfrm.get("flipV") in ("1", "true"))


def group_tf(grp_sppr, parent_tf=None):
    xf = child(grp_sppr, "xfrm")
    if xf is None:
        return parent_tf
    off, ext, choff, chext = (child(xf, n) for n in ("off", "ext", "chOff", "chExt"))
    ox, oy = num(off.get("x"), 0), num(off.get("y"), 0)
    ew, eh = num(ext.get("cx"), 0), num(ext.get("cy"), 0)
    cx, cy = (num(choff.get("x"), 0), num(choff.get("y"), 0)) if choff is not None else (ox, oy)
    cw, ch = (num(chext.get("cx"), 0), num(chext.get("cy"), 0)) if chext is not None else (ew, eh)
    sx = ew / cw if cw else 1.0
    sy = eh / ch if ch else 1.0

    def tf(x, y, w, h):
        x, y, w, h = ox + (x - cx) * sx, oy + (y - cy) * sy, w * sx, h * sy
        return parent_tf(x, y, w, h) if parent_tf else (x, y, w, h)
    return tf


def make_label(name: str, w: float, h: float, elements: list, ctx: Ctx, source: str, bg=None) -> dict:
    return {
        "version": 1, "name": name,
        "page": {"w": round(w, 1), "h": round(h, 1), "printRotate": 90 if (w > 108 and h <= 108) else 0,
                 "bg": bg or "#FFFFFF"},
        "elements": elements, "variables": [],
        "meta": {"source": source, "fonts": sorted(ctx.fonts), "warnings": ctx.warnings},
    }


# ================================================================= Word
def wv(el, attr="val"):
    return el.get(f"{{{W}}}{attr}") if el is not None else None


def w_on(el) -> bool | None:
    if el is None:
        return None
    return wv(el) not in ("0", "false", "off", "none")


def parse_rpr(rpr) -> dict:
    d: dict = {}
    if rpr is None:
        return d
    for c in rpr:
        n = ln(c)
        if n == "rFonts":
            for a in ("ascii", "hAnsi", "cs", "eastAsia"):
                if wv(c, a):
                    d["font_" + a] = wv(c, a)
                    d.pop("theme_" + a, None)
            for a, key in (("asciiTheme", "ascii"), ("hAnsiTheme", "hAnsi"), ("cstheme", "cs"),
                           ("eastAsiaTheme", "eastAsia")):
                if wv(c, a):
                    d["theme_" + key] = wv(c, a)
            if wv(c, "hint"):
                d["hint"] = wv(c, "hint")
        elif n in ("b", "bCs", "i", "iCs", "strike", "dstrike", "rtl", "cs", "vanish", "caps"):
            d[n] = w_on(c)
        elif n in ("sz", "szCs"):
            v = num(wv(c))
            if v:
                d[n] = v / 2
        elif n == "u":
            d["u"] = wv(c) not in (None, "none")
        elif n == "color":
            d["color"] = (wv(c), wv(c, "themeColor"), wv(c, "themeShade"), wv(c, "themeTint"))
        elif n == "highlight":
            d["bg"] = HIGHLIGHT.get(wv(c))
        elif n == "shd":
            f = wv(c, "fill")
            if f and f not in ("auto",):
                d["bg"] = "#" + f
        elif n == "vertAlign":
            d["vert"] = wv(c)
        elif n == "spacing":
            v = num(wv(c))
            if v:
                d["spacing"] = v / 20
    return d


def parse_ppr(ppr) -> dict:
    d: dict = {}
    if ppr is None:
        return d
    for c in ppr:
        n = ln(c)
        if n == "jc":
            d["jc"] = wv(c)
        elif n == "bidi":
            d["bidi"] = w_on(c)
        elif n == "spacing":
            for a in ("before", "after", "line"):
                if wv(c, a) is not None:
                    d[a] = num(wv(c, a), 0)
            if wv(c, "lineRule"):
                d["lineRule"] = wv(c, "lineRule")
        elif n == "ind":
            for a, key in (("left", "indL"), ("start", "indL"), ("right", "indR"), ("end", "indR"),
                           ("firstLine", "first"), ("hanging", "hanging")):
                if wv(c, a) is not None:
                    d[key] = num(wv(c, a), 0)
        elif n == "pStyle":
            d["pStyle"] = wv(c)
    return d


class WordStyles:
    def __init__(self, xml: bytes | None):
        self.doc_rpr: dict = {}
        self.doc_ppr: dict = {}
        self.styles: dict[str, dict] = {}
        self.default_para = None
        if not xml:
            return
        root = ET.fromstring(xml)
        dd = child(root, "docDefaults")
        if dd is not None:
            self.doc_rpr = parse_rpr(find_path(dd, "rPrDefault", "rPr"))
            self.doc_ppr = parse_ppr(find_path(dd, "pPrDefault", "pPr"))
        for s in children(root, "style"):
            sid = wv(s, "styleId")
            st = {"type": wv(s, "type"), "basedOn": wv(child(s, "basedOn")),
                  "rpr": parse_rpr(child(s, "rPr")), "ppr": parse_ppr(child(s, "pPr"))}
            self.styles[sid] = st
            if st["type"] == "paragraph" and wv(s, "default") in ("1", "true"):
                self.default_para = sid

    def chain(self, sid):
        out, seen = [], set()
        while sid and sid in self.styles and sid not in seen:
            seen.add(sid)
            out.append(self.styles[sid])
            sid = self.styles[sid]["basedOn"]
        return list(reversed(out))

    def ppr(self, direct: dict) -> dict:
        d = dict(self.doc_ppr)
        for s in self.chain(direct.get("pStyle") or self.default_para):
            d.update(s["ppr"])
        d.update(direct)
        return d

    def rpr(self, pstyle, rstyle, direct: dict) -> dict:
        d = dict(self.doc_rpr)
        for s in self.chain(pstyle or self.default_para) + self.chain(rstyle):
            merge_rpr(d, s["rpr"])
        merge_rpr(d, direct)
        return d


def merge_rpr(d: dict, upd: dict):
    for k, v in upd.items():
        if k.startswith("font_"):
            d.pop("theme_" + k[5:], None)
        d[k] = v


def word_font(rp: dict, theme: Theme, which: str) -> str | None:
    t = rp.get("theme_" + which)
    if t:
        kind = "major" if t.startswith("major") else "minor"
        if t.endswith("Bidi"):
            return theme.fonts.get(kind + "_cs")
        if t.endswith("EastAsia"):
            return theme.fonts.get(kind + "_ea") or theme.fonts.get(kind + "_latin")
        return theme.fonts.get(kind + "_latin")
    return rp.get("font_" + which)


def word_color(val, theme: Theme) -> str | None:
    if not val:
        return None
    hexv, tc, shade, tint = val
    if tc:
        base = theme.colors.get(WORD_THEME_COLOR.get(tc, tc))
        if base:
            r, g, b = (int(base[i:i + 2], 16) / 255 for i in (0, 2, 4))
            if shade:
                f = int(shade, 16) / 255
                r, g, b = r * f, g * f, b * f
            if tint:
                f = int(tint, 16) / 255
                r, g, b = (c * f + (1 - f) for c in (r, g, b))
            return rgb_hex((r, g, b))
    if hexv and hexv != "auto" and re.fullmatch(r"[0-9A-Fa-f]{6}", hexv):
        return "#" + hexv.upper()
    return None


class WordDoc:
    def __init__(self, z: zipfile.ZipFile, name: str):
        self.z = z
        self.name = name
        names = z.namelist()
        doc_part = "word/document.xml"
        for n in names:
            if n.lower() == "word/document.xml" or n.endswith("/document.xml"):
                doc_part = n
                break
        self.doc_part = doc_part
        self.rels = read_rels(z, doc_part)
        theme_xml = None
        for target, typ in self.rels.values():
            if typ == "theme" and target in names:
                theme_xml = z.read(target)
        self.ctx = Ctx(z, Theme(theme_xml))
        styles_xml = next((z.read(t) for t, typ in self.rels.values() if typ == "styles" and t in names), None)
        self.styles = WordStyles(styles_xml)
        self.root = ET.fromstring(z.read(doc_part))
        self.body = child(self.root, "body")
        self.anchors: list[tuple] = []  # (behind, relHeight, order, elements)

    # ---------- page ----------
    def page(self):
        sect = None
        for c in (self.body if self.body is not None else []):
            if ln(c) == "sectPr":
                sect = c
        if sect is None:
            sect = next(self.root.iter(f"{{{W}}}sectPr"), None)
        pg = child(sect, "pgSz")
        mar = child(sect, "pgMar")
        w = num(wv(pg, "w"), 11906) * TWIP_MM
        h = num(wv(pg, "h"), 16838) * TWIP_MM
        m = {k: num(wv(mar, k), 1440) * TWIP_MM for k in ("top", "right", "bottom", "left")}
        hdr = num(wv(mar, "header"), 720) * TWIP_MM
        self.page_w, self.page_h, self.mar, self.hdr_dist = w, h, m, hdr
        self.sect = sect

    # ---------- paragraph ----------
    def paragraph(self, p, rels, collect_anchors=None) -> dict:
        ppr_el = child(p, "pPr")
        direct = parse_ppr(ppr_el)
        pp = self.styles.ppr(direct)
        pstyle = pp.get("pStyle")
        mark = self.styles.rpr(pstyle, None, parse_rpr(child(ppr_el, "rPr")) if ppr_el is not None else {})
        rtl = bool(pp.get("bidi"))
        jc = pp.get("jc") or "start"
        align = {"left": "start", "start": "start", "right": "end", "end": "end", "center": "center",
                 "both": "justify", "distribute": "justify", "thaiDistribute": "justify"}.get(jc, "start")
        line = None
        if pp.get("line") is not None:
            rule = pp.get("lineRule", "auto")
            if rule == "auto":
                mult = pp["line"] / 240
                line = None if 0.95 <= mult <= 1.16 else fmt(1.2 * mult)
            else:
                line = fmt(pp["line"] / 20) + "pt"
        para = {
            "dir": "rtl" if rtl else "ltr", "align": align,
            "before": (pp.get("before") or 0) / 20, "after": (pp.get("after") or 0) / 20, "line": line,
            "indL": (pp.get("indL") or 0) * TWIP_MM, "indR": (pp.get("indR") or 0) * TWIP_MM,
            "first": ((pp.get("first") or 0) - (pp.get("hanging") or 0)) * TWIP_MM,
            "mark_size": (mark.get("szCs") if rtl else None) or mark.get("sz") or 10,
            "segs": [],
        }
        if rtl:  # indents swap sides in a right-to-left paragraph
            para["indL"], para["indR"] = para["indR"], para["indL"]
        self._runs(p, rels, para, pstyle, collect_anchors)
        return para

    def _runs(self, parent, rels, para, pstyle, collect_anchors):
        for c in parent:
            n = ln(c)
            if n == "r":
                self._run(c, rels, para, pstyle, collect_anchors)
            elif n in ("hyperlink", "ins", "smartTag", "fldSimple", "customXml", "dir", "bdo"):
                self._runs(c, rels, para, pstyle, collect_anchors)
            elif n == "sdt":
                self._runs(child(c, "sdtContent"), rels, para, pstyle, collect_anchors)
            elif n == "AlternateContent":
                ch = child(c, "Choice")
                if ch is not None:
                    self._runs(ch, rels, para, pstyle, collect_anchors)

    def _run(self, r, rels, para, pstyle, collect_anchors):
        rpr_el = child(r, "rPr")
        rstyle = wv(child(rpr_el, "rStyle")) if rpr_el is not None else None
        rp = self.styles.rpr(pstyle, rstyle, parse_rpr(rpr_el))
        if rp.get("vanish"):
            return
        items: list = []
        for c in r:
            n = ln(c)
            if n == "t":
                items.append(c.text or "")
            elif n == "tab":
                items.append("\t")
            elif n in ("br", "cr"):
                items.append(None)
            elif n == "noBreakHyphen":
                items.append("\u2011")
            elif n == "sym":
                try:
                    items.append(chr(int(wv(c, "char"), 16)))
                except (TypeError, ValueError):
                    pass
            elif n in ("drawing", "AlternateContent", "pict"):
                self._drawing(c, rels, para, collect_anchors)
        for it in items:
            if it is None:
                para["segs"].append({"br": True})
                continue
            if not it:
                continue
            cs_all = bool(rp.get("rtl") or rp.get("cs"))
            pieces = [(it, True)] if cs_all else split_script(it, rp.get("hint") == "cs")
            for text, is_cs in pieces:
                para["segs"].append(self._seg(text, rp, is_cs, bool(rp.get("rtl"))))

    def _seg(self, text, rp, is_cs, rtl) -> dict:
        theme = self.ctx.theme
        f_cs = word_font(rp, theme, "cs")
        f_lat = word_font(rp, theme, "ascii") or word_font(rp, theme, "hAnsi")
        if is_cs:
            fonts = [f_cs or f_lat or "Tahoma", f_lat]
            size = rp.get("szCs") or rp.get("sz") or 10
            bold, italic = rp.get("bCs"), rp.get("iCs")
        else:
            fonts = [f_lat or f_cs or "Tahoma", f_cs]
            size = rp.get("sz") or 10
            bold, italic = rp.get("b"), rp.get("i")
        fonts = [f for f in fonts if f]
        self.ctx.fonts.add(fonts[0])
        if rp.get("caps"):
            text = text.upper()
        return {"text": text, "fonts": fonts, "size": size, "bold": bool(bold), "italic": bool(italic),
                "underline": bool(rp.get("u")), "strike": bool(rp.get("strike") or rp.get("dstrike")),
                "color": word_color(rp.get("color"), theme), "bg": rp.get("bg"), "vert": rp.get("vert"),
                "spacing": rp.get("spacing"), "rtl": rtl}

    # ---------- floating and inline objects ----------
    def _drawing(self, el, rels, para, collect_anchors):
        if ln(el) == "AlternateContent":
            ch = child(el, "Choice")
            if ch is None:
                return
            for c in ch:
                self._drawing(c, rels, para, collect_anchors)
            return
        if ln(el) == "pict":
            self.ctx.warn("Legacy VML shapes were not imported")
            return
        for d in el:
            if ln(d) == "inline":
                ext = child(d, "extent")
                w = num(ext.get("cx"), 0) / EMU_MM
                h = num(ext.get("cy"), 0) / EMU_MM
                gd = find_path(d, "graphic", "graphicData")
                pic = child(gd, "pic")
                if pic is not None:
                    url, _crop = blip_image(self.ctx, child(pic, "blipFill"), rels)
                    if url:
                        para["segs"].append({"img": url, "w": w, "h": h})
                else:
                    self.ctx.warn("A non-picture inline object was not imported")
            elif ln(d) == "anchor" and collect_anchors is not None:
                collect_anchors.append(d)

    def anchor_elements(self, a, rels, para_y: float, area_top: float) -> tuple:
        ext = child(a, "extent")
        w = num(ext.get("cx"), 0) / EMU_MM
        h = num(ext.get("cy"), 0) / EMU_MM
        pw, ph, m = self.page_w, self.page_h, self.mar
        if a.get("simplePos") in ("1", "true"):
            sp = child(a, "simplePos")
            x, y = num(sp.get("x"), 0) / EMU_MM, num(sp.get("y"), 0) / EMU_MM
        else:
            x = self._pos(child(a, "positionH"), w, {
                "page": (0, pw), "margin": (m["left"], pw - m["right"]), "column": (m["left"], pw - m["right"]),
                "character": (m["left"], pw - m["right"]), "leftMargin": (0, m["left"]),
                "rightMargin": (pw - m["right"], pw), "insideMargin": (0, m["left"]),
                "outsideMargin": (pw - m["right"], pw)}, "margin")
            y = self._pos(child(a, "positionV"), h, {
                "page": (0, ph), "margin": (m["top"], ph - m["bottom"]), "paragraph": (para_y, ph),
                "line": (para_y, ph), "topMargin": (0, m["top"]), "bottomMargin": (ph - m["bottom"], ph),
                "insideMargin": (0, m["top"]), "outsideMargin": (ph - m["bottom"], ph)}, "paragraph")
        behind = a.get("behindDoc") in ("1", "true")
        rel_h = num(a.get("relativeHeight"), 0)
        gd = find_path(a, "graphic", "graphicData")
        els = self._graphic(gd, rels, (x, y, w, h), None) if gd is not None else []
        return behind, rel_h, els

    def _pos(self, pos, size, areas, default_rel):
        if pos is None:
            return areas[default_rel][0]
        rel = pos.get("relativeFrom") or default_rel
        start, end = areas.get(rel, areas[default_rel])
        off = child(pos, "posOffset")
        if off is not None:
            return start + num(off.text, 0) / EMU_MM
        pct = child(pos, "pctPosHOffset") or child(pos, "pctPosVOffset")
        if pct is not None:
            return start + (end - start) * num(pct.text, 0) / 100000
        al = child(pos, "align")
        v = (al.text or "").strip() if al is not None else ""
        if v in ("center",):
            return start + (end - start - size) / 2
        if v in ("right", "bottom", "outside"):
            return end - size
        return start

    def _graphic(self, gd, rels, box, tf) -> list[dict]:
        out = []
        for g in gd:
            n = ln(g)
            if n == "wsp":
                out += self._wsp(g, rels, box, tf)
            elif n == "pic":
                out += self._pic(g, rels, box, tf)
            elif n == "wgp":
                out += self._group(g, rels, box, tf)
            elif n in ("wpc", "chart", "relIds"):
                self.ctx.warn("A Word chart or drawing canvas was not imported")
        return out

    def _group(self, g, rels, box, tf):
        # Group: child coordinates are relative to the group's chOff/chExt
        x, y, w, h = box
        gsp = child(g, "grpSpPr")
        xf = child(gsp, "xfrm")
        choff, chext = (child(xf, "chOff"), child(xf, "chExt")) if xf is not None else (None, None)
        cx = num(choff.get("x"), 0) if choff is not None else 0
        cy = num(choff.get("y"), 0) if choff is not None else 0
        cw = num(chext.get("cx"), 1) if chext is not None else w * EMU_MM
        ch = num(chext.get("cy"), 1) if chext is not None else h * EMU_MM
        sx, sy = (w * EMU_MM) / cw if cw else 1, (h * EMU_MM) / ch if ch else 1

        def gtf(px, py, pw, ph):
            nx, ny = x * EMU_MM + (px - cx) * sx, y * EMU_MM + (py - cy) * sy
            nw, nh = pw * sx, ph * sy
            return tf(nx, ny, nw, nh) if tf else (nx, ny, nw, nh)
        out = []
        for c in g:
            n = ln(c)
            if n == "wsp":
                out += self._wsp(c, rels, None, gtf)
            elif n == "pic":
                out += self._pic(c, rels, None, gtf)
            elif n == "grpSp":
                out += self._group(c, rels, (x, y, w, h), tf)
        return out

    def _box(self, sppr, box, tf):
        xb = xfrm_box(child(sppr, "xfrm"), tf)
        if box is not None:
            rot, fh, fv = (xb[4], xb[5], xb[6]) if xb else (0, False, False)
            return box[0], box[1], box[2], box[3], rot, fh, fv
        return xb

    def _wsp(self, s, rels, box, tf):
        sppr = child(s, "spPr")
        b = self._box(sppr, box, tf)
        if b is None:
            return []
        x, y, w, h, rot, fh, fv = b
        lc, li, fc, fi, tc = style_refs(self.ctx, child(s, "style"))
        fill, blip = fill_props(self.ctx, sppr, fc, fi)
        stroke, sw, dash = line_props(self.ctx, child(sppr, "ln") if sppr is not None else None, lc, li)
        geom = child(sppr, "prstGeom")
        geom = geom.get("prst") if geom is not None else ("rect" if child(sppr, "custGeom") is None else "custom")
        txbx = find_path(s, "txbx", "txbxContent")
        paras = None
        if txbx is not None:
            paras = self.block_paras(txbx, rels, None)
            if tc:
                for p in paras:
                    for sg in p["segs"]:
                        sg.setdefault("color", None)
                        sg["color"] = sg["color"] or tc
        body = body_props(child(s, "bodyPr"))
        img, crop = (blip_image(self.ctx, blip, rels) if blip is not None else (None, None))
        return shape_elements(self.ctx, (x, y, w, h), rot, fh, fv, geom, fill, stroke, sw, dash,
                              paras, body, img, crop)

    def _pic(self, pic, rels, box, tf):
        sppr = child(pic, "spPr")
        b = self._box(sppr, box, tf)
        if b is None:
            return []
        x, y, w, h, rot, fh, fv = b
        url, crop = blip_image(self.ctx, child(pic, "blipFill"), rels)
        if not url:
            return []
        stroke, sw, dash = line_props(self.ctx, child(sppr, "ln") if sppr is not None else None)
        return shape_elements(self.ctx, (x, y, w, h), rot, fh, fv, "rect", None, stroke, sw, dash,
                              img=url, crop=crop)

    def block_paras(self, container, rels, collect_anchors) -> list[dict]:
        paras = []
        for c in container:
            n = ln(c)
            if n == "p":
                paras.append(self.paragraph(c, rels, collect_anchors))
            elif n == "sdt":
                paras += self.block_paras(child(c, "sdtContent"), rels, collect_anchors)
            elif n == "tbl":
                self.ctx.warn("A Word table was imported as plain text")
                for tr in children(c, "tr"):
                    row = []
                    for tcell in children(tr, "tc"):
                        row += self.block_paras(tcell, rels, collect_anchors)
                    if row:
                        merged = row[0]
                        for extra in row[1:]:
                            merged["segs"] += [dict(extra["segs"][0], text="  |  ")] if extra["segs"] else []
                            merged["segs"] += extra["segs"]
                        paras.append(merged)
        return paras

    # ---------- whole document ----------
    def convert(self) -> list[dict]:
        self.page()
        m = self.mar
        anchors_found: list = []
        body_paras: list[dict] = []
        para_ys: list[float] = []
        y_cursor = m["top"]
        content_w = self.page_w - m["left"] - m["right"]
        for c in (self.body if self.body is not None else []):
            n = ln(c)
            if n not in ("p", "sdt", "tbl"):
                continue
            local: list = []
            paras = self.block_paras([c] if n != "sdt" else child(c, "sdtContent"), self.rels, local)
            for p in paras:
                top = y_cursor + p["before"] * PT_MM
                for a in local:
                    anchors_found.append((a, top))
                local = []
                body_paras.append(p)
                para_ys.append(top)
                sizes = [s["size"] for s in p["segs"] if s.get("text")] or [p["mark_size"]]
                chars = sum(len(s.get("text") or "") for s in p["segs"])
                est_lines = max(1, sum(1 for s in p["segs"] if s.get("br")) + 1,
                                math.ceil(chars * max(sizes) * PT_MM * 0.5 / max(content_w, 1)))
                y_cursor = top + est_lines * max(sizes) * 1.3 * PT_MM + p["after"] * PT_MM
        # Header and footer: floating objects and plain text only
        hdr_elements: list[dict] = []
        sect = self.sect
        for ref in (children(sect, "headerReference") + children(sect, "footerReference")) if sect is not None else []:
            if wv(ref, "type") not in (None, "default"):
                continue
            target = self.rels.get(ref.get(f"{{{R}}}id"), (None,))[0]
            if not target or target not in self.z.namelist():
                continue
            hroot = ET.fromstring(self.z.read(target))
            hrels = read_rels(self.z, target)
            local: list = []
            hp = self.block_paras(hroot, hrels, local)
            is_header = ln(ref) == "headerReference"
            top = self.hdr_dist if is_header else self.page_h - m["bottom"]
            for a in local:
                behind, rel_h, els = self.anchor_elements(a, hrels, top, top)
                self.anchors.append((behind, rel_h, len(self.anchors), els))
            if any((s.get("text") or "").strip() or s.get("img") for p in hp for s in p["segs"]):
                hdr_elements.append(text_element(
                    (m["left"], top, content_w, max(5.0, m["top"] - top if is_header else m["bottom"])), 0, hp,
                    {"pad": [0, 0, 0, 0], "valign": "top"}))
        for a, top in anchors_found:
            behind, rel_h, els = self.anchor_elements(a, self.rels, top, top)
            self.anchors.append((behind, rel_h, len(self.anchors), els))
        elements: list[dict] = []
        back = sorted((t for t in self.anchors if t[0]), key=lambda t: (t[1], t[2]))
        front = sorted((t for t in self.anchors if not t[0]), key=lambda t: (t[1], t[2]))
        for t in back:
            elements += t[3]
        elements += hdr_elements
        has_text = any((s.get("text") or "").strip() or s.get("img") for p in body_paras for s in p["segs"])
        if has_text:
            # Drop trailing empty paragraphs; inner empty ones keep the spacing
            while body_paras and not any((s.get("text") or "").strip() or s.get("img") for s in body_paras[-1]["segs"]):
                body_paras.pop()
            elements.append(text_element(
                (m["left"], m["top"], content_w, max(5.0, self.page_h - m["top"] - m["bottom"])), 0, body_paras,
                {"pad": [0, 0, 0, 0], "valign": "top"}))
        for t in front:
            elements += t[3]
        name = posixpath.splitext(posixpath.basename(self.name.replace("\\", "/")))[0]
        return [make_label(name, self.page_w, self.page_h, elements, self.ctx, self.name)]


# ================================================================= PowerPoint
class PptxDoc:
    def __init__(self, z: zipfile.ZipFile, name: str):
        self.z = z
        self.name = name
        self.names = set(z.namelist())
        self.pres_part = "ppt/presentation.xml"
        self.pres = ET.fromstring(z.read(self.pres_part))
        self.pres_rels = read_rels(z, self.pres_part)
        sz = child(self.pres, "sldSz")
        self.w = num(sz.get("cx"), 9144000) / EMU_MM if sz is not None else 254
        self.h = num(sz.get("cy"), 6858000) / EMU_MM if sz is not None else 190.5
        self.default_style = child(self.pres, "defaultTextStyle")

    def slides(self) -> list[str]:
        out = []
        lst = child(self.pres, "sldIdLst")
        for s in children(lst, "sldId"):
            t = self.pres_rels.get(s.get(f"{{{R}}}id"), (None,))[0]
            if t and t in self.names:
                out.append(t)
        return out

    def _related(self, part, typ):
        for t, ty in read_rels(self.z, part).values():
            if ty == typ and t in self.names:
                return t
        return None

    def convert(self) -> list[dict]:
        labels = []
        slides = self.slides()
        base = posixpath.splitext(posixpath.basename(self.name.replace("\\", "/")))[0]
        for i, sp in enumerate(slides):
            labels.append(self.slide(sp, base if len(slides) == 1 else f"{base} - slide {i + 1}"))
        if not labels:
            raise ImportError_("import.no_slides", "No slides were found in the file")
        return labels

    def slide(self, part: str, name: str) -> dict:
        layout = self._related(part, "slideLayout")
        master = self._related(layout, "slideMaster") if layout else None
        theme_part = self._related(master, "theme") if master else None
        theme = Theme(self.z.read(theme_part) if theme_part else None)
        self.master = ET.fromstring(self.z.read(master)) if master else None
        self.layout = ET.fromstring(self.z.read(layout)) if layout else None
        clrmap = dict(DEFAULT_CLRMAP)
        cm = child(self.master, "clrMap") if self.master is not None else None
        if cm is not None:
            clrmap.update(cm.attrib)
        self.ctx = Ctx(self.z, theme, clrmap)
        self.rels = read_rels(self.z, part)
        root = ET.fromstring(self.z.read(part))
        ovr = find_path(root, "clrMapOvr", "overrideClrMapping")
        if ovr is not None:
            self.ctx.clrmap = dict(DEFAULT_CLRMAP, **ovr.attrib)
        tx1 = ET.Element(f"{{{A}}}x")
        ET.SubElement(tx1, f"{{{A}}}schemeClr", val="tx1")
        self.tx1 = theme.color(tx1, self.ctx.clrmap) or "#000000"
        csld = child(root, "cSld")
        elements: list[dict] = []
        bg = None
        for src, rels in ((root, self.rels), (self.layout, None), (self.master, None)):
            if src is None:
                continue
            b = find_path(src, "cSld", "bg")
            if b is None:
                continue
            bgpr = child(b, "bgPr")
            if bgpr is not None:
                fill, blip = fill_props(self.ctx, bgpr, clrmap=self.ctx.clrmap)
                if blip is not None and rels is not None:
                    url, crop = blip_image(self.ctx, blip, rels)
                    if url:
                        elements.append({"id": uid(), "type": "image", "x": 0, "y": 0, "w": r2(self.w),
                                         "h": r2(self.h), "rot": 0, "src": url, "fit": "fill", "crop": crop,
                                         "flipH": False, "flipV": False, "invert": False, "dither": False,
                                         "stroke": None, "strokeW": 0})
                bg = fill
            else:
                ref = child(b, "bgRef")
                if ref is not None:
                    bg = self.ctx.theme.color(ref, self.ctx.clrmap)
            break
        if bg and bg.upper() in ("#FFFFFF",):
            bg = None
        elements += self.tree(child(csld, "spTree"), None)
        return make_label(name, self.w, self.h, elements, self.ctx, self.name, bg)

    def tree(self, node, tf) -> list[dict]:
        out = []
        for c in (node if node is not None else []):
            n = ln(c)
            if n == "sp":
                out += self.sp(c, tf)
            elif n == "pic":
                out += self.pic(c, tf)
            elif n == "cxnSp":
                out += self.cxn(c, tf)
            elif n == "grpSp":
                gsp = child(c, "grpSpPr")
                xf = child(gsp, "xfrm")
                if xf is not None and num(xf.get("rot"), 0):
                    self.ctx.warn("Group rotation was ignored")
                out += self.tree(c, group_tf(gsp, tf))
            elif n == "graphicFrame":
                self.ctx.warn("A PowerPoint table or chart was not imported")
            elif n == "AlternateContent":
                ch = child(c, "Choice")
                if ch is not None:
                    out += self.tree(ch, tf)
        return out

    def _ph(self, sp):
        ph = find_path(sp, "nvSpPr", "nvPr", "ph")
        if ph is None:
            ph = find_path(sp, "nvPicPr", "nvPr", "ph")
        return ph

    def _ph_lookup(self, ph):
        """The matching placeholder shape in the layout and the master."""
        found = []
        for src in (self.layout, self.master):
            if src is None:
                continue
            for s in find_path(src, "cSld", "spTree") or []:
                p2 = self._ph(s)
                if p2 is None:
                    continue
                if (ph.get("idx") and p2.get("idx") == ph.get("idx")) or \
                        (p2.get("type", "body") == ph.get("type", "body") and not ph.get("idx")):
                    found.append(s)
                    break
        return found

    def sp(self, sp, tf):
        sppr = child(sp, "spPr")
        ph = self._ph(sp)
        inherited = self._ph_lookup(ph) if ph is not None else []
        xfrm = child(sppr, "xfrm")
        if xfrm is None:
            for s in inherited:
                xfrm = find_path(s, "spPr", "xfrm")
                if xfrm is not None:
                    break
        b = xfrm_box(xfrm, tf)
        if b is None:
            return []
        x, y, w, h, rot, fh, fv = b
        cm = self.ctx.clrmap
        lc, li, fc, fi, tc = style_refs(self.ctx, child(sp, "style"), cm)
        fill, blip = fill_props(self.ctx, sppr, fc, fi, cm)
        stroke, sw, dash = line_props(self.ctx, child(sppr, "ln") if sppr is not None else None, lc, li, cm)
        g = child(sppr, "prstGeom")
        geom = g.get("prst") if g is not None else ("custom" if child(sppr, "custGeom") is not None else "rect")
        txb = child(sp, "txBody")
        paras, body = None, None
        if txb is not None:
            ph_type = ph.get("type", "body") if ph is not None else None
            paras, body = self.text(txb, tc, ph_type, inherited)
        img, crop = (blip_image(self.ctx, blip, self.rels) if blip is not None else (None, None))
        return shape_elements(self.ctx, (x, y, w, h), rot, fh, fv, geom, fill, stroke, sw, dash,
                              paras, body, img, crop)

    def pic(self, pic, tf):
        sppr = child(pic, "spPr")
        b = xfrm_box(child(sppr, "xfrm"), tf)
        if b is None:
            return []
        x, y, w, h, rot, fh, fv = b
        url, crop = blip_image(self.ctx, child(pic, "blipFill"), self.rels)
        if not url:
            return []
        stroke, sw, dash = line_props(self.ctx, child(sppr, "ln") if sppr is not None else None,
                                      clrmap=self.ctx.clrmap)
        return shape_elements(self.ctx, (x, y, w, h), rot, fh, fv, "rect", None, stroke, sw, dash,
                              img=url, crop=crop)

    def cxn(self, c, tf):
        sppr = child(c, "spPr")
        b = xfrm_box(child(sppr, "xfrm"), tf)
        if b is None:
            return []
        x, y, w, h, rot, fh, fv = b
        lc, li, _fc, _fi, _tc = style_refs(self.ctx, child(c, "style"), self.ctx.clrmap)
        stroke, sw, dash = line_props(self.ctx, child(sppr, "ln") if sppr is not None else None, lc, li,
                                      self.ctx.clrmap)
        return shape_elements(self.ctx, (x, y, w, h), rot, fh, fv, "line", None, stroke, sw, dash)

    # ---------- text ----------
    def _level_styles(self, ph_type, inherited, lst_style, lvl):
        """Level pPr elements, from the most general to the most specific."""
        key = f"lvl{lvl + 1}pPr"
        chain = []
        if self.default_style is not None:
            chain.append(child(self.default_style, key))
        tx = child(self.master, "txStyles") if self.master is not None else None
        if tx is not None:
            if ph_type in ("title", "ctrTitle"):
                chain.append(find_path(tx, "titleStyle", key))
            elif ph_type is not None:
                chain.append(find_path(tx, "bodyStyle", key))
            else:
                chain.append(find_path(tx, "otherStyle", key))
        for s in reversed(inherited):
            chain.append(find_path(s, "txBody", "lstStyle", key))
        chain.append(child(lst_style, key) if lst_style is not None else None)
        return [c for c in chain if c is not None]

    def text(self, txb, style_color, ph_type, inherited):
        bp = child(txb, "bodyPr")
        body = body_props(bp)
        scale = body.get("fontScale", 1.0)
        reduce_ = body.get("lnReduce", 0.0)
        lst = child(txb, "lstStyle")
        theme = self.ctx.theme
        paras = []
        for p in children(txb, "p"):
            ppr = child(p, "pPr")
            lvl = int(num(ppr.get("lvl"), 0)) if ppr is not None else 0
            levels = self._level_styles(ph_type, inherited, lst, lvl) + ([ppr] if ppr is not None else [])
            algn, rtl, lnspc, bef, aft, marl, indent = "l", False, None, None, None, 0, 0
            rp_chain = []
            for lv in levels:
                algn = lv.get("algn", algn)
                if lv.get("rtl") is not None:
                    rtl = lv.get("rtl") in ("1", "true")
                marl = num(lv.get("marL"), marl)
                indent = num(lv.get("indent"), indent)
                for k in ("lnSpc", "spcBef", "spcAft"):
                    e = child(lv, k)
                    if e is not None:
                        if k == "lnSpc":
                            lnspc = e
                        elif k == "spcBef":
                            bef = e
                        else:
                            aft = e
                d = child(lv, "defRPr")
                if d is not None:
                    rp_chain.append(d)
            base = {"sz": 18.0, "latin": "+mn-lt", "cs": "+mn-cs", "color": style_color or None}

            def merged(extra):
                rp = dict(base)
                for e in rp_chain + ([extra] if extra is not None else []):
                    self._rpr(e, rp)
                return rp
            align = {"l": "left", "ctr": "center", "r": "right", "just": "justify", "dist": "justify",
                     "justLow": "justify", "thaiDist": "justify"}.get(algn, "left")
            mark_rp = merged(child(p, "endParaRPr"))
            para = {"dir": "rtl" if rtl else "ltr", "align": align, "segs": [],
                    "mark_size": mark_rp["sz"] * scale,
                    "before": self._spc(bef, mark_rp["sz"]), "after": self._spc(aft, mark_rp["sz"]),
                    "line": self._lnspc(lnspc, reduce_),
                    "indL" if not rtl else "indR": marl / EMU_MM, "first": indent / EMU_MM}
            for r in p:
                n = ln(r)
                if n == "br":
                    para["segs"].append({"br": True})
                    continue
                if n not in ("r", "fld"):
                    continue
                t = child(r, "t")
                text = (t.text or "") if t is not None else ""
                if not text:
                    continue
                rp = merged(child(r, "rPr"))
                lat = theme.font(rp.get("latin"))
                cs = theme.font(rp.get("cs"))
                for piece, is_cs in split_script(text, False):
                    fonts = [cs or lat, lat] if is_cs else [lat or cs, cs]
                    fonts = [f for f in fonts if f] or ["Tahoma"]
                    self.ctx.fonts.add(fonts[0])
                    if rp.get("cap") == "all":
                        piece = piece.upper()
                    para["segs"].append({
                        "text": piece, "fonts": fonts, "size": round(rp["sz"] * scale, 2),
                        "bold": rp.get("b", False), "italic": rp.get("i", False),
                        "underline": rp.get("u", False), "strike": rp.get("strike", False),
                        "color": rp.get("color") or self.tx1,
                        "bg": rp.get("bg"), "spacing": rp.get("spc"),
                        "vert": "superscript" if rp.get("baseline", 0) > 0 else (
                            "subscript" if rp.get("baseline", 0) < 0 else None),
                        "rtl": False})
            paras.append(para)
        return paras, body

    def _rpr(self, e, rp):
        if e.get("sz"):
            rp["sz"] = num(e.get("sz"), 1800) / 100
        for k in ("b", "i"):
            if e.get(k) is not None:
                rp[k] = e.get(k) in ("1", "true")
        if e.get("u") is not None:
            rp["u"] = e.get("u") != "none"
        if e.get("strike") is not None:
            rp["strike"] = e.get("strike") != "noStrike"
        if e.get("spc"):
            rp["spc"] = num(e.get("spc"), 0) / 100
        if e.get("baseline"):
            rp["baseline"] = num(e.get("baseline"), 0)
        if e.get("cap"):
            rp["cap"] = e.get("cap")
        for c in e:
            n = ln(c)
            if n == "solidFill":
                rp["color"] = self.ctx.theme.color(c, self.ctx.clrmap)
            elif n in ("latin", "cs") and c.get("typeface") is not None:
                rp[n] = c.get("typeface")
            elif n == "highlight":
                rp["bg"] = self.ctx.theme.color(c, self.ctx.clrmap)

    @staticmethod
    def _spc(e, size):
        if e is None:
            return 0
        pts = child(e, "spcPts")
        if pts is not None:
            return num(pts.get("val"), 0) / 100
        pct = child(e, "spcPct")
        if pct is not None:
            return num(pct.get("val"), 0) / 100000 * size * 1.2
        return 0

    @staticmethod
    def _lnspc(e, reduce_):
        if e is None:
            return None if not reduce_ else fmt(1.2 * (1 - reduce_))
        pts = child(e, "spcPts")
        if pts is not None:
            return fmt(num(pts.get("val"), 0) / 100) + "pt"
        pct = child(e, "spcPct")
        if pct is not None:
            v = num(pct.get("val"), 100000) / 100000 - reduce_
            return None if abs(v - 1) < 0.01 else fmt(1.2 * v)
        return None


# ================================================================= entry point
def import_file(filename: str, data: bytes) -> list[dict]:
    try:
        z = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        raise ImportError_("import.bad_file", "This is not a valid Word or PowerPoint file (only .docx and .pptx are supported)")
    names = set(z.namelist())
    if "ppt/presentation.xml" in names:
        return PptxDoc(z, filename).convert()
    if any(n.endswith("document.xml") and n.startswith("word/") for n in names):
        return WordDoc(z, filename).convert()
    raise ImportError_("import.unknown", "Unknown file type; only .docx and .pptx are supported")
