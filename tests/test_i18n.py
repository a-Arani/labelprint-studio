"""Translations: every catalog matches English, and every key the code uses exists."""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
I18N = WEB / "i18n"
PARAM = re.compile(r"\{(\w+)\}")


def catalog(code):
    return json.loads((I18N / f"{code}.json").read_text(encoding="utf-8"))


def languages():
    src = (WEB / "js" / "i18n.js").read_text(encoding="utf-8")
    return re.findall(r"code: '(\w+)'", src)


def test_every_language_has_a_catalog():
    files = sorted(p.stem for p in I18N.glob("*.json"))
    assert sorted(languages()) == files
    assert languages()[0] == "en"


def test_catalogs_match_english_keys_and_params():
    en = catalog("en")
    for code in languages():
        cat = catalog(code)
        assert set(cat) == set(en), f"{code}: missing {sorted(set(en) - set(cat))[:5]}, extra {sorted(set(cat) - set(en))[:5]}"
        for k, v in en.items():
            assert set(PARAM.findall(cat[k])) == set(PARAM.findall(v)), f"{code}.{k}: placeholders differ"
            assert cat[k].strip() or not v.strip(), f"{code}.{k} is empty"


def test_keys_used_in_code_exist():
    en = catalog("en")
    used, prefixes = set(), set()
    for js in (WEB / "js").glob("*.js"):
        src = js.read_text(encoding="utf-8")
        used |= set(re.findall(r"\bt(?:Raw)?\('([\w.]+)'[,)]", src))
        prefixes |= set(re.findall(r"\bt(?:Raw)?\('([\w.]+\.)' \+", src))
    html = (WEB / "index.html").read_text(encoding="utf-8")
    used |= set(re.findall(r'data-i18n(?:-title|-placeholder)?="([\w.]+)"', html))
    assert used, "no keys found"
    missing = sorted(k for k in used if k not in en)
    assert not missing, f"keys used in code but missing from en.json: {missing}"
    for p in prefixes:
        assert any(k.startswith(p) for k in en), f"no keys for dynamic prefix {p}"


def test_server_error_codes_are_translated():
    en = catalog("en")
    codes = set()
    for py in (ROOT / "app").glob("*.py"):
        codes |= set(re.findall(r'(?:Error_?|AppError)\(\s*"([a-z]+\.[a-z_]+)"', py.read_text(encoding="utf-8")))
        codes |= set(re.findall(r'"code": "([a-z]+\.[a-z_]+)"', py.read_text(encoding="utf-8")))
    assert codes, "no error codes found"
    missing = sorted(c for c in codes if f"err.{c}" not in en)
    assert not missing, f"server error codes without a translation: {missing}"


def test_dynamic_families_are_complete():
    """Keys built at run time (status, calendar, roll types, ...) exist for every value the code can produce."""
    en = catalog("en")
    families = {
        "hist.status.": ["ok", "partial", "error", "cancelled", "running"],
        "cal.": ["gregorian", "jalali", "hijri"],
        "media.gap.": ["gap", "bline", "continuous"],
        "rot.": ["auto", "auto180", "0", "90", "180", "270"],
        "var.type.": ["field", "counter", "date", "text", "list"],
        "var.default.": ["field", "counter", "date", "text", "list"],
        "type.": ["text", "shape", "line", "image", "barcode", "qr", "path"],
        "save.state.": ["saving", "saved", "dirty", "error"],
    }
    for prefix, values in families.items():
        for v in values:
            assert prefix + v in en, prefix + v
