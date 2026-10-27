import os
import socket
import sys
import tempfile
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app import printing  # noqa: E402


def sample_page(w=101, h=40):
    """A black frame plus one diagonal; an odd width also exercises the padding bits at the end of each row."""
    wb = (w + 7) // 8
    bits = bytearray(wb * h)
    for y in range(h):
        for x in range(w):
            if x in (0, w - 1) or y in (0, h - 1) or x == y:
                bits[y * wb + x // 8] |= 0x80 >> (x % 8)
    return {"w": w, "h": h, "bits": bytes(bits), "copies": 2}


def test_tspl_roundtrip():
    pg = sample_page()
    job = printing.tspl_job([pg, pg], {"dpi": 203, "gap": 3, "speed": 4, "density": 9})
    text = job.decode("latin-1")
    assert text.startswith("SIZE 12.64 mm,5 mm\r\nGAP 3 mm,0 mm\r\n")
    assert "DENSITY 9" in text and text.count("PRINT 1,2") == 2
    bitmaps = printing.decode_tspl_bitmaps(job)
    assert len(bitmaps) == 2
    wb, h, data = bitmaps[0]
    assert (wb, h) == (13, 40)
    # In TSPL a 0 bit is black
    assert bytes(b ^ 0xFF for b in data) == pg["bits"]


def test_tspl_media_options():
    pg = sample_page()
    assert b"BLINE 2 mm,0 mm" in printing.tspl_job([pg], {"media": "bline", "gap": 2})
    assert b"GAP 0,0" in printing.tspl_job([pg], {"media": "continuous"})
    inv = printing.decode_tspl_bitmaps(printing.tspl_job([pg], {"invert": True}))[0][2]
    assert inv == pg["bits"]


def test_roll_width_size_and_commands():
    pg = sample_page(800, 200)
    job = printing.tspl_job([pg], {"stockW": 104, "stockH": 25, "gap": 3})
    assert job.startswith(b"SIZE 104 mm,25 mm\r\nGAP 3 mm,0 mm\r\n")
    cal = printing.tspl_command("calibrate", {"stockW": 104, "stockH": 25, "gap": 2.5})
    assert cal == b"SIZE 104 mm,25 mm\r\nGAP 2.5 mm,0 mm\r\nGAPDETECT\r\n"
    assert printing.tspl_command("calibrate", {"media": "bline", "gap": 3}).endswith(b"BLINEDETECT\r\n")
    assert printing.tspl_command("feed", {"stockW": 100, "stockH": 50}).endswith(b"FORMFEED\r\n")
    try:
        printing.send_command("feed", {"method": "driver"})
        raise AssertionError("driver must be refused")
    except printing.PrintError:
        pass


def test_printer_control_commands():
    roll = {"stockW": 100, "stockH": 50, "gap": 2}
    # Distances are sent as printer dots: 10 mm = 80 dots at 203 dpi, 118 dots at 300 dpi
    assert printing.tspl_command("feedmm", {**roll, "mm": 10}).endswith(b"FEED 80\r\n")
    assert printing.tspl_command("backfeed", {**roll, "mm": 10, "dpi": 300}).endswith(b"BACKFEED 118\r\n")
    assert printing.tspl_command("backfeed", roll | {"mm": 5}).startswith(b"SIZE 100 mm,50 mm\r\nGAP 2 mm,0 mm\r\n")
    assert printing.tspl_command("home", roll).endswith(b"HOME\r\n")
    assert printing.tspl_command("autodetect", roll).endswith(b"AUTODETECT\r\n")
    # Commands that do not depend on the roll are sent alone
    assert printing.tspl_command("selftest", roll) == b"SELFTEST\r\n"
    assert printing.tspl_command("beep", roll) == b"SOUND 5,200\r\n"
    assert printing.tspl_command("factory", roll) == b"INITIALPRINTER\r\n"
    assert printing.tspl_command("finish", {"finish": "peel"}) == b"SET CUTTER OFF\r\nSET PEEL ON\r\n"
    assert printing.tspl_command("finish", {"finish": "tear"}).endswith(b"SET TEAR ON\r\n")
    for bad in ({"mm": 0}, {"mm": 900}, {"mm": "x"}):
        try:
            printing.tspl_command("feedmm", {**roll, **bad})
            raise AssertionError(f"distance {bad} must be refused")
        except printing.PrintError as e:
            assert e.code == "print.bad_distance"


def test_raw_command_is_checked():
    assert printing.tspl_command("raw", {"text": " SIZE 50 mm,30 mm\r\nCLS\nPRINT 1 "}) == b"SIZE 50 mm,30 mm\r\nCLS\r\nPRINT 1\r\n"
    for text, code in (("", "print.raw_empty"), ("PRINT ۱", "print.raw_invalid"), ("A" * 5000, "print.raw_too_long")):
        try:
            printing.tspl_command("raw", {"text": text})
            raise AssertionError(code)
        except printing.PrintError as e:
            assert e.code == code


def test_finish_mode_in_print_jobs():
    pg = sample_page()
    assert b"SET TEAR ON\r\n" in printing.tspl_job([pg], {})
    assert b"SET PEEL ON\r\n" in printing.tspl_job([pg], {"finish": "peel"})
    assert b"SET CUTTER BATCH\r\n" in printing.tspl_job([pg], {"finish": "cutBatch"})
    assert b"SET TEAR" not in printing.tspl_job([pg], {"finish": "cut"})


def test_base_name():
    assert printing.base_name("TSC TE200 (redirected 2)") == "TSC TE200"
    assert printing.base_name("TSC TE200") == "TSC TE200"


def test_network_send():
    received = bytearray()
    srv = socket.socket()
    srv.bind(("127.0.0.1", 0))
    srv.listen(1)
    port = srv.getsockname()[1]

    def accept():
        conn, _ = srv.accept()
        with conn:
            while True:
                chunk = conn.recv(65536)
                if not chunk:
                    break
                received.extend(chunk)
    t = threading.Thread(target=accept)
    t.start()
    res = printing.print_pages([sample_page()], {"method": "network", "host": "127.0.0.1", "port": port})
    t.join(5)
    srv.close()
    assert res["ok"] and bytes(received).startswith(b"SIZE ")


def test_gdi_to_pdf_file():
    names = [p["name"] for p in printing.list_printers()["printers"]]
    if "Microsoft Print to PDF" not in names:
        return
    out = Path(tempfile.mkdtemp()) / "label.pdf"
    n = printing.print_gdi("Microsoft Print to PDF", [sample_page(800, 400)], {"dpi": 203}, "test", str(out))
    assert n == 2
    for _ in range(50):
        if out.exists() and out.stat().st_size > 0:
            break
        time.sleep(0.2)
    assert out.exists() and out.read_bytes().startswith(b"%PDF")
