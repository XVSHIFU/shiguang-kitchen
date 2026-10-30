"""Server-owned authorization for operations on the shared database."""
import re

from app.core import config


def admin_ids_path():
    return config.DATA_DIR / "server-admin-ids"


def server_admin_ids() -> frozenset[str]:
    try:
        entries = admin_ids_path().read_text(encoding="ascii").split()
    except (OSError, UnicodeError):
        return frozenset()
    if any(not re.fullmatch(r"[0-9a-f]{32}", entry) for entry in entries):
        return frozenset()
    return frozenset(entries)
