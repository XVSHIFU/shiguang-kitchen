"""Privacy: export all user data (JSON) + soft-delete account.
Also MCP credential management (PAT creation is here because it needs a
logged-in session; the MCP endpoint itself uses Bearer PAT)."""
import json
import os
import shutil
import sqlite3
import tempfile
from contextlib import closing
from datetime import date, datetime, timezone
from pathlib import Path
from threading import Lock
from time import monotonic

from fastapi import APIRouter, Depends, File, UploadFile
from pydantic import BaseModel
from sqlalchemy.orm import Session
from starlette.background import BackgroundTask
from starlette.responses import FileResponse

from app.core.administration import server_admin_ids
from app.core.deps import get_current_user, require_server_admin
from app.core.errors import ApiError, ok
from app.core.security import new_token, token_hash, verify_password
from app.db import engine, get_db
from app.models import (
    AgentAction,
    AgentPreferences,
    AgentRun,
    AgentRunEvent,
    AgentThread,
    AuthSession,
    DietaryRestriction,
    HabitRecord,
    KnowledgeDoc,
    McpCredential,
    MealRecord,
    Notification,
    PantryBatch,
    PantryMovement,
    Report,
    ShoppingItem,
    User,
    UserProfile,
)

router = APIRouter(tags=["privacy", "mcp-credentials"])


def _rows(db, model, user_id):
    from datetime import date as _date
    from decimal import Decimal as _Dec

    out = []
    for r in db.query(model).filter(model.user_id == user_id).all():
        d = {}
        for c in model.__table__.columns:
            v = getattr(r, c.name)
            if isinstance(v, _Dec):
                d[c.name] = str(v)
            elif isinstance(v, (_date, datetime)):
                d[c.name] = v.isoformat()
            else:
                d[c.name] = v
        out.append(d)
    return out


_RESTORE_TABLES = {"users", "auth_sessions", "foods", "pantry_batches", "habit_records", "meal_records"}
_SQLITE_HEADER = b"SQLite format 3\x00"
_RESTORE_LOCK = Lock()


def _db_path() -> Path:
    url = engine.url
    if url.get_backend_name() != "sqlite" or url.database in ("", None, ":memory:"):
        raise ApiError(501, "NOT_SUPPORTED", "当前部署不支持 SQLite 文件备份与恢复")
    return Path(url.database).resolve()


def _open_readonly(path: Path):
    return sqlite3.connect(f"{path.resolve().as_uri()}?mode=ro", uri=True)


def _sqlite_backup(src_path: Path, dst_path: Path):
    """Use SQLite's own snapshot and locking for both backup and restore."""
    deadline = monotonic() + 8

    def progress(status, _remaining, _total):
        if status in (sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED) and monotonic() >= deadline:
            raise ApiError(503, "DATABASE_BUSY", "数据库正在写入，请稍后重试")

    with closing(_open_readonly(src_path)) as src, closing(sqlite3.connect(dst_path)) as dst:
        src.backup(dst, progress=progress)


def _prepare_restore(path: Path, db: Session):
    # Administrator credentials are server-owned and must survive old backups.
    allowed_ids = server_admin_ids()
    accounts = {u.id: u for u in db.query(User).filter(User.id.in_(allowed_ids)).all()}
    with closing(sqlite3.connect(path)) as candidate, candidate:
        candidate.execute("PRAGMA trusted_schema=OFF")
        tables = {row[0] for row in candidate.execute(
            "SELECT name FROM sqlite_master WHERE type='table'")}
        missing = sorted(_RESTORE_TABLES - tables)
        if missing:
            raise ApiError(422, "VALIDATION_ERROR", f"备份缺少核心表：{', '.join(missing)}")
        if not candidate.execute("SELECT 1 FROM users LIMIT 1").fetchone():
            raise ApiError(422, "VALIDATION_ERROR", "备份的 users 表为空")
        if candidate.execute("PRAGMA quick_check").fetchone() != ("ok",):
            raise ApiError(422, "VALIDATION_ERROR", "备份未通过数据库完整性检查")
        for uid in allowed_ids:
            user = accounts.get(uid)
            if user is None:
                candidate.execute("UPDATE users SET status='deleted' WHERE id=?", (uid,))
                continue
            candidate.execute(
                """INSERT INTO users (id, email, name, password_hash, status, created_at, deleted_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(id) DO UPDATE SET email=excluded.email, name=excluded.name,
                       password_hash=excluded.password_hash, status=excluded.status,
                       created_at=excluded.created_at, deleted_at=excluded.deleted_at""",
                (uid, user.email, user.name, user.password_hash, user.status,
                 str(user.created_at) if user.created_at else None,
                 str(user.deleted_at) if user.deleted_at else None),
            )
        candidate.execute("DELETE FROM auth_sessions")


@router.post("/privacy/backup")
def backup_db(user: User = Depends(require_server_admin)):
    """One-click backup: consistent SQLite snapshot as a file download.

    Only the .db file is returned — never .env or any key material.
    POST so it passes the CSRF middleware (frontend sends X-CSRF-Token).
    """
    db_path = _db_path()
    if not db_path.exists():
        raise ApiError(404, "NOT_FOUND", "数据库文件不存在")
    tmp = tempfile.NamedTemporaryFile(prefix="ai-life-agent-backup-", suffix=".db", delete=False)
    tmp_path = tmp.name
    tmp.close()
    try:
        _sqlite_backup(db_path, Path(tmp_path))
    except Exception:
        os.unlink(tmp_path)
        raise
    filename = f"ai-life-agent-backup-{date.today().strftime('%Y%m%d')}.db"
    return FileResponse(
        tmp_path, media_type="application/octet-stream", filename=filename,
        background=BackgroundTask(os.unlink, tmp_path),
    )


@router.post("/privacy/restore")
def restore_db(file: UploadFile = File(...), db: Session = Depends(get_db),
               user: User = Depends(require_server_admin)):
    """Validate the candidate, back up the current data, then restore atomically."""
    db_path = _db_path()
    with _RESTORE_LOCK, tempfile.TemporaryDirectory(prefix="ai-life-agent-restore-") as directory:
        candidate = Path(directory) / "candidate.db"
        with candidate.open("wb") as target:
            shutil.copyfileobj(file.file, target, length=1024 * 1024)
        with candidate.open("rb") as source:
            if source.read(16) != _SQLITE_HEADER:
                raise ApiError(422, "VALIDATION_ERROR", "文件不是有效的 SQLite 数据库")
        try:
            _prepare_restore(candidate, db)
        except sqlite3.Error as e:
            raise ApiError(422, "VALIDATION_ERROR", "备份无法读取或与管理员账号冲突") from e
        db.rollback()  # release the request's read transaction before writing
        bak_name = f"app.db.bak-{datetime.now().strftime('%Y%m%d-%H%M%S-%f')}"
        bak_path = db_path.with_name(bak_name)
        bak_path.touch(mode=0o600, exist_ok=False)
        try:
            _sqlite_backup(db_path, bak_path)
        except Exception:
            bak_path.unlink(missing_ok=True)
            raise
        _sqlite_backup(candidate, db_path)
        engine.dispose()
    return ok({"restored": True, "backup": bak_name, "message": "已恢复，请重新登录"})


@router.post("/privacy/export")
def export_data(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    profile = db.query(UserProfile).filter(UserProfile.user_id == user.id).first()
    data = {
        "user": {"id": user.id, "email": user.email, "name": user.name},
        "profile": {"timezone": profile.timezone, "locale": profile.locale,
                    "max_cook_minutes": profile.max_cook_minutes, "people": profile.people,
                    "equipment": profile.equipment, "taste": profile.taste} if profile else None,
        "restrictions": _rows(db, DietaryRestriction, user.id),
        "pantry_batches": _rows(db, PantryBatch, user.id),
        "pantry_movements": _rows(db, PantryMovement, user.id),
        "shopping_items": _rows(db, ShoppingItem, user.id),
        "meal_records": _rows(db, MealRecord, user.id),
        "habit_records": _rows(db, HabitRecord, user.id),
        "reports": _rows(db, Report, user.id),
        "notifications": _rows(db, Notification, user.id),
        "agent_preferences": _rows(db, AgentPreferences, user.id),
        "agent_threads": _rows(db, AgentThread, user.id),
        "agent_runs": _rows(db, AgentRun, user.id),
        "agent_events": _rows(db, AgentRunEvent, user.id),
        "agent_actions": _rows(db, AgentAction, user.id),
        "knowledge_docs": [ {"id": d.id, "title": d.title, "kind": d.kind, "source": d.source}
                            for d in db.query(KnowledgeDoc).filter(KnowledgeDoc.owner_user_id == user.id).all()],
        "exported_at": datetime.now(timezone.utc).isoformat(),
    }
    return ok({"content": data, "format": "json"})


class DeleteIn(BaseModel):
    password: str


@router.delete("/privacy/account")
def delete_account(body: DeleteIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    if not verify_password(body.password, user.password_hash):
        raise ApiError(401, "UNAUTHORIZED", "密码不正确，删除未执行")
    user.status = "deleted"
    user.deleted_at = datetime.now(timezone.utc)
    db.query(AgentPreferences).filter_by(user_id=user.id).delete()
    db.query(AuthSession).filter(AuthSession.user_id == user.id).update({"revoked_at": datetime.now(timezone.utc)})
    db.query(McpCredential).filter(McpCredential.user_id == user.id).update({"revoked_at": datetime.now(timezone.utc)})
    db.commit()
    return ok({"deleted": True, "note": "账号已软删除，会话与 MCP 凭证已撤销"})


class McpCredIn(BaseModel):
    name: str = "mcp-client"
    scope: list[str] = ["pantry:read", "recipes:read", "plan:read", "knowledge:read"]


@router.get("/mcp/credentials")
def list_mcp_creds(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    rows = db.query(McpCredential).filter(McpCredential.user_id == user.id).all()
    return ok([{"id": c.id, "name": c.name, "scope": c.scope or [],
                "revoked": c.revoked_at is not None,
                "created_at": c.created_at.isoformat() if c.created_at else None} for c in rows])


@router.post("/mcp/credentials")
def create_mcp_cred(body: McpCredIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    allowed = {"pantry:read", "recipes:read", "plan:read", "knowledge:read", "shopping:propose", "plan:propose"}
    scope = [s for s in body.scope if s in allowed]
    token = "mcp_" + new_token()
    cred = McpCredential(user_id=user.id, name=body.name, scope=scope, token_hash=token_hash(token))
    db.add(cred)
    db.commit()
    # plaintext token is shown exactly once, never stored
    return ok({"id": cred.id, "name": cred.name, "scope": scope, "token": token,
               "note": "token 仅显示一次，请妥善保存"}, status=201)


@router.delete("/mcp/credentials/{cid}")
def revoke_mcp_cred(cid: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    cred = db.query(McpCredential).filter(McpCredential.id == cid, McpCredential.user_id == user.id).first()
    if cred is None:
        raise ApiError(404, "NOT_FOUND", "凭证不存在")
    cred.revoked_at = datetime.now(timezone.utc)
    db.commit()
    return ok({"id": cred.id, "revoked": True})
