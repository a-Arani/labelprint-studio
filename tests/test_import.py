import io
import os
import sys
import zipfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from app.office_import import ImportError_, import_file, split_script  # noqa: E402
from office_samples import (  # noqa: E402
    docx, para, picture, pptx, run, slide_line, slide_picture, slide_text, text_box,
)


def texts(label):
    return [e for e in label["elements"] if e["type"] == "text"]


def test_docx_textboxes_and_page():
    body = para(
        picture(1, 2, 2, 10, 14),
        text_box(2, 14, 3, 38, 12, para(run("گلدان سرامیکی"))),
        text_box(3, 5, 30, 45, 10, para(run("3.800.000", rtl=True), run(" "), run("تومان", rtl=True))),
        text_box(4, 5, 42, 45, 6, para(run("Code 4411", font="Demo Sans", hint_cs=False), jc="left")),
    )
    [label] = import_file("pot.docx", docx(body, page_mm=(55, 50)))
    assert (label["page"]["w"], label["page"]["h"]) == (55.0, 50.0)
    kinds = [e["type"] for e in label["elements"]]
    assert kinds.count("image") == 1 and kinds.count("text") == 3
    html = "".join(e["html"] for e in texts(label))
    assert "گلدان" in html and "Demo Naskh" in html
    # The paragraph direction comes from the document defaults (bidi)
    price = next(e for e in texts(label) if "تومان" in e["html"])
    assert price["dir"] == "rtl" and price["html"].startswith('<div dir="rtl"')
    for e in label["elements"]:
        assert -20 < e["x"] < 75 and -20 < e["y"] < 70
    img = next(e for e in label["elements"] if e["type"] == "image")
    assert img["src"].startswith("data:image/png;base64,") and abs(img["x"] - 2) < 0.1 and abs(img["w"] - 10) < 0.1


def test_docx_left_to_right_document():
    body = para(text_box(1, 5, 5, 40, 10, para(run("Fresh herbs", font="Demo Sans", hint_cs=False), jc="left")))
    [label] = import_file("herbs.docx", docx(body, page_mm=(50, 30), doc_bidi=False))
    [t] = texts(label)
    assert t["dir"] == "ltr" and "Fresh herbs" in t["html"]


def test_docx_mixed_direction_runs_keep_number_order():
    # "12,000,000 toman" typed in a right-to-left paragraph: digits are rtl runs, the commas are not
    price = para(run("   000", rtl=True), run(",", hint_cs=False), run("000", rtl=True), run(",", hint_cs=False),
                 run("12", rtl=True), run(" تومان", rtl=True))
    [label] = import_file("price.docx", docx(para(text_box(1, 2, 2, 50, 20, para(run("فتونیا", rtl=True)), price))))
    html = "".join(e["html"] for e in texts(label))
    # Each run of the other direction becomes an isolated span, so the number reads in the right order
    assert html.count('<span dir="ltr">') == 2
    assert "Demo Naskh" in label["meta"]["fonts"]


def test_pptx_rotated_text_and_image():
    shapes = slide_picture(2, 5, 5, 40, 20, rot=90) + slide_text(3, 50, 10, 45, 8, "Production Date", rot=90)
    [label] = import_file("rotated.pptx", pptx(shapes, size_mm=(100, 50)))
    assert (label["page"]["w"], label["page"]["h"]) == (100.0, 50.0)
    img = [e for e in label["elements"] if e["type"] == "image"]
    txt = texts(label)
    assert len(img) == 1 and img[0]["rot"] == 90 and img[0]["src"].startswith("data:image/png;base64,")
    assert len(txt) == 1 and txt[0]["rot"] == 90 and "Production Date" in txt[0]["html"]
    assert txt[0]["wrap"] is False


def test_pptx_lines():
    shapes = slide_line(2, 5, 25, 90, 0) + slide_line(3, 50, 5, 0, 40, width_pt=0.75, color="000000")
    [label] = import_file("lines.pptx", pptx(shapes))
    lines = [e for e in label["elements"] if e["type"] == "line"]
    assert len(lines) == 2 and all(e["strokeW"] > 0 and e["stroke"] for e in lines)
    assert {e["stroke"].upper() for e in lines} == {"#1F5FBF", "#000000"}


def test_import_errors_have_codes():
    with pytest.raises(ImportError_) as e:
        import_file("broken.docx", b"not a zip")
    assert e.value.code == "import.bad_file"
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("hello.txt", "hi")
    with pytest.raises(ImportError_) as e:
        import_file("other.docx", buf.getvalue())
    assert e.value.code == "import.unknown"


def test_split_script():
    assert split_script("Cactus خاک", False) == [("Cactus ", False), ("خاک", True)]
    assert split_script("12 لیتر", False)[-1] == ("12 لیتر", True)


def test_all_samples_if_present():
    """With LABEL_SAMPLES pointing at a folder of real files, every one must import without errors."""
    root = os.environ.get("LABEL_SAMPLES")
    if not root:
        pytest.skip("LABEL_SAMPLES is not set")
    n = 0
    for dp, _dn, fn in os.walk(root):
        for f in fn:
            if f.lower().endswith((".docx", ".pptx")) and not f.startswith("~$"):
                for label in import_file(f, Path(dp, f).read_bytes()):
                    assert label["page"]["w"] > 0 and label["elements"] is not None
                n += 1
    assert n > 0
