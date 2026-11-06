"""Business logic. Knows nothing about HTTP, so it can be unit tested on its own."""
import contextlib
import csv
import datetime
import io
import json
import os
import time

from . import auth, db
from .validation import valid_id, validate_lesson

MAX_SYNC_OPS = 100
SYNC_OP_KEEP_DAYS = 30
AUDIT_KEEP_DAYS = 180
OP_TYPES = ("create", "update", "delete")
EXPORT_FIELDS = ["lessonId", "clientId", "title", "subject", "lessonDate", "durationMin", "learnerCount",
                 "steps", "materials", "safety", "inclusion", "notes", "activityId", "version",
                 "createdAt", "updatedAt"]


class ServiceError(Exception):
    def __init__(self, status, code, message, fields=None, extra=None):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message
        self.fields, self.extra = fields, extra or {}

    def body(self):
        err = {"code": self.code, "message": self.message}
        if self.fields:
            err["fields"] = self.fields
        body = {"error": err}
        body.update(self.extra)
        return body


def _iso(ts):
    return datetime.datetime.fromtimestamp(ts, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _lesson_dict(row):
    return {
        "lessonId": row["lesson_id"], "clientId": row["client_id"], "title": row["title"],
        "subject": row["subject"], "lessonDate": row["lesson_date"], "durationMin": row["duration_min"],
        "learnerCount": row["learner_count"], "steps": row["steps"], "materials": row["materials"],
        "safety": row["safety"], "inclusion": row["inclusion"], "notes": row["notes"],
        "activityId": row["activity_id"], "version": row["version"],
        "createdAt": row["created_at"], "updatedAt": row["updated_at"],
    }


class Service:
    def __init__(self, db_path=None, clock=time.time, today=None, activities_path=None):
        self.db_path = db_path or db.default_db_path()
        self.clock = clock
        self._today = today                       # optional function returning a date (tests)
        self.activities_path = activities_path or os.environ.get(
            "STEMMATE_ACTIVITIES", os.path.join(db.ROOT, "data", "activities.json"))
        db.init_db(self.db_path)

    # ---- plumbing -------------------------------------------------------------------------
    def today(self):
        return self._today() if self._today else datetime.date.fromtimestamp(self.clock())

    @contextlib.contextmanager
    def _tx(self):
        conn = db.connect(self.db_path)
        try:
            conn.execute("BEGIN IMMEDIATE")
            try:
                yield conn
            except BaseException:
                conn.execute("ROLLBACK")
                raise
            else:
                conn.execute("COMMIT")
        finally:
            conn.close()

    def _audit(self, conn, fid, event, detail=""):
        conn.execute("INSERT INTO audit_log(at, facilitator_id, event, detail) VALUES (?,?,?,?)",
                     (_iso(self.clock()), fid, event, detail))

    # ---- authentication -------------------------------------------------------------------
    def login(self, facilitator_id, pin):
        now = self.clock()
        failed, locked = False, None
        with self._tx() as conn:
            # Errors are raised after the transaction commits, so failed attempts and the lock are kept.
            try:
                fid, token = auth.login(conn, facilitator_id, pin, now)
            except auth.AuthError:
                failed = True
                self._audit(conn, None, "login_failed")
            except auth.LockedError as e:
                locked = e.retry_after
                self._audit(conn, auth.normalise_id(facilitator_id), "login_locked")
            else:
                self._audit(conn, fid, "login_ok")
                return {"token": token, "facilitatorId": fid, "expiresInSec": auth.SESSION_SECONDS}
        if failed:
            raise ServiceError(401, "invalid_credentials", "The code or PIN is not correct.")
        raise ServiceError(429, "locked", "Sign-in is temporarily unavailable. Try again in about %d minutes."
                           % max(1, round(locked / 60)), extra={"retryAfterSec": locked})

    def authenticate(self, token):
        with self._tx() as conn:
            return auth.authenticate(conn, token, self.clock())

    def logout(self, token):
        with self._tx() as conn:
            fid = auth.authenticate(conn, token, self.clock())
            if fid is None:
                return False
            auth.logout(conn, token)
            self._audit(conn, fid, "logout")
            return True

    def me(self, fid):
        conn = db.connect(self.db_path)
        try:
            n = conn.execute("SELECT COUNT(*) FROM lesson WHERE facilitator_id=?", (fid,)).fetchone()[0]
        finally:
            conn.close()
        return {"facilitatorId": fid, "lessonCount": n}

    # ---- lessons --------------------------------------------------------------------------
    def create_lesson(self, fid, data, client_id):
        with self._tx() as conn:
            return self._create(conn, fid, data, client_id)

    def _create(self, conn, fid, data, client_id):
        if not valid_id(client_id):
            raise ServiceError(422, "validation_failed", "Some details need fixing.",
                               {"clientId": "A device-made clientId is required."})
        row = conn.execute("SELECT * FROM lesson WHERE facilitator_id=? AND client_id=?",
                           (fid, client_id)).fetchone()
        if row is not None:                        # safe retry: same clientId, no second record
            return 200, _lesson_dict(row), True
        clean, errors = validate_lesson(data, self.today())
        if errors:
            raise ServiceError(422, "validation_failed", "Some details need fixing.", errors)
        now = _iso(self.clock())
        cur = conn.execute(
            "INSERT INTO lesson(client_id, facilitator_id, title, subject, lesson_date, duration_min, "
            "learner_count, notes, steps, materials, safety, inclusion, activity_id, version, created_at, updated_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)",
            (client_id, fid, clean["title"], clean["subject"], clean["lessonDate"], clean["durationMin"],
             clean["learnerCount"], clean["notes"], clean["steps"], clean["materials"], clean["safety"],
             clean["inclusion"], clean["activityId"], now, now))
        self._audit(conn, fid, "lesson_created", "lessonId=%d" % cur.lastrowid)
        row = conn.execute("SELECT * FROM lesson WHERE lesson_id=?", (cur.lastrowid,)).fetchone()
        return 201, _lesson_dict(row), False

    def list_lessons(self, fid):
        conn = db.connect(self.db_path)
        try:
            rows = conn.execute("SELECT * FROM lesson WHERE facilitator_id=? ORDER BY lesson_date DESC, lesson_id DESC",
                                (fid,)).fetchall()
        finally:
            conn.close()
        return [_lesson_dict(r) for r in rows]

    def get_lesson(self, fid, lesson_id):
        conn = db.connect(self.db_path)
        try:
            row = conn.execute("SELECT * FROM lesson WHERE lesson_id=? AND facilitator_id=?",
                               (lesson_id, fid)).fetchone()
        finally:
            conn.close()
        if row is None:                            # same answer for "missing" and "someone else's"
            raise ServiceError(404, "not_found", "Lesson not found.")
        return _lesson_dict(row)

    def update_lesson(self, fid, lesson_id, data, base_version):
        with self._tx() as conn:
            row = conn.execute("SELECT * FROM lesson WHERE lesson_id=? AND facilitator_id=?",
                               (lesson_id, fid)).fetchone()
            if row is None:
                raise ServiceError(404, "not_found", "Lesson not found.")
            return self._update(conn, fid, row, data, base_version)

    def _update(self, conn, fid, row, data, base_version):
        if not (isinstance(base_version, int) and not isinstance(base_version, bool) and base_version >= 1):
            raise ServiceError(422, "validation_failed", "Some details need fixing.",
                               {"baseVersion": "The version you edited from is required."})
        if row["version"] != base_version:         # stale edit: refuse, keep the server copy
            raise ServiceError(409, "version_conflict",
                               "This lesson changed since you opened it. Your edit was not applied.",
                               extra={"serverCopy": _lesson_dict(row)})
        clean, errors = validate_lesson(data, self.today())
        if errors:
            raise ServiceError(422, "validation_failed", "Some details need fixing.", errors)
        current = _lesson_dict(row)
        if all(current[k] == v for k, v in clean.items()):
            return current                         # nothing changed: no new version
        conn.execute(
            "UPDATE lesson SET title=?, subject=?, lesson_date=?, duration_min=?, learner_count=?, notes=?, "
            "steps=?, materials=?, safety=?, inclusion=?, activity_id=?, version=version+1, updated_at=? "
            "WHERE lesson_id=?",
            (clean["title"], clean["subject"], clean["lessonDate"], clean["durationMin"], clean["learnerCount"],
             clean["notes"], clean["steps"], clean["materials"], clean["safety"], clean["inclusion"],
             clean["activityId"], _iso(self.clock()), row["lesson_id"]))
        self._audit(conn, fid, "lesson_updated", "lessonId=%d" % row["lesson_id"])
        return _lesson_dict(conn.execute("SELECT * FROM lesson WHERE lesson_id=?", (row["lesson_id"],)).fetchone())

    def delete_lesson(self, fid, lesson_id, base_version=None):
        with self._tx() as conn:
            row = conn.execute("SELECT * FROM lesson WHERE lesson_id=? AND facilitator_id=?",
                               (lesson_id, fid)).fetchone()
            if row is None:
                raise ServiceError(404, "not_found", "Lesson not found.")
            self._delete(conn, fid, row, base_version)

    def _delete(self, conn, fid, row, base_version):
        if base_version is not None and row["version"] != base_version:
            raise ServiceError(409, "version_conflict",
                               "This lesson changed since you opened it. It was not deleted.",
                               extra={"serverCopy": _lesson_dict(row)})
        conn.execute("DELETE FROM lesson WHERE lesson_id=?", (row["lesson_id"],))
        self._audit(conn, fid, "lesson_deleted", "lessonId=%d" % row["lesson_id"])

    # ---- offline sync ---------------------------------------------------------------------
    def sync(self, fid, ops):
        if not isinstance(ops, list):
            raise ServiceError(422, "validation_failed", "Some details need fixing.",
                               {"ops": "ops must be a list of operations."})
        if len(ops) > MAX_SYNC_OPS:
            raise ServiceError(413, "too_many_operations",
                               "Send at most %d operations at a time." % MAX_SYNC_OPS)
        results = [self._sync_one(fid, op) for op in ops]
        with self._tx() as conn:
            counts = {}
            for r in results:
                counts[r["status"]] = counts.get(r["status"], 0) + 1
            self._audit(conn, fid, "sync_batch", ",".join("%s=%d" % kv for kv in sorted(counts.items())))
        return {"results": results}

    def _sync_one(self, fid, op):
        """Each operation is processed and committed on its own, so one bad record never blocks the rest."""
        op_id = op.get("opId") if isinstance(op, dict) else None
        if not valid_id(op_id):
            return {"opId": op_id if isinstance(op_id, str) else None, "status": "rejected",
                    "error": {"code": "validation_failed", "message": "Some details need fixing.",
                              "fields": {"opId": "Each operation needs its own opId."}}}
        with self._tx() as conn:
            prev = conn.execute("SELECT response_json FROM sync_op WHERE facilitator_id=? AND op_id=?",
                                (fid, op_id)).fetchone()
            if prev is not None:
                return self._replay(conn, fid, op_id, json.loads(prev["response_json"]))
            stored = self._apply(conn, fid, op)
            conn.execute("INSERT INTO sync_op(op_id, facilitator_id, result, response_json, created_at) "
                         "VALUES (?,?,?,?,?)",
                         (op_id, fid, stored["status"], json.dumps(stored), _iso(self.clock())))
            return self._replay(conn, fid, op_id, stored, duplicate=False)

    def _apply(self, conn, fid, op):
        """Run one operation and return the small record that is stored for replays (no lesson content)."""
        kind, client_id = op.get("type"), op.get("clientId")
        base = {"type": kind, "clientId": client_id if isinstance(client_id, str) else None}
        try:
            if kind not in OP_TYPES:
                raise ServiceError(422, "validation_failed", "Some details need fixing.",
                                   {"type": "type must be create, update or delete."})
            if kind == "create":
                _, lesson, duplicate = self._create(conn, fid, op.get("data"), client_id)
                return dict(base, status="applied", duplicate=duplicate)
            if not valid_id(client_id):
                raise ServiceError(422, "validation_failed", "Some details need fixing.",
                                   {"clientId": "A device-made clientId is required."})
            row = conn.execute("SELECT * FROM lesson WHERE facilitator_id=? AND client_id=?",
                               (fid, client_id)).fetchone()
            if kind == "delete":
                if row is None:
                    return dict(base, status="applied", alreadyGone=True)     # deleting twice is harmless
                self._delete(conn, fid, row, op.get("baseVersion"))
                return dict(base, status="applied", deleted=True)
            if row is None:
                raise ServiceError(404, "not_found", "This lesson is not on the server. Save it again.")
            self._update(conn, fid, row, op.get("data"), op.get("baseVersion"))
            return dict(base, status="applied")
        except ServiceError as e:
            if e.code == "version_conflict":
                return dict(base, status="conflict")
            err = {"code": e.code, "message": e.message}
            if e.fields:
                err["fields"] = e.fields
            return dict(base, status="rejected", error=err)

    def _replay(self, conn, fid, op_id, stored, duplicate=True):
        """Build the answer for an operation from the stored record plus the lesson as it is now."""
        out = {"opId": op_id, "status": stored["status"], "type": stored.get("type"),
               "clientId": stored.get("clientId"), "duplicate": duplicate or bool(stored.get("duplicate"))}
        if stored["status"] == "rejected":
            out["error"] = stored["error"]
            return out
        if stored.get("deleted") or stored.get("alreadyGone"):
            out["deleted"] = True
            return out
        row = conn.execute("SELECT * FROM lesson WHERE facilitator_id=? AND client_id=?",
                           (fid, stored.get("clientId"))).fetchone()
        if row is None:
            out["deleted"] = True                  # applied earlier, removed since
        elif stored["status"] == "conflict":
            out["serverCopy"] = _lesson_dict(row)
        else:
            out["lesson"] = _lesson_dict(row)
        return out

    # ---- export, deletion, housekeeping ---------------------------------------------------
    def export(self, fid, fmt):
        lessons = self.list_lessons(fid)
        with self._tx() as conn:
            self._audit(conn, fid, "export", "format=%s count=%d" % (fmt, len(lessons)))
        if fmt == "json":
            body = json.dumps({"exportedAt": _iso(self.clock()), "facilitatorId": fid, "lessons": lessons},
                              indent=2, ensure_ascii=False)
            return "application/json; charset=utf-8", "stemmate-lessons.json", body.encode("utf-8")
        if fmt == "csv":
            buf = io.StringIO()
            writer = csv.writer(buf)
            writer.writerow(EXPORT_FIELDS)
            for lesson in lessons:
                writer.writerow([self._csv_safe(lesson[f]) for f in EXPORT_FIELDS])
            return "text/csv; charset=utf-8", "stemmate-lessons.csv", ("\ufeff" + buf.getvalue()).encode("utf-8")
        raise ServiceError(422, "validation_failed", "Some details need fixing.",
                           {"format": "format must be json or csv."})

    @staticmethod
    def _csv_safe(value):
        """Stop spreadsheet programs treating text as a formula."""
        if isinstance(value, str) and value[:1] in ("=", "+", "-", "@", "\t", "\r"):
            return "'" + value
        return value

    def delete_all(self, fid, confirm):
        if confirm != "DELETE":
            raise ServiceError(422, "validation_failed", "Some details need fixing.",
                               {"confirm": 'Send "DELETE" to confirm.'})
        with self._tx() as conn:
            n = conn.execute("DELETE FROM lesson WHERE facilitator_id=?", (fid,)).rowcount
            conn.execute("DELETE FROM sync_op WHERE facilitator_id=?", (fid,))
            self._audit(conn, fid, "data_deleted", "lessons=%d" % n)
        return {"deletedLessons": n}

    def purge_old(self):
        """Remove expired tokens, old replay records (30 days) and old audit rows (180 days)."""
        now = self.clock()
        with self._tx() as conn:
            t = conn.execute("DELETE FROM session_token WHERE expires_at<=?", (now,)).rowcount
            o = conn.execute("DELETE FROM sync_op WHERE created_at<?",
                             (_iso(now - SYNC_OP_KEEP_DAYS * 86400),)).rowcount
            a = conn.execute("DELETE FROM audit_log WHERE at<?",
                             (_iso(now - AUDIT_KEEP_DAYS * 86400),)).rowcount
        return {"tokens": t, "syncOps": o, "auditRows": a}

    # ---- activity catalogue (read-only content, no personal data) ---------------------------
    def activities(self):
        try:
            with open(self.activities_path, "r", encoding="utf-8") as fh:
                raw = json.load(fh)
        except (OSError, ValueError):
            return []
        items = raw.get("activities", []) if isinstance(raw, dict) else raw
        seen, out = set(), []
        for a in items if isinstance(items, list) else []:
            if isinstance(a, dict) and a.get("id") is not None and a.get("title") and str(a["id"]) not in seen:
                seen.add(str(a["id"]))
                out.append(a)
        return out
