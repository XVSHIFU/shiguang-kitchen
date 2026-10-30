#!/usr/bin/env bash
# Linux 快速启动。以 --no-seed 启动已准备好数据的实例。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PY=python3.12
command -v "$PY" >/dev/null || PY=python3
VENV="$ROOT/backend/.venv"
if [ ! -x "$VENV/bin/python" ]; then
    "$PY" -m venv "$VENV"
fi
"$VENV/bin/python" -m pip install -r backend/requirements.txt

seed=(--demo)
for option in "$@"; do
    case "$option" in
        --demo|--no-seed) seed=() ;;
    esac
done
exec "$VENV/bin/python" scripts/run_local.py --host "${HOST:-127.0.0.1}" --port "${PORT:-8014}" "${seed[@]}" "$@"
