"""Printing to thermal label printers.

Every method takes 1-bit images (row by row, most significant bit first, 1 = black) that the
browser rendered at the printer's dpi. Three methods:
  - tspl   : TSPL commands with BITMAP, sent to the Windows spooler as RAW data
  - driver : ordinary printing through the Windows driver (GDI) with a custom paper size
  - network: TSPL sent to the printer's IP address on port 9100
"""
from __future__ import annotations

import ctypes
import re
import socket
import struct
import sys
from ctypes import wintypes

from .errors import AppError
from .logs import LOG

IS_WIN = sys.platform == "win32"


class PrintError(AppError):
    pass


def _n(v: float) -> str:
    s = f"{float(v):.2f}".rstrip("0").rstrip(".")
    return s or "0"


# ---------------------------------------------------------------- TSPL
def _media_lines(s: dict, w_mm: float, h_mm: float) -> list[str]:
    """SIZE and GAP: full roll width x height of one row, and the gap between rows."""
    gap = float(s.get("gap", 2))
    media = s.get("media", "gap")
    lines = [f"SIZE {_n(w_mm)} mm,{_n(h_mm)} mm"]
    if media == "bline":
        lines.append(f"BLINE {_n(gap)} mm,{_n(s.get('gapOffset', 0))} mm")
    elif media == "continuous":
        lines.append("GAP 0,0")
    else:
        lines.append(f"GAP {_n(gap)} mm,{_n(s.get('gapOffset', 0))} mm")
    return lines


def tspl_job(pages: list[dict], s: dict) -> bytes:
    """pages: [{w, h, bits (bytes, 1 = black), copies}]; s: printer and roll settings."""
    if not pages:
        raise PrintError("print.nothing", "Nothing to print")
    dpmm = float(s.get("dpi", 203)) / 25.4
    # Exact roll size if given; otherwise derived from the number of dots
    w_mm = float(s.get("stockW") or pages[0]["w"] / dpmm)
    h_mm = float(s.get("stockH") or pages[0]["h"] / dpmm)
    head = _media_lines(s, w_mm, h_mm) + [
        f"DIRECTION {int(s.get('direction', 1))},0",
        "REFERENCE 0,0",
        f"OFFSET {_n(s.get('feedOffset', 0))} mm",
        f"SPEED {_n(s.get('speed', 4))}",
        f"DENSITY {int(s.get('density', 8))}",
        *FINISH.get(s.get("finish") or "tear", FINISH["tear"]),
    ]
    out = bytearray(("\r\n".join(head) + "\r\n").encode("ascii"))
    invert = bool(s.get("invert"))
    for pg in pages:
        wb = (pg["w"] + 7) // 8
        bits = pg["bits"]
        if len(bits) != wb * pg["h"]:
            raise PrintError("print.bad_bitmap", "The image data has the wrong size")
        # In TSPL a 0 bit means a black dot
        data = bits if invert else bytes(b ^ 0xFF for b in bits)
        out += b"CLS\r\n"
        out += f"BITMAP 0,0,{wb},{pg['h']},0,".encode("ascii") + data + b"\r\n"
        out += f"PRINT 1,{max(1, int(pg.get('copies', 1)))}\r\n".encode("ascii")
    return bytes(out)


# What the printer does after each label (set in every job, and from Printer control)
FINISH = {
    "tear": ["SET TEAR ON"],                 # stop at the tear bar (default)
    "peel": ["SET PEEL ON"],                 # peel-off module: wait until the label is taken
    "cut": ["SET CUTTER 1"],                 # cutter: cut after every label
    "cutBatch": ["SET CUTTER BATCH"],        # cutter: cut once at the end of the job
    "none": ["SET TEAR OFF"],                # stop right after printing
}
# Switching mode from Printer control also turns the other modes off
FINISH_SWITCH = {
    "tear": ["SET PEEL OFF", "SET CUTTER OFF", "SET TEAR ON"],
    "peel": ["SET CUTTER OFF", "SET PEEL ON"],
    "cut": ["SET PEEL OFF", "SET CUTTER 1"],
    "cutBatch": ["SET PEEL OFF", "SET CUTTER BATCH"],
    "none": ["SET PEEL OFF", "SET CUTTER OFF", "SET TEAR OFF"],
}
RAW_MAX = 4096


def _dots(s: dict) -> int:
    """A paper distance in mm (s["mm"]) as printer dots."""
    try:
        mm = float(s.get("mm", 0))
    except (TypeError, ValueError):
        mm = 0
    if not 0.1 <= mm <= 500:
        raise PrintError("print.bad_distance", "The distance must be between 0.1 and 500 mm")
    return max(1, min(9999, round(mm * float(s.get("dpi", 203)) / 25.4)))


def _finish_switch(s: dict) -> list[str]:
    mode = s.get("finish") or "tear"
    if mode not in FINISH_SWITCH:
        raise PrintError("print.unknown_command", "Unknown command")
    return FINISH_SWITCH[mode]


def _raw(s: dict) -> list[str]:
    text = str(s.get("text", "")).replace("\r\n", "\n").replace("\r", "\n").strip()
    if not text:
        raise PrintError("print.raw_empty", "Write a command first")
    if any(not (32 <= ord(ch) < 127 or ch in "\n\t") for ch in text):
        raise PrintError("print.raw_invalid", "Commands may contain only English letters, digits and symbols")
    if len(text) > RAW_MAX:
        raise PrintError("print.raw_too_long", "The command is too long (at most {max} characters)", max=RAW_MAX)
    return [ln.rstrip() for ln in text.split("\n")]


# Printer control. Each entry: (needs the roll's SIZE/GAP first, the TSPL lines)
COMMANDS = {
    "feed": (True, lambda s: ["FORMFEED"]),                      # feed one label (one row)
    "feedmm": (True, lambda s: [f"FEED {_dots(s)}"]),             # feed a distance
    "backfeed": (True, lambda s: [f"BACKFEED {_dots(s)}"]),       # reverse feed a distance
    "home": (True, lambda s: ["HOME"]),                          # move to the start of the next label
    # Calibrate the gap or black-mark sensor for a new roll
    "calibrate": (True, lambda s: ["BLINEDETECT" if s.get("media") == "bline" else "GAPDETECT"]),
    "autodetect": (True, lambda s: ["AUTODETECT"]),
    "selftest": (False, lambda s: ["SELFTEST"]),                 # print the printer's self-test page
    "beep": (False, lambda s: ["SOUND 5,200"]),
    "finish": (False, _finish_switch),
    "factory": (False, lambda s: ["INITIALPRINTER"]),            # restore the printer's factory settings
    "raw": (False, _raw),                                        # any TSPL the user types
}


def tspl_command(cmd: str, s: dict) -> bytes:
    if cmd not in COMMANDS:
        raise PrintError("print.unknown_command", "Unknown command")
    if s.get("media") == "continuous" and cmd in ("calibrate", "autodetect"):
        raise PrintError("print.continuous_no_calibration", "Continuous media does not need calibration")
    with_media, build = COMMANDS[cmd]
    lines = (_media_lines(s, float(s.get("stockW") or 100), float(s.get("stockH") or 50)) if with_media else []) + build(s)
    return ("\r\n".join(lines) + "\r\n").encode("ascii")


def send_command(cmd: str, s: dict) -> dict:
    """Send a direct command to the printer (TSPL or network method only)."""
    method = s.get("method", "tspl")
    if method == "driver":
        raise PrintError("print.direct_only", "This only works with the Direct (TSPL) or Network method")
    data = tspl_command(cmd, s)
    LOG.info("Printer command '%s': method=%s printer=%s -> %r", cmd, method, s.get("printer") or s.get("host"), data[:300])
    if method == "network":
        return {"ok": True, "bytes": send_tcp(s.get("host", ""), int(s.get("port", 9100)), data)}
    return {"ok": True, "bytes": send_raw(resolve_printer(s.get("printer", "")), data, f"Label {cmd}")}


def decode_tspl_bitmaps(job: bytes) -> list[tuple[int, int, bytes]]:
    """For tests: the BITMAPs of a TSPL job as (width in bytes, height, data)."""
    out = []
    pos = 0
    head = re.compile(rb"BITMAP (\d+),(\d+),(\d+),(\d+),(\d+),")
    while True:
        m = head.search(job, pos)
        if not m:
            return out
        wb, h = int(m.group(3)), int(m.group(4))
        out.append((wb, h, job[m.end():m.end() + wb * h]))
        pos = m.end() + wb * h


# ---------------------------------------------------------------- Windows
if IS_WIN:
    winspool = ctypes.WinDLL("winspool.drv", use_last_error=True)
    gdi32 = ctypes.WinDLL("gdi32", use_last_error=True)

    class DOC_INFO_1(ctypes.Structure):
        _fields_ = [("pDocName", wintypes.LPWSTR), ("pOutputFile", wintypes.LPWSTR),
                    ("pDatatype", wintypes.LPWSTR)]

    class DOCINFOW(ctypes.Structure):
        _fields_ = [("cbSize", ctypes.c_int), ("lpszDocName", wintypes.LPCWSTR),
                    ("lpszOutput", wintypes.LPCWSTR), ("lpszDatatype", wintypes.LPCWSTR),
                    ("fwType", wintypes.DWORD)]

    class PRINTER_INFO_2(ctypes.Structure):
        _fields_ = [("pServerName", wintypes.LPWSTR), ("pPrinterName", wintypes.LPWSTR),
                    ("pShareName", wintypes.LPWSTR), ("pPortName", wintypes.LPWSTR),
                    ("pDriverName", wintypes.LPWSTR), ("pComment", wintypes.LPWSTR),
                    ("pLocation", wintypes.LPWSTR), ("pDevMode", ctypes.c_void_p),
                    ("pSepFile", wintypes.LPWSTR), ("pPrintProcessor", wintypes.LPWSTR),
                    ("pDatatype", wintypes.LPWSTR), ("pParameters", wintypes.LPWSTR),
                    ("pSecurityDescriptor", ctypes.c_void_p), ("Attributes", wintypes.DWORD),
                    ("Priority", wintypes.DWORD), ("DefaultPriority", wintypes.DWORD),
                    ("StartTime", wintypes.DWORD), ("UntilTime", wintypes.DWORD),
                    ("Status", wintypes.DWORD), ("cJobs", wintypes.DWORD), ("AveragePPM", wintypes.DWORD)]

    winspool.OpenPrinterW.argtypes = [wintypes.LPWSTR, ctypes.POINTER(wintypes.HANDLE), ctypes.c_void_p]
    winspool.OpenPrinterW.restype = wintypes.BOOL
    winspool.ClosePrinter.argtypes = [wintypes.HANDLE]
    winspool.StartDocPrinterW.argtypes = [wintypes.HANDLE, wintypes.DWORD, ctypes.POINTER(DOC_INFO_1)]
    winspool.StartDocPrinterW.restype = wintypes.DWORD
    winspool.StartPagePrinter.argtypes = [wintypes.HANDLE]
    winspool.EndPagePrinter.argtypes = [wintypes.HANDLE]
    winspool.EndDocPrinter.argtypes = [wintypes.HANDLE]
    winspool.WritePrinter.argtypes = [wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD,
                                      ctypes.POINTER(wintypes.DWORD)]
    winspool.WritePrinter.restype = wintypes.BOOL
    winspool.EnumPrintersW.argtypes = [wintypes.DWORD, wintypes.LPWSTR, wintypes.DWORD, ctypes.c_void_p,
                                       wintypes.DWORD, ctypes.POINTER(wintypes.DWORD),
                                       ctypes.POINTER(wintypes.DWORD)]
    winspool.EnumPrintersW.restype = wintypes.BOOL
    winspool.GetDefaultPrinterW.argtypes = [wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]
    winspool.DocumentPropertiesW.argtypes = [wintypes.HWND, wintypes.HANDLE, wintypes.LPWSTR, ctypes.c_void_p,
                                             ctypes.c_void_p, wintypes.DWORD]
    winspool.DocumentPropertiesW.restype = ctypes.c_long
    gdi32.CreateDCW.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.LPCWSTR, ctypes.c_void_p]
    gdi32.CreateDCW.restype = wintypes.HDC
    gdi32.DeleteDC.argtypes = [wintypes.HDC]
    gdi32.GetDeviceCaps.argtypes = [wintypes.HDC, ctypes.c_int]
    gdi32.StartDocW.argtypes = [wintypes.HDC, ctypes.POINTER(DOCINFOW)]
    gdi32.StartPage.argtypes = [wintypes.HDC]
    gdi32.EndPage.argtypes = [wintypes.HDC]
    gdi32.EndDoc.argtypes = [wintypes.HDC]
    gdi32.AbortDoc.argtypes = [wintypes.HDC]
    gdi32.SetStretchBltMode.argtypes = [wintypes.HDC, ctypes.c_int]
    gdi32.StretchDIBits.argtypes = [wintypes.HDC, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int,
                                    ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_void_p,
                                    ctypes.c_void_p, wintypes.UINT, wintypes.DWORD]

PRINTER_ENUM_LOCAL = 0x2
PRINTER_ENUM_CONNECTIONS = 0x4
DM_OUT_BUFFER = 2
DM_IN_BUFFER = 8
DM_ORIENTATION, DM_PAPERSIZE, DM_PAPERLENGTH, DM_PAPERWIDTH = 0x1, 0x2, 0x4, 0x8
LOGPIXELSX, LOGPIXELSY, PHYSICALOFFSETX, PHYSICALOFFSETY = 88, 90, 112, 113


def list_printers() -> dict:
    if not IS_WIN:
        return {"printers": [], "default": None}
    flags = PRINTER_ENUM_LOCAL | PRINTER_ENUM_CONNECTIONS
    needed, count = wintypes.DWORD(0), wintypes.DWORD(0)
    winspool.EnumPrintersW(flags, None, 2, None, 0, ctypes.byref(needed), ctypes.byref(count))
    printers = []
    if needed.value:
        buf = ctypes.create_string_buffer(needed.value)
        if winspool.EnumPrintersW(flags, None, 2, buf, needed, ctypes.byref(needed), ctypes.byref(count)):
            arr = ctypes.cast(buf, ctypes.POINTER(PRINTER_INFO_2))
            for i in range(count.value):
                p = arr[i]
                printers.append({"name": p.pPrinterName, "driver": p.pDriverName or "", "port": p.pPortName or ""})
    size = wintypes.DWORD(0)
    winspool.GetDefaultPrinterW(None, ctypes.byref(size))
    default = None
    if size.value:
        b = ctypes.create_unicode_buffer(size.value)
        if winspool.GetDefaultPrinterW(b, ctypes.byref(size)):
            default = b.value
    return {"printers": printers, "default": default}


def base_name(name: str) -> str:
    """'TSC TE200 (redirected 2)' -> 'TSC TE200', to find a printer again in later Remote Desktop sessions."""
    return re.sub(r"\s*\(redirected \d+\)\s*$", "", name or "", flags=re.I).strip()


def resolve_printer(name: str) -> str:
    names = [p["name"] for p in list_printers()["printers"]]
    if name in names:
        return name
    want = base_name(name).lower()
    for n in names:
        if base_name(n).lower() == want:
            return n
    raise PrintError("print.not_found", "Printer \"{name}\" was not found", name=name)


def _open(name: str):
    h = wintypes.HANDLE()
    if not winspool.OpenPrinterW(name, ctypes.byref(h), None):
        raise PrintError("print.open_failed", "Could not open printer \"{name}\" (error {code})", name=name, code=ctypes.get_last_error())
    return h


def send_raw(printer: str, data: bytes, job_name: str = "Label") -> int:
    if not IS_WIN:
        raise PrintError("print.windows_only", "Printing is only available on Windows")
    h = _open(printer)
    try:
        di = DOC_INFO_1(job_name, None, "RAW")
        if not winspool.StartDocPrinterW(h, 1, ctypes.byref(di)):
            raise PrintError("print.start_failed", "Could not start the print job (error {code})", code=ctypes.get_last_error())
        try:
            winspool.StartPagePrinter(h)
            written = wintypes.DWORD(0)
            buf = ctypes.create_string_buffer(data, len(data))
            ok = winspool.WritePrinter(h, buf, len(data), ctypes.byref(written))
            winspool.EndPagePrinter(h)
            if not ok or written.value != len(data):
                raise PrintError("print.write_failed", "Sending data to the printer did not finish (error {code})", code=ctypes.get_last_error())
        finally:
            winspool.EndDocPrinter(h)
    finally:
        winspool.ClosePrinter(h)
    return len(data)


def send_tcp(host: str, port: int, data: bytes, timeout: float = 10.0) -> int:
    try:
        with socket.create_connection((host, int(port or 9100)), timeout=timeout) as sk:
            sk.sendall(data)
    except OSError as ex:
        raise PrintError("print.network_failed", "Could not connect to the network printer ({host}): {error}", host=host, error=str(ex))
    return len(data)


def _devmode(h, printer: str, w_mm: float | None, h_mm: float | None):
    size = winspool.DocumentPropertiesW(None, h, printer, None, None, 0)
    if size <= 0:
        return None
    dm = ctypes.create_string_buffer(size)
    if winspool.DocumentPropertiesW(None, h, printer, dm, None, DM_OUT_BUFFER) < 0:
        return None
    if w_mm and h_mm:
        fields = struct.unpack_from("<I", dm, 72)[0]
        struct.pack_into("<I", dm, 72, fields | DM_ORIENTATION | DM_PAPERSIZE | DM_PAPERLENGTH | DM_PAPERWIDTH)
        struct.pack_into("<h", dm, 76, 1)                       # portrait
        struct.pack_into("<h", dm, 78, 256)                     # DMPAPER_USER
        struct.pack_into("<h", dm, 80, int(round(h_mm * 10)))   # paper length, tenths of a mm
        struct.pack_into("<h", dm, 82, int(round(w_mm * 10)))   # paper width
        out = ctypes.create_string_buffer(size)
        if winspool.DocumentPropertiesW(None, h, printer, out, dm, DM_IN_BUFFER | DM_OUT_BUFFER) >= 0:
            dm = out
    return dm


def printer_caps(printer: str) -> dict:
    """The driver's real dpi, so images can be rendered at exactly that resolution."""
    if not IS_WIN:
        return {}
    h = _open(printer)
    try:
        dm = _devmode(h, printer, None, None)
    finally:
        winspool.ClosePrinter(h)
    hdc = gdi32.CreateDCW("WINSPOOL", printer, None, dm)
    if not hdc:
        raise PrintError("print.driver_no_response", "The printer driver did not respond")
    try:
        return {"dpiX": gdi32.GetDeviceCaps(hdc, LOGPIXELSX), "dpiY": gdi32.GetDeviceCaps(hdc, LOGPIXELSY)}
    finally:
        gdi32.DeleteDC(hdc)


def _bitmapinfo(w: int, h: int) -> ctypes.Array:
    bmi = ctypes.create_string_buffer(40 + 8)
    struct.pack_into("<IiiHHIIiiII", bmi, 0, 40, w, -h, 1, 1, 0, 0, 0, 0, 2, 2)
    bmi[40:44] = b"\xff\xff\xff\x00"   # colour 0 = white
    bmi[44:48] = b"\x00\x00\x00\x00"   # colour 1 = black
    return bmi


def print_gdi(printer: str, pages: list[dict], s: dict, job_name: str = "Label",
              output_file: str | None = None) -> int:
    """Print through the Windows driver; every page has the exact label (row) size."""
    if not IS_WIN:
        raise PrintError("print.windows_only", "Printing is only available on Windows")
    if not pages:
        raise PrintError("print.nothing", "Nothing to print")
    src_dpi = float(s.get("dpi", 203))
    w_mm = pages[0]["w"] * 25.4 / src_dpi
    h_mm = pages[0]["h"] * 25.4 / src_dpi
    h = _open(printer)
    try:
        dm = _devmode(h, printer, w_mm, h_mm)
    finally:
        winspool.ClosePrinter(h)
    hdc = gdi32.CreateDCW("WINSPOOL", printer, None, dm)
    if not hdc:
        raise PrintError("print.driver_no_response", "The printer driver did not respond")
    try:
        di = DOCINFOW(ctypes.sizeof(DOCINFOW), job_name, output_file, None, 0)
        if gdi32.StartDocW(hdc, ctypes.byref(di)) <= 0:
            raise PrintError("print.start_failed", "Could not start the print job (error {code})", code=ctypes.get_last_error())
        dpx = gdi32.GetDeviceCaps(hdc, LOGPIXELSX) or src_dpi
        dpy = gdi32.GetDeviceCaps(hdc, LOGPIXELSY) or src_dpi
        offx = gdi32.GetDeviceCaps(hdc, PHYSICALOFFSETX)
        offy = gdi32.GetDeviceCaps(hdc, PHYSICALOFFSETY)
        LOG.info("Driver '%s': dpi=%sx%s printer margin=%s,%s requested paper=%.1fx%.1f mm (devmode: %s)",
                 printer, dpx, dpy, offx, offy, w_mm, h_mm, "yes" if dm is not None else "no")
        gdi32.SetStretchBltMode(hdc, 3)  # COLORONCOLOR: no smoothing
        count = 0
        try:
            for pg in pages:
                w, hh = pg["w"], pg["h"]
                wb = (w + 7) // 8
                stride = (wb + 3) // 4 * 4
                src = pg["bits"]
                if stride != wb:
                    rows = bytearray(stride * hh)
                    for r in range(hh):
                        rows[r * stride:r * stride + wb] = src[r * wb:(r + 1) * wb]
                    src = bytes(rows)
                buf = ctypes.create_string_buffer(src, len(src))
                bmi = _bitmapinfo(w, hh)
                dw = int(round(w * dpx / src_dpi))
                dh = int(round(hh * dpy / src_dpi))
                for _ in range(max(1, int(pg.get("copies", 1)))):
                    gdi32.StartPage(hdc)
                    gdi32.StretchDIBits(hdc, -offx, -offy, dw, dh, 0, 0, w, hh, buf, bmi, 0, 0x00CC0020)
                    gdi32.EndPage(hdc)
                    count += 1
        except Exception:
            gdi32.AbortDoc(hdc)
            raise
        gdi32.EndDoc(hdc)
        return count
    finally:
        gdi32.DeleteDC(hdc)


def print_pages(pages: list[dict], s: dict, job_name: str = "Label") -> dict:
    method = s.get("method", "tspl")
    LOG.info("Sending to printer: method=%s printer=%s host=%s dpi=%s pages=%d image=%sx%s media=%s density=%s speed=%s",
             method, s.get("printer"), s.get("host"), s.get("dpi"), len(pages), pages[0]["w"] if pages else "-",
             pages[0]["h"] if pages else "-", s.get("media"), s.get("density"), s.get("speed"))
    if method == "network":
        n = send_tcp(s.get("host", ""), int(s.get("port", 9100)), tspl_job(pages, s))
        return {"ok": True, "bytes": n}
    printer = resolve_printer(s.get("printer", ""))
    if method == "driver":
        n = print_gdi(printer, pages, s, job_name)
        return {"ok": True, "pages": n, "printer": printer}
    n = send_raw(printer, tspl_job(pages, s), job_name)
    return {"ok": True, "bytes": n, "printer": printer}
