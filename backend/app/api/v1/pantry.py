"""Pantry: batches, movements, consumptions (FEFO + idempotent), adjustments."""
from datetime import date
from decimal import Decimal

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.v1.serializers import batch_to_dict, num
from app.application import services
from app.core.deps import get_current_user
from app.core.errors import ApiError, ok
from app.db import get_db
from app.models import Food, PantryBatch, PantryMovement, User
from app.tasks import notify_expiring

router = APIRouter(prefix="/pantry", tags=["pantry"])


class BatchIn(BaseModel):
    food_id: str
    qty: float | None = None
    unit: str | None = None
    expires_on: date | None = None
    location: str | None = "fridge"
    purchased_on: date | None = None


class ConsumptionIn(BaseModel):
    batch_id: str | None = None
    food_id: str | None = None
    amount: float
    unit: str | None = None
    reason: str | None = None
    source_type: str = "manual"
    source_id: str | None = None
    idempotency_key: str | None = None


class AdjustmentIn(BaseModel):
    batch_id: str
    delta: float
    reason: str


@router.get("/expiring")
def list_expiring(days: int = 3, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """Batches expiring within `days` days, by days_left ascending.

    Side effect: calling this endpoint also writes deduped expiry
    notifications (one per user/batch/day, see tasks.notify_expiring);
    policy off suppresses the notifications, not the listing.
    """
    if days < 0 or days > 365:
        raise ApiError(422, "VALIDATION_ERROR", "days 须在 0~365 之间")
    return ok(notify_expiring(db, user, days))


@router.get("/batches")
def list_batches(food_id: str | None = None, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    q = db.query(PantryBatch).filter(PantryBatch.user_id == user.id)
    if food_id:
        q = q.filter(PantryBatch.food_id == food_id)
    rows = q.order_by(PantryBatch.expires_on).all()
    out = []
    for b in rows:
        d = batch_to_dict(b)
        f = db.query(Food).filter(Food.id == b.food_id).first()
        d["food_name"] = f.name if f else b.food_id
        out.append(d)
    return ok(out)


@router.post("/batches")
def create_batch(body: BatchIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    if body.qty is not None and body.qty < 0:
        raise ApiError(422, "VALIDATION_ERROR", "数量不能为负")
    batch = services.add_batch(db, user, body.food_id, body.qty, body.unit,
                               body.expires_on, body.location or "fridge")
    db.commit()
    return ok(batch_to_dict(batch), status=201)


@router.get("/batches/{bid}")
def get_batch(bid: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    b = db.query(PantryBatch).filter(PantryBatch.id == bid, PantryBatch.user_id == user.id).first()
    if b is None:
        raise ApiError(404, "NOT_FOUND", "批次不存在")
    return ok(batch_to_dict(b))


@router.get("/movements")
def list_movements(batch_id: str | None = None, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    q = db.query(PantryMovement).filter(PantryMovement.user_id == user.id)
    if batch_id:
        q = q.filter(PantryMovement.batch_id == batch_id)
    rows = q.order_by(PantryMovement.created_at.desc()).limit(200).all()
    return ok([{"id": m.id, "batch_id": m.batch_id, "food_id": m.food_id,
                "delta": num(m.delta), "kind": m.kind, "reason": m.reason,
                "source_type": m.source_type, "source_id": m.source_id,
                "at": m.created_at.isoformat() if m.created_at else None} for m in rows])


@router.post("/consumptions")
def consume(body: ConsumptionIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    if body.batch_id:
        batch = db.query(PantryBatch).filter(PantryBatch.id == body.batch_id, PantryBatch.user_id == user.id).first()
        if batch is None:
            raise ApiError(404, "NOT_FOUND", "批次不存在")
        food_id = batch.food_id
    elif body.food_id:
        food_id = body.food_id
    else:
        raise ApiError(422, "VALIDATION_ERROR", "需要 batch_id 或 food_id")
    import uuid
    result = services.consume_from_pantry(
        db, user, food_id, body.amount, body.unit, body.reason or "手动消耗",
        body.source_type, body.source_id or f"manual-{uuid.uuid4().hex[:12]}",
        idempotency_key=body.idempotency_key, batch_id=body.batch_id)
    db.commit()
    return ok(result)


@router.post("/adjustments")
def adjust(body: AdjustmentIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    batch = db.query(PantryBatch).filter(PantryBatch.id == body.batch_id, PantryBatch.user_id == user.id).first()
    if batch is None:
        raise ApiError(404, "NOT_FOUND", "批次不存在")
    if not body.reason:
        raise ApiError(422, "VALIDATION_ERROR", "盘点调整必须填写理由")
    if batch.quantity_status == "unknown":
        # establish a quantifiable baseline first (MVP setBatchKnown semantics)
        batch.quantity_status = "known"
        batch.original_amount = Decimal("0")
        batch.remaining_amount = Decimal("0")
    new_remaining = Decimal(str(batch.remaining_amount)) + Decimal(str(body.delta))
    if new_remaining < 0:
        raise ApiError(422, "INSUFFICIENT_STOCK", f"库存不足：剩余 {batch.remaining_amount}")
    batch.remaining_amount = new_remaining
    batch.version += 1
    services._add_movement(db, user.id, batch, Decimal(str(body.delta)), "ADJUST", body.reason,
                           "adjustment", f"adj-{batch.id}-{batch.version}", None)
    db.commit()
    return ok(batch_to_dict(batch))
