"""FastAPI entrypoint: envelope, CSRF middleware, routers, health checks."""
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pathlib import Path
from sqlalchemy import text
from starlette.middleware.base import BaseHTTPMiddleware

from app.agents.meal_approval import setup_checkpointer
from app.api.v1 import agent as agent_router
from app.api.v1 import auth as auth_router
from app.api.v1 import foods as foods_router
from app.api.v1 import habits as habits_router
from app.api.v1 import mcp as mcp_router
from app.api.v1 import meals as meals_router
from app.api.v1 import pantry as pantry_router
from app.api.v1 import plans as plans_router
from app.api.v1 import privacy as privacy_router
from app.api.v1 import recognition as recognition_router
from app.api.v1 import shopping as shopping_router
from app.api.v1 import users as users_router
from app.api.v1 import version as version_router
from app.core.errors import ApiError, api_error_handler, fail
from app.db import SessionLocal, engine, init_db

app = FastAPI(title="AI 饮食与健康生活管家", version="0.2.0")
app.add_exception_handler(ApiError, api_error_handler)


@app.exception_handler(RequestValidationError)
async def validation_handler(request: Request, exc: RequestValidationError):
    return fail(422, "VALIDATION_ERROR", "请求参数校验失败", {"errors": exc.errors()})


@app.exception_handler(Exception)
async def unhandled_handler(request: Request, exc: Exception):
    return fail(500, "INTERNAL", "服务器内部错误，请稍后重试")


class CsrfMiddleware(BaseHTTPMiddleware):
    """Double-submit cookie CSRF for state-changing /api/v1 calls.

    Exempt: login/register (no session yet) and MCP (Bearer auth).
    """

    EXEMPT_SUFFIXES = ("/auth/login", "/auth/register")

    async def dispatch(self, request, call_next):
        if request.method in ("POST", "PUT", "PATCH", "DELETE"):
            path = request.url.path
            is_api = path.startswith("/api/v1")
            is_mcp = "/mcp" in path
            exempt = any(path.endswith(s) for s in self.EXEMPT_SUFFIXES)
            if is_api and not is_mcp and not exempt:
                cookie_token = request.cookies.get("csrf_token")
                header_token = request.headers.get("X-CSRF-Token")
                if not cookie_token or not header_token or cookie_token != header_token:
                    return fail(403, "CSRF_FAILED", "CSRF 校验失败，请携带 X-CSRF-Token")
        return await call_next(request)


app.add_middleware(CsrfMiddleware)


@app.on_event("startup")
def on_startup():
    init_db()
    setup_checkpointer(engine)
    # Startup expiry scan (sync, no Redis/Celery needed): one deduped
    # notification per expiring batch for every user. Must never block
    # startup — failures are only logged.
    try:
        import logging

        from app.core import config as _config
        from app.models import User
        from app.tasks import notify_expiring

        db = SessionLocal()
        try:
            for u in db.query(User).filter(User.status == "active").all():
                try:
                    notify_expiring(db, u, _config.EXPIRY_WARN_DAYS)
                except Exception as e:  # noqa: BLE001 - per-user failure is non-fatal
                    logging.getLogger(__name__).warning("启动临期扫描失败 user=%s: %s", u.id, e)
        finally:
            db.close()
    except Exception as e:  # noqa: BLE001 - startup scan must never block boot
        import logging

        logging.getLogger(__name__).warning("启动临期扫描失败: %s", e)


@app.get("/health/live")
def health_live():
    return {"data": {"status": "ok"}, "error": None, "request_id": "live"}


@app.get("/health/ready")
def health_ready():
    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        return {"data": {"status": "ready", "db": "ok"}, "error": None, "request_id": "ready"}
    except Exception as e:  # noqa: BLE001
        return JSONResponse(status_code=503, content={
            "data": None, "error": {"code": "DB_UNAVAILABLE", "message": str(e), "details": {}},
            "request_id": "ready"})


for r in (auth_router.router, users_router.router, foods_router.router, pantry_router.router,
          shopping_router.router, meals_router.router, plans_router.router, habits_router.router,
          agent_router.router, privacy_router.router, version_router.router,
          recognition_router.router):
    app.include_router(r, prefix="/api/v1")
app.include_router(mcp_router.router, prefix="/api/v1")
app.include_router(mcp_router.router)  # also expose /mcp at root

# Serve the real frontend (frontend/ at repo root) at / so login + all pages
# work same-origin (session cookie + CSRF). Mounted last so /api/* wins.
_FRONTEND_DIR = Path(__file__).resolve().parents[2] / "frontend"
if _FRONTEND_DIR.joinpath("index.html").exists():
    app.mount("/", StaticFiles(directory=str(_FRONTEND_DIR), html=True), name="frontend")
