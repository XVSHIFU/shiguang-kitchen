"""Prepare the local database and run the same-origin application."""
import argparse
import os
from pathlib import Path
import sys

from dotenv import load_dotenv


ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8014)
    seed = parser.add_mutually_exclusive_group()
    seed.add_argument("--demo", action="store_true", help="Add the demonstration account and records")
    seed.add_argument("--no-seed", action="store_true", help="Leave the existing catalog untouched")
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("port must be between 1 and 65535")

    os.chdir(ROOT)
    env_path = ROOT / ".env"
    if not env_path.is_file():
        try:
            fd = os.open(env_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            pass
        else:
            with os.fdopen(fd, "wb") as destination:
                destination.write((ROOT / ".env.example").read_bytes())
    load_dotenv(env_path)

    from alembic import command
    from alembic.config import Config

    sys.path.insert(0, str(BACKEND))
    command.upgrade(Config(str(BACKEND / "alembic.ini")), "head")

    if not args.no_seed:
        from app.db import SessionLocal
        from app.seed import seed_all

        with SessionLocal() as db:
            summary = seed_all(db, demo=args.demo)
        print("Catalog ready:", summary, flush=True)

    import uvicorn

    uvicorn.run("app.main:app", host=args.host, port=args.port)


if __name__ == "__main__":
    main()
