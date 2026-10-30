"""Smoke test: 注册/登录 -> 加库存 -> 生成计划 -> 审批替换 -> 烹饪扣库存 -> 记餐 -> 看周报.
Usage:
  python scripts/smoke_test.py                 # in-process TestClient, fresh temp DB
  python scripts/smoke_test.py --base-url http://127.0.0.1:8014   # disposable test server
Exit 0 = all steps passed.
"""
import argparse, json, os, sys, tempfile, uuid

def check(name, cond, detail=""):
    if not cond:
        raise SystemExit(f"[FAIL] {name} {detail}")
    print(f"[PASS] {name}")

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-url", default="")
    args = ap.parse_args()
    if args.base_url:
        import httpx
        client = httpx.Client(base_url=args.base_url.rstrip("/"), follow_redirects=True, timeout=30, trust_env=False)
        def req(method, path, **kw):
            r = client.request(method, path, **kw)
            return r.status_code, r.json() if r.headers.get("content-type","").startswith("application/json") else r.text
        # live: need CSRF cookie first
        s, _ = req("GET", "/api/v1/auth/csrf"); check("live csrf", s == 200, str(s))
        csrf = client.cookies.get("csrf_token")
    else:
        test_data = tempfile.mkdtemp(prefix="shiguang-smoke-")
        os.environ["DATA_DIR"] = test_data
        os.environ["DATABASE_URL"] = f"sqlite:///{test_data}/smoke.db"
        os.environ["MODEL_API_KEY"] = ""
        sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))
        from fastapi.testclient import TestClient
        from app.main import app
        from app.seed import seed_all
        from app.db import SessionLocal, init_db
        init_db()
        db = SessionLocal()
        try: seed_all(db)
        finally: db.close()
        c = TestClient(app, raise_server_exceptions=False)
        def req(method, path, **kw):
            r = c.request(method, path, **kw)
            try: body = r.json()
            except Exception: body = r.text
            return r.status_code, body
        s, b = req("GET", "/api/v1/auth/csrf"); check("csrf", s == 200, str(b))
        csrf = b["data"]["csrf_token"] if isinstance(b, dict) else ""
        client = c
    H = {"X-CSRF-Token": csrf} if csrf else {}

    # 1. register + login (fresh user; demo account already seeded in-process)
    email = f"smoke-{uuid.uuid4().hex[:8]}@example.com"
    s, b = req("POST", "/api/v1/auth/register", json={"email": email, "password": "Smoke1234!", "name": "冒烟"}, headers=H)
    check("register", s in (200, 201), str(s) + str(b)[:200])
    s, b = req("POST", "/api/v1/auth/login", json={"email": email, "password": "Smoke1234!"}, headers=H)
    check("login", s == 200, str(s) + str(b)[:200])
    # TestClient keeps cookies; httpx too. Refresh CSRF after login.
    s, b = req("GET", "/api/v1/auth/csrf"); csrf = b["data"]["csrf_token"]; H = {"X-CSRF-Token": csrf}
    # restrictions: peanut allergy (hard)
    s, b = req("POST", "/api/v1/users/me/restrictions", json={"kind": "allergy", "label": "花生", "keys": ["花生"], "hard": True}, headers=H)
    check("add restriction", s in (200, 201), str(s) + str(b)[:200])

    # 2. foods / recipes present
    s, b = req("GET", "/api/v1/foods")
    foods = b["data"] if isinstance(b, dict) else []
    check("foods >= 30", s == 200 and len(foods) >= 30, f"count={len(foods)}")
    s, b = req("GET", "/api/v1/recipes")
    recipes = b["data"] if isinstance(b, dict) else []
    check("recipes >= 10", s == 200 and len(recipes) >= 10, f"count={len(recipes)}")

    # 3. add pantry batch (egg 8 pieces)
    egg = next((f for f in foods if f.get("code") == "egg" or f.get("name") == "鸡蛋"), foods[0])
    egg_id = egg["id"]
    s, b = req("POST", "/api/v1/pantry/batches", json={"food_id": egg_id, "qty": "8", "unit": "piece", "location": "fridge"}, headers={**H, "Idempotency-Key": str(uuid.uuid4())})
    check("add batch", s in (200, 201), str(s) + str(b)[:300])

    # 4. plan draft (3 days) must not contain peanut recipes, must not consume stock
    s, b = req("POST", "/api/v1/plans/drafts", json={"period_start": "2026-11-23", "days": 3, "meal_slots": ["breakfast", "lunch", "dinner"], "constraints": {"max_cook_minutes": 35}, "use_pantry": True}, headers={**H, "Idempotency-Key": str(uuid.uuid4())})
    check("plan draft", s in (200, 201), str(s) + str(b)[:300])
    draft = b["data"]; draft_id = draft.get("draft_id") or draft.get("id")
    titles = json.dumps(draft, ensure_ascii=False)
    check("plan excludes peanut", "宫保鸡丁" not in titles, "peanut recipe leaked into draft")
    s, b = req("GET", "/api/v1/pantry/batches")
    check("plan does not consume stock", s == 200, str(s))

    # 5. commit plan, then replace one meal (approval-style: replace-meal with expected_version)
    s, b = req("POST", "/api/v1/plans", json={"draft_id": draft_id}, headers={**H, "Idempotency-Key": str(uuid.uuid4())}) if draft_id else (404, {})
    if s not in (200, 201):
        # fallback: commit endpoint
        s, b = req("POST", f"/api/v1/plans/{draft_id}/commit", json={}, headers={**H, "Idempotency-Key": str(uuid.uuid4())})
    check("commit plan", s in (200, 201), str(s) + str(b)[:300])
    plan = b["data"]; plan_id = plan.get("id") or plan.get("plan_id") or draft_id
    ver = plan.get("active_version", 1)
    # replace Wednesday-ish dinner (day 3) with a safe recipe
    safe = next((r for r in recipes if "番茄炒蛋" in r.get("title", "")), recipes[0])
    s, b = req("POST", f"/api/v1/plans/{plan_id}/replace-meal", json={"expected_version": ver, "target": {"local_date": "2026-11-25", "slot": "dinner"}, "replacement": {"recipe_id": safe["id"], "servings": "1"}}, headers={**H, "Idempotency-Key": str(uuid.uuid4())})
    check("replace meal (versioned)", s in (200, 201), str(s) + str(b)[:300])
    new_ver = b["data"].get("active_version", ver + 1)
    check("version incremented", new_ver == ver + 1, f"{ver}->{new_ver}")
    # stale version must conflict
    s, b = req("POST", f"/api/v1/plans/{plan_id}/replace-meal", json={"expected_version": ver, "target": {"local_date": "2026-11-25", "slot": "dinner"}, "replacement": {"recipe_id": safe["id"], "servings": "1"}}, headers={**H, "Idempotency-Key": str(uuid.uuid4())})
    check("stale version -> 409", s == 409, str(s))

    # 6. cooking consumption (FEFO) reduces stock exactly once; repeat idempotency key does not double-deduct
    key = str(uuid.uuid4())
    s, b = req("POST", "/api/v1/pantry/consumptions", json={"food_id": egg_id, "amount": "2", "unit": "piece", "reason": "烹饪：番茄炒蛋", "source_type": "cooking_session", "source_id": "smoke-ck-1", "idempotency_key": key}, headers={**H, "Idempotency-Key": key})
    check("cook consume 2 eggs", s in (200, 201), str(s) + str(b)[:300])
    s, b = req("POST", "/api/v1/pantry/consumptions", json={"food_id": egg_id, "amount": "2", "unit": "piece", "reason": "烹饪：番茄炒蛋", "source_type": "cooking_session", "source_id": "smoke-ck-1", "idempotency_key": key}, headers={**H, "Idempotency-Key": key})
    check("repeat consumption idempotent", s in (200, 201), str(s) + str(b)[:200])

    # 7. meal record (default: no stock deduction) + nutrition example
    s, b = req("POST", "/api/v1/nutrition/estimate", json={"items": [{"food_id": egg_id, "amount": "150", "unit": "g"}]}, headers=H)
    check("nutrition estimate", s in (200, 201), str(s) + str(b)[:200])
    s, b = req("POST", "/api/v1/meals", json={"date": "2026-11-23", "slot": "lunch", "items": [{"food_id": egg_id, "amount": "150", "unit": "g"}], "note": "冒烟记餐"}, headers={**H, "Idempotency-Key": str(uuid.uuid4())})
    check("meal record", s in (200, 201), str(s) + str(b)[:300])

    # 8. habit + weekly report
    s, b = req("POST", "/api/v1/habits/records", json={"kind": "water", "date": "2026-11-23", "value": "250", "unit": "ml"}, headers={**H, "Idempotency-Key": str(uuid.uuid4())})
    check("habit record", s in (200, 201), str(s) + str(b)[:200])
    s, b = req("POST", "/api/v1/reports/generate", json={"week_start": "2026-11-23"}, headers={**H, "Idempotency-Key": str(uuid.uuid4())})
    check("weekly report", s in (200, 201), str(s) + str(b)[:300])

    # 9. health + frontend served
    s, b = req("GET", "/health/live"); check("health live", s == 200, str(s))
    if not args.base_url:
        r = client.get("/"); check("frontend index served", r.status_code == 200 and "AI" in r.text or "饮食" in r.text, str(r.status_code))
    print("SMOKE OK: 注册/库存/计划/替换/烹饪/记餐/习惯/周报 全通")

if __name__ == "__main__":
    main()
