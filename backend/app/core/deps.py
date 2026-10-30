"""Auth deps: session cookie -> user; CSRF check for state-changing calls.

Cross-user isolation: every business query is filtered by user_id; a
resource owned by another user is treated as 404 (no leak).
"""
import hashlib
from datetime import datetime, timezone

from fastapi import Cookie, Depends, Header, Request
from sqlalchemy.orm import Session

from app.core.administration import server_admin_ids
from app.core.errors import ApiError
from app.db import get_db
from app.models import AuthSession, User


def _now():
    return datetime.now(timezone.utc)


def get_current_user(
    request: Request,
    session_id: str | None = Cookie(default=None),
    db: Session = Depends(get_db),
) -> User:
    if not session_id:
        raise ApiError(401, "UNAUTHORIZED", "未登录")
    thash = hashlib.sha256(session_id.encode()).hexdigest()
    sess = db.query(AuthSession).filter(AuthSession.token_hash == thash).first()
    if not sess or sess.revoked_at is not None:
        raise ApiError(401, "UNAUTHORIZED", "会话已失效")
    if sess.expires_at and sess.expires_at.replace(tzinfo=timezone.utc) < _now():
        raise ApiError(401, "UNAUTHORIZED", "会话已过期")
    user = db.query(User).filter(User.id == sess.user_id).first()
    if not user or user.status != "active":
        raise ApiError(401, "UNAUTHORIZED", "用户不存在或已删除")
    request.state.session = sess
    request.state.user = user
    return user


def require_server_admin(user: User = Depends(get_current_user)) -> User:
    if user.id not in server_admin_ids():
        raise ApiError(403, "ADMIN_REQUIRED", "仅服务器管理员可以备份或恢复数据库")
    return user


def require_csrf(
    request: Request,
    x_csrf_token: str | None = Header(default=None, alias="X-CSRF-Token"),
):
    # Exempt: login/register (no session yet) and MCP (Bearer auth, not cookies).
    path = request.url.path
    if path.endswith("/auth/login") or path.endswith("/auth/register"):
        return
    if path.startswith("/api/v1/mcp") or path.startswith("/mcp"):
        return
    cookie_token = request.cookies.get("csrf_token")
    if not cookie_token or not x_csrf_token or x_csrf_token != cookie_token:
        raise ApiError(403, "CSRF_FAILED", "CSRF 校验失败，请携带 X-CSRF-Token")
