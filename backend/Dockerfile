# syntax=docker/dockerfile:1
# AI 饮食与健康生活管家 — API / Worker / Beat 共用镜像
#
# 构建上下文必须是仓库根目录（compose.yaml 里 build.context: .），因为：
# - 后端代码在 backend/
# - FastAPI 用 StaticFiles 挂载 ../frontend（backend/app/main.py 按
#   parents[2]/frontend 解析，即镜像内的 /app/frontend），所以镜像内
#   必须同时包含 backend/ 与 frontend/
# - scripts/seed_demo.py 也一并复制，供 Compose 里做种子用
#
# 本镜像不跑迁移、不跑种子：迁移用一次性命令
#   docker compose run --rm api alembic upgrade head
# 种子用一次性命令
#   docker compose run --rm api python /app/scripts/seed_demo.py

# ---------- 构建阶段：建 venv、装依赖 ----------
FROM python:3.12-slim AS builder

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /build

# 只复制依赖清单先装依赖，利用 Docker 层缓存：改业务代码不重装依赖。
COPY backend/requirements.txt ./requirements.txt

RUN python -m venv /opt/venv \
    && /opt/venv/bin/pip install --upgrade pip \
    && /opt/venv/bin/pip install -r requirements.txt

# ---------- 运行阶段：非 root、只含运行期文件 ----------
FROM python:3.12-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH="/opt/venv/bin:$PATH" \
    DATA_DIR=/app/data

WORKDIR /app/backend

COPY --from=builder /opt/venv /opt/venv
COPY backend/ /app/backend/
COPY frontend/ /app/frontend/
COPY scripts/ /app/scripts/
COPY VERSION /app/VERSION

RUN groupadd -r app && useradd -r -g app -d /app app \
    && mkdir -p /app/data /app/backend/data \
    && chown -R app:app /app

USER app

EXPOSE 8000

# 默认命令是 API；worker / beat 在 compose.yaml 里用 command 覆盖。
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
