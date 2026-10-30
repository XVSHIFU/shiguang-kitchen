"""AI 功能测试：拍照识别 + Agent 接真模型（降级/连通性）。

复用 test_smoke.py 的 fixture 思路：真实临时 sqlite + 真实 TestClient +
seed_all。识别路由用 TestClient 单独挂载验证（main.py 的注册由协调员集成）。
Run: .venv/bin/python -m pytest backend/tests/test_ai_features.py -v
"""
import io
import json
import os
import sys
import tempfile
from pathlib import Path

import httpx
import pytest

TMP = tempfile.mkdtemp()
os.environ["DATABASE_URL"] = f"sqlite:///{TMP}/test.db"
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.agents import llm, titles  # noqa: E402
from app.api.v1 import recognition as recognition_router  # noqa: E402
from app.core import config  # noqa: E402
from app.core.deps import get_current_user  # noqa: E402
from app.core.errors import ApiError, api_error_handler  # noqa: E402
from app.db import SessionLocal, get_db, init_db  # noqa: E402
from app.main import app  # noqa: E402
from app.models import User  # noqa: E402
from app.seed import seed_all  # noqa: E402


@pytest.fixture(autouse=True)
def isolate_title_provider(monkeypatch):
    monkeypatch.setattr(titles, "summarize_title", lambda *args: "")


@pytest.fixture(scope="module")
def client():
    init_db()
    db = SessionLocal()
    seed_all(db)
    db.close()
    with TestClient(app) as c:
        yield c


@pytest.fixture(scope="module")
def recog_client(client):
    """单独挂载 recognition router：无 CSRF 中间件，依赖 override 供测试。"""
    rapp = FastAPI()
    rapp.add_exception_handler(ApiError, api_error_handler)
    rapp.include_router(recognition_router.router, prefix="/api/v1")

    def _db():
        db = SessionLocal()
        try:
            yield db
        finally:
            db.close()

    def _user():
        db = SessionLocal()
        u = db.query(User).filter(User.email == "demo@example.com").first()
        db.close()
        return u

    rapp.dependency_overrides[get_db] = _db
    rapp.dependency_overrides[get_current_user] = _user
    with TestClient(rapp) as c:
        yield c


def _login(c, email="demo@example.com", password="Demo1234!"):
    c.get("/api/v1/auth/csrf")
    r = c.post("/api/v1/auth/login", json={"email": email, "password": password})
    assert r.status_code == 200, r.text


def _auth_headers(c):
    return {"X-CSRF-Token": c.cookies.get("csrf_token")}


def _png_bytes(n=100):
    # 最小合法 PNG 头 + 填充（内容不重要，识别走 mock）
    return b"\x89PNG\r\n\x1a\n" + b"\x00" * n


# ---- 识别 ----

def test_recognition_no_key_returns_503(recog_client, monkeypatch):
    monkeypatch.setattr(config, "MODEL_API_KEY", "")
    r = recog_client.post("/api/v1/recognition/image",
                          files={"file": ("egg.png", _png_bytes(), "image/png")},
                          data={"target": "pantry"})
    assert r.status_code == 503, r.text
    assert r.json()["error"]["code"] == "MODEL_NOT_CONFIGURED"


def test_recognition_oversize_413(recog_client):
    r = recog_client.post("/api/v1/recognition/image",
                          files={"file": ("big.png", _png_bytes(5 * 1024 * 1024 + 1), "image/png")},
                          data={"target": "pantry"})
    assert r.status_code == 413, r.text


def test_recognition_non_image_422(recog_client):
    r = recog_client.post("/api/v1/recognition/image",
                          files={"file": ("note.txt", b"hello", "text/plain")},
                          data={"target": "pantry"})
    assert r.status_code == 422, r.text


def test_recognition_pantry_maps_alias_and_null_qty(recog_client, monkeypatch):
    monkeypatch.setattr(config, "MODEL_API_KEY", "test-key")
    payload = {"candidates": [
        {"name": "西红柿", "qty": None, "unit": "piece", "confidence": "high",
         "expires_days": 2, "note": "三个番茄"},
        {"name": "不存在的食材", "qty": 100, "unit": "g", "confidence": "low",
         "expires_days": None, "note": ""},
    ]}
    monkeypatch.setattr(llm, "vision_chat_complete",
                        lambda *a, **k: {"provider": "llm", "model": "m", "text": json.dumps(payload, ensure_ascii=False)})
    r = recog_client.post("/api/v1/recognition/image",
                          files={"file": ("t.png", _png_bytes(), "image/png")},
                          data={"target": "pantry"})
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    assert d["target"] == "pantry" and d["demo"] is False
    assert d["candidates"][0]["food_id"] == "tomato"  # 西红柿 -> 番茄
    assert d["candidates"][0]["qty"] is None  # 无法判断不瞎猜
    assert d["candidates"][1]["food_id"] is None  # 映射不上为 null


def test_recognition_meal_maps_recipe(recog_client, monkeypatch):
    monkeypatch.setattr(config, "MODEL_API_KEY", "test-key")
    payload = {"recipes": [{"recipe_id": "r_tomegg", "title": "番茄炒蛋", "confidence": "high"}],
               "items": [{"name": "鸡蛋", "amount": 3, "unit": "piece", "confidence": "high"}]}
    monkeypatch.setattr(llm, "vision_chat_complete",
                        lambda *a, **k: {"provider": "llm", "model": "m", "text": json.dumps(payload, ensure_ascii=False)})
    r = recog_client.post("/api/v1/recognition/image",
                          files={"file": ("m.png", _png_bytes(), "image/png")},
                          data={"target": "meal"})
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    assert d["recipes"][0]["recipe_id"] == "r_tomegg"
    assert d["items"][0]["food_id"] == "egg"


# ---- Agent test-connection ----

def test_langchain_compatible_chat_and_stream(monkeypatch):
    from langchain_openai import ChatOpenAI

    model = "deepseek-flash"
    monkeypatch.setattr(config, "MODEL_API_KEY", "test-key")
    monkeypatch.setattr(config, "MODEL_BASE_URL", "https://api.deepseek.com/v1")
    monkeypatch.setattr(config, "MODEL_NAME", model)

    def complete(request):
        assert request.url.path == "/v1/chat/completions"
        body = json.loads(request.content)
        assert body["model"] == model
        assert body["thinking"] == {"type": "disabled"}
        common = {"id": "chatcmpl-fixture", "created": 0, "model": model}
        if body.get("stream"):
            parts = [
                {"delta": {"role": "assistant", "content": "先查"}, "finish_reason": None},
                {"delta": {"content": "库存"}, "finish_reason": "stop"},
            ]
            events = [{**common, "object": "chat.completion.chunk",
                       "choices": [{"index": 0, **part}]} for part in parts]
            content = "".join(f"data: {json.dumps(event)}\n\n" for event in events)
            return httpx.Response(200, content=content + "data: [DONE]\n\n",
                                  headers={"content-type": "text/event-stream"})
        assert body["max_tokens"] == 100
        assert body["response_format"] == {"type": "json_object"}
        return httpx.Response(200, json={
            **common, "object": "chat.completion",
            "choices": [{"index": 0, "finish_reason": "stop",
                         "message": {"role": "assistant", "content": '{"ok": true}'}}],
        })

    with httpx.Client(transport=httpx.MockTransport(complete)) as client:
        monkeypatch.setattr(llm, "ChatOpenAI", lambda **kwargs: ChatOpenAI(http_client=client, **kwargs))
        messages = [{"role": "user", "content": "测试"}]
        result = llm.chat_complete(messages, thinking=False, max_tokens=100, json_output=True)
        assert json.loads(result["text"]) == {"ok": True}
        assert list(llm.stream_chat(messages, thinking=False)) == ["先查", "库存"]


def test_agent_test_connection_no_key(client, monkeypatch):
    monkeypatch.setattr(config, "MODEL_API_KEY", "")
    _login(client)
    r = client.post("/api/v1/agent/test-connection", headers=_auth_headers(client))
    assert r.status_code == 200, r.text
    assert r.json()["data"]["ok"] is False


# ---- Agent 降级 ----

def _start_run(client, message):
    r = client.post("/api/v1/agent/threads", json={"title": "AI测试"}, headers=_auth_headers(client))
    tid = r.json()["data"]["id"]
    r = client.post(f"/api/v1/agent/threads/{tid}/runs",
                    json={"message": message}, headers=_auth_headers(client))
    assert r.status_code == 201, r.text
    return r.json()["data"]["run_id"]


def test_agent_no_key_falls_back_to_rule(client, monkeypatch):
    monkeypatch.setattr(config, "MODEL_API_KEY", "")
    _login(client)
    run_id = _start_run(client, "冰箱里还有什么")
    r = client.get(f"/api/v1/agent/runs/{run_id}", headers=_auth_headers(client))
    d = r.json()["data"]
    assert d["provider"] == "rule"
    assert d["result"]["text"]  # 规则回复非空
    r = client.get(f"/api/v1/agent/runs/{run_id}/events", headers=_auth_headers(client))
    assert '"mode": "rule"' in r.text
    assert '"llm_configured": false' in r.text


def test_agent_llm_failure_annotates_fallback(client, monkeypatch):
    monkeypatch.setattr(config, "MODEL_API_KEY", "test-key")

    def _boom(*a, **k):
        raise httpx.ConnectError("unreachable", request=httpx.Request("POST", "http://x"))

    monkeypatch.setattr(llm, "stream_chat", _boom)
    _login(client)
    run_id = _start_run(client, "冰箱里还有什么")
    r = client.get(f"/api/v1/agent/runs/{run_id}", headers=_auth_headers(client))
    d = r.json()["data"]
    assert d["provider"] == "rule"
    assert "模型调用失败，已用规则回复" in d["result"]["text"]


def test_slow_model_releases_sqlite_writer(client, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event

    monkeypatch.setattr(config, "MODEL_API_KEY", "test-key")
    model_waiting = Event()
    finish_model = Event()

    def complete(*args, **kwargs):
        model_waiting.set()
        assert finish_model.wait(8)
        yield "库存测试回复"

    monkeypatch.setattr(llm, "stream_chat", complete)
    _login(client)
    headers = _auth_headers(client)
    path = "/api/v1/agent/threads"
    threads = [
        client.post(path, json={"title": "并发测试"}, headers=headers).json()["data"]["id"]
        for _ in range(2)
    ]
    first_url, second_url = [f"{path}/{tid}/runs" for tid in threads]

    with ThreadPoolExecutor(max_workers=1) as pool:
        first = pool.submit(client.post, first_url, json={"message": "冰箱还有什么"}, headers=headers)
        try:
            assert model_waiting.wait(4)
            busy = client.post(first_url, json={"message": "怎么记餐"}, headers=headers)
            assert busy.status_code == 409
            concurrent = client.post(second_url, json={"message": "怎么记餐"}, headers=headers)
            assert concurrent.status_code == 201
        finally:
            finish_model.set()
        response = first.result(timeout=8)

    assert response.status_code == 201
    run = response.json()["data"]
    assert run["status"] == "running"
    assert client.get(f"/api/v1/agent/runs/{run['run_id']}").json()["data"]["provider"] == "llm"
    events = client.get(run["events_url"])
    assert "event: message.delta" in events.text
    assert "库存测试回复" in events.text


def test_followup_explains_pending_action_with_same_thread_history(client, monkeypatch):
    monkeypatch.setattr(config, "MODEL_API_KEY", "test-key")
    calls = []

    def stream(messages, **kwargs):
        calls.append(messages)
        yield "这是对上一张菜单草稿的说明"

    monkeypatch.setattr(llm, "stream_chat", stream)
    _login(client)
    headers = _auth_headers(client)
    base = "/api/v1/agent/threads"
    first = client.post(base, json={}, headers=headers).json()["data"]["id"]
    other = client.post(base, json={}, headers=headers).json()["data"]["id"]

    def send(thread, text):
        response = client.post(f"{base}/{thread}/runs", json={"message": text}, headers=headers)
        assert response.status_code == 201, response.text
        return response.json()["data"]["run_id"]

    send(other, "隔离标记对话")
    proposal_id = send(first, "安排一周菜单")
    assert len(calls) == 1
    followup_id = send(first, "为什么安排这个")
    assert len(calls) == 2
    prompt = calls[-1]
    assert any(m["role"] == "user" and m["content"] == "安排一周菜单" for m in prompt)
    assert any(m["role"] == "assistant" and "待审批，尚未生效" in m["content"] for m in prompt)
    assert not any("隔离标记对话" in m["content"] for m in prompt)
    assert "为什么安排这个" in prompt[-1]["content"]
    result = client.get(f"/api/v1/agent/runs/{followup_id}").json()["data"]
    assert result["provider"] == "llm"
    assert result["actions"] == []
    original = client.get(f"/api/v1/agent/runs/{proposal_id}").json()["data"]
    assert original["status"] == "waiting_approval" and len(original["actions"]) == 1

    action = original["actions"][0]
    response = client.post(f"/api/v1/agent/runs/{proposal_id}/actions/{action['id']}/decision",
                           headers=headers, json={"decision": "reject", "shown_payload_hash": action["payload_hash"]})
    assert response.status_code == 200
    send(first, "依据是什么")
    assert any(m["role"] == "assistant" and "已拒绝，未生效" in m["content"] for m in calls[-1])


def test_title_updates_from_completed_conversation_and_preserves_reply(client, monkeypatch):
    _login(client)
    monkeypatch.setattr(config, "MODEL_API_KEY", "fixture-model")
    summaries = iter(["冰箱里的鸡蛋", "两人番茄炒蛋"])
    monkeypatch.setattr(titles, "summarize_title", lambda *args: next(summaries))
    scripted = iter([("# 库存\n", "已核对鸡蛋。"), ("# 做法\n", "先准备食材。"), ("仍然是同一道菜。",)])

    def stream(messages, thinking=None):
        yield from next(scripted)

    monkeypatch.setattr(llm, "stream_chat", stream)

    base = "/api/v1/agent/threads"
    headers = _auth_headers(client)
    thread = client.post(base, json={}, headers=headers).json()["data"]["id"]
    for message, title in [
        ("冰箱还有什么？", "冰箱里的鸡蛋"),
        ("那用番茄炒蛋安排两个人的晚饭", "两人番茄炒蛋"),
        ("为什么这样做？", "两人番茄炒蛋"),
    ]:
        response = client.post(f"{base}/{thread}/runs", json={"message": message}, headers=headers)
        assert response.status_code == 201, response.text
        result = client.get(f"{base}/{thread}/history").json()["data"]
        assert result["title"] == title
        assert title not in result["runs"][-1]["text"]
        listing = client.get(base).json()["data"]
        assert next(row["title"] for row in listing if row["id"] == thread) == title


def test_preferences_persist_with_version_and_are_used_by_chat(client, monkeypatch):
    _login(client)
    base = "/api/v1/agent/preferences"
    headers = _auth_headers(client)
    initial = client.get(base).json()["data"]
    saved = {**initial, "name": "厨房搭档", "tone": "concise", "style": "给快速做法", "memory": "工作日晚餐优先一锅菜"}
    response = client.put(base, json=saved, headers=headers)
    assert response.status_code == 200, response.text
    changes = response.json()["data"]
    assert changes == {**saved, "version": initial["version"] + 1}
    assert client.put(base, json=saved, headers=headers).status_code == 409

    with TestClient(app) as other:
        invited = other.post("/api/v1/auth/register", json={
            "email": "agent-preferences-other@example.com", "password": "Preview1234!", "name": "测试账户",
        })
        assert invited.status_code in (200, 201), invited.text
        _login(other, "agent-preferences-other@example.com", "Preview1234!")
        assert other.get(base).json()["data"]["memory"] == ""

    monkeypatch.setattr(config, "MODEL_API_KEY", "fixture-model")
    seen = []

    def stream(messages, thinking=None):
        seen.append(messages[-1]["content"])
        yield "收到。"

    monkeypatch.setattr(llm, "stream_chat", stream)
    _start_run(client, "今晚的做法给个建议")
    assert "工作日晚餐优先一锅菜" in seen[-1]
    cleared = client.put(base, json={**changes, "memory": ""}, headers=headers)
    assert cleared.status_code == 200, cleared.text
    _start_run(client, "再想一道菜")
    assert "工作日晚餐优先一锅菜" not in seen[-1]


def test_team_run_has_specialist_progress_without_a_business_proposal(client, monkeypatch):
    _login(client)
    monkeypatch.setattr(config, "MODEL_API_KEY", "fixture-model")
    monkeypatch.setattr(llm, "chat_complete", lambda messages, **kwargs: {"text": "复核食材并给出建议。"})
    def stream(messages, **kwargs):
        yield "小组给出两种做法。"

    monkeypatch.setattr(llm, "stream_chat", stream)

    headers = _auth_headers(client)
    path = "/api/v1/agent/threads"
    thread = client.post(path, json={"title": "自定小组题目"}, headers=headers).json()["data"]["id"]
    message = "用快过期的食材安排今晚的菜"
    started = client.post(f"{path}/{thread}/runs", json={"message": message, "collaborate": True}, headers=headers)
    assert started.status_code == 201, started.text
    history = client.get(f"{path}/{thread}/history").json()["data"]
    assert history["title"] == "自定小组题目"
    result = history["runs"][0]
    assert result["status"] == "completed"
    assert not result["actions"]
    worker_states = {item["tool"]: item["st"] for item in result["trace"] if item["tool"].startswith("team.")}
    assert worker_states == {"team.ingredients": "ok", "team.planning": "ok", "team.synthesize": "ok"}
