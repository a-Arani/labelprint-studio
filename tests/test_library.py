import json
import os
import sys
import tempfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app.library import Library, LibraryError  # noqa: E402


@pytest.fixture()
def lib():
    return Library(Path(tempfile.mkdtemp()))


def names(node):
    return [f["name"] for f in node["files"]]


def test_save_read_and_tree(lib):
    p, uid = lib.save("خاک/خاک سبک 16", {"page": {"w": 100, "h": 50}, "elements": []}, b"\x89PNG")
    assert p == "خاک/خاک سبک 16.lbl" and len(uid) == 16
    assert lib.read(p)["name"] == "خاک سبک 16" and lib.read(p)["uid"] == uid
    tree = lib.tree({uid: {"sent": 7, "counters": {"شماره": 7}}})
    f = tree["folders"][0]["files"][0]
    assert tree["folders"][0]["name"] == "خاک" and f["thumb"] is True and f["printed"] == 7
    assert tree["printed"] == 7 and tree["folders"][0]["printed"] == 7
    # Without overwrite: a unique name and a separate uid
    p2, uid2 = lib.save("خاک/خاک سبک 16", {"uid": uid, "elements": []}, overwrite=False)
    assert p2 == "خاک/خاک سبک 16 (2).lbl" and uid2 != uid


def test_old_files_get_uid_on_read(lib):
    f = lib.root / "old.lbl"
    f.write_text(json.dumps({"elements": []}), encoding="utf-8")
    uid = lib.read("old.lbl")["uid"]
    assert uid and json.loads(f.read_text(encoding="utf-8"))["uid"] == uid


def test_rename_move_copy_delete_keep_uid(lib):
    p, uid = lib.save("a/one", {"elements": []}, b"x")
    lib.mkdir("b")
    p = lib.rename(p, "دو")
    assert p == "a/دو.lbl" and lib.thumb(p) == b"x"
    p = lib.move(p, "b")
    assert p == "b/دو.lbl" and lib.thumb(p) == b"x" and lib.read(p)["uid"] == uid
    assert lib.path_of_uid(uid) == p
    c = lib.copy(p)
    assert c == "b/دو (copy).lbl" and lib.read(c)["uid"] != uid
    lib.delete(p)
    assert names(lib.tree()["folders"][1]) == ["دو (copy)"]
    assert any(lib.trash.rglob("دو.lbl"))


def test_names_keep_characters_windows_does_not_allow_as_look_alikes(lib):
    lib.mkdir("50 100")
    assert lib.rename("50 100", "50*100") == "50\u00d7100"
    assert lib.rename("50\u00d7100", 'Size: 50/100? "A" <B> |C|') == "Size\u2236 50\u2215100\uff1f \u201dA\u201d \u2039B\u203a \u2223C\u2223"
    p, _ = lib.save("a/Pot: 12 cm?", {"elements": []})
    assert p == "a/Pot\u2236 12 cm\uff1f.lbl" and lib.read(p)["name"] == "Pot\u2236 12 cm\uff1f"
    assert lib.mkdir("con") == "con_"
    lib.mkdir("abc")
    assert lib.rename("abc", "ABC") == "ABC" and (lib.root / "ABC").is_dir()


def test_rename_waits_while_another_program_holds_the_folder(lib, monkeypatch):
    lib.mkdir("a")
    real, calls = os.rename, []

    def busy_twice(src, dest):
        calls.append(src)
        if len(calls) < 3:
            raise PermissionError(13, "Access is denied")
        real(src, dest)

    monkeypatch.setattr("app.library.time.sleep", lambda s: None)
    monkeypatch.setattr("app.library.os.rename", busy_twice)
    assert lib.rename("a", "b") == "b" and len(calls) == 3

    def always_busy(src, dest):
        raise PermissionError(13, "Access is denied")

    monkeypatch.setattr("app.library.os.rename", always_busy)
    with pytest.raises(LibraryError) as e:
        lib.rename("b", "c")
    assert e.value.code == "lib.in_use" and (lib.root / "b").is_dir()


def test_products_of_template(lib):
    _, tuid = lib.save("قالب گل", {"kind": "template", "elements": []})
    lib.save("گل‌ها/فوتونیا", {"kind": "product", "fromTemplate": {"uid": tuid, "name": "قالب گل"},
                                "variables": [{"type": "field", "name": "نام", "value": "فوتونیا"}], "elements": []})
    lib.save("گل‌ها/دیگر", {"kind": "label", "elements": []})
    rows = lib.products(tuid)
    assert [r["name"] for r in rows] == ["فوتونیا"] and rows[0]["fields"] == {"نام": "فوتونیا"}
    tree = lib.tree()
    kinds = {f["name"]: (f["kind"], f["template"]) for f in tree["folders"][0]["files"]}
    assert kinds["فوتونیا"] == ("product", "قالب گل")


def test_paths_cannot_escape(lib):
    for bad in ("../x", "a/../../x", ".thumbs/x"):
        with pytest.raises(LibraryError):
            lib.read(bad)
    lib.mkdir("a")
    lib.mkdir("a/b")
    with pytest.raises(LibraryError):
        lib.move("a", "a/b")
