"""Read a table from Excel (.xlsx) or CSV for list variables and bulk product creation."""
from __future__ import annotations

import csv
import io
import re
import zipfile
from xml.etree import ElementTree as ET

NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"


def _col_index(ref: str) -> int:
    letters = re.match(r"[A-Z]+", ref or "A").group(0)
    n = 0
    for ch in letters:
        n = n * 26 + ord(ch) - 64
    return n - 1


def read_xlsx(data: bytes) -> list[list[str]]:
    z = zipfile.ZipFile(io.BytesIO(data))
    shared: list[str] = []
    if "xl/sharedStrings.xml" in z.namelist():
        root = ET.fromstring(z.read("xl/sharedStrings.xml"))
        for si in root.iter(f"{NS}si"):
            shared.append("".join(t.text or "" for t in si.iter(f"{NS}t")))
    sheet = "xl/worksheets/sheet1.xml"
    if sheet not in z.namelist():
        sheet = next(n for n in z.namelist() if n.startswith("xl/worksheets/sheet"))
    root = ET.fromstring(z.read(sheet))
    rows: list[list[str]] = []
    for row in root.iter(f"{NS}row"):
        cells: dict[int, str] = {}
        for c in row.iter(f"{NS}c"):
            t = c.get("t")
            v = c.find(f"{NS}v")
            if t == "s" and v is not None:
                val = shared[int(v.text)]
            elif t == "inlineStr":
                val = "".join(x.text or "" for x in c.iter(f"{NS}t"))
            elif v is not None and v.text is not None:
                val = v.text
                if re.fullmatch(r"-?\d+\.0+", val):
                    val = val.split(".")[0]
            else:
                val = ""
            cells[_col_index(c.get("r", ""))] = val
        if cells:
            width = max(cells) + 1
            rows.append([cells.get(i, "") for i in range(width)])
    return rows


def read_table(filename: str, data: bytes) -> dict:
    name = filename.lower()
    if name.endswith(".xlsx"):
        rows = read_xlsx(data)
    else:
        text = None
        for enc in ("utf-8-sig", "cp1256", "utf-16"):
            try:
                text = data.decode(enc)
                break
            except UnicodeDecodeError:
                continue
        text = text or data.decode("utf-8", errors="replace")
        dialect = csv.Sniffer().sniff(text[:2000], delimiters=",;\t") if "," in text or "\t" in text or ";" in text else csv.excel
        rows = [r for r in csv.reader(io.StringIO(text), dialect)]
    rows = [[(c or "").strip() for c in r] for r in rows if any((c or "").strip() for c in r)]
    if not rows:
        return {"columns": [], "rows": []}
    width = max(len(r) for r in rows)
    header = rows[0] + [""] * (width - len(rows[0]))
    columns = [h or f"Column{i + 1}" for i, h in enumerate(header)]
    body = [r + [""] * (width - len(r)) for r in rows[1:]]
    return {"columns": columns, "rows": body}
