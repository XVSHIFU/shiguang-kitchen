"""DB engine/session. SQLite default; DATABASE_URL can switch to postgres.
Do not hardcode Postgres: URL parsing only branches on the scheme for
connect_args (SQLite needs check_same_thread=False)."""
from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.core import config

if config.DATABASE_URL.startswith("sqlite"):
    Path(config.DATA_DIR).mkdir(parents=True, exist_ok=True)

connect_args = {"check_same_thread": False} if config.DATABASE_URL.startswith("sqlite") else {}
engine = create_engine(config.DATABASE_URL, connect_args=connect_args, future=True)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, class_=Session, future=True)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db():
    from app import models  # noqa: F401  (registers metadata)

    models.Base.metadata.create_all(bind=engine)
