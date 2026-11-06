"""Backend automated tests. Run: python -m unittest discover -s tests -v
B01-B15 keep the IDs and meanings used in the team report; B16 onwards cover the v2 integration work."""
import datetime
import json
import os
import sqlite3
import sys
import tempfile
import unittest
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import auth, db                                   # noqa: E402
from app.server import make_server, serve_in_thread        # noqa: E402
from app.service import Service, ServiceError              # noqa: E402
from app.validation import validate_lesson, looks_personal  # noqa: E402

TODAY = datetime.date(2026, 10, 22)
GOOD = {"title": "Fractions with bottle caps", "subject": "Mathematics", "lessonDate": "2026-10-21",
        "durationMin": 45, "learnerCount": 22, "notes": "Offline lesson"}


class Clock:
    def __init__(self):
        self.t = 1_790_000_000.0
    def __call__(self):
        return self.t


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.tmp.name, "t.db")
        self.clock = Clock()
        self.svc = Service(self.path, clock=self.clock, today=lambda: TODAY,
                           activities_path=os.path.join(db.ROOT, "data", "activities.json"))
        conn = db.connect(self.path)
        auth.set_pin(conn, "FAC-01", "4821")
        auth.set_pin(conn, "FAC-02", "7365")
        conn.close()

    def tearDown(self):
        self.tmp.cleanup()

    def op(self, op_id, kind, client_id, data=None, base=None):
        o = {"opId": op_id, "type": kind, "clientId": client_id}
        if data is not None:
            o["data"] = data
        if base is not None:
            o["baseVersion"] = base
        return o


class ValidationTests(Base):
    def test_B01_valid_lesson_is_accepted_and_cleaned(self):
        clean, errors = validate_lesson(dict(GOOD, title="  Fractions  ", extra="ignored"), TODAY)
        self.assertEqual(errors, {})
        self.assertEqual(clean["title"], "Fractions")
        self.assertNotIn("extra", clean)                    # unknown fields are never stored

    def test_B02_each_invalid_field_is_reported_separately(self):
        _, e = validate_lesson({"title": " ", "subject": "Cooking", "lessonDate": "2026-12-01",
                                "durationMin": 3, "learnerCount": 500}, TODAY)
        self.assertEqual(set(e), {"title", "subject", "lessonDate", "durationMin", "learnerCount"})
        self.assertEqual(e["lessonDate"], "Lesson date cannot be in the future.")

    def test_B03_notes_with_contact_or_id_details_are_rejected(self):
        for bad in ("call me on 081 123 4567", "mail teacher@example.com", "ID 80010112345", "+264 81 123 4567"):
            _, e = validate_lesson(dict(GOOD, notes=bad), TODAY)
            self.assertIn("notes", e, bad)
            self.assertNotIn("4567", e["notes"])            # the value is not echoed back
        _, e = validate_lesson(dict(GOOD, notes="Grade 8, 2026-10-21 22 learners, 45 min"), TODAY)
        self.assertEqual(e, {})

    def test_B04_true_false_is_not_accepted_as_a_number(self):
        _, e = validate_lesson(dict(GOOD, durationMin=True, learnerCount=False), TODAY)
        self.assertIn("durationMin", e)
        self.assertIn("learnerCount", e)
        _, e = validate_lesson(dict(GOOD, durationMin=45.5), TODAY)
        self.assertIn("durationMin", e)


class LessonTests(Base):
    def test_B05_retried_create_makes_no_duplicate(self):
        s1, l1, d1 = self.svc.create_lesson("FAC-01", GOOD, "dev1-aaaa-0001")
        s2, l2, d2 = self.svc.create_lesson("FAC-01", GOOD, "dev1-aaaa-0001")
        self.assertEqual((s1, d1, s2, d2), (201, False, 200, True))
        self.assertEqual(l1["lessonId"], l2["lessonId"])
        self.assertEqual(len(self.svc.list_lessons("FAC-01")), 1)

    def test_B06_lessons_survive_closing_and_reopening_the_database(self):
        self.svc.create_lesson("FAC-01", GOOD, "dev1-aaaa-0001")
        del self.svc
        reopened = Service(self.path, clock=self.clock, today=lambda: TODAY)
        lessons = reopened.list_lessons("FAC-01")
        self.assertEqual([x["title"] for x in lessons], [GOOD["title"]])

    def test_B07_facilitator_cannot_read_another_facilitators_lesson(self):
        _, l, _ = self.svc.create_lesson("FAC-01", GOOD, "dev1-aaaa-0001")
        with self.assertRaises(ServiceError) as cm:
            self.svc.get_lesson("FAC-02", l["lessonId"])
        self.assertEqual(cm.exception.status, 404)
        self.assertEqual(self.svc.list_lessons("FAC-02"), [])
        with self.assertRaises(ServiceError):
            self.svc.update_lesson("FAC-02", l["lessonId"], GOOD, 1)

    def test_B08_stale_update_returns_409_and_keeps_the_server_copy(self):
        _, l, _ = self.svc.create_lesson("FAC-01", GOOD, "dev1-aaaa-0001")
        v2 = self.svc.update_lesson("FAC-01", l["lessonId"], dict(GOOD, title="Edited on device A"), 1)
        self.assertEqual(v2["version"], 2)
        with self.assertRaises(ServiceError) as cm:
            self.svc.update_lesson("FAC-01", l["lessonId"], dict(GOOD, title="Edited on device B"), 1)
        self.assertEqual(cm.exception.status, 409)
        self.assertEqual(cm.exception.extra["serverCopy"]["title"], "Edited on device A")
        self.assertEqual(self.svc.get_lesson("FAC-01", l["lessonId"])["title"], "Edited on device A")

    def test_B16_plan_fields_are_saved_returned_exported_and_persist(self):
        plan = dict(GOOD, steps="Fold, test, improve", materials="papers, scissors",
                    safety="don't run with scissors", inclusion="make everyone participate", activityId=1)
        _, l, _ = self.svc.create_lesson("FAC-01", plan, "dev1-aaaa-0002")
        for f in ("steps", "materials", "safety", "inclusion"):
            self.assertEqual(l[f], plan[f])
        self.assertEqual(l["activityId"], "1")
        reopened = Service(self.path, clock=self.clock, today=lambda: TODAY)
        self.assertEqual(reopened.list_lessons("FAC-01")[0]["materials"], "papers, scissors")
        _, _, body = reopened.export("FAC-01", "json")
        self.assertEqual(json.loads(body)["lessons"][0]["inclusion"], "make everyone participate")

    def test_B17_privacy_check_covers_every_free_text_field(self):
        for field in ("steps", "materials", "safety", "inclusion", "notes"):
            _, e = validate_lesson(dict(GOOD, **{field: "phone 081 123 4567"}), TODAY)
            self.assertIn(field, e, field)
            self.assertNotIn("081", e[field])
        self.assertTrue(looks_personal("write to a.b@school.edu.na"))
        self.assertFalse(looks_personal("Use 12 caps and 3 cups"))


class SyncTests(Base):
    def test_B09_sync_keeps_good_records_rejects_the_bad_one_and_is_replay_safe(self):
        ops = [self.op("op-a1", "create", "dev1-aaaa-0001", GOOD),
               self.op("op-a2", "create", "dev1-aaaa-0002", dict(GOOD, durationMin=1)),
               self.op("op-a3", "create", "dev1-aaaa-0003", dict(GOOD, title="Second good lesson"))]
        r = self.svc.sync("FAC-01", ops)["results"]
        self.assertEqual([x["status"] for x in r], ["applied", "rejected", "applied"])
        self.assertIn("durationMin", r[1]["error"]["fields"])
        again = self.svc.sync("FAC-01", ops)["results"]           # same queue sent again
        self.assertTrue(all(x["duplicate"] for x in again))
        self.assertEqual([x["status"] for x in again], ["applied", "rejected", "applied"])
        self.assertEqual(len(self.svc.list_lessons("FAC-01")), 2)

    def test_B18_sync_update_applies_with_current_version_and_conflicts_when_stale(self):
        self.svc.sync("FAC-01", [self.op("op-1", "create", "dev1-aaaa-0001", GOOD)])
        ok = self.svc.sync("FAC-01", [self.op("op-2", "update", "dev1-aaaa-0001", dict(GOOD, title="A"), base=1)])
        self.assertEqual(ok["results"][0]["status"], "applied")
        self.assertEqual(ok["results"][0]["lesson"]["version"], 2)
        stale = self.svc.sync("FAC-01", [self.op("op-3", "update", "dev1-aaaa-0001", dict(GOOD, title="B"), base=1)])
        r = stale["results"][0]
        self.assertEqual(r["status"], "conflict")
        self.assertEqual(r["serverCopy"]["title"], "A")
        self.assertEqual(self.svc.list_lessons("FAC-01")[0]["title"], "A")

    def test_B19_keep_my_version_resends_with_the_servers_version(self):
        self.svc.sync("FAC-01", [self.op("op-1", "create", "c-1", GOOD)])
        self.svc.sync("FAC-01", [self.op("op-2", "update", "c-1", dict(GOOD, title="Online"), base=1)])
        conflict = self.svc.sync("FAC-01", [self.op("op-3", "update", "c-1", dict(GOOD, title="Phone"), base=1)])
        server_version = conflict["results"][0]["serverCopy"]["version"]
        resolved = self.svc.sync("FAC-01", [self.op("op-4", "update", "c-1", dict(GOOD, title="Phone"), base=server_version)])
        self.assertEqual(resolved["results"][0]["status"], "applied")
        self.assertEqual(self.svc.list_lessons("FAC-01")[0]["title"], "Phone")
        self.assertEqual(self.svc.list_lessons("FAC-01")[0]["version"], 3)

    def test_B20_delete_by_rest_and_sync_is_safe_to_repeat(self):
        _, l, _ = self.svc.create_lesson("FAC-01", GOOD, "c-1")
        self.svc.sync("FAC-01", [self.op("op-1", "create", "c-2", GOOD)])
        r = self.svc.sync("FAC-01", [self.op("op-2", "delete", "c-2", base=1)])["results"][0]
        self.assertEqual((r["status"], r.get("deleted")), ("applied", True))
        again = self.svc.sync("FAC-01", [self.op("op-3", "delete", "c-2", base=1)])["results"][0]
        self.assertEqual((again["status"], again.get("deleted")), ("applied", True))
        self.svc.update_lesson("FAC-01", l["lessonId"], dict(GOOD, title="x"), 1)
        with self.assertRaises(ServiceError) as cm:
            self.svc.delete_lesson("FAC-01", l["lessonId"], base_version=1)
        self.assertEqual(cm.exception.status, 409)
        self.svc.delete_lesson("FAC-01", l["lessonId"], base_version=2)
        self.assertEqual(self.svc.list_lessons("FAC-01"), [])

    def test_B21_replay_records_hold_no_lesson_text_and_are_private_to_each_facilitator(self):
        self.svc.sync("FAC-01", [self.op("op-shared", "create", "c-1", dict(GOOD, title="Secret title"))])
        conn = db.connect(self.path)
        dump = json.dumps([tuple(r) for r in conn.execute("SELECT * FROM sync_op")])
        conn.close()
        self.assertNotIn("Secret title", dump)
        other = self.svc.sync("FAC-02", [self.op("op-shared", "create", "c-9", dict(GOOD, title="Other title"))])
        self.assertFalse(other["results"][0]["duplicate"])
        self.assertEqual(other["results"][0]["lesson"]["title"], "Other title")
        self.assertEqual(len(self.svc.list_lessons("FAC-01")), 1)

    def test_B28a_sync_batch_limit_and_bad_operations(self):
        with self.assertRaises(ServiceError) as cm:
            self.svc.sync("FAC-01", [self.op("op-%d" % i, "create", "c-%d" % i, GOOD) for i in range(101)])
        self.assertEqual(cm.exception.status, 413)
        r = self.svc.sync("FAC-01", ["junk", {"type": "create"}, self.op("op-x", "explode", "c-1")])["results"]
        self.assertEqual([x["status"] for x in r], ["rejected"] * 3)


class AccountTests(Base):
    def test_B10_csv_and_json_export_contain_the_saved_lesson(self):
        self.svc.create_lesson("FAC-01", GOOD, "c-1")
        self.svc.create_lesson("FAC-02", dict(GOOD, title="Not mine"), "c-2")
        _, _, js = self.svc.export("FAC-01", "json")
        _, _, csv_bytes = self.svc.export("FAC-01", "csv")
        self.assertEqual([x["title"] for x in json.loads(js)["lessons"]], [GOOD["title"]])
        text = csv_bytes.decode("utf-8-sig")
        self.assertIn(GOOD["title"], text)
        self.assertNotIn("Not mine", text)

    def test_B25_csv_export_neutralises_spreadsheet_formulas(self):
        self.svc.create_lesson("FAC-01", dict(GOOD, title="=HYPERLINK(1)"), "c-1")
        text = self.svc.export("FAC-01", "csv")[2].decode("utf-8-sig")
        self.assertIn("'=HYPERLINK(1)", text)

    def test_B11_login_logout_and_token_expiry(self):
        tok = self.svc.login("fac-01", "4821")["token"]            # code is not case sensitive
        self.assertEqual(self.svc.authenticate(tok), "FAC-01")
        self.assertTrue(self.svc.logout(tok))
        self.assertIsNone(self.svc.authenticate(tok))
        tok = self.svc.login("FAC-01", "4821")["token"]
        self.clock.t += 31 * 60
        self.assertIsNone(self.svc.authenticate(tok))              # expired after 30 minutes idle

    def test_B26_tokens_are_stored_hashed_and_expiry_slides_with_use(self):
        tok = self.svc.login("FAC-01", "4821")["token"]
        conn = db.connect(self.path)
        stored = [r[0] for r in conn.execute("SELECT token FROM session_token")]
        conn.close()
        self.assertNotIn(tok, stored)
        self.clock.t += 20 * 60
        self.assertEqual(self.svc.authenticate(tok), "FAC-01")
        self.clock.t += 20 * 60                                    # 40 min since login, 20 since last use
        self.assertEqual(self.svc.authenticate(tok), "FAC-01")

    def test_B12_lockout_after_repeated_wrong_pins(self):
        for _ in range(4):
            with self.assertRaises(ServiceError) as cm:
                self.svc.login("FAC-01", "0000")
            self.assertEqual(cm.exception.status, 401)
        with self.assertRaises(ServiceError) as cm:
            self.svc.login("FAC-01", "0000")
        self.assertEqual(cm.exception.status, 429)
        with self.assertRaises(ServiceError) as cm:
            self.svc.login("FAC-01", "4821")                       # right PIN is refused while locked
        self.assertEqual(cm.exception.status, 429)
        self.clock.t += 5 * 60 + 1
        self.assertIn("token", self.svc.login("FAC-01", "4821"))

    def test_B12b_wrong_code_and_wrong_pin_give_the_same_answer(self):
        msgs = []
        for code, pin in (("NOPE-99", "4821"), ("FAC-01", "9999"), ("FAC-01", "abcd")):
            with self.assertRaises(ServiceError) as cm:
                self.svc.login(code, pin)
            msgs.append((cm.exception.status, cm.exception.message))
        self.assertEqual(len(set(msgs)), 1)

    def test_B13_pin_is_not_stored_in_plain_text(self):
        conn = db.connect(self.path)
        row = conn.execute("SELECT * FROM facilitator WHERE facilitator_id='FAC-01'").fetchone()
        conn.close()
        self.assertNotIn("4821", " ".join(str(v) for v in tuple(row)))
        self.assertEqual(len(row["pin_hash"]), 64)

    def test_B23_delete_all_needs_confirmation_and_only_touches_own_data(self):
        self.svc.create_lesson("FAC-01", GOOD, "c-1")
        self.svc.create_lesson("FAC-02", GOOD, "c-2")
        with self.assertRaises(ServiceError):
            self.svc.delete_all("FAC-01", "yes")
        self.assertEqual(self.svc.delete_all("FAC-01", "DELETE"), {"deletedLessons": 1})
        self.assertEqual(self.svc.list_lessons("FAC-01"), [])
        self.assertEqual(len(self.svc.list_lessons("FAC-02")), 1)

    def test_B24_purge_removes_expired_tokens_and_old_replay_records(self):
        self.svc.login("FAC-01", "4821")
        self.svc.sync("FAC-01", [self.op("op-1", "create", "c-1", GOOD)])
        self.assertEqual(self.svc.purge_old(), {"tokens": 0, "syncOps": 0, "auditRows": 0})
        self.clock.t += 31 * 86400
        out = self.svc.purge_old()
        self.assertEqual((out["tokens"], out["syncOps"]), (1, 1))
        self.assertEqual(len(self.svc.list_lessons("FAC-01")), 1)   # lessons themselves are never purged

    def test_B22_activity_catalogue_is_served_with_unique_ids(self):
        items = self.svc.activities()
        self.assertGreaterEqual(len(items), 1)
        self.assertEqual(len({str(a["id"]) for a in items}), len(items))
        missing = Service(self.path, activities_path=os.path.join(self.tmp.name, "nope.json"))
        self.assertEqual(missing.activities(), [])
        odd = os.path.join(self.tmp.name, "odd.json")
        with open(odd, "w") as fh:
            json.dump([{"id": 1, "title": "A"}, {"id": 1, "title": "dup"}, {"title": "no id"}, "junk"], fh)
        self.assertEqual(len(Service(self.path, activities_path=odd).activities()), 1)

    def test_B29_audit_log_records_events_without_personal_content(self):
        self.svc.login("FAC-01", "4821")
        self.svc.create_lesson("FAC-01", dict(GOOD, title="Very private title"), "c-1")
        conn = db.connect(self.path)
        rows = [tuple(r) for r in conn.execute("SELECT * FROM audit_log")]
        conn.close()
        self.assertIn("lesson_created", " ".join(r[2] for r in rows))
        self.assertNotIn("Very private title", json.dumps(rows))
        self.assertNotIn("4821", json.dumps(rows))


class HttpTests(Base):
    def setUp(self):
        super().setUp()
        self.svc = Service(self.path, today=lambda: datetime.date.today())    # real clock over real HTTP
        self.static = os.path.join(db.ROOT, "static")
        self.httpd = make_server(self.svc, "127.0.0.1", 0, quiet=True, cors_origins=["http://allowed.example"])
        serve_in_thread(self.httpd)
        self.base = "http://127.0.0.1:%d" % self.httpd.server_address[1]

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        super().tearDown()

    def call(self, method, path, body=None, token=None, raw=None, headers=None):
        data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
        req = urllib.request.Request(self.base + path, data=data, method=method)
        if data is not None:
            req.add_header("Content-Type", "application/json")
        if token:
            req.add_header("Authorization", "Bearer " + token)
        for k, v in (headers or {}).items():
            req.add_header(k, v)
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                return r.status, dict(r.headers), r.read()
        except urllib.error.HTTPError as e:
            return e.code, dict(e.headers), e.read()

    def j(self, *a, **k):
        status, headers, raw = self.call(*a, **k)
        return status, (json.loads(raw) if raw and headers.get("Content-Type", "").startswith("application/json") else raw)

    def test_B14_full_workflow_over_real_http_including_401_after_sign_out(self):
        self.assertEqual(self.j("GET", "/api/health")[1]["status"], "ok")
        s, login = self.j("POST", "/api/auth/login", {"facilitatorId": "FAC-01", "pin": "4821"})
        self.assertEqual(s, 200)
        tok = login["token"]
        today = datetime.date.today().isoformat()
        plan = dict(GOOD, lessonDate=today, clientId="dev1-aaaa-0001", steps="s", materials="m", safety="x", inclusion="i")
        s, body = self.j("POST", "/api/lessons", plan, tok)
        self.assertEqual((s, body["duplicate"]), (201, False))
        s, body = self.j("POST", "/api/lessons", plan, tok)
        self.assertEqual((s, body["duplicate"]), (200, True))
        s, body = self.j("POST", "/api/sync", {"ops": [self.op("op-a1", "create", "dev1-aaaa-0002", dict(GOOD, lessonDate=today))]}, tok)
        self.assertEqual(body["results"][0]["status"], "applied")
        s, body = self.j("GET", "/api/lessons", token=tok)
        self.assertEqual(len(body["lessons"]), 2)
        lid = body["lessons"][0]["lessonId"]
        s, body = self.j("PUT", "/api/lessons/%d" % lid, dict(GOOD, lessonDate=today, title="Edited", baseVersion=1), tok)
        self.assertEqual((s, body["lesson"]["version"]), (200, 2))
        s, body = self.j("PUT", "/api/lessons/%d" % lid, dict(GOOD, lessonDate=today, baseVersion=1), tok)
        self.assertEqual((s, body["serverCopy"]["version"]), (409, 2))
        s, headers, raw = self.call("GET", "/api/export?format=csv", token=tok)
        self.assertEqual(s, 200)
        self.assertIn("attachment", headers["Content-Disposition"])
        self.assertEqual(self.j("POST", "/api/auth/logout", {}, tok)[0], 200)
        self.assertEqual(self.j("GET", "/api/lessons", token=tok)[0], 401)

    def test_B15_malformed_json_returns_a_clean_400(self):
        s, body = self.j("POST", "/api/auth/login", raw=b"{not json")
        self.assertEqual(s, 400)
        self.assertEqual(body["error"]["code"], "bad_request")
        self.assertNotIn("Traceback", json.dumps(body))
        self.assertEqual(self.j("POST", "/api/auth/login", raw=b"[1,2]")[0], 400)

    def test_B27_static_files_security_headers_and_cors(self):
        s, h, raw = self.call("GET", "/")
        if os.path.exists(os.path.join(self.static, "index.html")):
            self.assertEqual(s, 200)
            self.assertIn("default-src 'self'", h["Content-Security-Policy"])
            self.assertEqual(h["X-Content-Type-Options"], "nosniff")
        for bad in ("/../app/db.py", "/%2e%2e/app/db.py", "/app/db.py", "/.hidden", "/stemmate.db"):
            self.assertEqual(self.call("GET", bad)[0], 404, bad)
        s, h, _ = self.call("GET", "/api/health", headers={"Origin": "http://allowed.example"})
        self.assertEqual(h.get("Access-Control-Allow-Origin"), "http://allowed.example")
        s, h, _ = self.call("GET", "/api/health", headers={"Origin": "http://evil.example"})
        self.assertNotIn("Access-Control-Allow-Origin", h)
        self.assertEqual(self.call("OPTIONS", "/api/sync", headers={"Origin": "http://allowed.example"})[0], 204)

    def test_B28_oversized_body_and_unknown_routes(self):
        tok = self.j("POST", "/api/auth/login", {"facilitatorId": "FAC-01", "pin": "4821"})[1]["token"]
        self.assertEqual(self.j("POST", "/api/sync", raw=b"x" * (300 * 1024), token=tok)[0], 413)
        self.assertEqual(self.j("GET", "/api/nothing")[0], 404)
        self.assertEqual(self.j("GET", "/api/lessons")[0], 401)               # no token
        self.assertEqual(self.j("DELETE", "/api/lessons", token=tok)[0], 405)

    def test_B12c_lockout_over_http_sends_retry_after(self):
        for _ in range(4):
            self.assertEqual(self.j("POST", "/api/auth/login", {"facilitatorId": "FAC-01", "pin": "1111"})[0], 401)
        s, h, raw = self.call("POST", "/api/auth/login", body={"facilitatorId": "FAC-01", "pin": "1111"})
        self.assertEqual(s, 429)
        self.assertEqual(h["Retry-After"], "300")

    def test_B14b_server_errors_never_leak_details(self):
        self.svc.list_lessons = lambda fid: 1 / 0                              # force an unexpected failure
        tok = self.j("POST", "/api/auth/login", {"facilitatorId": "FAC-01", "pin": "4821"})[1]["token"]
        s, body = self.j("GET", "/api/lessons", token=tok)
        self.assertEqual(s, 500)
        self.assertNotIn("ZeroDivision", json.dumps(body))


if __name__ == "__main__":
    unittest.main(verbosity=2)
