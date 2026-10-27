import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app.history import History  # noqa: E402


def make():
    return History(Path(tempfile.mkdtemp()) / "history.db")


def job(h, **kw):
    info = {"label_uid": "u1", "label_name": "فوتونیا", "printer": "TSC", "method": "tspl", "counter": "شماره",
            "c_from": 1, "c_to": 10, "c_step": 1, "copies": 1, "planned": 10}
    info.update(kw)
    return h.begin(info)


def test_full_job_updates_counter_and_totals():
    h = make()
    j = job(h)
    h.batch(j, 5, 5)
    h.batch(j, 5, 10)
    assert h.finish(j) == {"status": "ok", "sent": 10, "sent_to": 10}
    s = h.label_summary("u1")
    assert s["sent"] == 10 and s["counters"]["شماره"]["last"] == 10 and s["ranges"]["شماره"] == [[1, 10]]
    assert h.totals()["u1"]["sent"] == 10


def test_partial_job_keeps_where_it_stopped():
    h = make()
    j = job(h, c_from=11, c_to=40, planned=30)
    h.batch(j, 10, 20)
    h.fail(j, "چاپگر پاسخ نداد")
    res = h.finish(j)
    assert res["status"] == "partial" and res["sent_to"] == 20
    assert h.counters("u1")["شماره"]["last"] == 20
    assert h.jobs(label_uid="u1")[0]["error"] == "چاپگر پاسخ نداد"


def test_reprint_of_older_range_does_not_lower_last():
    h = make()
    j = job(h, c_from=1, c_to=50, planned=50)
    h.batch(j, 50, 50)
    h.finish(j)
    j2 = job(h, c_from=5, c_to=6, planned=2)
    h.batch(j2, 2, 6)
    h.finish(j2)
    assert h.counters("u1")["شماره"]["last"] == 50


def test_manual_adjust_and_ranges_merge():
    h = make()
    for a, b in ((1, 10), (11, 20), (30, 35)):
        j = job(h, c_from=a, c_to=b, planned=b - a + 1)
        h.batch(j, b - a + 1, b)
        h.finish(j)
    assert h.ranges("u1", "شماره") == [[1, 20], [30, 35]]
    h.adjust("u1", "شماره", 33, "دو لیبل خراب شد")
    assert h.counters("u1")["شماره"]["last"] == 33
    adj = h.adjustments("u1")[0]
    assert (adj["old"], adj["new"], adj["note"]) == (35, 33, "دو لیبل خراب شد")


def test_running_jobs_marked_after_restart():
    d = Path(tempfile.mkdtemp())
    h = History(d / "history.db")
    j = job(h)
    h.batch(j, 3, 3)
    h.close()
    h2 = History(d / "history.db")
    row = h2.jobs(label_uid="u1")[0]
    assert row["status"] == "partial" and row["sent_to"] == 3 and row["error"]


def test_job_with_nothing_sent_is_error():
    h = make()
    j = job(h)
    h.fail(j, "بارکد نامعتبر")
    h.fail(j, "خطای دوم")
    res = h.finish(j)
    assert res["status"] == "error" and h.jobs(label_uid="u1")[0]["error"] == "بارکد نامعتبر"
    j2 = job(h)
    assert h.finish(j2)["status"] == "error"


def test_label_without_counter_counts_copies():
    h = make()
    j = job(h, counter=None, c_from=None, c_to=None, planned=24)
    h.batch(j, 24)
    assert h.finish(j)["status"] == "ok"
    assert h.label_summary("u1")["sent"] == 24 and h.counters("u1") == {}
