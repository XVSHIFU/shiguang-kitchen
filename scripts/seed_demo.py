#!/usr/bin/env python3
"""Initialize example content, or only publish the shared food and recipe catalog."""
import argparse
import sys
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
load_dotenv(ROOT / ".env")
sys.path.insert(0, str(ROOT / "backend"))

from app.db import SessionLocal, init_db
from app.seed import seed_all


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--catalog-only", action="store_true", help="Load catalog without a demo account")
    args = parser.parse_args()
    init_db()
    with SessionLocal() as db:
        print(seed_all(db, demo=not args.catalog_only))
