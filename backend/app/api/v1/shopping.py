"""Shopping: items + receive (PURCHASE_IN, idempotent) + recompute."""
from datetime import date

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.v1.serializers import batch_to_dict, shopping_to_dict
from app.application import services
from app.core.deps import get_current_user
from app.core.errors import ApiError, ok
from app.db import get_db
from app.models import MealPlan, PantryBatch, ShoppingItem, StockReceipt, User

router = APIRouter(prefix="/shopping", tags=["shopping"])


class ItemIn(BaseModel):
    food_id: str
    qty: float | None = None
    unit: str | None = None
    note: str | None = None
    status: str | None = None


class ItemPatch(BaseModel):
    qty: float | None = None
    unit: str | None = None
    status: str | None = None
    note: str | None = None


class ReceiveIn(BaseModel):
    qty: float | None = None
    expires_on: date | None = None
    location: str | None = None


@router.get("/items")
def list_items(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    rows = db.query(ShoppingItem).filter(ShoppingItem.user_id == user.id).order_by(ShoppingItem.created_at).all()
    return ok([shopping_to_dict(i) for i in rows])


@router.post("/items")
def create_item(body: ItemIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    from app.models import Food
    food = db.query(Food).filter(Food.id == body.food_id).first()
    if food is None:
        raise ApiError(404, "NOT_FOUND", "食物不存在")
    item = ShoppingItem(user_id=user.id, food_id=body.food_id, quantity=body.qty,
                        unit=body.unit or food.unit, origin="manual",
                        status=body.status or "confirmed", note=body.note)
    db.add(item)
    db.commit()
    return ok(shopping_to_dict(item), status=201)


@router.patch("/items/{iid}")
def patch_item(iid: str, body: ItemPatch, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    item = db.query(ShoppingItem).filter(ShoppingItem.id == iid, ShoppingItem.user_id == user.id).first()
    if item is None:
        raise ApiError(404, "NOT_FOUND", "购物项不存在")
    if body.qty is not None:
        item.quantity = body.qty
    if body.unit is not None:
        item.unit = body.unit
    if body.status is not None:
        if body.status not in ("proposed", "confirmed", "purchased", "received", "cancelled"):
            raise ApiError(422, "VALIDATION_ERROR", "状态不合法")
        item.status = body.status
    if body.note is not None:
        item.note = body.note
    item.version += 1
    db.commit()
    return ok(shopping_to_dict(item))


@router.delete("/items/{iid}")
def delete_item(iid: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    item = db.query(ShoppingItem).filter(ShoppingItem.id == iid, ShoppingItem.user_id == user.id).first()
    if item is None:
        raise ApiError(404, "NOT_FOUND", "购物项不存在")
    db.delete(item)
    db.commit()
    return ok({})


@router.post("/items/{iid}/receive")
def receive_item(iid: str, body: ReceiveIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    item = db.query(ShoppingItem).filter(ShoppingItem.id == iid, ShoppingItem.user_id == user.id).first()
    if item is None:
        raise ApiError(404, "NOT_FOUND", "购物项不存在")
    if item.status == "received":
        # idempotent: return the original batch
        receipt = db.query(StockReceipt).filter(StockReceipt.shopping_item_id == item.id).first()
        batch = db.query(PantryBatch).filter(PantryBatch.id == receipt.batch_id).first() if receipt and receipt.batch_id else None
        return ok({"item": shopping_to_dict(item), "duplicated": True, "batch": batch_to_dict(batch) if batch else None})
    qty = body.qty if body.qty is not None else item.quantity
    batch = services.add_batch(db, user, item.food_id, qty, item.unit, body.expires_on,
                               body.location or "fridge", kind="PURCHASE_IN",
                               source_type="stock_receipt", source_id=f"rc_{item.id}")
    item.status = "received"
    item.version += 1
    db.add(StockReceipt(user_id=user.id, shopping_item_id=item.id, batch_id=batch.id, quantity=qty))
    db.commit()
    return ok({"item": shopping_to_dict(item), "batch": batch_to_dict(batch), "duplicated": False})


@router.post("/recompute")
def recompute(body: dict | None = None, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    plan_id = (body or {}).get("plan_id")
    plan = None
    if plan_id:
        plan = db.query(MealPlan).filter(MealPlan.id == plan_id, MealPlan.user_id == user.id).first()
        if plan is None:
            raise ApiError(404, "NOT_FOUND", "计划不存在")
    else:
        plan = db.query(MealPlan).filter(MealPlan.user_id == user.id).order_by(MealPlan.created_at.desc()).first()
    if plan is None:
        return ok({"items": []})
    services.recompute_shopping(db, user, plan)
    db.commit()
    rows = db.query(ShoppingItem).filter(ShoppingItem.user_id == user.id, ShoppingItem.origin == "plan").all()
    return ok({"items": [shopping_to_dict(i) for i in rows]})
