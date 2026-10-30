"""Core config. Env vars override defaults; no secrets are hardcoded."""
import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parents[2]  # backend/
DATA_DIR = Path(os.environ.get("DATA_DIR", BASE_DIR / "data"))
DATABASE_URL = os.environ.get("DATABASE_URL", f"sqlite:///{DATA_DIR / 'app.db'}")
if DATABASE_URL.startswith("postgresql://"):
    DATABASE_URL = "postgresql+psycopg://" + DATABASE_URL.removeprefix("postgresql://")
SECRET_KEY = os.environ.get("SECRET_KEY", "dev-secret-change-me")
MODEL_API_KEY = os.environ.get("MODEL_API_KEY", "")
MODEL_BASE_URL = os.environ.get("MODEL_BASE_URL", "https://api.deepseek.com")
MODEL_NAME = os.environ.get("MODEL_NAME", "deepseek-chat")
EMBEDDING_API_KEY = os.environ.get("EMBEDDING_API_KEY", "")
EMBEDDING_BASE_URL = os.environ.get("EMBEDDING_BASE_URL", "")
EMBEDDING_MODEL = os.environ.get("EMBEDDING_MODEL", "")
EMBEDDING_DIMENSION = int(os.environ.get("EMBEDDING_DIMENSION", "0") or 0)
MODEL_VISION_NAME = os.environ.get("MODEL_VISION_NAME", "")
EXPIRY_WARN_DAYS = int(os.environ.get("EXPIRY_WARN_DAYS", "3"))
CELERY_BROKER_URL = os.environ.get("CELERY_BROKER_URL", "redis://localhost:6379/0")
CELERY_RESULT_BACKEND = os.environ.get("CELERY_RESULT_BACKEND", "redis://localhost:6379/0")
CELERY_EAGER = os.environ.get("CELERY_EAGER", "false").lower() in ("1", "true", "yes")
SESSION_TTL_SECONDS = 7 * 24 * 3600
CSRF_TTL_SECONDS = 7 * 24 * 3600
