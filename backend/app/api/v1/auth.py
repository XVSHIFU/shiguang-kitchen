"""Auth routes: register / login / logout / csrf / me."""
import re
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.v1.serializers import user_to_dict
from app.core import config
from app.core.administration import server_admin_ids
from app.core.errors import ApiError, ok
from app.core.security import hash_password, new_token, token_hash, verify_password
from app.db import get_db
from app.core.deps import get_current_user
from app.models import AuthSession, AutomationPolicy, DietaryRestriction, User, UserProfile

router = APIRouter(prefix="/auth", tags=["auth"])


class RegisterIn(BaseModel):
    email: str
    password: str
    name: str | None = None


class LoginIn(BaseModel):
    email: str
    password: str


def _set_session_cookies(resp, session_token: str, csrf: str):
    max_age = config.SESSION_TTL_SECONDS
    resp.set_cookie("session_id", session_token, httponly=True, samesite="lax", max_age=max_age, path="/")
    resp.set_cookie("csrf_token", csrf, httponly=False, samesite="lax", max_age=max_age, path="/")


@router.post("/register")
def register(body: RegisterIn, db: Session = Depends(get_db)):
    email = body.email.strip().lower()
    if not re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", email):
        raise ApiError(422, "VALIDATION_ERROR", "邮箱格式不正确")
    if len(body.password) < 8:
        raise ApiError(422, "VALIDATION_ERROR", "密码至少 8 位")
    if db.query(User).filter(User.email == email).first():
        raise ApiError(409, "CONFLICT", "该邮箱已注册")
    user = User(email=email, password_hash=hash_password(body.password), name=body.name)
    db.add(user)
    db.flush()
    db.add(UserProfile(user_id=user.id))
    db.commit()
    return ok({"user": user_to_dict(user)}, status=201)


@router.post("/login")
def login(request: Request, body: LoginIn, db: Session = Depends(get_db)):
    email = body.email.strip().lower()
    user = db.query(User).filter(User.email == email).first()
    if user is None or user.status != "active" or not verify_password(body.password, user.password_hash):
        raise ApiError(401, "UNAUTHORIZED", "邮箱或密码错误")
    token = new_token()
    # 登录前前端已通过 GET /auth/csrf 拿到一个 token 并存在 cookie 里；
    # 直接复用它，不要再换发一个，否则前端内存里的旧值和新 cookie 对不上，
    # 登录后第一个写操作就会 403 CSRF_FAILED。
    csrf = request.cookies.get("csrf_token") or new_token()
    sess = AuthSession(
        user_id=user.id, token_hash=token_hash(token), csrf_token=csrf,
        expires_at=datetime.now(timezone.utc) + timedelta(seconds=config.SESSION_TTL_SECONDS),
    )
    db.add(sess)
    db.commit()
    resp = ok({"user": user_to_dict(user)})
    _set_session_cookies(resp, token, csrf)
    return resp


@router.post("/logout")
def logout(request: Request, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    sess = getattr(request.state, "session", None)
    if sess is not None:
        sess.revoked_at = datetime.now(timezone.utc)
        db.commit()
    resp = ok({})
    resp.delete_cookie("session_id", path="/")
    resp.delete_cookie("csrf_token", path="/")
    return resp


@router.get("/csrf")
def get_csrf():
    csrf = new_token()
    resp = ok({"csrf_token": csrf})
    resp.set_cookie("csrf_token", csrf, httponly=False, samesite="lax", max_age=config.CSRF_TTL_SECONDS, path="/")
    return resp


@router.get("/me")
def me(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    profile = db.query(UserProfile).filter(UserProfile.user_id == user.id).first()
    restrictions = db.query(DietaryRestriction).filter(DietaryRestriction.user_id == user.id).all()
    account = user_to_dict(user, profile, [
        {"id": r.id, "kind": r.kind, "label": r.label, "keys": r.keys or [], "hard": bool(r.hard)}
        for r in restrictions])
    account["server_admin"] = user.id in server_admin_ids()
    return ok({"user": account})
