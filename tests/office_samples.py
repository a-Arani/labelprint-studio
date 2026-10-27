"""Small synthetic Word and PowerPoint files for the import tests.

The files are built in memory so the repository carries no binary samples. Each one reproduces a
structure seen in real label files: floating text boxes and pictures, document-default right-to-left
paragraphs, numbers split into runs of different direction, rotated slide objects and connector lines.
"""
import io
import struct
import zipfile
import zlib

EMU_MM = 36000
TWIP_MM = 1440 / 25.4

NS_W = ('xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
        'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" '
        'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
        'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" '
        'xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" '
        'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"')
NS_P = ('xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" '
        'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"')
REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships"


def png(w=8, h=8, rgb=(40, 90, 200)):
    """A tiny solid-colour PNG."""
    raw = b"".join(b"\x00" + bytes(rgb) * w for _ in range(h))

    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


def _rels(items):
    body = "".join(f'<Relationship Id="{i}" Type="{REL}/{t}" Target="{target}"/>' for i, t, target in items)
    return f'<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="{PKG_REL}">{body}</Relationships>'


def _zip(parts: dict) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in parts.items():
            z.writestr(name, data if isinstance(data, bytes) else data.encode("utf-8"))
    return buf.getvalue()


def _types(overrides):
    over = "".join(f'<Override PartName="/{p}" ContentType="{ct}"/>' for p, ct in overrides)
    return ('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>'
            f'{over}</Types>')


# ---------------------------------------------------------------- Word
def run(text, rtl=False, font="Demo Naskh", hint_cs=True):
    hint = ' w:hint="cs"' if hint_cs else ""
    rpr = f'<w:rFonts w:ascii="{font}" w:hAnsi="{font}" w:cs="{font}"{hint}/>'
    rpr += "<w:rtl/>" if rtl else ""
    space = ' xml:space="preserve"' if text != text.strip() else ""
    return f"<w:r><w:rPr>{rpr}</w:rPr><w:t{space}>{text}</w:t></w:r>"


def para(*runs, jc="center"):
    return f'<w:p><w:pPr><w:jc w:val="{jc}"/></w:pPr>{"".join(runs)}</w:p>'


def _drawing(n, x_mm, y_mm, w_mm, h_mm, graphic, behind=False):
    """A floating object positioned from the page's top-left corner."""
    e = lambda v: int(v * EMU_MM)  # noqa: E731
    return (f'<w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="{251658240 + n}" '
            f'behindDoc="{1 if behind else 0}" locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/>'
            f'<wp:positionH relativeFrom="page"><wp:posOffset>{e(x_mm)}</wp:posOffset></wp:positionH>'
            f'<wp:positionV relativeFrom="page"><wp:posOffset>{e(y_mm)}</wp:posOffset></wp:positionV>'
            f'<wp:extent cx="{e(w_mm)}" cy="{e(h_mm)}"/><wp:wrapNone/><wp:docPr id="{n}" name="Object {n}"/>'
            f'<a:graphic><a:graphicData uri="x">{graphic}</a:graphicData></a:graphic></wp:anchor></w:drawing>')


def text_box(n, x_mm, y_mm, w_mm, h_mm, *paras):
    e = lambda v: int(v * EMU_MM)  # noqa: E731
    wsp = (f'<wps:wsp><wps:cNvSpPr txBox="1"/><wps:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="{e(w_mm)}" cy="{e(h_mm)}"/></a:xfrm>'
           f'<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></wps:spPr>'
           f'<wps:txbx><w:txbxContent>{"".join(paras)}</w:txbxContent></wps:txbx>'
           f'<wps:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" anchor="t"/></wps:wsp>')
    # Word writes text boxes inside mc:AlternateContent
    return ('<w:r><mc:AlternateContent><mc:Choice Requires="wps">' + _drawing(n, x_mm, y_mm, w_mm, h_mm, wsp)
            + "</mc:Choice></mc:AlternateContent></w:r>")


def picture(n, x_mm, y_mm, w_mm, h_mm, rid="rIdImg", behind=True):
    e = lambda v: int(v * EMU_MM)  # noqa: E731
    pic = (f'<pic:pic><pic:nvPicPr><pic:cNvPr id="{n}" name="Logo"/><pic:cNvPicPr/></pic:nvPicPr>'
           f'<pic:blipFill><a:blip r:embed="{rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>'
           f'<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="{e(w_mm)}" cy="{e(h_mm)}"/></a:xfrm>'
           f'<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>')
    return "<w:r>" + _drawing(n, x_mm, y_mm, w_mm, h_mm, pic, behind) + "</w:r>"


def docx(body: str, page_mm=(55, 50), doc_bidi=True) -> bytes:
    """A .docx whose single section has the given page size; paragraphs default to right-to-left when doc_bidi."""
    w, h = (round(v * TWIP_MM) for v in page_mm)
    document = (f'<?xml version="1.0" encoding="UTF-8"?><w:document {NS_W}><w:body>{body}'
                f'<w:sectPr><w:pgSz w:w="{w}" w:h="{h}"/><w:pgMar w:top="0" w:right="0" w:bottom="0" w:left="0" '
                f'w:header="0" w:footer="0" w:gutter="0"/></w:sectPr></w:body></w:document>')
    styles = (f'<?xml version="1.0" encoding="UTF-8"?><w:styles {NS_W}><w:docDefaults>'
              '<w:rPrDefault><w:rPr><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault>'
              f'<w:pPrDefault><w:pPr>{"<w:bidi/>" if doc_bidi else ""}<w:spacing w:after="0"/></w:pPr></w:pPrDefault>'
              '</w:docDefaults></w:styles>')
    return _zip({
        "[Content_Types].xml": _types([
            ("word/document.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"),
            ("word/styles.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml")]),
        "_rels/.rels": _rels([("rId1", "officeDocument", "word/document.xml")]),
        "word/document.xml": document,
        "word/styles.xml": styles,
        "word/_rels/document.xml.rels": _rels([("rIdStyles", "styles", "styles.xml"), ("rIdImg", "image", "media/image1.png")]),
        "word/media/image1.png": png(),
    })


# ---------------------------------------------------------------- PowerPoint
def pptx(shapes: str, size_mm=(100, 50)) -> bytes:
    """A one-slide .pptx with the given shape tree content."""
    cx, cy = (int(v * EMU_MM) for v in size_mm)
    pres = (f'<?xml version="1.0" encoding="UTF-8"?><p:presentation {NS_P}><p:sldIdLst><p:sldId id="256" r:id="rIdS1"/></p:sldIdLst>'
            f'<p:sldSz cx="{cx}" cy="{cy}"/><p:notesSz cx="{cy}" cy="{cx}"/></p:presentation>')
    slide = (f'<?xml version="1.0" encoding="UTF-8"?><p:sld {NS_P}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/>'
             f'<p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>{shapes}</p:spTree></p:cSld></p:sld>')
    return _zip({
        "[Content_Types].xml": _types([
            ("ppt/presentation.xml", "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"),
            ("ppt/slides/slide1.xml", "application/vnd.openxmlformats-officedocument.presentationml.slide+xml")]),
        "_rels/.rels": _rels([("rId1", "officeDocument", "ppt/presentation.xml")]),
        "ppt/presentation.xml": pres,
        "ppt/_rels/presentation.xml.rels": _rels([("rIdS1", "slide", "slides/slide1.xml")]),
        "ppt/slides/slide1.xml": slide,
        "ppt/slides/_rels/slide1.xml.rels": _rels([("rIdImg", "image", "../media/image1.png")]),
        "ppt/media/image1.png": png(),
    })


def _xfrm(x_mm, y_mm, w_mm, h_mm, rot=0):
    e = lambda v: int(v * EMU_MM)  # noqa: E731
    rot_attr = f' rot="{rot * 60000}"' if rot else ""
    return f'<a:xfrm{rot_attr}><a:off x="{e(x_mm)}" y="{e(y_mm)}"/><a:ext cx="{e(w_mm)}" cy="{e(h_mm)}"/></a:xfrm>'


def slide_text(n, x_mm, y_mm, w_mm, h_mm, text, rot=0, wrap="none"):
    return (f'<p:sp><p:nvSpPr><p:cNvPr id="{n}" name="Text {n}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>'
            f'<p:spPr>{_xfrm(x_mm, y_mm, w_mm, h_mm, rot)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>'
            f'<p:txBody><a:bodyPr wrap="{wrap}"/><a:p><a:r><a:rPr lang="en-US" sz="1400"/><a:t>{text}</a:t></a:r></a:p></p:txBody></p:sp>')


def slide_picture(n, x_mm, y_mm, w_mm, h_mm, rot=0):
    return (f'<p:pic><p:nvPicPr><p:cNvPr id="{n}" name="Picture {n}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>'
            f'<p:blipFill><a:blip r:embed="rIdImg"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>'
            f'<p:spPr>{_xfrm(x_mm, y_mm, w_mm, h_mm, rot)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>')


def slide_line(n, x_mm, y_mm, w_mm, h_mm, width_pt=1.5, color="1F5FBF"):
    return (f'<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="{n}" name="Line {n}"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr>'
            f'<p:spPr>{_xfrm(x_mm, y_mm, w_mm, h_mm)}<a:prstGeom prst="line"><a:avLst/></a:prstGeom>'
            f'<a:ln w="{int(width_pt * 12700)}"><a:solidFill><a:srgbClr val="{color}"/></a:solidFill></a:ln></p:spPr></p:cxnSp>')
