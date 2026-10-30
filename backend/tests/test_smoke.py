"""Smoke tests: real DB (temp sqlite file), real TestClient, seeded demo data.

Run: .venv/bin/python -m pytest backend/tests/test_smoke.py -v
"""
import os
import sys
import tempfile
from pathlib import Path

import pytest

# DATABASE_URL must be set before app import (engine is built at import).
TMP = tempfile.mkdtemp()
os.environ["DATABASE_URL"] = f"sqlite:///{TMP}/test.db"
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi.testclient import TestClient  # noqa: E402

from app.db import SessionLocal, init_db  # noqa: E402
from app.main import app  # noqa: E402
from app.models import Food  # noqa: E402
from app.seed import seed_all  # noqa: E402


@pytest.fixture(scope="module")
def client():
    init_db()
    db = SessionLocal()
    seed_all(db)
    db.close()
    with TestClient(app) as c:
        yield c


def _login(c, email="demo@example.com", password="Demo1234!"):
    c.get("/api/v1/auth/csrf")
    csrf = c.cookies.get("csrf_token")
    r = c.post("/api/v1/auth/login", json={"email": email, "password": password})
    assert r.status_code == 200, r.text
    # login sets a fresh csrf cookie; use whatever the jar holds now
    return c.cookies.get("csrf_token")


def _auth_headers(c):
    return {"X-CSRF-Token": c.cookies.get("csrf_token")}


def _egg_remaining(c):
    r = c.get("/api/v1/pantry/batches?food_id=egg")
    assert r.status_code == 200
    rows = [b for b in r.json()["data"] if b["quantity_status"] == "known"]
    return sum(b["remaining"] for b in rows)


def test_register_login_and_cross_user_isolation(client):
    csrf = _login(client)
    # register a second user
    r = client.post("/api/v1/auth/register",
                    json={"email": "other@example.com", "password": "Other1234!", "name": "他人"},
                    headers=_auth_headers(client))
    assert r.status_code == 201, r.text
    # demo's batch id must not be visible to the other user
    r = client.get("/api/v1/pantry/batches?food_id=egg")
    demo_batch = r.json()["data"][0]["id"]
    _login(client, "other@example.com", "Other1234!")
    r = client.get(f"/api/v1/pantry/batches/{demo_batch}", headers=_auth_headers(client))
    assert r.status_code == 404, r.text  # cross-user -> 404, no leak
    r = client.get("/api/v1/pantry/batches", headers=_auth_headers(client))
    assert r.json()["data"] == []
    _login(client)  # back to demo


def test_nutrition_example_150g_protein_20_per_100g_is_30g(client):
    _login(client)
    # synthetic food with exactly 20g protein / 100g (doc example)
    db = SessionLocal()
    db.add(Food(id="testfood", name="测试食材", unit="g", nutrients=[100, 20, 5, 10],
                allergens=[], tags=[]))
    db.commit()
    db.close()
    r = client.post("/api/v1/nutrition/estimate",
                    json={"items": [{"food_id": "testfood", "amount": 150, "unit": "g"}]},
                    headers=_auth_headers(client))
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    assert d["protein"] == "30.0", d
    assert d["completeness"] == "full"
    # unknown nutrition: pidan has null nutrients
    r = client.post("/api/v1/nutrition/estimate",
                    json={"items": [{"food_id": "pidan", "amount": 1, "unit": "piece"}]},
                    headers=_auth_headers(client))
    assert r.json()["data"]["completeness"] == "unknown"


def test_pantry_idempotent_consumption_only_once(client):
    _login(client)
    before = _egg_remaining(client)
    body = {"food_id": "egg", "amount": 1, "unit": "piece", "reason": "测试",
            "source_type": "test", "source_id": "idem-1", "idempotency_key": "idem-key-1"}
    for i in range(3):
        r = client.post("/api/v1/pantry/consumptions", json=body, headers=_auth_headers(client))
        assert r.status_code == 200, r.text
    after = _egg_remaining(client)
    assert before - after == 1, (before, after)


def test_plan_commit_does_not_consume_stock(client):
    _login(client)
    before = _egg_remaining(client)
    r = client.get("/api/v1/plans", headers=_auth_headers(client))
    plan_id = r.json()["data"][0]["id"]
    today = __import__("datetime").date.today()
    monday = today - __import__("datetime").timedelta(days=today.weekday())
    r = client.post("/api/v1/plans/drafts",
                    json={"period_start": monday.isoformat(), "days": 7,
                          "meal_slots": ["breakfast", "lunch", "dinner"]},
                    headers=_auth_headers(client))
    assert r.status_code == 201, r.text
    draft_id = r.json()["data"]["draft_id"]
    r = client.post(f"/api/v1/plans/{plan_id}/commit",
                    json={"draft_id": draft_id}, headers=_auth_headers(client))
    assert r.status_code == 200, r.text
    assert _egg_remaining(client) == before


def test_meal_record_default_no_consume_but_opt_in_consumes(client):
    _login(client)
    before = _egg_remaining(client)
    today = __import__("datetime").date.today().isoformat()
    r = client.post("/api/v1/meals",
                    json={"date": today, "slot": "snack",
                          "items": [{"food_id": "egg", "amount": 1, "unit": "piece"}]},
                    headers=_auth_headers(client))
    assert r.status_code == 201, r.text
    assert _egg_remaining(client) == before  # default: no deduction
    r = client.post("/api/v1/meals",
                    json={"date": today, "slot": "snack",
                          "items": [{"food_id": "egg", "amount": 1, "unit": "piece"}],
                          "consume_from_pantry": True},
                    headers=_auth_headers(client))
    assert r.status_code == 201, r.text
    assert _egg_remaining(client) == before - 1


def test_allergy_hard_block(client):
    _login(client)
    r = client.get("/api/v1/plans", headers=_auth_headers(client))
    plan_id = r.json()["data"][0]["id"]
    version = r.json()["data"][0]["active_version"]
    today = __import__("datetime").date.today()
    monday = today - __import__("datetime").timedelta(days=today.weekday())
    # 宫保鸡丁 contains peanut -> hard blocked for demo user
    r = client.post(f"/api/v1/plans/{plan_id}/replace-meal",
                    json={"expected_version": version,
                          "target": {"local_date": monday.isoformat(), "slot": "lunch"},
                          "replacement": {"recipe_id": "r_kungpao", "servings": 2}},
                    headers=_auth_headers(client))
    assert r.status_code == 422, r.text
    assert r.json()["error"]["code"] == "ALLERGY_BLOCKED"
    # draft generation must also exclude it
    r = client.post("/api/v1/plans/drafts",
                    json={"period_start": monday.isoformat(), "days": 7,
                          "meal_slots": ["breakfast", "lunch", "dinner"]},
                    headers=_auth_headers(client))
    meals = r.json()["data"]["meals"]
    assert all(m["recipe_id"] != "r_kungpao" for m in meals.values())


def test_plan_version_conflict_409(client):
    _login(client)
    r = client.get("/api/v1/plans", headers=_auth_headers(client))
    plan = r.json()["data"][0]
    today = __import__("datetime").date.today()
    monday = today - __import__("datetime").timedelta(days=today.weekday())
    r = client.post(f"/api/v1/plans/{plan['id']}/replace-meal",
                    json={"expected_version": plan["active_version"] + 99,
                          "target": {"local_date": monday.isoformat(), "slot": "lunch"},
                          "replacement": {"recipe_id": "r_broc", "servings": 2}},
                    headers=_auth_headers(client))
    assert r.status_code == 409, r.text
    assert r.json()["error"]["code"] == "CONFLICT"


def test_agent_reject_writes_nothing(client):
    _login(client)
    r = client.get("/api/v1/plans", headers=_auth_headers(client))
    plan = r.json()["data"][0]
    version_before = plan["active_version"]
    r = client.post("/api/v1/agent/threads", json={"title": "测试"}, headers=_auth_headers(client))
    tid = r.json()["data"]["id"]
    r = client.post(f"/api/v1/agent/threads/{tid}/runs",
                    json={"message": "把午餐换成蒜蓉虾仁意面"}, headers=_auth_headers(client))
    assert r.status_code == 201, r.text
    run_id = r.json()["data"]["run_id"]
    assert r.json()["data"]["status"] == "waiting_approval"
    r = client.get(f"/api/v1/agent/runs/{run_id}", headers=_auth_headers(client))
    action = r.json()["data"]["actions"][0]
    assert action["type"] == "replace_meal"
    r = client.post(f"/api/v1/agent/runs/{run_id}/actions/{action['id']}/decision",
                    json={"decision": "reject", "shown_payload_hash": action["payload_hash"]},
                    headers=_auth_headers(client))
    assert r.status_code == 200, r.text
    assert r.json()["data"]["status"] == "rejected"
    r = client.get("/api/v1/plans", headers=_auth_headers(client))
    assert r.json()["data"][0]["active_version"] == version_before


# ---- v0.2.0: version / backup-restore / habits import / expiring ----

def test_version_endpoint_public(client):
    r = client.get("/api/v1/version")
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    assert d["version"] == "0.2.0", d
    assert isinstance(d["commit"], str) and d["commit"], d
    assert d["agent_provider"] in ("rule", "llm"), d
    assert isinstance(d["recognition_available"], bool), d
    assert (d["agent_model"] is None) == (d["agent_provider"] == "rule"), d


def test_database_backup_and_restore_require_admin(client, monkeypatch, tmp_path):
    from app.api.v1.privacy import _db_path, _sqlite_backup
    from app.core import config

    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    _login(client)
    assert client.get("/api/v1/auth/me").json()["data"]["user"]["server_admin"] is False
    backup_route = "/api/v1/privacy/backup"
    restore_route = "/api/v1/privacy/restore"
    bad_file = {"file": ("bad.db", b"not a sqlite file", "application/octet-stream")}
    for route, options in ((backup_route, {}), (restore_route, {"files": bad_file})):
        denied = client.post(route, headers=_auth_headers(client), **options)
        assert denied.status_code == 403 and denied.json()["error"]["code"] == "ADMIN_REQUIRED"
    export = client.post("/api/v1/privacy/export", headers=_auth_headers(client))
    assert export.status_code == 200
    assert export.json()["data"]["content"]["user"]["email"] == "demo@example.com"

    # A backup made before provisioning contains no administrator or admin login session.
    legacy = tmp_path / "before-admin.db"
    _sqlite_backup(_db_path(), legacy)
    email, password = "admin@example.test", "Admin-test-password"
    user = client.post("/api/v1/auth/register", json={"email": email, "password": password})
    assert user.status_code == 201, user.text
    uid = user.json()["data"]["user"]["id"]
    (tmp_path / "server-admin-ids").write_text(uid + "\n", encoding="ascii")
    _login(client, email, password)
    assert client.get("/api/v1/auth/me").json()["data"]["user"]["server_admin"] is True

    backup = client.post(backup_route, headers=_auth_headers(client))
    assert backup.status_code == 200 and backup.content.startswith(b"SQLite format 3\x00")
    assert "ai-life-agent-backup-" in backup.headers["content-disposition"]
    invalid = client.post(restore_route, files=bad_file, headers=_auth_headers(client))
    assert invalid.status_code == 422, invalid.text
    assert client.get("/api/v1/auth/me").status_code == 200

    restored = client.post(
        restore_route,
        files={"file": ("before-admin.db", legacy.read_bytes(), "application/octet-stream")},
        headers=_auth_headers(client),
    )
    assert restored.status_code == 200, restored.text
    rollback = _db_path().with_name(restored.json()["data"]["backup"])
    assert rollback.read_bytes().startswith(b"SQLite format 3\x00")
    assert client.get("/api/v1/auth/me").status_code == 401
    _login(client, email, password)
    assert client.get("/api/v1/auth/me").json()["data"]["user"]["server_admin"] is True
    _login(client)
    assert client.post(backup_route, headers=_auth_headers(client)).status_code == 403


def test_automatic_weekly_reports_follow_policy_and_deduplicate(client):
    from concurrent.futures import ThreadPoolExecutor
    from datetime import date, datetime

    from app.application.weekly_reports import REPORT_TIMEZONE, generate_automatic_report, latest_due_week
    from app.models import AutomationPolicy, Notification, Report, User

    before = datetime(2026, 11, 22, 19, 59, tzinfo=REPORT_TIMEZONE)
    assert latest_due_week(before) == date(2026, 11, 9)
    start = latest_due_week(before.replace(hour=20, minute=0))
    assert start == date(2026, 11, 16)
    with SessionLocal() as db:
        users = {}
        for mode in ("auto", "observe", "off", "deleted"):
            user = User(email=f"weekly-{mode}@example.test", password_hash="unused",
                        status="deleted" if mode == "deleted" else "active")
            db.add(user)
            db.flush()
            db.add(AutomationPolicy(user_id=user.id, task_kind="weekly_report",
                                    mode="auto" if mode == "deleted" else mode))
            users[mode] = user.id
        db.commit()

    def run(uid):
        with SessionLocal() as db:
            return generate_automatic_report(db, uid, start)

    for mode in ("observe", "off", "deleted"):
        assert run(users[mode])["status"] == "skipped"
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(run, [users["auto"]] * 2))
    assert sorted(bool(result.get("duplicated")) for result in results) == [False, True]
    with SessionLocal() as db:
        uid = users["auto"]
        report = db.query(Report).filter(Report.user_id.in_(users.values())).one()
        notice = db.query(Notification).filter(Notification.user_id.in_(users.values())).one()
        assert report.user_id == notice.user_id == uid
        assert report.period_start == start and report.metrics_json["missing_days"] == 7
        assert notice.link == f"#/reports?week={start}"


def test_habits_import_csv_dedup_overwrites(client):
    _login(client)
    import datetime as _dt
    day = (_dt.date.today() + _dt.timedelta(days=30)).isoformat()
    csv1 = f"date,kind,value\n{day},water,500\n{day},water,800\nbad-date,steps,100\n{day},steps,7000\n"
    r = client.post("/api/v1/habits/import",
                    files={"file": ("import.csv", csv1.encode(), "text/csv")},
                    headers=_auth_headers(client))
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    assert d["imported"] == 2 and len(d["failed"]) == 1, d  # water(500+800 当天总量)+steps；坏行只记 failed
    csv2 = f"date,kind,value\n{day},water,900\n"
    r = client.post("/api/v1/habits/import",
                    files={"file": ("import.csv", csv2.encode(), "text/csv")},
                    headers=_auth_headers(client))
    assert r.status_code == 200, r.text
    assert r.json()["data"]["imported"] == 1, r.text
    r = client.get(f"/api/v1/habits/records?kind=water&date_from={day}&date_to={day}",
                   headers=_auth_headers(client))
    rows = r.json()["data"]
    assert len(rows) == 1 and rows[0]["value"] == 900.0, rows  # 导两次只留一条，值为后一次


def test_pantry_expiring_sorted_and_notified_once_per_day(client):
    _login(client)
    # 清掉已有的临期通知（含启动扫描产生的），以便验证本次调用真的发通知
    db = SessionLocal()
    from app.models import Notification, User
    demo = db.query(User).filter(User.email == "demo@example.com").first()
    db.query(Notification).filter(Notification.user_id == demo.id, Notification.kind == "expiry").delete()
    db.commit()
    db.close()

    def _expiry_count():
        r = client.get("/api/v1/notifications", headers=_auth_headers(client))
        assert r.status_code == 200, r.text
        return len([n for n in r.json()["data"] if n["kind"] == "expiry"])

    r = client.get("/api/v1/pantry/expiring?days=3", headers=_auth_headers(client))
    assert r.status_code == 200, r.text
    items = r.json()["data"]
    assert items, items
    days_left = [i["days_left"] for i in items]
    assert days_left == sorted(days_left), items
    assert all(0 <= d <= 3 for d in days_left), items  # 已过期批次不出现
    assert any(i["remaining"] is None for i in items), items  # 数量未知批次也在内
    first_count = _expiry_count()
    assert first_count == len(items), (first_count, items)
    r = client.get("/api/v1/pantry/expiring?days=3", headers=_auth_headers(client))
    assert r.status_code == 200, r.text
    assert _expiry_count() == first_count  # 同一天重复调用不重复发通知


def test_habits_import_apple_xml(client):
    _login(client)
    import datetime as _dt
    day = (_dt.date.today() + _dt.timedelta(days=31)).isoformat()
    xml = (
        '<?xml version="1.0" encoding="UTF-8"?>\n<HealthData locale="zh_CN">\n'
        f'<Record type="HKQuantityTypeIdentifierStepCount" startDate="{day} 08:00:00 +0800" endDate="{day} 08:10:00 +0800" value="1000"/>\n'
        f'<Record type="HKQuantityTypeIdentifierStepCount" startDate="{day} 18:00:00 +0800" endDate="{day} 18:05:00 +0800" value="500"/>\n'
        f'<Record type="HKQuantityTypeIdentifierHeartRate" startDate="{day} 09:00:00 +0800" endDate="{day} 09:00:00 +0800" value="70"/>\n'
        f'<Record type="HKCategoryTypeIdentifierSleepAnalysis" startDate="{day} 00:00:00 +0800" endDate="{day} 07:30:00 +0800" value="HKCategoryValueSleepAnalysisAsleep"/>\n'
        f'<Record type="HKCategoryTypeIdentifierSleepAnalysis" startDate="{day} 07:30:00 +0800" endDate="{day} 08:00:00 +0800" value="HKCategoryValueSleepAnalysisInBed"/>\n'
        f'<Record type="HKQuantityTypeIdentifierBodyMass" startDate="{day} 07:00:00 +0800" endDate="{day} 07:00:00 +0800" value="62.0"/>\n'
        f'<Record type="HKQuantityTypeIdentifierBodyMass" startDate="{day} 20:00:00 +0800" endDate="{day} 20:00:00 +0800" value="62.3"/>\n'
        '</HealthData>\n'
    )
    r = client.post("/api/v1/habits/import",
                    files={"file": ("export.xml", xml.encode(), "text/xml")},
                    headers=_auth_headers(client))
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    assert d["imported"] == 3 and d["failed"] == [], d  # steps/sleep/weight；心率与非 Asleep 睡眠被忽略
    assert d["skipped"] == 2, d
    r = client.get(f"/api/v1/habits/records?date_from={day}&date_to={day}", headers=_auth_headers(client))
    got = {(row["kind"]): row["value"] for row in r.json()["data"]}
    assert got == {"steps": 1500.0, "sleep": 7.5, "weight": 62.3}, got
