"""Plans: drafts (deterministic), commit, replace-meal, restore-version."""
from datetime import date, timedelta

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.application import services
from app.core.deps import get_current_user
from app.core.errors import ApiError, ok
from app.db import get_db
from app.models import MealPlan, PlanDraft, User

router = APIRouter(prefix="/plans", tags=["plans"])


class DraftIn(BaseModel):
    period_start: date
    days: int = 7
    meal_slots: list[str] = ["breakfast", "lunch", "dinner"]
    constraints: dict | None = None
    use_pantry: bool = True


class CommitIn(BaseModel):
    draft_id: str
    expected_version: int | None = None


class ReplaceIn(BaseModel):
    expected_version: int | None = None
    target: dict
    replacement: dict


class RestoreIn(BaseModel):
    version: int


def _get_plan(db, pid, user_id):
    plan = db.query(MealPlan).filter(MealPlan.id == pid, MealPlan.user_id == user_id).first()
    if plan is None:
        raise ApiError(404, "NOT_FOUND", "计划不存在")
    return plan


@router.post("/drafts")
def create_draft(body: DraftIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    if body.days not in (1, 3, 7):
        raise ApiError(422, "VALIDATION_ERROR", "days 必须是 1|3|7")
    plan = db.query(MealPlan).filter(MealPlan.user_id == user.id).order_by(MealPlan.created_at.desc()).first()
    data = services.generate_draft(db, user, body.period_start, body.days, body.meal_slots, body.constraints)
    draft = PlanDraft(user_id=user.id, plan_id=plan.id if plan else None,
                      based_on_version=plan.active_version if plan else None,
                      content_json=data["meals"], shopping_projection=data["shopping_projection"],
                      hard_violations=data["hard_violations"],
                      nutrition_completeness=data["nutrition_completeness"])
    db.add(draft)
    db.commit()
    return ok({"draft_id": draft.id, "meals": data["meals"],
               "shopping_projection": data["shopping_projection"],
               "hard_violations": data["hard_violations"],
               "nutrition_completeness": data["nutrition_completeness"]}, status=201)


@router.get("")
def list_plans(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    plans = db.query(MealPlan).filter(MealPlan.user_id == user.id).order_by(MealPlan.created_at.desc()).all()
    return ok([services.plan_to_dict(db, p) for p in plans])


@router.post("")
def create_plan(body: dict, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    start = date.fromisoformat(body["period_start"]) if body.get("period_start") else services.today()
    days = body.get("days", 7)
    plan = MealPlan(user_id=user.id, title=body.get("title", "本周菜单"),
                    period_start=start, period_end=start + timedelta(days=days - 1))
    db.add(plan)
    db.commit()
    return ok(services.plan_to_dict(db, plan), status=201)


@router.get("/{pid}")
def get_plan(pid: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    return ok(services.plan_to_dict(db, _get_plan(db, pid, user.id)))


@router.post("/{pid}/commit")
def commit_plan(pid: str, body: CommitIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    plan = _get_plan(db, pid, user.id)
    draft = db.query(PlanDraft).filter(PlanDraft.id == body.draft_id, PlanDraft.user_id == user.id).first()
    if draft is None:
        raise ApiError(404, "NOT_FOUND", "草稿不存在")
    version = services.commit_plan_version(db, user, plan, draft.content_json, "草稿提交", by="user",
                                           expected_version=body.expected_version)
    draft.status = "committed"
    db.commit()
    return ok({"plan_id": plan.id, "active_version": version.version})


@router.post("/{pid}/replace-meal")
def replace_meal(pid: str, body: ReplaceIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    plan = _get_plan(db, pid, user.id)
    if body.expected_version is not None and body.expected_version != plan.active_version:
        raise ApiError(409, "CONFLICT", "计划版本冲突，请刷新后重试",
                       {"expected": body.expected_version, "current": plan.active_version})
    meals = services.active_meals(db, plan)
    key = f"{body.target['local_date']}|{body.target['slot']}"
    old = meals.get(key)
    meals[key] = {"recipe_id": body.replacement["recipe_id"],
                  "servings": body.replacement.get("servings", old.get("servings", 2) if old else 2)}
    version = services.commit_plan_version(db, user, plan, meals,
                                           f"替换 {body.target['local_date']} {body.target['slot']}",
                                           by="user", expected_version=body.expected_version)
    db.commit()
    return ok({"plan_id": plan.id, "active_version": version.version})


@router.post("/{pid}/restore-version")
def restore_version(pid: str, body: RestoreIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    plan = _get_plan(db, pid, user.id)
    from app.models import MealPlanVersion, PlannedMeal
    ver = db.query(MealPlanVersion).filter(MealPlanVersion.plan_id == plan.id, MealPlanVersion.version == body.version).first()
    if ver is None:
        raise ApiError(404, "NOT_FOUND", "版本不存在")
    pms = db.query(PlannedMeal).filter(PlannedMeal.plan_version_id == ver.id).all()
    meals = {f"{pm.local_date.isoformat()}|{pm.slot}": {"recipe_id": pm.recipe_id, "servings": float(pm.servings)} for pm in pms}
    version = services.commit_plan_version(db, user, plan, meals,
                                           f"恢复 v{body.version} 的内容（生成新版本，不回滚已发生的购买/消耗/记餐）",
                                           by="user")
    db.commit()
    return ok({"plan_id": plan.id, "active_version": version.version})
