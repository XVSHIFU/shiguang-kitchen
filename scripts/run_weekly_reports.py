#!/usr/bin/env python3
"""Generate the latest due weekly reports for active users who opted in."""
import argparse
import logging
import sys
from datetime import datetime
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
load_dotenv(ROOT / ".env")
sys.path.insert(0, str(ROOT / "backend"))

from app.application.weekly_reports import REPORT_TIMEZONE, generate_automatic_report, latest_due_week
from app.db import SessionLocal
from app.models import AutomationPolicy, User


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--as-of", type=datetime.fromisoformat, help="Timezone-aware ISO timestamp")
    args = parser.parse_args()
    if args.as_of is not None and args.as_of.utcoffset() is None:
        parser.error("--as-of requires a timezone offset")
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    start = latest_due_week(args.as_of or datetime.now(REPORT_TIMEZONE))
    with SessionLocal() as db:
        users = [uid for (uid,) in db.query(User.id).join(AutomationPolicy).filter(
            User.status == "active",
            AutomationPolicy.task_kind == "weekly_report",
            AutomationPolicy.mode == "auto",
        )]
    generated = duplicate = failed = 0
    for user_id in users:
        try:
            with SessionLocal() as db:
                result = generate_automatic_report(db, user_id, start)
            if result["status"] == "completed":
                if result.get("duplicated"):
                    duplicate += 1
                else:
                    generated += 1
        except Exception:
            failed += 1
            logging.exception("Weekly report failed for user %s", user_id)
    logging.info(
        "Weekly report %s: %s generated, %s already completed, %s failed",
        start, generated, duplicate, failed,
    )
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
