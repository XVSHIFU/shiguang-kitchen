"""Scoped changes to menu proposals and recipe follow-up actions."""
import json
import re
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError
from sqlalchemy.orm import Session

from app.agents import llm
from app.application import services
from app.core.errors import ApiError
from app.core.security import payload_hash
from app.models import AgentAction, Approval, Food, MealPlan, PlanDraft, Recipe, User

MealSlot = Literal["breakfast", "lunch", "dinner", "snack"]
SLOTS = {"breakfast": "早餐", "lunch": "午餐", "dinner": "晚餐", "snack": "加餐"}


class MealEdit(BaseModel):
    model_config = ConfigDict(extra="forbid")

    local_date: date
    slot: MealSlot
    recipe_id: str = Field(min_length=1, max_length=64)
    servings: Decimal = Field(gt=0, le=24, decimal_places=2)


class RecipeActionIn(BaseModel):
    kind: Literal["menu", "shopping"]
    recipe_id: str = Field(min_length=1, max_length=64)
    local_date: date
    slot: MealSlot
    servings: Decimal = Field(gt=0, le=24, decimal_places=2)


class MenuEdits(BaseModel):
    model_config = ConfigDict(extra="forbid")

    edits: list[MealEdit] = Field(default_factory=list, max_length=56)
    days: int | None = Field(default=None, ge=1, le=14)


class RevisionIn(MenuEdits):
    shown_payload_hash: str = Field(min_length=1, max_length=128)
    instructions: str = Field(default="", max_length=600)


def plan_days(message: str) -> int | None:
    count = re.search(r"(?<!\d)(1[0-4]|[1-9]|[一二两三四五六七八九十])\s*(?:日|天)(?:的)?(?:菜|食谱|餐)", message)
    if count is None:
        return None
    raw = count[1]
    return int(raw) if raw.isascii() else "一二三四五六七八九十".index(raw.replace("两", "二")) + 1


def active_plan_for(db: Session, user_id: str, start: date, end: date):
    return (db.query(MealPlan).filter(MealPlan.user_id == user_id, MealPlan.active_version > 0,
                                     MealPlan.period_start <= start, MealPlan.period_end >= end)
            .order_by(MealPlan.created_at.desc()).first())


def allowed_recipe(db: Session, user_id: str, recipe_id: str) -> Recipe:
    recipe = db.get(Recipe, recipe_id)
    if recipe is None:
        raise ApiError(404, "NOT_FOUND", "菜谱不存在")
    blocked = services.recipe_blocked(db, user_id, recipe)
    if blocked:
        raise ApiError(422, "ALLERGY_BLOCKED", f"{recipe.title} 含忌口食材 {blocked[0]['food']}")
    return recipe


def draft_payload(db: Session, user: User, plan: MealPlan | None, start: date, days: int,
                  meals: dict, *, patch_only: bool = True, generated: dict | None = None) -> dict:
    if generated is None:
        projection = services.compute_gap_for_meals(db, user, meals, start, days)
        completeness = "full" if all(
            services.nutrition_of_food_items(db, services.recipe_food_items(
                db, db.get(Recipe, meal["recipe_id"]), meal["servings"]))["completeness"] == "full"
            for meal in meals.values()
        ) else "partial"
        violations = []
    else:
        projection = generated["shopping_projection"]
        completeness = generated["nutrition_completeness"]
        violations = generated["hard_violations"]
    draft = PlanDraft(user_id=user.id, plan_id=plan.id if plan else None,
                      based_on_version=plan.active_version if plan else None, content_json=meals,
                      shopping_projection=projection, hard_violations=violations, nutrition_completeness=completeness)
    db.add(draft)
    db.flush()
    return {"draft_id": draft.id, "plan_id": draft.plan_id, "period_start": start.isoformat(),
            "days": days, "patch_only": patch_only, "draft_hash": payload_hash(meals)}


def recipe_proposal(db: Session, user: User, body: RecipeActionIn):
    recipe = allowed_recipe(db, user.id, body.recipe_id)
    day = services.today() if body.kind == "shopping" else body.local_date
    meal = {"recipe_id": recipe.id, "servings": float(body.servings)}
    key = f"{day.isoformat()}|{body.slot}"
    if body.kind == "shopping":
        gaps = services.compute_gap_for_meals(db, user, {key: meal}, day, 1, ignore_recorded=True)
        items = [{"food_id": gap["food_id"], "name": db.get(Food, gap["food_id"]).name,
                  "qty": gap["gap"], "unit": gap["unit"]} for gap in gaps]
        if not items:
            return None, {}, None, f"{recipe.title} 所需食材已经有了，或采购清单上已有足量。"
        summary = f"为 {recipe.title}（{body.servings:g} 份）准备食材"
        return "propose_shopping", {"recipe_id": recipe.id, "items": items}, None, summary
    plan = active_plan_for(db, user.id, day, day)
    summary = f"{day.isoformat()} {SLOTS[body.slot]}安排 {recipe.title}（{body.servings:g} 份）"
    if plan is None:
        return "commit_plan", draft_payload(db, user, None, day, 1, {key: meal}), None, summary
    old = services.active_meals(db, plan).get(key)
    previous = db.get(Recipe, old["recipe_id"]) if old else None
    payload = {"plan_id": plan.id, "target": {"local_date": day.isoformat(), "slot": body.slot},
               "replacement": meal, "old_recipe_id": previous.id if previous else None,
               "old_recipe_title": previous.title if previous else "", "new_recipe_title": recipe.title}
    return "replace_meal", payload, plan.active_version, summary


def revision_rows(db: Session, action: AgentAction) -> dict:
    payload = action.payload_json
    if action.action_type == "replace_meal":
        t = payload["target"]
        return {f"{t['local_date']}|{t['slot']}": payload["replacement"]}
    if action.action_type != "commit_plan":
        raise ApiError(422, "UNSUPPORTED_ACTION", "只有菜单修改单可以调整")
    draft = db.query(PlanDraft).filter_by(id=payload["draft_id"], user_id=action.user_id).first()
    if draft is None or draft.status != "draft":
        raise ApiError(409, "STALE_DRAFT", "这份菜单草稿已经失效")
    if payload.get("draft_hash") and payload["draft_hash"] != payload_hash(draft.content_json):
        raise ApiError(409, "STALE_DRAFT", "菜单草稿已变化，请重新查看")
    return draft.content_json


def checked_approval(db: Session, action: AgentAction, shown_hash: str) -> Approval:
    if action.status != "waiting_approval":
        raise ApiError(409, "STALE_DRAFT", "这张修改单已处理，请打开最新一份")
    if action.payload_hash != shown_hash or payload_hash(action.payload_json) != shown_hash:
        raise ApiError(409, "HASH_MISMATCH", "展示内容已变化，请刷新后重试")
    approval = db.query(Approval).filter_by(user_id=action.user_id, action_id=action.id).first()
    if (approval is None or approval.status != "pending" or
            approval.expires_at and approval.expires_at.replace(tzinfo=timezone.utc) <= datetime.now(timezone.utc)):
        raise ApiError(409, "APPROVAL_EXPIRED", "这张修改单已失效，请重新发起")
    return approval


def interpret_edits(instructions: str, rows: dict, recipes: list[dict]) -> MenuEdits:
    if not llm.provider_available():
        raise ApiError(503, "MODEL_UNAVAILABLE", "目前无法理解文字要求，可以直接修改餐次")
    try:
        response = llm.chat_complete([
            {"role": "system", "content": (
                '将用户对菜单草稿的要求翻译为 JSON：{"edits":[{"local_date":"YYYY-MM-DD",'
                '"slot":"dinner","recipe_id":"...","servings":2}],"days":null}。'
                "餐次只能选现有 key，菜只能选给出的 recipe_id，份数必须为 0.01 到 24。"
                "只返回确实需要修改的餐次。用户想减少总天数时可传 days，否则为空。"
                "不要自行决定模糊的目标，无法满足时返回空 edits 与 null days。")},
            {"role": "user", "content": json.dumps({"要求": instructions, "已有餐次": rows,
                                                     "可用菜谱": recipes}, ensure_ascii=False)},
        ], temperature=0, timeout=12, max_tokens=2400, thinking=False, json_output=True)
        return MenuEdits.model_validate_json(response["text"])
    except ValidationError:
        raise ApiError(422, "INVALID_REVISION", "没能确定怎么改，试试说清日期、餐次或菜名") from None
    except Exception:
        raise ApiError(503, "MODEL_UNAVAILABLE", "暂时无法处理文字要求，可以直接修改餐次") from None


def revised_proposal(db: Session, user: User, action: AgentAction, manual: MenuEdits, suggested: MenuEdits):
    original = revision_rows(db, action)
    payload = action.payload_json
    plan = None
    if payload.get("plan_id"):
        plan = (db.query(MealPlan).filter_by(id=payload["plan_id"], user_id=user.id)
                .with_for_update().first())
        if plan is None or plan.active_version != action.expected_version:
            raise ApiError(409, "STALE_DRAFT", "生效菜单已有更新，请重新发起修改")
    meals = original.copy()
    for change in [*suggested.edits, *manual.edits]:
        key = f"{change.local_date.isoformat()}|{change.slot}"
        if key not in original:
            raise ApiError(422, "OUTSIDE_SCOPE", "请选择这份草稿里已有的日期与餐次")
        recipe = allowed_recipe(db, user.id, change.recipe_id)
        meals[key] = {"recipe_id": recipe.id, "servings": float(change.servings)}
    days = manual.days or suggested.days
    if action.action_type == "replace_meal":
        if days:
            raise ApiError(422, "OUTSIDE_SCOPE", "这张修改单只调整一餐")
        if original == meals:
            raise ApiError(422, "NO_CHANGES", "没有找到要改的内容，可以直接调整菜名或份数")
        meal = next(iter(meals.values()))
        title = db.get(Recipe, meal["recipe_id"]).title
        target = payload["target"]
        return {**payload, "replacement": meal, "new_recipe_title": title, "reason": "按你的要求调整"}, (
            f"{target['local_date']} {SLOTS[target['slot']]}改为 {title}（{meal['servings']:g} 份）")
    start = date.fromisoformat(payload["period_start"])
    previous_days = payload.get("days", 7)
    if days and days > previous_days:
        raise ApiError(422, "OUTSIDE_SCOPE", "这份草稿的日期无法延长，可以另发一份菜单")
    if days and days < previous_days:
        end = (start + timedelta(days=days)).isoformat()
        meals = {key: meal for key, meal in meals.items() if key.split("|")[0] < end}
    days = days or previous_days
    if not meals or (meals == original and days == previous_days):
        raise ApiError(422, "NO_CHANGES", "没有找到要改的内容，可以直接调整菜名或份数")
    updated = draft_payload(db, user, plan, start, days, meals,
                            patch_only=bool(payload.get("patch_only") or days != previous_days))
    return updated, f"已调整 {days} 日菜单草稿（{len(meals)} 餐）"
