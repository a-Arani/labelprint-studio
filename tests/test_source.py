"""Source hygiene: user-facing text lives in the translation catalogs, not in the code."""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Arabic-script letters, plus invisible direction marks that are easy to miss when written literally
NON_ASCII_UI = re.compile("[\u0600-\u06ff\ufb50-\ufdff\ufe70-\ufefe\u200e\u200f\u2066-\u2069]")


def sources():
    yield from (ROOT / "app").glob("*.py")
    yield ROOT / "run.py"
    yield from (ROOT / "web" / "js").glob("*.js")
    yield ROOT / "web" / "index.html"
    yield ROOT / "web" / "css" / "app.css"


def test_no_hard_coded_persian_or_arabic_text():
    found = []
    for path in sources():
        for i, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if NON_ASCII_UI.search(line):
                found.append(f"{path.relative_to(ROOT)}:{i}: {line.strip()[:80]}")
    assert not found, "write these as \\uXXXX escapes or move them to web/i18n:\n" + "\n".join(found)


def test_app_identity_is_in_one_place():
    meta = (ROOT / "app" / "meta.py").read_text(encoding="utf-8")
    version = re.search(r'VERSION = "([\d.]+)"', meta).group(1)
    assert re.fullmatch(r"\d+\.\d+\.\d+", version)
    changelog = (ROOT / "CHANGELOG.md").read_text(encoding="utf-8")
    assert f"[{version}]" in changelog, "CHANGELOG.md has no entry for the current version"
