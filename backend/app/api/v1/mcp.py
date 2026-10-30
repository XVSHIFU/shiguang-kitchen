"""MCP server mounted inside FastAPI (Streamable HTTP simplified:
JSON-RPC over HTTP, tools/list + tools/call).

Auth: Bearer PAT from mcp_credentials (token hash, revocable, scope-checked).
Read tools are read-only; propose_* tools only create drafts/proposals —
they never write business facts directly. Cross-user access -> FORBIDDEN.
"""
import json
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Header, Request
from sqlalchemy.orm import Session

from app.api.v1.serializers import batch_to_dict, recipe_to_dict, shopping_to_dict
from app.application import services
from app.core.errors import ApiError, ok
from app.core.security import token_hash
from app.db import get_db
from app.models import Food, McpCredential, MealPlan, PantryBatch, PlanDraft, Recipe, ShoppingItem, User
from app.rag.bm25 import search_knowledge

router = APIRouter(tags=["mcp"])

TOOLS = [
    {"name": "get_my_pantry", "description": "只读：查询本人的库存批次", "scopes": ["pantry:read"]},
    {"name": "search_my_recipes", "description": "只读：搜索菜谱", "scopes": ["recipes:read"]},
    {"name": "get_my_meal_plan", "description": "只读：查询本人当前生效计划", "scopes": ["plan:read"]},
    {"name": "search_food_knowledge", "description": "只读：BM25 检索食物知识", "scopes": ["knowledge:read"]},
    {"name": "propose_shopping_items", "description": "只建采购提议（proposed），不直接入库", "scopes": ["shopping:propose"]},
    {"name": "request_plan_change", "description": "只建计划变更草稿，需用户审批后才生效", "scopes": ["plan:propose"]},
]


def _auth_mcp(authorization: str | None, db: Session) -> tuple[User, McpCredential]:
    if not authorization or not authorization.startswith("Bearer "):
        raise ApiError(401, "UNAUTHORIZED", "缺少 MCP Bearer 凭证")
    cred = db.query(McpCredential).filter(McpCredential.token_hash == token_hash(authorization[7:])).first()
    if cred is None or cred.revoked_at is not None:
        raise ApiError(401, "UNAUTHORIZED", "MCP 凭证无效或已撤销")
    user = db.query(User).filter(User.id == cred.user_id).first()
    if user is None or user.status != "active":
        raise ApiError(401, "UNAUTHORIZED", "用户不存在或已删除")
    cred.last_used_at = datetime.now(timezone.utc)
    db.flush()
    return user, cred


def _require_scope(cred: McpCredential, scope: str):
    if scope not in (cred.scope or []):
        raise ApiError(403, "FORBIDDEN", f"凭证缺少 scope: {scope}")


def _rpc_result(rpc_id, result):
    return {"jsonrpc": "2.0", "id": rpc_id, "result": result}


def _rpc_error(rpc_id, code, message):
    return {"jsonrpc": "2.0", "id": rpc_id, "error": {"code": code, "message": message}}


def _text(payload) -> dict:
    return {"content": [{"type": "text", "text": json.dumps(payload, ensure_ascii=False)}]}


@router.post("/mcp")
async def mcp_post(request: Request, authorization: str | None = Header(default=None),
                   db: Session = Depends(get_db)):
    user, cred = _auth_mcp(authorization, db)
    try:
        body = await request.json()
    except Exception:
        raise ApiError(400, "VALIDATION_ERROR", "请求体必须是 JSON")
    method = body.get("method")
    rpc_id = body.get("id")
    params = body.get("params") or {}
    if method == "initialize":
        return _rpc_result(rpc_id, {"protocolVersion": "2024-11-05", "capabilities": {"tools": {}},
                                      "serverInfo": {"name": "ai-life-agent-mcp", "version": "0.1.0"}})
    if method == "ping":
        return _rpc_result(rpc_id, {})
    if method == "tools/list":
        return _rpc_result(rpc_id, {"tools": [{"name": t["name"], "description": t["description"],
                                               "inputSchema": {"type": "object", "properties": {}}} for t in TOOLS]})
    if method != "tools/call":
        return _rpc_error(rpc_id, -32601, f"未知方法 {method}")
    name = params.get("name")
    args = params.get("arguments") or {}
    tool = next((t for t in TOOLS if t["name"] == name), None)
    if tool is None:
        return _rpc_error(rpc_id, -32602, f"未知工具 {name}")
    _require_scope(cred, tool["scopes"][0])
    if name == "get_my_pantry":
        rows = db.query(PantryBatch).filter(PantryBatch.user_id == user.id).all()
        return _rpc_result(rpc_id, _text([batch_to_dict(b) for b in rows]))
    if name == "search_my_recipes":
        rows = db.query(Recipe).all()
        q = args.get("q") or ""
        slot = args.get("slot")
        out = [recipe_to_dict(db, r, user.id) for r in rows
               if (not q or q in r.title) and (not slot or slot in (r.slots or []))]
        return _rpc_result(rpc_id, _text(out))
    if name == "get_my_meal_plan":
        plan = db.query(MealPlan).filter(MealPlan.user_id == user.id).order_by(MealPlan.created_at.desc()).first()
        return _rpc_result(rpc_id, _text(services.plan_to_dict(db, plan) if plan else {}))
    if name == "search_food_knowledge":
        return _rpc_result(rpc_id, _text(search_knowledge(db, args.get("q", ""), user.id)))
    if name == "propose_shopping_items":
        created = []
        for it in args.get("items", []):
            food = db.query(Food).filter(Food.id == it["food_id"]).first()
            if food is None:
                continue
            item = ShoppingItem(user_id=user.id, food_id=food.id, quantity=it.get("qty"),
                                unit=it.get("unit", food.unit), origin="manual",
                                status="proposed", note="MCP 提议")
            db.add(item)
            db.flush()
            created.append(shopping_to_dict(item))
        db.commit()
        return _rpc_result(rpc_id, _text({"created": created, "note": "仅为提议，需用户确认后才采购"}))
    if name == "request_plan_change":
        plan = db.query(MealPlan).filter(MealPlan.user_id == user.id).order_by(MealPlan.created_at.desc()).first()
        if plan is None:
            return _rpc_error(rpc_id, -32602, "当前无计划")
        meals = services.active_meals(db, plan)
        t = args["target"]
        meals[f"{t['local_date']}|{t['slot']}"] = {"recipe_id": args["replacement_recipe_id"], "servings": 2}
        draft = PlanDraft(user_id=user.id, plan_id=plan.id, based_on_version=plan.active_version,
                          content_json=meals, status="draft")
        db.add(draft)
        db.commit()
        return _rpc_result(rpc_id, _text({"draft_id": draft.id, "note": "仅为草稿，需用户审批提交后才生效"}))
    return _rpc_error(rpc_id, -32602, f"未实现工具 {name}")


@router.get("/mcp")
def mcp_info():
    return ok({"name": "ai-life-agent-mcp", "protocol": "json-rpc-over-http",
               "tools": [t["name"] for t in TOOLS]})
