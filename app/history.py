"""Print history and the last printed number of each label (SQLite in data/history.db).

Every print job is a row in `jobs`. After each batch reaches the printer, `sent` and `sent_to`
(the last number sent) are updated, so if a job stops half way it is clear how far it got.
"""
from __future__ import annotations

import sqlite3
import threading
import time
from pathlib import Path

from .logs import LOG

SCHEMA = """
CREATE TABLE IF NOT EXISTS jobs(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started TEXT NOT NULL, finished TEXT,
  label_uid TEXT, label_path TEXT, label_name TEXT, kind TEXT, template_uid TEXT,
  printer TEXT, method TEXT,
  counter TEXT, c_from REAL, c_to REAL, c_step REAL,
  rows_from INTEGER, rows_to INTEGER,
  copies INTEGER DEFAULT 1, planned INTEGER DEFAULT 0,
  sent INTEGER DEFAULT 0, sent_to REAL,
  status TEXT DEFAULT 'running', error TEXT, note TEXT, values_json TEXT
);
CREATE INDEX IF NOT EXISTS jobs_label ON jobs(label_uid);
CREATE INDEX IF NOT EXISTS jobs_started ON jobs(started);
CREATE TABLE IF NOT EXISTS counters(
  label_uid TEXT NOT NULL, counter TEXT NOT NULL, last REAL, updated TEXT, job_id INTEGER,
  PRIMARY KEY(label_uid, counter)
);
CREATE TABLE IF NOT EXISTS adjustments(
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, label_uid TEXT, counter TEXT, old REAL, new REAL, note TEXT
);
"""

JOB_FIELDS = ("label_uid", "label_path", "label_name", "kind", "template_uid", "printer", "method", "counter",
              "c_from", "c_to", "c_step", "rows_from", "rows_to", "copies", "planned", "values_json", "note")

INTERRUPTED = "The application was closed before printing finished"


def now() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S")


def _num(v):
    if v is None or v == "":
        return None
    f = float(v)
    return int(f) if f.is_integer() else f


class History:
    def __init__(self, path: Path):
        self.path = path
        self.lock = threading.Lock()
        self.db = sqlite3.connect(str(path), check_same_thread=False, timeout=15)
        self.db.row_factory = sqlite3.Row
        with self.lock, self.db:
            self.db.execute("PRAGMA journal_mode=WAL")
            self.db.execute("PRAGMA synchronous=FULL")
            self.db.executescript(SCHEMA)
            # Jobs left unfinished by a sudden shutdown
            n = self.db.execute(
                "UPDATE jobs SET status=CASE WHEN sent>0 THEN 'partial' ELSE 'error' END, finished=?, "
                "error=COALESCE(error,?) WHERE status='running'", (now(), INTERRUPTED)).rowcount
        if n:
            LOG.warning("History: marked %d unfinished job(s) from the previous run", n)

    def close(self):
        with self.lock:
            self.db.close()

    def _q(self, sql, args=()):
        with self.lock:
            return [dict(r) for r in self.db.execute(sql, args).fetchall()]

    # ---------------------------------------------------------------- print jobs
    def begin(self, info: dict) -> int:
        vals = {k: info.get(k) for k in JOB_FIELDS}
        for k in ("c_from", "c_to", "c_step"):
            vals[k] = _num(vals[k])
        with self.lock, self.db:
            cur = self.db.execute(
                f"INSERT INTO jobs(started,{','.join(JOB_FIELDS)}) VALUES(?{',?' * len(JOB_FIELDS)})",
                (now(), *[vals[k] for k in JOB_FIELDS]))
            job_id = cur.lastrowid
        LOG.info("Print #%d started: '%s' uid=%s printer=%s method=%s counter=%s from=%s to=%s copies=%s total=%s",
                 job_id, vals["label_name"], vals["label_uid"], vals["printer"], vals["method"], vals["counter"],
                 vals["c_from"], vals["c_to"], vals["copies"], vals["planned"])
        return job_id

    def batch(self, job_id: int, sent: int, last=None):
        """A batch reached the printer successfully."""
        last = _num(last)
        with self.lock, self.db:
            job = self.db.execute("SELECT label_uid, counter, c_step FROM jobs WHERE id=?", (job_id,)).fetchone()
            if not job:
                return
            self.db.execute("UPDATE jobs SET sent=sent+?, sent_to=COALESCE(?, sent_to) WHERE id=?",
                            (int(sent), last, job_id))
            if job["counter"] and last is not None and job["label_uid"]:
                row = self.db.execute("SELECT last FROM counters WHERE label_uid=? AND counter=?",
                                      (job["label_uid"], job["counter"])).fetchone()
                step = job["c_step"] or 1
                better = row is None or row["last"] is None or (last > row["last"] if step > 0 else last < row["last"])
                if better:
                    self.db.execute(
                        "INSERT INTO counters(label_uid,counter,last,updated,job_id) VALUES(?,?,?,?,?) "
                        "ON CONFLICT(label_uid,counter) DO UPDATE SET last=excluded.last, updated=excluded.updated, "
                        "job_id=excluded.job_id", (job["label_uid"], job["counter"], last, now(), job_id))

    def fail(self, job_id: int, error: str):
        with self.lock, self.db:
            # Keep the first error (usually the most precise one, from the server)
            self.db.execute("UPDATE jobs SET error=COALESCE(error, ?) WHERE id=?", (error[:2000], job_id))
        LOG.error("Print #%d failed: %s", job_id, error)

    def finish(self, job_id: int, cancelled: bool = False) -> dict:
        with self.lock, self.db:
            job = self.db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
            if not job:
                return {}
            if job["error"]:
                status = "partial" if job["sent"] else "error"
            elif cancelled:
                status = "partial" if job["sent"] else "cancelled"
            elif job["sent"] >= (job["planned"] or 0):
                status = "ok"
            else:
                status = "partial" if job["sent"] else "error"
            self.db.execute("UPDATE jobs SET status=?, finished=? WHERE id=?", (status, now(), job_id))
        LOG.info("Print #%d finished: status=%s sent=%s of %s, up to number %s",
                 job_id, status, job["sent"], job["planned"], job["sent_to"])
        return {"status": status, "sent": job["sent"], "sent_to": _num(job["sent_to"])}

    # ---------------------------------------------------------------- manual correction
    def adjust(self, label_uid: str, counter: str, value, note: str = "") -> None:
        value = _num(value)
        with self.lock, self.db:
            row = self.db.execute("SELECT last FROM counters WHERE label_uid=? AND counter=?",
                                  (label_uid, counter)).fetchone()
            old = row["last"] if row else None
            self.db.execute("INSERT INTO adjustments(ts,label_uid,counter,old,new,note) VALUES(?,?,?,?,?,?)",
                            (now(), label_uid, counter, old, value, note))
            self.db.execute(
                "INSERT INTO counters(label_uid,counter,last,updated,job_id) VALUES(?,?,?,?,NULL) "
                "ON CONFLICT(label_uid,counter) DO UPDATE SET last=excluded.last, updated=excluded.updated",
                (label_uid, counter, value, now()))
        LOG.info("Counter corrected: uid=%s '%s' from %s to %s (%s)", label_uid, counter, old, value, note)

    # ---------------------------------------------------------------- reports
    def counters(self, label_uid: str) -> dict:
        rows = self._q("SELECT counter, last, updated FROM counters WHERE label_uid=?", (label_uid,))
        return {r["counter"]: {"last": _num(r["last"]), "updated": r["updated"]} for r in rows}

    def ranges(self, label_uid: str, counter: str) -> list[list]:
        """Printed ranges (only the part of each job that was sent), merged."""
        rows = self._q("SELECT c_from, sent_to, c_step FROM jobs WHERE label_uid=? AND counter=? AND sent_to IS NOT NULL "
                       "AND c_from IS NOT NULL ORDER BY c_from", (label_uid, counter))
        spans = []
        for r in rows:
            a, b, step = r["c_from"], r["sent_to"], r["c_step"] or 1
            if step < 0:
                a, b = b, a
            spans.append([a, b, abs(step)])
        spans.sort()
        merged: list[list] = []
        for a, b, step in spans:
            if merged and a <= merged[-1][1] + step:
                merged[-1][1] = max(merged[-1][1], b)
            else:
                merged.append([a, b])
        return [[_num(a), _num(b)] for a, b in merged]

    def label_summary(self, label_uid: str) -> dict:
        tot = self._q("SELECT COUNT(*) AS jobs, COALESCE(SUM(sent),0) AS sent, MAX(started) AS last FROM jobs "
                      "WHERE label_uid=?", (label_uid,))[0]
        counters = self.counters(label_uid)
        return {"jobs": tot["jobs"], "sent": tot["sent"], "lastPrint": tot["last"], "counters": counters,
                "ranges": {c: self.ranges(label_uid, c) for c in counters}}

    def jobs(self, label_uid: str | None = None, since: str | None = None, q: str | None = None,
             limit: int = 500) -> list[dict]:
        sql, args = "SELECT * FROM jobs WHERE 1=1", []
        if label_uid:
            sql += " AND label_uid=?"
            args.append(label_uid)
        if since:
            sql += " AND started>=?"
            args.append(since)
        if q:
            sql += " AND (label_name LIKE ? OR label_path LIKE ? OR printer LIKE ?)"
            args += [f"%{q}%"] * 3
        sql += " ORDER BY id DESC LIMIT ?"
        args.append(int(limit))
        out = self._q(sql, args)
        for r in out:
            for k in ("c_from", "c_to", "c_step", "sent_to"):
                r[k] = _num(r[k])
        return out

    def adjustments(self, label_uid: str) -> list[dict]:
        return self._q("SELECT * FROM adjustments WHERE label_uid=? ORDER BY id DESC", (label_uid,))

    def totals(self) -> dict:
        """uid -> {sent, lastPrint, counters} for the library badges."""
        out = {}
        for r in self._q("SELECT label_uid, COALESCE(SUM(sent),0) AS sent, MAX(started) AS last FROM jobs "
                         "WHERE label_uid IS NOT NULL GROUP BY label_uid"):
            out[r["label_uid"]] = {"sent": r["sent"], "lastPrint": r["last"], "counters": {}}
        for r in self._q("SELECT label_uid, counter, last FROM counters"):
            out.setdefault(r["label_uid"], {"sent": 0, "lastPrint": None, "counters": {}})
            out[r["label_uid"]]["counters"][r["counter"]] = _num(r["last"])
        return out
