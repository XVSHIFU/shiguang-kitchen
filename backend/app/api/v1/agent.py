"""Agent threads/runs/SSE/decisions + automation policies + notifications."""
import asyncio
import json
from datetime import datetime, timezone

from openai import APIStatusError
from fastapi import APIRouter, BackgroundTasks, Depends, Header
from starlette.concurrency import run_in_threadpool
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.agents import engine as agent_engine
from app.agents import llm, meal_approval, menu_actions, references, team, titles
from app.agents.preferences import PreferencesIn, read_preferences
from app.agents.engine import _emit
from app.core import config
from app.core.deps import get_current_user
from app.core.errors import ApiError, ok
from app.core.security import payload_hash
from app.db import SessionLocal, get_db
from app.models import (
    AgentAction,
    AgentPreferences,
    AgentRun,
    AgentRunEvent,
    AgentTask,
    AgentThread,
    Approval,
    AutomationPolicy,
    Notification,
    PlanDraft,
    Recipe,
    User,
)

router = APIRouter(tags=["agent", "automation", "notifications"])


class ThreadIn(BaseModel):
    title: str | None = None
    parent_thread_id: str | None = Field(default=None, max_length=32)
    quote: references.QuoteIn | None = None


class RunIn(BaseModel):
    message: str
    thinking: bool | None = None
    collaborate: bool = False
    quote: references.QuoteIn | None = None
    recipe_action: menu_actions.RecipeActionIn | None = None


class DecisionIn(BaseModel):
    decision: meal_approval.Decision
    shown_payload_hash: str


class PolicyIn(BaseModel):
    weekly_report: str | None = None
    expiry: str | None = None
    habit_review: str | None = None


# ---- threads / runs ----
@router.post("/agent/test-connection")
def test_connection(user: User = Depends(get_current_user)):
    """验证模型 key 是否可用。绝不返回 key 本身。"""
    if not llm.provider_available():
        return ok({"ok": False, "error": "未配置模型 key"})
    try:
        llm.chat_complete([
            {"role": "system", "content": "只回答 ok"},
            {"role": "user", "content": "ping"},
        ], temperature=0, timeout=10)
    except APIStatusError as e:
        return ok({"ok": False, "error": f"模型调用失败：上游状态 {e.status_code}"})
    except Exception:
        return ok({"ok": False, "error": "模型调用失败，请检查模型配置或网络"})
    return ok({"ok": True, "model": config.MODEL_NAME})


def _iso_utc(value):
    return value.replace(tzinfo=timezone.utc).isoformat() if value else None


@router.get("/agent/preferences")
def get_preferences(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    return ok(read_preferences(db, user.id))


@router.put("/agent/preferences")
def save_preferences(body: PreferencesIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    agent_engine.lock_sqlite_writes(db)
    db.query(User).filter_by(id=user.id).with_for_update().one()
    row = db.get(AgentPreferences, user.id)
    if body.version != (row.version if row else 0):
        raise ApiError(409, "PREFERENCES_CONFLICT", "另一页面已更新管家设置，请重新载入后再保存")
    values = body.model_dump(exclude={"version"})
    if row is not None and "persona" not in body.model_fields_set:
        values["persona"] = row.persona
    if row is None:
        row = AgentPreferences(user_id=user.id, version=1, **values)
        db.add(row)
    else:
        for field, value in values.items():
            setattr(row, field, value)
        row.version += 1
    preferences = {"version": row.version, **values}
    db.commit()
    return ok(preferences)


@router.get("/agent/threads")
def list_threads(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    stats = (db.query(AgentRun.thread_id, func.count().label("run_count"),
                      func.max(func.coalesce(AgentRun.finished_at, AgentRun.started_at)).label("last_activity"))
             .filter(AgentRun.user_id == user.id).group_by(AgentRun.thread_id).subquery())
    first_prompt = (db.query(AgentRun.input_text).filter(AgentRun.thread_id == AgentThread.id,
                    AgentRun.user_id == user.id).order_by(AgentRun.started_at, AgentRun.id)
                    .limit(1).correlate(AgentThread).scalar_subquery())
    activity = func.coalesce(stats.c.last_activity, AgentThread.created_at)
    rows = (db.query(AgentThread, stats.c.run_count, activity, first_prompt).outerjoin(
            stats, stats.c.thread_id == AgentThread.id).filter(AgentThread.user_id == user.id)
            .order_by(activity.desc(), AgentThread.id).all())
    return ok([{"id": thread.id,
                "title": titles.display_title(db, thread, prompt),
                "status": thread.status, "message_count": 2 * (count or 0),
                "parent_thread_id": (thread.context_json or {}).get("parent_thread_id"),
                "quote": (thread.context_json or {}).get("quote"),
                "created_at": _iso_utc(thread.created_at), "updated_at": _iso_utc(updated)}
               for thread, count, updated, prompt in rows])


@router.post("/agent/threads")
def create_thread(body: ThreadIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    title = (body.title or "").strip()[:200]
    context = {}
    if body.parent_thread_id:
        parent = db.query(AgentThread).filter_by(id=body.parent_thread_id, user_id=user.id).first()
        if parent is None:
            raise ApiError(404, "NOT_FOUND", "原对话不存在")
        context["parent_thread_id"] = parent.id
        if body.quote:
            scope = {parent.id, (parent.context_json or {}).get("parent_thread_id")}
            context["quote"] = references.read_quote(db, user.id, scope, body.quote)
    elif body.quote:
        raise ApiError(422, "VALIDATION_ERROR", "旁支引用需要原对话")
    t = AgentThread(user_id=user.id, title=title or titles.DEFAULT_TITLE,
                    title_origin="manual" if title else "auto", context_json=context)
    db.add(t)
    db.commit()
    return ok({"id": t.id, "title": t.title, "status": t.status,
               "created_at": _iso_utc(t.created_at), "message_count": 0, **context}, status=201)


@router.post("/agent/threads/{tid}/runs")
def create_run(tid: str, body: RunIn, background: BackgroundTasks, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    agent_engine.lock_sqlite_writes(db)
    thread = db.query(AgentThread).filter(AgentThread.id == tid, AgentThread.user_id == user.id).with_for_update().first()
    if thread is None:
        raise ApiError(404, "NOT_FOUND", "会话不存在")
    if not body.message or not body.message.strip():
        raise ApiError(422, "VALIDATION_ERROR", "消息不能为空")
    message = body.message.strip()
    context = thread.context_json or {}
    quote = references.read_quote(db, user.id, {tid, context.get("parent_thread_id")}, body.quote) if body.quote else None
    collaborate = not body.recipe_action and (body.collaborate or message.startswith(
        ("请团队", "请小组", "让团队", "让小组", "团队协作")))
    if collaborate and not llm.provider_available():
        raise ApiError(503, "MODEL_UNAVAILABLE", "团队协作需要可用的对话模型")
    intent = agent_engine.route_intent(message)
    running = db.query(AgentRun).filter_by(thread_id=tid, user_id=user.id, status="running").first()
    if running:
        raise ApiError(409, "THREAD_BUSY", "这段对话正在回复", {"run_id": running.id, "status": running.status})
    busy = None
    if body.recipe_action or (not collaborate and intent in agent_engine.PROPOSAL_INTENTS):
        busy = db.query(AgentRun).filter_by(thread_id=tid, user_id=user.id, status="waiting_approval").first()
    if busy and busy.status == "waiting_approval":
        proposal = (db.query(AgentAction, Approval)
                    .join(Approval, Approval.action_id == AgentAction.id)
                    .filter(AgentAction.run_id == busy.id, AgentAction.status == "waiting_approval").first())
        if proposal:
            action, approval = proposal
            if approval.expires_at and approval.expires_at.replace(tzinfo=timezone.utc) <= datetime.now(timezone.utc):
                action.status = approval.status = "expired"
                busy.status = "cancelled"
                busy.finished_at = datetime.now(timezone.utc)
                busy = None
    if busy:
        raise ApiError(409, "THREAD_BUSY", "该会话已有进行中的运行", {"run_id": busy.id, "status": busy.status})


    def enqueue(run_id: str, context: str, fallback: str, references: str):
        roles = team.specialists_for(intent) if collaborate else ()
        background.add_task(agent_engine.stream_model_reply, run_id, context, fallback, references,
                            thinking=body.thinking, roles=roles)

    run = agent_engine.run_agent(db, user, tid, message, enqueue, collaborate=collaborate,
                                 quote=quote, recipe_action=body.recipe_action)
    title = titles.update_title(db, run) if run.status in ("completed", "waiting_approval") else thread.title
    db.commit()
    return ok({"run_id": run.id, "thread_id": tid, "status": run.status, "title": title,
               "provider": run.provider, "events_url": f"/api/v1/agent/runs/{run.id}/events"}, status=201)


@router.get("/agent/runs/{rid}")
def get_run(rid: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    run = db.query(AgentRun).filter(AgentRun.id == rid, AgentRun.user_id == user.id).first()
    if run is None:
        raise ApiError(404, "NOT_FOUND", "运行不存在")
    actions = db.query(AgentAction).filter(AgentAction.run_id == rid).all()
    return ok({"run_id": run.id, "thread_id": run.thread_id, "status": run.status,
               "provider": run.provider, "result": run.result_json or {},
               "actions": [{"id": a.id, "type": a.action_type, "status": a.status,
                            "payload": a.payload_json, "payload_hash": a.payload_hash} for a in actions]})


def _approval_event(db: Session, rid: str, payload: dict) -> dict:
    action = db.query(AgentAction).filter_by(run_id=rid, id=payload.get("action_id")).first()
    if action is None:
        return payload
    approval = db.query(Approval).filter_by(action_id=action.id).first()
    body = action.payload_json or {}
    data = {**payload, "type": action.action_type, "status": action.status,
            "expected_version": action.expected_version}
    if approval and approval.expires_at:
        data["approval_id"] = approval.id
        data["expires_at"] = approval.expires_at.replace(tzinfo=timezone.utc).isoformat()
        if action.status == "waiting_approval" and approval.expires_at.replace(tzinfo=timezone.utc) <= datetime.now(timezone.utc):
            data["status"] = "expired"
    if action.action_type == "replace_meal":
        data.update(target=body.get("target"), from_recipe=body.get("old_recipe_id"),
                    servings=body.get("replacement", {}).get("servings"),
                    to=body.get("replacement", {}).get("recipe_id"),
                    old_recipe_title=body.get("old_recipe_title"), new_recipe_title=body.get("new_recipe_title"))
    elif action.action_type == "commit_plan":
        draft = db.get(PlanDraft, body.get("draft_id")) if body.get("draft_id") else None
        data["diff_list"] = [
            {"local_date": key.split("|")[0], "slot": key.split("|")[1],
             "to": meal["recipe_id"], "servings": meal.get("servings")}
            for key, meal in sorted((draft.content_json or {}).items())
        ] if draft else []
    elif action.action_type == "propose_shopping":
        data["items"] = body.get("items", [])
    return data


@router.get("/agent/threads/{tid}/history")
def thread_history(tid: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    thread = db.query(AgentThread).filter_by(id=tid, user_id=user.id).first()
    if thread is None:
        raise ApiError(404, "NOT_FOUND", "会话不存在")
    runs = db.query(AgentRun).filter_by(thread_id=tid, user_id=user.id).order_by(AgentRun.started_at, AgentRun.id).all()
    history = {run.id: {"id": run.id, "input_text": run.input_text or "", "status": run.status,
                        "provider": run.provider, "text": "", "trace": [], "actions": [], "last_event_id": 0,
                        "quote": (run.context_json or {}).get("quote")}
               for run in runs}
    events = (db.query(AgentRunEvent).join(AgentRun, AgentRun.id == AgentRunEvent.run_id)
              .filter(AgentRun.thread_id == tid, AgentRun.user_id == user.id, AgentRunEvent.user_id == user.id)
              .order_by(AgentRunEvent.run_id, AgentRunEvent.seq_no))
    parts = {}
    terminal = {"run.completed": "completed", "run.failed": "failed", "run.cancelled": "cancelled"}
    for event in events:
        entry = history.get(event.run_id)
        if entry is None:
            continue
        payload = event.payload_json or {}
        entry["last_event_id"] = event.seq_no
        if event.type == "message.delta":
            parts.setdefault(event.run_id, []).append(payload.get("text") or "")
        elif event.type == "tool.started":
            tool = payload.get("tool", "")
            entry["trace"].append({"tool": tool, "label": payload.get("label") or tool, "st": "run"})
        elif event.type == "tool.completed":
            for step in reversed(entry["trace"]):
                if step["tool"] == payload.get("tool") and step["st"] == "run":
                    step["st"] = "err" if payload.get("error") else "ok"
                    break
        elif event.type == "approval.required":
            entry["actions"].append(_approval_event(db, event.run_id, payload))
            if entry["status"] == "running":
                entry["status"] = "waiting_approval"
        elif event.type in terminal and entry["status"] == "running":
            entry["status"] = terminal[event.type]
    for run in runs:
        entry = history[run.id]
        entry["text"] = (run.result_json or {}).get("text") or "".join(parts.get(run.id, []))
    return ok({"title": titles.display_title(db, thread), "runs": list(history.values()),
               **(thread.context_json or {})})


@router.get("/agent/runs/{rid}/events")
def run_events(rid: str, after: int = 0,
               last_event_id: str | None = Header(default=None, alias="Last-Event-ID"),
               db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    run = db.query(AgentRun).filter(AgentRun.id == rid, AgentRun.user_id == user.id).first()
    if run is None:
        raise ApiError(404, "NOT_FOUND", "运行不存在")
    if last_event_id:
        try:
            after = max(after, int(last_event_id))
        except ValueError:
            pass
    db.close()

    def read_events(cursor: int):
        with SessionLocal() as reader:
            status = reader.query(AgentRun.status).filter_by(id=rid).scalar()
            events = (reader.query(AgentRunEvent).filter(AgentRunEvent.run_id == rid,
                      AgentRunEvent.seq_no > cursor).order_by(AgentRunEvent.seq_no).all())
            return status, [
                (ev.seq_no, ev.type, _approval_event(reader, rid, ev.payload_json or {})
                 if ev.type == "approval.required" else ev.payload_json or {})
                for ev in events
            ]

    async def gen():
        cursor = after
        idle = 0
        while True:
            status, events = await run_in_threadpool(read_events, cursor)
            for seq, kind, payload in events:
                cursor = seq
                yield f"id: {cursor}\nevent: {kind}\ndata: {json.dumps({'seq': cursor, 'type': kind, 'payload': payload}, ensure_ascii=False)}\n\n"
            if status != "running":
                return
            idle = 0 if events else idle + 1
            if idle == 50:
                yield ": keepalive\n\n"
                idle = 0
            await asyncio.sleep(0.2)

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@router.post("/agent/runs/{rid}/actions/{aid}/decision")
def decide_action(rid: str, aid: str, body: DecisionIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    agent_engine.lock_sqlite_writes(db)
    run = db.query(AgentRun).filter_by(id=rid, user_id=user.id).with_for_update().first()
    if run is None:
        raise ApiError(404, "NOT_FOUND", "运行不存在")
    action = db.query(AgentAction).filter_by(id=aid, run_id=rid, user_id=user.id).with_for_update().first()
    if action is None:
        raise ApiError(404, "NOT_FOUND", "动作不存在")
    if action.status == "committed":
        return ok({"action_id": action.id, "status": "committed", "duplicated": True})
    if action.status == "rejected":
        return ok({"action_id": action.id, "status": "rejected", "duplicated": True})
    if run.status != "waiting_approval" or action.status != "waiting_approval":
        raise ApiError(409, "CONFLICT", "这张修改单已处理，请打开最新一份")
    if body.shown_payload_hash != action.payload_hash or payload_hash(action.payload_json) != action.payload_hash:
        raise ApiError(409, "HASH_MISMATCH", "展示内容已变化，审批失效，请重新确认",
                       {"expected": action.payload_hash})
    approval = db.query(Approval).filter_by(action_id=action.id, user_id=user.id).first()
    if approval is None or approval.status != "pending":
        raise ApiError(409, "CONFLICT", "这张修改单已处理，请打开最新一份")
    if body.decision == "approve" and approval.expires_at and (
        approval.expires_at.replace(tzinfo=timezone.utc) <= datetime.now(timezone.utc)
    ):
        raise ApiError(409, "APPROVAL_EXPIRED", "审批已过期，请重新发起")
    decision = body.decision
    if action.checkpoint_thread_id:
        # Keep the authorization active until the graph and menu transaction commit.
        actor_status = db.query(User.status).filter_by(id=user.id).with_for_update(read=True).scalar()
        if actor_status != "active":
            raise ApiError(401, "UNAUTHORIZED", "请重新登录")
        try:
            decision = meal_approval.resume(db, action, decision)
        except ApiError:
            action.status = approval.status = "failed"
            agent_engine._finish(db, run, "failed")
            db.commit()
            raise
    if decision == "reject":
        action.status = "rejected"
        approval.status = "rejected"
        approval.decided_at = datetime.now(timezone.utc)
        _emit(db, run, "action.committed", {"action_id": action.id, "status": "rejected", "note": "用户拒绝，未写入业务数据"})
        run.status = "completed"
        run.finished_at = datetime.now(timezone.utc)
        db.commit()
        return ok({"action_id": action.id, "status": "rejected"})
    # approve: re-validate + commit in one transaction
    try:
        with db.begin_nested():
            approval.status = "approved"
            approval.decided_at = datetime.now(timezone.utc)
            action.status = "approved"
            result = agent_engine.commit_action(db, user, action)
    except ApiError as e:
        action.status = "conflict" if e.status == 409 else "failed"
        approval.status = action.status
        run.status = "completed"
        run.finished_at = datetime.now(timezone.utc)
        db.commit()
        raise
    _emit(db, run, "action.committed", {"action_id": action.id, "status": "committed", "result": result})
    run.status = "completed"
    run.finished_at = datetime.now(timezone.utc)
    db.commit()
    return ok({"action_id": action.id, "status": "committed", "result": result})


@router.get("/agent/runs/{rid}/cooking-guide")
def get_cooking_guide(rid: str, url: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    run = db.query(AgentRun).filter_by(id=rid, user_id=user.id).first()
    if run is None:
        raise ApiError(404, "REFERENCE_NOT_FOUND", "找不到参考菜谱")
    return ok(references.cooking_guide(run, url))


@router.post("/agent/runs/{rid}/actions/{aid}/revise")
def revise_action(rid: str, aid: str, body: menu_actions.RevisionIn, db: Session = Depends(get_db),
                  user: User = Depends(get_current_user)):
    user_id = user.id
    query = db.query(AgentAction).filter_by(id=aid, run_id=rid, user_id=user_id)
    suggested = menu_actions.MenuEdits()
    if body.instructions.strip():
        action = query.first()
        if action is None:
            raise ApiError(404, "NOT_FOUND", "修改单不存在")
        menu_actions.checked_approval(db, action, body.shown_payload_hash)
        rows = menu_actions.revision_rows(db, action)
        recipes = [{"recipe_id": r.id, "菜名": r.title, "用时": r.cook_minutes,
                    "适用餐次": r.slots, "设备": r.equipment} for r in db.query(Recipe).order_by(Recipe.title).limit(180)]
        db.rollback()
        suggested = menu_actions.interpret_edits(body.instructions.strip(), rows, recipes)
    agent_engine.lock_sqlite_writes(db)
    run = db.query(AgentRun).filter_by(id=rid, user_id=user_id).with_for_update().first()
    action = query.with_for_update().first()
    if run is None or action is None:
        raise ApiError(404, "NOT_FOUND", "修改单不存在")
    if run.status != "waiting_approval":
        raise ApiError(409, "STALE_DRAFT", "这张修改单已处理，请打开最新一份")
    approval = menu_actions.checked_approval(db, action, body.shown_payload_hash)
    payload, summary = menu_actions.revised_proposal(db, user, action, body, suggested)
    new_action = agent_engine._create_action(db, run, action.action_type, payload, action.expected_version)
    action.status = approval.status = "superseded"
    approval.decided_at = datetime.now(timezone.utc)
    if action.action_type == "commit_plan":
        old_draft = db.get(PlanDraft, action.payload_json["draft_id"])
        old_draft.status = "superseded"
    event = {"action_id": new_action.id, "payload_hash": new_action.payload_hash, "summary": summary}
    _emit(db, run, "approval.required", event)
    data = _approval_event(db, rid, event)
    db.commit()
    return ok(data, status=201)


@router.post("/agent/runs/{rid}/cancel")
def cancel_run(rid: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    agent_engine.lock_sqlite_writes(db)
    run = db.query(AgentRun).filter(AgentRun.id == rid, AgentRun.user_id == user.id).with_for_update().first()
    if run is None:
        raise ApiError(404, "NOT_FOUND", "运行不存在")
    if run.status in ("completed", "failed", "cancelled"):
        return ok({"run_id": run.id, "status": run.status, "duplicated": True})
    run.status = "cancelled"
    run.finished_at = datetime.now(timezone.utc)
    _emit(db, run, "run.cancelled", {"run_id": run.id})
    db.commit()
    return ok({"run_id": run.id, "status": "cancelled"})


# ---- automation ----
@router.get("/automation/policies")
def get_policies(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    rows = db.query(AutomationPolicy).filter(AutomationPolicy.user_id == user.id).all()
    out = {r.task_kind: r.mode for r in rows}
    for k in ("weekly_report", "expiry", "habit_review"):
        out.setdefault(k, "off")
    return ok(out)


@router.put("/automation/policies")
def put_policies(body: PolicyIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    for kind, mode in (("weekly_report", body.weekly_report), ("expiry", body.expiry), ("habit_review", body.habit_review)):
        if mode is None:
            continue
        if mode not in ("off", "observe", "auto"):
            raise ApiError(422, "VALIDATION_ERROR", "mode 必须是 off|observe|auto")
        row = db.query(AutomationPolicy).filter(AutomationPolicy.user_id == user.id, AutomationPolicy.task_kind == kind).first()
        if row is None:
            row = AutomationPolicy(user_id=user.id, task_kind=kind, mode=mode)
            db.add(row)
        else:
            row.mode = mode
            row.policy_version += 1
    db.commit()
    return ok({"updated": True})


@router.get("/automation/tasks")
def list_tasks(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    rows = db.query(AgentTask).filter((AgentTask.user_id == user.id) | (AgentTask.user_id.is_(None))).all()
    return ok([{"id": t.id, "kind": t.kind, "name": t.name, "status": t.status, "next": t.next_run} for t in rows])


# ---- notifications ----
@router.get("/notifications")
def list_notifications(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    rows = db.query(Notification).filter(Notification.user_id == user.id).order_by(Notification.created_at.desc()).limit(50).all()
    return ok([{"id": n.id, "kind": n.kind, "text": n.text, "link": n.link, "read": bool(n.read),
                "at": n.created_at.isoformat() if n.created_at else None} for n in rows])


@router.post("/notifications/{nid}/read")
def read_notification(nid: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    n = db.query(Notification).filter(Notification.id == nid, Notification.user_id == user.id).first()
    if n is None:
        raise ApiError(404, "NOT_FOUND", "通知不存在")
    n.read = True
    db.commit()
    return ok({"id": n.id, "read": True})
