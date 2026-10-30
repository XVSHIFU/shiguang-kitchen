"""Version endpoint (public): app version, git commit, agent/recognition availability."""
import subprocess
from pathlib import Path

from fastapi import APIRouter

from app.agents import llm
from app.core import config
from app.core.errors import ok

router = APIRouter(tags=["version"])


def _repo_root() -> Path:
    # version.py lives at backend/app/api/v1/ -> repo root is parents[4];
    # walk up as a fallback so the lookup survives a moved checkout.
    for parent in Path(__file__).resolve().parents:
        if (parent / "VERSION").is_file():
            return parent
    return Path(__file__).resolve().parents[4]


def read_version() -> str:
    try:
        return (_repo_root() / "VERSION").read_text(encoding="utf-8").strip()
    except OSError:
        return "0.2.0"


def read_commit() -> str:
    """Short git commit; never raises — "dev" when git is unavailable."""
    try:
        proc = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=str(_repo_root()), capture_output=True, text=True, timeout=2,
        )
        commit = proc.stdout.strip()
        return commit if proc.returncode == 0 and commit else "dev"
    except Exception:  # noqa: BLE001 - any git/subprocess failure means "dev"
        return "dev"


@router.get("/version")
def get_version():
    available = llm.provider_available()
    return ok({
        "version": read_version(),
        "commit": read_commit(),
        "agent_provider": "llm" if available else "rule",
        "agent_model": config.MODEL_NAME if available else None,
        "recognition_available": bool(available),
        "agent_thinking_available": llm.thinking_available(),
    })
