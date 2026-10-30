"""Serializers: DB rows -> contract JSON. Decimal amounts as strings."""
from decimal import Decimal

from app.models import Food, PantryBatch, Recipe, ShoppingItem


def num(v):
    if v is None:
        return None
    d = Decimal(str(v))
    return float(d)


def food_to_dict(f: Food) -> dict:
    return {
        "id": f.id, "code": f.id, "name": f.name, "unit": f.unit,
        "piece_g": num(f.piece_g), "density_g_ml": num(f.density_g_ml),
        "allergens": f.allergens or [], "tags": f.tags or [],
        "nutrients": ({"kcal": str(f.nutrients[0]), "protein": str(f.nutrients[1]),
                       "fat": str(f.nutrients[2]), "carbs": str(f.nutrients[3])}
                      if f.nutrients else None),
        "nutrient_missing": f.nutrients is None,
        "allergen_unknown": bool(f.allergen_unknown),
    }


def recipe_to_dict(db, r: Recipe, user_id: str | None = None) -> dict:
    from app.models import RecipeFavorite, RecipeIngredient, RecipeStep

    ings = db.query(RecipeIngredient).filter(RecipeIngredient.recipe_id == r.id).all()
    steps = db.query(RecipeStep).filter(RecipeStep.recipe_id == r.id).order_by(RecipeStep.step_index).all()
    fav = False
    if user_id:
        fav = db.query(RecipeFavorite).filter(
            RecipeFavorite.user_id == user_id, RecipeFavorite.recipe_id == r.id).first() is not None
    return {
        "id": r.id, "title": r.title, "cook_minutes": r.cook_minutes,
        "difficulty": r.difficulty, "servings": r.servings,
        "equipment": r.equipment or [], "slots": r.slots or [], "source": r.source,
        "favorite": fav,
        "ingredients": [{"food_id": i.food_id, "amount": str(i.amount), "unit": i.unit, "optional": bool(i.optional)} for i in ings],
        "steps": [{"text": s.text, "seconds": s.seconds} for s in steps],
    }


def batch_to_dict(b: PantryBatch) -> dict:
    return {
        "id": b.id, "food_id": b.food_id, "unit": b.base_unit,
        "original": num(b.original_amount), "remaining": num(b.remaining_amount),
        "quantity_status": b.quantity_status,
        "purchased_on": b.purchased_on.isoformat() if b.purchased_on else None,
        "expires_on": b.expires_on.isoformat() if b.expires_on else None,
        "location": b.location, "version": b.version,
    }


def shopping_to_dict(i: ShoppingItem) -> dict:
    return {
        "id": i.id, "food_id": i.food_id, "qty": num(i.quantity), "unit": i.unit,
        "origin": i.origin, "plan_id": i.plan_id, "plan_version": i.plan_version,
        "status": i.status, "note": i.note,
        "need": num(i.need_qty), "avail": num(i.avail_qty), "incoming": num(i.incoming_qty),
        "first_date": i.first_date.isoformat() if i.first_date else None,
        "version": i.version,
    }


def user_to_dict(u, profile=None, restrictions=None) -> dict:
    d = {"id": u.id, "email": u.email, "name": u.name}
    if profile is not None:
        d["profile"] = {
            "timezone": profile.timezone, "locale": profile.locale,
            "max_cook_minutes": profile.max_cook_minutes, "people": profile.people,
            "equipment": profile.equipment or [], "taste": profile.taste or [],
        }
    if restrictions is not None:
        d["restrictions"] = restrictions
    return d
