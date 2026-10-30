"""Foods, recipes, search (BM25)."""
from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.api.v1.serializers import food_to_dict, recipe_to_dict
from app.application import services
from app.core.deps import get_current_user
from app.core.errors import ApiError, ok
from app.db import get_db
from app.models import Food, Recipe, RecipeFavorite
from app.rag.bm25 import search_knowledge

router = APIRouter(tags=["foods", "recipes"])


@router.get("/foods")
def list_foods(db: Session = Depends(get_db), user=Depends(get_current_user)):
    return ok([food_to_dict(f) for f in db.query(Food).order_by(Food.id).all()])


@router.get("/foods/{fid}")
def get_food(fid: str, db: Session = Depends(get_db), user=Depends(get_current_user)):
    f = db.query(Food).filter(Food.id == fid).first()
    if f is None:
        raise ApiError(404, "NOT_FOUND", "食物不存在")
    return ok(food_to_dict(f))


@router.get("/recipes")
def list_recipes(q: str | None = None, slot: str | None = None, max_minutes: int | None = None,
                 exclude_allergen: str | None = None, favorite_only: bool = False,
                 db: Session = Depends(get_db), user=Depends(get_current_user)):
    rows = db.query(Recipe).order_by(Recipe.id).all()
    out = []
    fav_ids = {f.recipe_id for f in db.query(RecipeFavorite).filter(RecipeFavorite.user_id == user.id).all()}
    for r in rows:
        if q and q not in r.title:
            continue
        if slot and slot not in (r.slots or []):
            continue
        if max_minutes is not None and r.cook_minutes > max_minutes:
            continue
        if favorite_only and r.id not in fav_ids:
            continue
        if exclude_allergen:
            blocked = services.recipe_blocked(db, user.id, r, [exclude_allergen])
            if blocked:
                continue
        d = recipe_to_dict(db, r, user.id)
        out.append(d)
    return ok(out)


@router.get("/recipes/{rid}")
def get_recipe(rid: str, db: Session = Depends(get_db), user=Depends(get_current_user)):
    r = db.query(Recipe).filter(Recipe.id == rid).first()
    if r is None:
        raise ApiError(404, "NOT_FOUND", "菜谱不存在")
    d = recipe_to_dict(db, r, user.id)
    d["hard_violations"] = services.recipe_blocked(db, user.id, r)
    d["verify_notes"] = services.recipe_verify_notes(db, r)
    return ok(d)


@router.post("/recipes/{rid}/favorite")
def add_favorite(rid: str, db: Session = Depends(get_db), user=Depends(get_current_user)):
    if db.query(Recipe).filter(Recipe.id == rid).first() is None:
        raise ApiError(404, "NOT_FOUND", "菜谱不存在")
    if db.query(RecipeFavorite).filter(RecipeFavorite.user_id == user.id, RecipeFavorite.recipe_id == rid).first() is None:
        db.add(RecipeFavorite(user_id=user.id, recipe_id=rid))
        db.commit()
    return ok({"recipe_id": rid, "favorite": True})


@router.delete("/recipes/{rid}/favorite")
def remove_favorite(rid: str, db: Session = Depends(get_db), user=Depends(get_current_user)):
    db.query(RecipeFavorite).filter(RecipeFavorite.user_id == user.id, RecipeFavorite.recipe_id == rid).delete()
    db.commit()
    return ok({"recipe_id": rid, "favorite": False})


@router.get("/search")
def search(q: str = Query(...), db: Session = Depends(get_db), user=Depends(get_current_user)):
    return ok(search_knowledge(db, q, user.id))
