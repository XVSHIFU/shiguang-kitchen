"""Meals + nutrition estimate. Recording a meal does NOT consume pantry
stock unless consume_from_pantry=true (same transaction then)."""
from datetime import date

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.application import services
from app.core.deps import get_current_user
from app.core.errors import ApiError, ok
from app.db import get_db
from app.models import MealItem, MealRecord, NutritionSnapshot, User

router = APIRouter(tags=["meals", "nutrition"])


class MealItemIn(BaseModel):
    food_id: str | None = None
    recipe_id: str | None = None
    amount: float | None = None
    servings: float | None = None
    unit: str | None = None


class MealIn(BaseModel):
    date: date
    slot: str
    items: list[MealItemIn]
    note: str | None = ""
    consume_from_pantry: bool = False
    planned: bool = False
    source: str = "manual"


def _meal_dict(db, rec: MealRecord) -> dict:
    items = db.query(MealItem).filter(MealItem.meal_record_id == rec.id).all()
    snaps = {s.nutrient_code: str(s.amount) for s in db.query(NutritionSnapshot).filter(NutritionSnapshot.meal_record_id == rec.id).all()}
    completeness = "full"
    snap0 = db.query(NutritionSnapshot).filter(NutritionSnapshot.meal_record_id == rec.id).first()
    if snap0:
        completeness = snap0.completeness
    return {
        "id": rec.id, "date": rec.local_date.isoformat(), "slot": rec.slot,
        "title": rec.title, "source": rec.source, "planned": bool(rec.planned),
        "note": rec.note, "version": rec.version,
        "items": [{"food_id": i.food_id, "recipe_id": i.recipe_id, "amount": str(i.amount), "unit": i.unit} for i in items],
        "nutrition": {"kcal": snaps.get("kcal", "0"), "protein": snaps.get("protein", "0"),
                      "fat": snaps.get("fat", "0"), "carbs": snaps.get("carbs", "0"),
                      "completeness": completeness, "unknown_items": []},
    }


@router.get("/meals")
def list_meals(date_from: date | None = None, date_to: date | None = None,
               db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    q = db.query(MealRecord).filter(MealRecord.user_id == user.id)
    if date_from:
        q = q.filter(MealRecord.local_date >= date_from)
    if date_to:
        q = q.filter(MealRecord.local_date <= date_to)
    rows = q.order_by(MealRecord.local_date.desc(), MealRecord.created_at.desc()).limit(200).all()
    return ok([_meal_dict(db, r) for r in rows])


@router.post("/meals")
def create_meal(body: MealIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    if body.slot not in ("breakfast", "lunch", "dinner", "snack"):
        raise ApiError(422, "VALIDATION_ERROR", "slot 不合法")
    if not body.items:
        raise ApiError(422, "VALIDATION_ERROR", "至少需要一项食物或菜谱")
    items = []
    for it in body.items:
        if it.recipe_id:
            items.append({"recipe_id": it.recipe_id, "servings": it.servings or it.amount or 1})
        elif it.food_id:
            if it.amount is None:
                raise ApiError(422, "VALIDATION_ERROR", "食物项需要 amount")
            items.append({"food_id": it.food_id, "amount": it.amount, "unit": it.unit})
        else:
            raise ApiError(422, "VALIDATION_ERROR", "每项需要 food_id 或 recipe_id")
    rec = services.create_meal_record(db, user, body.date, body.slot, items,
                                      source=body.source, planned=body.planned,
                                      note=body.note or "", consume_pantry=body.consume_from_pantry)
    db.commit()
    return ok(_meal_dict(db, rec), status=201)


@router.get("/meals/{mid}")
def get_meal(mid: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    rec = db.query(MealRecord).filter(MealRecord.id == mid, MealRecord.user_id == user.id).first()
    if rec is None:
        raise ApiError(404, "NOT_FOUND", "记餐不存在")
    return ok(_meal_dict(db, rec))


@router.delete("/meals/{mid}")
def delete_meal(mid: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    rec = db.query(MealRecord).filter(MealRecord.id == mid, MealRecord.user_id == user.id).first()
    if rec is None:
        raise ApiError(404, "NOT_FOUND", "记餐不存在")
    db.query(MealItem).filter(MealItem.meal_record_id == rec.id).delete()
    db.query(NutritionSnapshot).filter(NutritionSnapshot.meal_record_id == rec.id).delete()
    services.mark_reports_stale(db, user, rec.local_date)
    db.delete(rec)
    db.commit()
    return ok({})


@router.post("/nutrition/estimate")
def estimate(body: dict, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    items = body.get("items") or []
    if not items:
        raise ApiError(422, "VALIDATION_ERROR", "items 不能为空")
    norm = []
    for it in items:
        if it.get("recipe_id"):
            norm.append({"recipe_id": it["recipe_id"], "servings": it.get("servings") or it.get("amount") or 1})
        else:
            norm.append({"food_id": it["food_id"], "amount": it["amount"], "unit": it.get("unit")})
    result = services.nutrition_of_meal_items(db, norm)
    return ok(result)
