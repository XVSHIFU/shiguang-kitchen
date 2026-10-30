"""Application services: nutrition, allergy, pantry, plan, shopping, meals, reports.

Routers are thin wrappers; all business rules live here. Decimal math
throughout; missing data is reported as unknown, never fabricated.
"""
import hashlib
import json
import math
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, ROUND_HALF_UP

from sqlalchemy.orm import Session

from app.core.errors import ApiError
from app.models import (
    Food,
    HabitRecord,
    IdempotencyRecord,
    MealItem,
    MealPlan,
    MealPlanVersion,
    MealRecord,
    Notification,
    NutritionSnapshot,
    PantryBatch,
    PantryMovement,
    PlannedMeal,
    PlanDraft,
    Recipe,
    RecipeIngredient,
    Report,
    ReportMetric,
    ShoppingItem,
    StockReceipt,
    User,
    UserProfile,
)

Q1 = Decimal("0.1")
NUTRIENTS = ["kcal", "protein", "fat", "carbs"]


def D(v) -> Decimal:
    return Decimal(str(v))


def q1(v: Decimal) -> Decimal:
    return D(v).quantize(Q1, rounding=ROUND_HALF_UP)


def dec_str(v) -> str:
    return str(q1(D(v)))


def today() -> date:
    return datetime.now(timezone.utc).date()


# ---------------------------------------------------------------- nutrition
def to_grams(food: Food, amount, unit: str) -> Decimal | None:
    """Convert an amount in `unit` to grams. None = cannot convert."""
    amt = D(amount)
    if unit == "g":
        return amt
    if unit == "ml":
        return amt * D(food.density_g_ml) if food.density_g_ml is not None else None
    if unit == "piece":
        return amt * D(food.piece_g) if food.piece_g is not None else None
    return None


def grams_to_base(food: Food, grams: Decimal) -> Decimal | None:
    if food.unit == "g":
        return grams
    if food.unit == "ml":
        return grams / D(food.density_g_ml) if food.density_g_ml is not None else None
    if food.unit == "piece":
        return grams / D(food.piece_g) if food.piece_g is not None else None
    return None


def nutrition_of_food_items(db: Session, items: list[dict]) -> dict:
    """items: [{food_id, amount, unit}]. Returns Decimal totals as strings."""
    totals = {n: Decimal("0") for n in NUTRIENTS}
    unknown: list[str] = []
    for it in items:
        food = db.query(Food).filter(Food.id == it["food_id"]).first()
        if food is None:
            unknown.append(str(it["food_id"]))
            continue
        grams = to_grams(food, it["amount"], it.get("unit") or food.unit)
        if food.nutrients is None or grams is None:
            unknown.append(food.name)
            continue
        for i, n in enumerate(NUTRIENTS):
            totals[n] += grams / Decimal("100") * D(food.nutrients[i])
    if unknown:
        completeness = "partial" if any(totals[n] > 0 for n in NUTRIENTS) else "unknown"
    else:
        completeness = "full"
    return {
        "kcal": dec_str(totals["kcal"]),
        "protein": dec_str(totals["protein"]),
        "fat": dec_str(totals["fat"]),
        "carbs": dec_str(totals["carbs"]),
        "completeness": completeness,
        "unknown_items": unknown,
    }


def recipe_food_items(db: Session, recipe: Recipe, servings) -> list[dict]:
    ings = (
        db.query(RecipeIngredient)
        .filter(RecipeIngredient.recipe_id == recipe.id)
        .order_by(RecipeIngredient.id)
        .all()
    )
    scale = D(servings) / D(recipe.servings or 1)
    out = []
    for ing in ings:
        food = db.query(Food).filter(Food.id == ing.food_id).first()
        out.append({"food_id": ing.food_id, "amount": D(ing.amount) * scale, "unit": food.unit if food else ing.unit})
    return out


def nutrition_of_meal_items(db: Session, items: list[dict]) -> dict:
    """items: [{food_id,amount,unit}] or [{recipe_id,servings}]."""
    flat: list[dict] = []
    for it in items:
        if it.get("recipe_id"):
            recipe = db.query(Recipe).filter(Recipe.id == it["recipe_id"]).first()
            if recipe is None:
                flat.append({"food_id": it["recipe_id"], "amount": 0, "unit": "g"})
                continue
            flat.extend(recipe_food_items(db, recipe, it.get("servings") or it.get("amount") or 1))
        else:
            flat.append(it)
    return nutrition_of_food_items(db, flat)


# ---------------------------------------------------------------- allergy
def hard_restrictions(db: Session, user_id: str) -> list[dict]:
    from app.models import DietaryRestriction

    rows = (
        db.query(DietaryRestriction)
        .filter(DietaryRestriction.user_id == user_id, DietaryRestriction.hard == True)  # noqa: E712
        .all()
    )
    return [{"label": r.label, "keys": r.keys or [], "kind": r.kind} for r in rows if r.keys]


def food_hits(food: Food, keys: list[str]) -> bool:
    for k in keys:
        if k in (food.allergens or []) or k in food.name or k in (food.tags or []):
            return True
    return False


def recipe_blocked(db: Session, user_id: str, recipe: Recipe, extra_keys: list[str] | None = None) -> list[dict]:
    """Hard allergy/avoid violations for a recipe. Empty = allowed."""
    blocked = []
    hard = hard_restrictions(db, user_id)
    if extra_keys:
        hard = hard + [{"label": "、".join(extra_keys), "keys": extra_keys, "kind": "request"}]
    ings = db.query(RecipeIngredient).filter(RecipeIngredient.recipe_id == recipe.id).all()
    for ing in ings:
        food = db.query(Food).filter(Food.id == ing.food_id).first()
        if food is None:
            continue
        for h in hard:
            if food_hits(food, h["keys"]):
                blocked.append({"label": h["label"], "food": food.name, "kind": h["kind"]})
    return blocked


def recipe_verify_notes(db: Session, recipe: Recipe) -> list[str]:
    ings = db.query(RecipeIngredient).filter(RecipeIngredient.recipe_id == recipe.id).all()
    notes = []
    for ing in ings:
        food = db.query(Food).filter(Food.id == ing.food_id).first()
        if food and food.allergen_unknown:
            notes.append(food.name)
    return notes


# ---------------------------------------------------------------- pantry
def live_batches(db: Session, user_id: str, food_id: str):
    t = today()
    rows = (
        db.query(PantryBatch)
        .filter(PantryBatch.user_id == user_id, PantryBatch.food_id == food_id)
        .all()
    )
    return [b for b in rows if (b.expires_on is None or b.expires_on >= t) and (b.quantity_status == "unknown" or (b.remaining_amount or 0) > 0)]


def available_qty(db: Session, user_id: str, food_id: str) -> tuple[Decimal, bool, list]:
    bs = live_batches(db, user_id, food_id)
    qty = sum((D(b.remaining_amount) for b in bs if b.quantity_status == "known"), Decimal("0"))
    unknown = any(b.quantity_status == "unknown" for b in bs)
    return qty, unknown, bs


def _add_movement(db, user_id, batch, delta, kind, reason, source_type, source_id, idem_key):
    mv = PantryMovement(
        user_id=user_id, batch_id=batch.id, food_id=batch.food_id, delta=delta,
        kind=kind, reason=reason, source_type=source_type, source_id=source_id,
        idempotency_key=idem_key,
    )
    db.add(mv)
    return mv


def add_batch(db: Session, user: User, food_id: str, qty, unit: str | None, expires_on, location: str, kind="OPENING", source_type="manual", source_id=None, purchased_on=None) -> PantryBatch:
    food = db.query(Food).filter(Food.id == food_id).first()
    if food is None:
        raise ApiError(404, "NOT_FOUND", "食物不存在")
    known = qty is not None and str(qty) != ""
    batch = PantryBatch(
        user_id=user.id, food_id=food_id, base_unit=food.unit,
        original_amount=D(qty) if known else None,
        remaining_amount=D(qty) if known else None,
        quantity_status="known" if known else "unknown",
        purchased_on=purchased_on or today(), expires_on=expires_on, location=location or "fridge",
    )
    db.add(batch)
    db.flush()
    if known:
        _add_movement(db, user.id, batch, D(qty), kind, "入库", source_type, source_id or batch.id, f"open-{batch.id}")
    else:
        _add_movement(db, user.id, batch, None, kind, "新建批次（数量未知，不参与数值计算）", source_type, source_id or batch.id, None)
    return batch


def fefo_alloc(db: Session, user_id: str, food_id: str, need_base: Decimal) -> tuple[list[dict], Decimal]:
    bs = [b for b in live_batches(db, user_id, food_id) if b.quantity_status == "known"]
    bs.sort(key=lambda b: (b.expires_on is None, b.expires_on or date.max))
    alloc, left = [], D(need_base)
    for b in bs:
        if left <= 0:
            break
        take = min(D(b.remaining_amount), left)
        alloc.append({"batch_id": b.id, "amount": take, "expires": b.expires_on.isoformat() if b.expires_on else None, "version": b.version})
        left -= take
    return alloc, max(Decimal("0"), left)


def consume_from_pantry(db: Session, user: User, food_id: str, amount, unit: str, reason: str, source_type: str, source_id: str, idempotency_key: str | None = None, batch_id: str | None = None) -> dict:
    """FEFO consumption in one transaction. Idempotent on (user,source,kind)."""
    key = idempotency_key or f"{source_type}:{source_id}:CONSUME"
    rec = db.query(IdempotencyRecord).filter(
        IdempotencyRecord.user_id == user.id,
        IdempotencyRecord.operation == "pantry.consume", IdempotencyRecord.key == key,
    ).first()
    if rec is not None:
        return dict(rec.response_json or {}, duplicated=True)
    # also treat an existing movement for this source as a duplicate
    existing = db.query(PantryMovement).filter(
        PantryMovement.user_id == user.id, PantryMovement.source_type == source_type,
        PantryMovement.source_id == source_id, PantryMovement.kind == "CONSUME",
    ).first()
    if existing is not None:
        return {"duplicated": True, "allocations": [], "short": "0"}

    food = db.query(Food).filter(Food.id == food_id).first()
    if food is None:
        raise ApiError(404, "NOT_FOUND", "食物不存在")
    grams = to_grams(food, amount, unit or food.unit)
    if grams is None:
        raise ApiError(422, "UNIT_CONVERSION_UNKNOWN", f"无法换算 {food.name} 的单位 {unit}（缺少 density/piece_g）")
    need_base = grams_to_base(food, grams)
    if need_base is None:
        raise ApiError(422, "UNIT_CONVERSION_UNKNOWN", f"无法换算 {food.name} 到基础单位")
    if batch_id:
        batch = db.query(PantryBatch).filter(PantryBatch.id == batch_id, PantryBatch.user_id == user.id).first()
        if batch is None:
            raise ApiError(404, "NOT_FOUND", "批次不存在")
        if batch.quantity_status != "known":
            raise ApiError(422, "UNIT_CONVERSION_UNKNOWN", "该批次数量未知，无法扣减")
        if D(batch.remaining_amount) < need_base:
            raise ApiError(422, "INSUFFICIENT_STOCK", f"库存不足：剩余 {batch.remaining_amount}")
        alloc = [{"batch_id": batch.id, "amount": need_base, "expires": batch.expires_on.isoformat() if batch.expires_on else None, "version": batch.version}]
        short = Decimal("0")
    else:
        alloc, short = fefo_alloc(db, user.id, food_id, need_base)
        if short > 0:
            raise ApiError(422, "INSUFFICIENT_STOCK", f"库存不足：缺 {short} {food.unit}")
    for a in alloc:
        batch = db.query(PantryBatch).filter(PantryBatch.id == a["batch_id"]).first()
        batch.remaining_amount = D(batch.remaining_amount) - D(a["amount"])
        batch.version += 1
        _add_movement(db, user.id, batch, -D(a["amount"]), "CONSUME", reason or "烹饪消耗",
                      source_type, source_id, f"{key}:{batch.id}")
    result = {
        "food_id": food_id, "amount": str(need_base), "unit": food.unit,
        "allocations": [{**a, "amount": str(a["amount"])} for a in alloc],
        "short": str(short), "duplicated": False,
    }
    db.add(IdempotencyRecord(user_id=user.id, operation="pantry.consume", key=key,
                             request_hash=hashlib.sha256(json.dumps(result, sort_keys=True).encode()).hexdigest(),
                             response_json=result))
    db.flush()
    return result


# ---------------------------------------------------------------- plan
def stock_match(db: Session, user_id: str, recipe: Recipe) -> Decimal:
    ings = db.query(RecipeIngredient).filter(RecipeIngredient.recipe_id == recipe.id, RecipeIngredient.optional == False).all()  # noqa: E712
    if not ings:
        return Decimal("1")
    ok = Decimal("0")
    for ing in ings:
        qty, unknown, _ = available_qty(db, user_id, ing.food_id)
        if unknown or qty >= D(ing.amount):
            ok += 1
        elif qty > 0:
            ok += qty / D(ing.amount)
    return ok / len(ings)


def urgency_bonus(db: Session, user_id: str, recipe: Recipe) -> Decimal:
    s = Decimal("0")
    ings = db.query(RecipeIngredient).filter(RecipeIngredient.recipe_id == recipe.id).all()
    for ing in ings:
        for b in live_batches(db, user_id, ing.food_id):
            if b.expires_on is None:
                continue
            d = (b.expires_on - today()).days
            if d <= 2:
                s += 1
            elif d <= 4:
                s += Decimal("0.4")
    return min(s, Decimal("3")) / Decimal("3")


def generate_draft(db: Session, user: User, period_start: date, days: int, slots: list[str], constraints: dict | None = None) -> dict:
    profile = db.query(UserProfile).filter(UserProfile.user_id == user.id).first()
    max_cook = (constraints or {}).get("max_cook_minutes") or (profile.max_cook_minutes if profile else 35)
    equipment = set((constraints or {}).get("equipment") or (profile.equipment if profile else []) or [])
    avoid_ids = set((constraints or {}).get("avoid_food_ids") or [])
    extra_keys = []
    for fid in avoid_ids:
        f = db.query(Food).filter(Food.id == fid).first()
        if f:
            extra_keys.append(f.name)
    recipes = db.query(Recipe).all()
    meals: dict[str, dict] = {}
    used_recent: dict[str, int] = {}  # recipe_id -> last day index
    hard_violations: list[dict] = []
    for di in range(days):
        d = period_start + timedelta(days=di)
        for slot in slots:
            cands = []
            for r in recipes:
                if slot not in (r.slots or []):
                    continue
                blocked = recipe_blocked(db, user.id, r, extra_keys)
                if blocked:
                    hard_violations.append({"recipe_id": r.id, "slot": slot, "date": d.isoformat(), "blocked": blocked})
                    continue
                if equipment and not set(r.equipment or []).issubset(equipment):
                    continue
                stock = stock_match(db, user.id, r)
                urg = urgency_bonus(db, user.id, r)
                if (constraints or {}).get("require_expiring_ingredient") and not urg:
                    continue
                last = used_recent.get(r.id)
                div = Decimal("1") if last is None or di - last > 1 else Decimal("0")
                too_long = r.cook_minutes > max_cook
                conv = Decimal("0.3") if too_long else Decimal("1")
                verify = recipe_verify_notes(db, r)
                score = Decimal("0.35") * stock + Decimal("0.2") * urg + Decimal("0.25") * div + Decimal("0.2") * conv
                if verify:
                    score -= Decimal("0.15")
                cands.append((score, too_long, r))
            if not cands:
                continue
            # hard duration filter first; fall back to over-time recipes if none fit
            fitting = [c for c in cands if not c[1]] or cands
            fitting.sort(key=lambda c: c[0], reverse=True)
            best = fitting[0][2]
            meals[f"{d.isoformat()}|{slot}"] = {"recipe_id": best.id, "servings": best.servings}
            used_recent[best.id] = di
    projection = compute_gap_for_meals(db, user, meals, period_start, days)
    completeness = "full"
    for key, m in meals.items():
        r = db.query(Recipe).filter(Recipe.id == m["recipe_id"]).first()
        if r:
            nut = nutrition_of_food_items(db, recipe_food_items(db, r, m["servings"]))
            if nut["completeness"] != "full":
                completeness = "partial"
                break
    return {"meals": meals, "shopping_projection": projection, "hard_violations": hard_violations,
            "nutrition_completeness": completeness}


def compute_gap_for_meals(db: Session, user: User, meals: dict, period_start: date, days: int,
                          *, ignore_recorded: bool = False) -> list[dict]:
    t = today()
    need: dict[str, Decimal] = {}
    first: dict[str, str] = {}
    for di in range(days):
        d = period_start + timedelta(days=di)
        if d < t:
            continue
        for slot in ("breakfast", "lunch", "dinner", "snack"):
            m = meals.get(f"{d.isoformat()}|{slot}")
            if not m:
                continue
            eaten = None if ignore_recorded else db.query(MealRecord).filter(
                MealRecord.user_id == user.id, MealRecord.local_date == d,
                MealRecord.slot == slot, MealRecord.planned == True).first()  # noqa: E712
            if eaten:
                continue
            recipe = db.query(Recipe).filter(Recipe.id == m["recipe_id"]).first()
            if not recipe:
                continue
            ings = db.query(RecipeIngredient).filter(
                RecipeIngredient.recipe_id == recipe.id, RecipeIngredient.optional == False).all()  # noqa: E712
            for ing in ings:
                amt = D(ing.amount) * D(m.get("servings", recipe.servings)) / D(recipe.servings or 1)
                need[ing.food_id] = need.get(ing.food_id, Decimal("0")) + amt
                first.setdefault(ing.food_id, d.isoformat())
    out = []
    for fid, amt in need.items():
        food = db.query(Food).filter(Food.id == fid).first()
        avail, unknown, _ = available_qty(db, user.id, fid)
        incoming = sum(
            (D(i.quantity) for i in db.query(ShoppingItem).filter(
                ShoppingItem.user_id == user.id, ShoppingItem.food_id == fid,
                ShoppingItem.status.in_(["confirmed", "purchased"])).all() if i.quantity is not None),
            Decimal("0"),
        )
        gap_raw = max(Decimal("0"), amt - avail - incoming)
        if food.unit == "piece":
            gap = math.ceil(gap_raw)
        else:
            gap = math.ceil(gap_raw / 10) * 10
        if (gap > 0 and not unknown) or (unknown and amt > avail + incoming):
            out.append({"food_id": fid, "needed": str(q1(amt)), "available": str(q1(avail)),
                        "gap": gap if not unknown else None, "unit": food.unit,
                        "unknown_stock": unknown, "first_date": first.get(fid)})
    return out


def recompute_shopping(db: Session, user: User, plan: MealPlan):
    """Rebuild plan-origin *proposed* items; manual/confirmed items untouched."""
    db.query(ShoppingItem).filter(
        ShoppingItem.user_id == user.id, ShoppingItem.origin == "plan",
        ShoppingItem.status == "proposed").delete(synchronize_session=False)
    version = db.query(MealPlanVersion).filter(
        MealPlanVersion.plan_id == plan.id, MealPlanVersion.version == plan.active_version).first()
    if not version:
        return []
    pms = db.query(PlannedMeal).filter(PlannedMeal.plan_version_id == version.id).all()
    meals = {f"{pm.local_date.isoformat()}|{pm.slot}": {"recipe_id": pm.recipe_id, "servings": float(pm.servings)} for pm in pms}
    days = (plan.period_end - plan.period_start).days + 1
    gaps = compute_gap_for_meals(db, user, meals, plan.period_start, days)
    created = []
    for g in gaps:
        item = ShoppingItem(user_id=user.id, food_id=g["food_id"], quantity=g["gap"],
                            unit=g["unit"], origin="plan", plan_id=plan.id,
                            plan_version=plan.active_version, status="proposed",
                            need_qty=D(g["needed"]), avail_qty=D(g["available"]),
                            incoming_qty=None,
                            first_date=date.fromisoformat(g["first_date"]) if g.get("first_date") else None)
        db.add(item)
        created.append(item)
    db.flush()
    return created


def commit_plan_version(db: Session, user: User, plan: MealPlan, meals: dict, reason: str, by: str = "user", expected_version: int | None = None) -> MealPlanVersion:
    if expected_version is not None and expected_version != plan.active_version:
        raise ApiError(409, "CONFLICT", "计划版本冲突，请刷新后重试",
                       {"expected": expected_version, "current": plan.active_version})
    for key, m in meals.items():
        recipe = db.query(Recipe).filter(Recipe.id == m["recipe_id"]).first()
        if recipe is None:
            raise ApiError(404, "NOT_FOUND", f"菜谱不存在: {m['recipe_id']}")
        blocked = recipe_blocked(db, user.id, recipe)
        if blocked:
            raise ApiError(422, "ALLERGY_BLOCKED", f"违反饮食限制：{recipe.title} 含 {blocked[0]['food']}",
                           {"recipe_id": recipe.id, "blocked": blocked})
    new_v = plan.version_counter + 1
    version = MealPlanVersion(plan_id=plan.id, user_id=user.id, version=new_v,
                              based_on_version=plan.active_version, reason=reason, created_by=by)
    db.add(version)
    db.flush()
    for key, m in meals.items():
        dstr, slot = key.split("|")
        db.add(PlannedMeal(plan_version_id=version.id, user_id=user.id,
                           local_date=date.fromisoformat(dstr), slot=slot,
                           recipe_id=m["recipe_id"], servings=D(m.get("servings", 2))))
    plan.active_version = new_v
    plan.version_counter = new_v
    db.flush()
    recompute_shopping(db, user, plan)
    return version


def active_meals(db: Session, plan: MealPlan) -> dict:
    version = db.query(MealPlanVersion).filter(
        MealPlanVersion.plan_id == plan.id, MealPlanVersion.version == plan.active_version).first()
    if not version:
        return {}
    pms = db.query(PlannedMeal).filter(PlannedMeal.plan_version_id == version.id).all()
    return {f"{pm.local_date.isoformat()}|{pm.slot}": {"recipe_id": pm.recipe_id, "servings": float(pm.servings)} for pm in pms}


def plan_to_dict(db: Session, plan: MealPlan) -> dict:
    versions = db.query(MealPlanVersion).filter(MealPlanVersion.plan_id == plan.id).order_by(MealPlanVersion.version).all()
    out_versions = []
    for v in versions:
        pms = db.query(PlannedMeal).filter(PlannedMeal.plan_version_id == v.id).all()
        out_versions.append({
            "v": v.version, "reason": v.reason, "by": v.created_by,
            "at": v.created_at.isoformat() if v.created_at else None,
            "based_on": v.based_on_version,
            "meals": {f"{pm.local_date.isoformat()}|{pm.slot}": {"recipe_id": pm.recipe_id, "servings": float(pm.servings)} for pm in pms},
        })
    return {"id": plan.id, "title": plan.title, "period_start": plan.period_start.isoformat(),
            "period_end": plan.period_end.isoformat(), "active_version": plan.active_version,
            "versions": out_versions}


# ---------------------------------------------------------------- meals
def create_meal_record(db: Session, user: User, local_date: date, slot: str, items: list[dict],
                       source: str = "manual", planned: bool = False, note: str = "",
                       consume_pantry: bool = False) -> MealRecord:
    nut = nutrition_of_meal_items(db, items)
    titles = []
    for it in items:
        if it.get("recipe_id"):
            r = db.query(Recipe).filter(Recipe.id == it["recipe_id"]).first()
            titles.append(r.title if r else it["recipe_id"])
        else:
            f = db.query(Food).filter(Food.id == it.get("food_id")).first()
            titles.append(f.name if f else str(it.get("food_id")))
    rec = MealRecord(user_id=user.id, local_date=local_date, slot=slot,
                     title=" + ".join(titles), source=source, planned=planned, note=note)
    db.add(rec)
    db.flush()
    for it in items:
        if it.get("recipe_id"):
            db.add(MealItem(meal_record_id=rec.id, user_id=user.id, recipe_id=it["recipe_id"],
                            amount=D(it.get("servings") or it.get("amount") or 1), unit="servings"))
        else:
            db.add(MealItem(meal_record_id=rec.id, user_id=user.id, food_id=it["food_id"],
                            amount=D(it["amount"]), unit=it.get("unit")))
    for code in NUTRIENTS:
        db.add(NutritionSnapshot(meal_record_id=rec.id, nutrient_code=code,
                                 amount=D(nut[code]), completeness=nut["completeness"]))
    if consume_pantry:
        # same transaction: consume each plain food item from pantry
        for it in items:
            if it.get("food_id"):
                consume_from_pantry(db, user, it["food_id"], it["amount"], it.get("unit"),
                                    f"记餐消耗：{rec.title}", "meal_record", rec.id)
    mark_reports_stale(db, user, local_date)
    return rec


def mark_reports_stale(db: Session, user: User, local_date: date):
    for rp in db.query(Report).filter(Report.user_id == user.id, Report.status == "fresh").all():
        if rp.period_start <= local_date <= rp.period_end:
            rp.status = "stale"


# ---------------------------------------------------------------- reports
def compute_report_metrics(db: Session, user: User, week_start: date, *,
                           through: date | None = None) -> dict:
    days = [week_start + timedelta(days=i) for i in range(7)]
    t = through or today()
    elapsed = [d for d in days if d <= t]
    meals_by_day: dict[str, list[MealRecord]] = {}
    for m in db.query(MealRecord).filter(MealRecord.user_id == user.id,
                                         MealRecord.local_date >= week_start,
                                         MealRecord.local_date <= week_start + timedelta(days=6)).all():
        meals_by_day.setdefault(m.local_date.isoformat(), []).append(m)
    record_days = len([d for d in elapsed if d.isoformat() in meals_by_day])
    missing_days = len(elapsed) - record_days
    # plan rate: planned meals due vs eaten (planned=True records)
    plan = db.query(MealPlan).filter(MealPlan.user_id == user.id).order_by(MealPlan.created_at.desc()).first()
    judged = done = 0
    if plan and plan.active_version:
        active = active_meals(db, plan)
        for key in active:
            dstr, slot = key.split("|")
            d = date.fromisoformat(dstr)
            if d not in elapsed:
                continue
            judged += 1
            if any(m.slot == slot and m.planned for m in meals_by_day.get(dstr, [])):
                done += 1
    kcal_by_day = []
    total_kcal = total_protein = Decimal("0")
    for d in days:
        if d > t or d.isoformat() not in meals_by_day:
            kcal_by_day.append(None)
            continue
        day_kcal = day_prot = Decimal("0")
        for m in meals_by_day[d.isoformat()]:
            for snap in db.query(NutritionSnapshot).filter(NutritionSnapshot.meal_record_id == m.id).all():
                if snap.nutrient_code == "kcal":
                    day_kcal += D(snap.amount)
                elif snap.nutrient_code == "protein":
                    day_prot += D(snap.amount)
        kcal_by_day.append(float(q1(day_kcal)))
        total_kcal += day_kcal
        total_protein += day_prot

    def habit_avg(kind: str):
        rows = db.query(HabitRecord).filter(HabitRecord.user_id == user.id, HabitRecord.kind == kind,
                                            HabitRecord.local_date >= week_start,
                                            HabitRecord.local_date <= week_start + timedelta(days=6)).all()
        if not rows:
            return None, 0
        by_day: dict[str, Decimal] = {}
        for r in rows:
            by_day[r.local_date.isoformat()] = by_day.get(r.local_date.isoformat(), Decimal("0")) + D(r.value)
        vals = list(by_day.values())
        return float(q1(sum(vals) / len(vals))), len(vals)

    water_avg, water_days = habit_avg("water")
    sleep_avg, sleep_days = habit_avg("sleep")
    steps_avg, steps_days = habit_avg("steps")
    return {
        "record_rate": round(record_days / len(elapsed) * 100, 1) if elapsed else 0,
        "plan_rate": round(done / judged * 100, 1) if judged else None,
        "record_days": record_days, "missing_days": missing_days,
        "avg_kcal": float(q1(total_kcal / record_days)) if record_days else None,
        "avg_protein": float(q1(total_protein / record_days)) if record_days else None,
        "water_avg": water_avg, "water_days": water_days,
        "sleep_avg": sleep_avg, "sleep_days": sleep_days,
        "steps_avg": steps_avg, "steps_days": steps_days,
        "kcal_by_day": kcal_by_day,
    }


def report_text(metrics: dict) -> str:
    lines = ["# 本周饮食与习惯回顾", "",
             f"- 记录天数：{metrics['record_days']} 天，缺失 {metrics['missing_days']} 天，记录率 {metrics['record_rate']}%。"]
    if metrics.get("plan_rate") is not None:
        lines.append(f"- 计划完成率：{metrics['plan_rate']}%。")
    if metrics.get("avg_kcal") is not None:
        lines.append(f"- 日均热量约 {metrics['avg_kcal']} kcal，日均蛋白质约 {metrics['avg_protein']} g（仅基于已记录餐食，未记录部分不计入）。")
    if metrics.get("water_avg") is not None:
        lines.append(f"- 日均饮水约 {metrics['water_avg']} ml（{metrics['water_days']} 天有记录）。")
    if metrics.get("sleep_avg") is not None:
        lines.append(f"- 平均睡眠约 {metrics['sleep_avg']} 小时。")
    if metrics.get("steps_avg") is not None:
        lines.append(f"- 日均步数约 {metrics['steps_avg']} 步。")
    lines.append("")
    lines.append("说明：未记录的天数按缺失处理，不补 0；营养数值来自结构化食物数据，缺失项已标注 unknown。")
    return "\n".join(lines)
