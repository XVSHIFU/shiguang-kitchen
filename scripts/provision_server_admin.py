#!/usr/bin/env python3
"""Create the first server administrator and save its login to a private file."""
import argparse
import os
import secrets
import sys
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
load_dotenv(ROOT / ".env")
sys.path.insert(0, str(ROOT / "backend"))

from app.core.administration import admin_ids_path, server_admin_ids
from app.core.security import hash_password
from app.db import SessionLocal
from app.models import User, UserProfile


def write_private(path: Path, content: str):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="ascii") as file:
            file.write(content)
    except BaseException:
        path.unlink(missing_ok=True)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--email", default="admin@shiguang.local")
    parser.add_argument("--credentials-file", required=True, type=Path)
    args = parser.parse_args()
    email = args.email.strip().lower()
    if not email.isascii() or email.count("@") != 1 or any(c.isspace() for c in email):
        parser.error("provide a valid ASCII email")
    ids_file = admin_ids_path()
    with SessionLocal() as db:
        existing = db.query(User).filter_by(email=email).one_or_none()
        if existing and existing.id in server_admin_ids() and existing.status == "active":
            print("Server administrator already provisioned")
            return
        if existing or ids_file.exists():
            raise SystemExit("An account or administrator configuration already exists")
        password = secrets.token_urlsafe(32)
        user = User(email=email, password_hash=hash_password(password), name="系统管理员")
        db.add(user)
        db.flush()
        db.add(UserProfile(user_id=user.id))
        write_private(args.credentials_file, f"{email}\n{password}\n")
        try:
            write_private(ids_file, f"{user.id}\n")
        except BaseException:
            args.credentials_file.unlink(missing_ok=True)
            raise
        try:
            db.commit()
        except BaseException:
            ids_file.unlink(missing_ok=True)
            args.credentials_file.unlink(missing_ok=True)
            raise
    print("Server administrator provisioned")


if __name__ == "__main__":
    main()
