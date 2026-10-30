"""User profile + dietary restrictions."""
from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.v1.serializers import user_to_dict
from app.core.deps import get_current_user
from app.core.errors import ApiError, ok
from app.db import get_db
from app.models import DietaryRestriction, User, UserProfile

router = APIRouter(prefix="/users", tags=["users"])


class ProfilePatch(BaseModel):
    name: str | None = None
    timezone: str | None = None
    locale: str | None = None
    max_cook_minutes: int | None = None
    people: int | None = None
    equipment: list[str] | None = None
    taste: list[str] | None = None


class RestrictionIn(BaseModel):
    kind: str
    label: str
    keys: list[str] = []
    hard: bool = False


@router.get("/me")
def get_me(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    profile = db.query(UserProfile).filter(UserProfile.user_id == user.id).first()
    return ok({"user": user_to_dict(user, profile)})


@router.patch("/me")
def patch_me(body: ProfilePatch, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    if body.name is not None:
        user.name = body.name
    profile = db.query(UserProfile).filter(UserProfile.user_id == user.id).first()
    if profile is None:
        profile = UserProfile(user_id=user.id)
        db.add(profile)
    for field in ("timezone", "locale", "max_cook_minutes", "people", "equipment", "taste"):
        v = getattr(body, field)
        if v is not None:
            setattr(profile, field, v)
    db.commit()
    return ok({"user": user_to_dict(user, profile)})


@router.get("/me/restrictions")
def list_restrictions(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    rows = db.query(DietaryRestriction).filter(DietaryRestriction.user_id == user.id).all()
    return ok([{"id": r.id, "kind": r.kind, "label": r.label, "keys": r.keys or [], "hard": bool(r.hard)} for r in rows])


@router.post("/me/restrictions")
def add_restriction(body: RestrictionIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    if body.kind not in ("allergy", "avoid", "pref"):
        raise ApiError(422, "VALIDATION_ERROR", "kind 必须是 allergy|avoid|pref")
    r = DietaryRestriction(user_id=user.id, kind=body.kind, label=body.label, keys=body.keys, hard=body.hard)
    db.add(r)
    db.commit()
    return ok({"id": r.id, "kind": r.kind, "label": r.label, "keys": r.keys or [], "hard": bool(r.hard)}, status=201)


@router.patch("/me/restrictions/{rid}")
def patch_restriction(rid: str, body: RestrictionIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    r = db.query(DietaryRestriction).filter(DietaryRestriction.id == rid, DietaryRestriction.user_id == user.id).first()
    if r is None:
        raise ApiError(404, "NOT_FOUND", "限制不存在")
    r.kind, r.label, r.keys, r.hard = body.kind, body.label, body.keys, body.hard
    db.commit()
    return ok({"id": r.id, "kind": r.kind, "label": r.label, "keys": r.keys or [], "hard": bool(r.hard)})


@router.delete("/me/restrictions/{rid}")
def delete_restriction(rid: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    r = db.query(DietaryRestriction).filter(DietaryRestriction.id == rid, DietaryRestriction.user_id == user.id).first()
    if r is None:
        raise ApiError(404, "NOT_FOUND", "限制不存在")
    db.delete(r)
    db.commit()
    return ok({})
