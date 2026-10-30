"""End-to-end approval recovery across API process restarts and PostgreSQL."""

from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import subprocess
import sys

import pytest


def test_postgres_meal_approval_survives_restart(tmp_path):
    url = os.environ.get("SHIGUANG_TEST_POSTGRES_URL")
    if not url:
        pytest.skip("Set SHIGUANG_TEST_POSTGRES_URL to an empty PostgreSQL test database")
    backend = Path(__file__).resolve().parents[1]
    env = {
        **os.environ, "DATABASE_URL": url, "MODEL_API_KEY": "",
        "DATA_DIR": str(tmp_path), "PYTHONPATH": str(backend),
    }
    child = [sys.executable, __file__]
    pending = subprocess.check_output(
        [*child, "propose"], cwd=backend, env=env, encoding="utf-8", timeout=45,
    )
    crashed = subprocess.run(
        [*child, "crash"], cwd=backend, env=env, input=pending, encoding="utf-8", timeout=45,
    )
    assert crashed.returncode == 37
    subprocess.run(
        [*child, "resume"], cwd=backend, env=env, input=pending, encoding="utf-8",
        check=True, timeout=45,
    )


def _post(client, path, body, status=200):
    response = client.post(path, json=body, headers={"X-CSRF-Token": client.cookies.get("csrf_token", "")})
    assert response.status_code == status, response.text
    return response.json()["data" if status < 400 else "error"]


def _propose(client, day, recipe_id):
    thread = _post(client, "/api/v1/agent/threads", {}, 201)["id"]
    run = _post(client, f"/api/v1/agent/threads/{thread}/runs", {
        "message": "换今晚的菜",
        "recipe_action": {
            "kind": "menu", "recipe_id": recipe_id, "local_date": day, "slot": "dinner", "servings": 2,
        },
    }, 201)
    assert run["status"] == "waiting_approval"
    path = f"/api/v1/agent/runs/{run['run_id']}"
    action, = client.get(path).json()["data"]["actions"]
    assert action["type"] == "replace_meal"
    assert "event: approval.required" in client.get(run["events_url"]).text
    return {
        "thread": thread, "path": f"{path}/actions/{action['id']}/decision",
        "hash": action["payload_hash"], "recipe_id": recipe_id,
    }


def _phase(phase):
    from alembic import command
    from alembic.config import Config
    from fastapi.testclient import TestClient
    from sqlalchemy import inspect, text
    from unittest.mock import patch

    from app.agents import engine as agent_engine
    from app.application import services
    from app.db import SessionLocal, engine
    from app.main import app
    from app.models import MealPlan, Recipe, User

    if phase == "propose":
        assert engine.dialect.driver == "psycopg"
        assert not inspect(engine).get_table_names(), "Use an empty test database"
        command.upgrade(Config("alembic.ini"), "head")

    with TestClient(app, raise_server_exceptions=False) as client:
        credentials = {"email": "approval-test@example.com", "password": "ApprovalTest123!"}
        if phase == "propose":
            uid = _post(client, "/api/v1/auth/register", credentials, 201)["user"]["id"]
            day = services.today()
            with SessionLocal() as db:
                db.add_all([
                    Recipe(id="soup", title="番茄汤"), Recipe(id="broccoli", title="蒜蓉西兰花"),
                    Recipe(id="rice", title="鸡腿饭"), Recipe(id="noodles", title="虾仁意面"),
                ])
                plan = MealPlan(user_id=uid, title="测试菜单", period_start=day, period_end=day)
                db.add(plan)
                db.flush()
                services.commit_plan_version(db, db.get(User, uid), plan, {
                    f"{day.isoformat()}|dinner": {"recipe_id": "soup", "servings": 2},
                }, "测试初始菜单")
                db.commit()
        _post(client, "/api/v1/auth/login", credentials)
        if phase == "propose":
            plan, = client.get("/api/v1/plans").json()["data"]
            day = plan["period_start"]
            pending = [_propose(client, day, recipe) for recipe in ("noodles", "broccoli", "rice")]
            with engine.connect() as conn:
                assert conn.scalar(text("SELECT count(DISTINCT thread_id) FROM checkpoints")) == 3
            print(json.dumps({"plan": plan, "day": day, "pending": pending}))
            return

        data = json.load(sys.stdin)
        approved, stale, rejected = data["pending"]
        plan = data["plan"]
        plan_path = f"/api/v1/plans/{plan['id']}"
        assert client.get(plan_path).json()["data"] == plan
        history = client.get(f"/api/v1/agent/threads/{approved['thread']}/history").json()["data"]
        assert history["runs"][0]["actions"][0]["status"] == "waiting_approval"

        def decide(action, decision, status=200, shown_hash=None):
            return _post(client, action["path"], {
                "decision": decision, "shown_payload_hash": shown_hash or action["hash"],
            }, status)

        if phase == "crash":
            commit_action = agent_engine.commit_action

            def crash_before_commit(*args):
                commit_action(*args)
                # Exit after the domain changes are flushed, before the request commits.
                os._exit(37)

            with patch.object(agent_engine, "commit_action", crash_before_commit):
                decide(approved, "approve")
            raise AssertionError("The approval process should have exited before commit")

        assert decide(rejected, "reject")["status"] == "rejected"
        assert decide(approved, "approve", 409, "stale-hash")["code"] == "HASH_MISMATCH"
        assert client.get(plan_path).json()["data"] == plan

        with ThreadPoolExecutor(max_workers=2) as workers:
            attempts = [workers.submit(decide, approved, "approve") for _ in range(2)]
        results = [attempt.result() for attempt in attempts]
        assert all(result["status"] == "committed" for result in results)
        assert sum(result.get("duplicated", False) for result in results) == 1
        assert decide(stale, "approve", 409)["code"] == "CONFLICT"
        changed = client.get(plan_path).json()["data"]
        assert changed["active_version"] == plan["active_version"] + 1
        assert len(changed["versions"]) == len(plan["versions"]) + 1
        assert changed["versions"][-1]["meals"][f"{data['day']}|dinner"]["recipe_id"] == approved["recipe_id"]


if __name__ == "__main__":
    _phase(sys.argv[1])
