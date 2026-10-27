"""End-to-end check in a real browser (optional: needs `pip install playwright` and Microsoft Edge or Chromium).

Covers start-up, a new label, a counter variable, printing to a fake network printer, the history
and switching the interface language (including right-to-left).
"""
import re
import socket
import sys
import tempfile
import threading
import time
import urllib.request
from pathlib import Path

import pytest

sync_api = pytest.importorskip("playwright.sync_api")

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from app import printing  # noqa: E402
from app.server import serve  # noqa: E402


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def fake_printer():
    """Accepts TSPL over TCP like a network label printer; returns (port, received bytes)."""
    got = bytearray()
    srv = socket.socket()
    srv.bind(("127.0.0.1", 0))
    srv.listen(5)

    def run():
        while True:
            try:
                c, _ = srv.accept()
            except OSError:
                return
            with c:
                while True:
                    d = c.recv(65536)
                    if not d:
                        break
                    got.extend(d)
    threading.Thread(target=run, daemon=True).start()
    return srv.getsockname()[1], got


@pytest.fixture(scope="module")
def app_url():
    port = free_port()
    threading.Thread(target=serve, args=(Path(tempfile.mkdtemp()),), kwargs={"port": port}, daemon=True).start()
    for _ in range(50):
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=1)
            break
        except OSError:
            time.sleep(0.1)
    return f"http://127.0.0.1:{port}/"


@pytest.fixture(scope="module")
def page(app_url):
    with sync_api.sync_playwright() as p:
        try:
            browser = p.chromium.launch(channel="msedge")
        except Exception:
            try:
                browser = p.chromium.launch()
            except Exception as e:  # no browser installed
                pytest.skip(f"no browser for Playwright: {e}")
        pg = browser.new_page(viewport={"width": 1400, "height": 860})
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.goto(app_url)
        pg.evaluate("() => { localStorage.clear(); sessionStorage.clear(); }")
        yield pg
        browser.close()
        assert not errors, errors


def test_start_new_label_print_and_history(page, app_url):
    page.goto(app_url)
    page.wait_for_selector("#splash", state="detached", timeout=10000)
    assert page.locator(".welcome-title").inner_text() == "LabelPrint Studio"
    assert page.evaluate("document.documentElement.dir") == "ltr"

    page.click("#welcome-new")
    dlg = page.locator(".dlg").last
    dlg.locator("input.inp").nth(0).fill("Box label")
    dlg.locator(".btn-primary").click()
    page.wait_for_function("() => !document.body.classList.contains('no-doc')")
    assert page.locator("#doc-title").inner_text() == "Box label"

    # A counter variable inserted as a text element
    page.locator("#props .chip", has_text="Counter").click()
    page.locator("#props .var-card .icon-btn").first.click()
    page.wait_for_function("async () => (await import('/js/state.js')).S.doc.elements.length === 1")

    port, received = fake_printer()
    page.click("#btn-print")
    dlg = page.locator(".dlg").last
    dlg.locator("select").nth(1).select_option("network")
    dlg.locator("input[placeholder='192.168.1.50']").fill("127.0.0.1")
    field = lambda text: dlg.locator("label.field", has=page.locator("span", has_text=text)).locator("input")  # noqa: E731
    field("Port").fill(str(port))
    field("from").fill("1")
    field(re.compile("^to$")).fill("3")
    dlg.locator(".btn-primary").click()
    page.wait_for_selector(".toast-ok", timeout=15000)
    for _ in range(50):
        if received.count(b"PRINT") >= 1:
            break
        time.sleep(0.1)
    assert b"BITMAP" in received and b"PRINT" in received

    page.click("#btn-history")
    hist = page.locator(".dlg").last
    hist.locator(".tbl").first.wait_for()
    assert "1–3" in hist.inner_text().replace("⁦", "").replace("⁩", "").replace("⁨", "")
    hist.locator(".dlg-x").click()


def test_switch_language_to_right_to_left_and_back(page, app_url):
    page.goto(app_url)
    page.wait_for_selector("#splash", state="detached", timeout=10000)
    page.locator(".lib-file", has_text="Box label").click()
    page.wait_for_function("() => !document.body.classList.contains('no-doc')")
    page.click("#btn-lang")
    page.locator(".lang-menu .menu-item", has_text="فارسی").click()
    page.wait_for_load_state("load")
    page.wait_for_function("() => document.documentElement.dir === 'rtl'")
    assert page.evaluate("document.documentElement.lang") == "fa"
    # The label that was open is opened again after the reload
    page.wait_for_function("() => document.getElementById('doc-title').textContent === 'Box label'", timeout=10000)
    page.click("#btn-lang")
    page.locator(".lang-menu .menu-item", has_text="English").click()
    page.wait_for_load_state("load")
    page.wait_for_function("() => document.documentElement.dir === 'ltr'")


def _photo_label(page):
    """A label with a generated colour picture (white border around it) and nothing else."""
    page.evaluate("""async () => {
      const { api, uid } = await import('/js/util.js');
      const c = document.createElement('canvas'); c.width = 600; c.height = 400;
      const g = c.getContext('2d');
      g.fillStyle = '#fff'; g.fillRect(0, 0, 600, 400);
      const grad = g.createLinearGradient(60, 0, 540, 0); grad.addColorStop(0, '#103080'); grad.addColorStop(1, '#f0d070');
      g.fillStyle = grad; g.fillRect(60, 50, 480, 300);
      const doc = { name: 'Photo', version: 1, kind: 'label', variables: [], page: { w: 60, h: 40, printRotate: 'auto', bg: '#FFFFFF' },
        elements: [{ id: uid(), type: 'image', x: 10, y: 5, w: 40, h: 30, rot: 0, src: c.toDataURL('image/png'), fit: 'fill', crop: [0, 0, 0, 0] }] };
      await api('/api/library/save', { path: 'Photo', label: doc, overwrite: true });
    }""")
    page.reload()
    page.wait_for_selector("#splash", state="detached", timeout=10000)
    page.locator(".lib-file", has_text="Photo").first.click()
    page.wait_for_function("() => document.getElementById('doc-title').textContent === 'Photo'")


def test_image_editor_crop_and_black_white(page, app_url):
    page.goto(app_url)
    _photo_label(page)
    page.evaluate("async () => { const st = await import('/js/state.js'); st.emit('image-edit', st.S.doc.elements[0]); }")
    page.wait_for_selector(".ie-canvas")
    page.locator(".ie-controls .btn", has_text="Trim borders").click()
    page.wait_for_timeout(400)
    page.locator(".ie-controls select").nth(1).select_option("threshold")
    page.locator(".dlg-foot .btn-primary").click()
    page.wait_for_timeout(800)
    res = page.evaluate("""async () => {
      const st = await import('/js/state.js');
      const { rasterize } = await import('/js/render.js');
      const e = st.S.doc.elements[0];
      const c = await rasterize(st.S.doc, { dpi: 203 });
      const k = 203 / 25.4, d = c.getContext('2d').getImageData(Math.round(e.x * k) + 2, Math.round(e.y * k) + 2, Math.round(e.w * k) - 4, Math.round(e.h * k) - 4).data;
      let grey = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] > 24 && d[i] < 232) grey++;
      return { mode: e.fx.mode, crop: e.crop, ratio: e.w / e.h, grey: grey / (d.length / 4) };
    }""")
    # The white border is cut away (the frame follows the 480 x 300 picture) and the print is pure black and white
    assert res["mode"] == "threshold" and res["grey"] < 0.01
    assert all(c > 0.05 for c in res["crop"]) and abs(res["ratio"] - 1.6) < 0.05


def test_test_print_shift_and_printer_control(page, app_url):
    page.goto(app_url)
    _photo_label(page)
    port, received = fake_printer()
    page.click("#btn-print")
    dlg = page.locator(".dlg").last
    dlg.locator("select").nth(1).select_option("network")
    dlg.locator("input[placeholder='192.168.1.50']").fill("127.0.0.1")
    dlg.locator("label.field", has=page.locator("span", has_text="Port")).locator("input").fill(str(port))

    def test_print():
        n = received.count(b"PRINT 1,")
        dlg.locator(".pa-head .btn").click()
        for _ in range(100):
            if received.count(b"PRINT 1,") > n:
                break
            time.sleep(0.1)
        return printing.decode_tspl_bitmaps(bytes(received))[-1]

    def first_ink(bm):
        wb, hh, data = bm
        return min(x for y in range(hh) for x in range(wb * 8) if not (data[y * wb + (x >> 3)] & (0x80 >> (x & 7))))

    before = first_ink(test_print())
    for _ in range(4):
        dlg.locator(".pa-arrow", has_text="→").click()
    page.wait_for_timeout(600)
    # 4 steps of 0.5 mm = 2 mm = 16 dots at 203 dpi
    assert first_ink(test_print()) - before == 16
    # Test prints are not recorded in the history
    jobs = page.evaluate("async () => { const st = await import('/js/state.js'); return (await (await fetch('/api/history/label?uid=' + st.S.doc.uid)).json()).summary.jobs; }")
    assert jobs == 0
    dlg.locator(".dlg-x").click()

    page.evaluate("async () => { const m = await import('/js/printercontrol.js'); m.openPrinterControl(); }")
    pc = page.locator(".dlg").last
    pc.locator("select").nth(1).select_option("network")
    pc.locator("input[placeholder='192.168.1.50']").fill("127.0.0.1")
    pc.locator("label.field", has=page.locator("span", has_text="Port")).locator("input").fill(str(port))
    pc.locator(".pc-dist input").fill("5")
    pc.get_by_role("button", name="Reverse feed", exact=True).click()
    for _ in range(50):
        if b"BACKFEED 40" in received:
            break
        time.sleep(0.1)
    assert b"BACKFEED 40\r\n" in received
    # Back one label: the roll's label height plus its gap
    pc.get_by_role("button", name="Reverse feed one label").click()
    one = re.compile(rb"SIZE [\d.]+ mm,([\d.]+) mm\r\nGAP ([\d.]+) mm,[\d.]+ mm\r\nBACKFEED (\d+)\r\n")
    for _ in range(50):
        if len(one.findall(received)) > 1:
            break
        time.sleep(0.1)
    label_h, gap, dots = one.findall(received)[-1]
    assert int(dots) == round((float(label_h) + float(gap)) * 203 / 25.4) != 40
    # Go back 10 mm more, then forward until the sensor finds the gap; the choice is kept for the printer
    pc.locator(".pc-back-extra input").fill("10")
    pc.locator(".pc-back-extra input").dispatch_event("change")
    pc.locator(".pc-back-then select").select_option("home")
    pc.get_by_role("button", name="Reverse feed one label").click()
    want = f"BACKFEED {round((float(label_h) + float(gap) + 10) * 203 / 25.4)}\r\nHOME\r\n".encode()
    for _ in range(50):
        if want in received:
            break
        time.sleep(0.1)
    assert want in received
    kept = page.evaluate("async () => { const st = await import('/js/state.js'); return Object.values(st.S.settings.printers).map((p) => [p.backExtra, p.backThen]); }")
    assert [10, "home"] in kept


def test_folder_names_keep_slash_and_star(page, app_url):
    """A "/" typed in a name stays in the name, and characters Windows does not allow become look-alikes."""
    page.keyboard.press("Escape")
    page.locator("#lib-root").click()
    page.locator("#lib-new-folder").click()
    page.locator(".dlg input").fill("50/100")
    page.locator(".dlg input").press("Enter")
    row = page.locator(".lib-folder", has_text="50\u2215100")
    row.wait_for()
    row.click(button="right")
    page.locator(".menu-item", has_text="Rename").click()
    page.locator(".dlg input").fill("50*100")
    page.locator(".dlg input").press("Enter")
    page.locator(".lib-folder", has_text="50\u00d7100").wait_for()
    names = page.evaluate("async () => (await (await fetch('/api/library/tree')).json()).folders.map((f) => f.name)")
    assert "50\u00d7100" in names and "50" not in names
