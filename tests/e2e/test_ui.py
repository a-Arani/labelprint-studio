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
