"""Alembic env: uses app.models metadata (single source of truth)."""
import os
import sys
from logging.config import fileConfig

from sqlalchemy import engine_from_config, pool

from alembic import context

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.core import config  # noqa: E402
from app.models import Base  # noqa: E402
from pathlib import Path  # noqa: E402

# SQLite 无法在不存在的目录里建库；先建 data 目录（zip/git 里空目录不会被打包进来）
Path(config.DATA_DIR).mkdir(parents=True, exist_ok=True)

config_alembic = context.config
config_alembic.set_main_option("sqlalchemy.url", config.DATABASE_URL.replace("%", "%%"))
if config_alembic.config_file_name is not None:
    fileConfig(config_alembic.config_file_name)

target_metadata = Base.metadata


def run_migrations_offline():
    context.configure(url=config.DATABASE_URL, target_metadata=target_metadata, literal_binds=True)
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online():
    connectable = engine_from_config(
        config_alembic.get_section(config_alembic.config_ini_section, {}),
        prefix="sqlalchemy.", poolclass=pool.NullPool)
    with connectable.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata)
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
