# syntax=docker/dockerfile:1
# AI 饮食与健康生活管家 — 前端纯静态镜像（备用，不参与 Compose）
#
# Compose 部署（形态 A）不使用本镜像：web 服务直接用 nginx:1.27-alpine
# 镜像 + infra/nginx/default.conf，静态文件以只读挂载方式 served，
# /api/ 与 /mcp 反代到 api 服务；api 服务自身也挂载了 frontend/
# （形态 B 单机 uvicorn 时由 FastAPI 直接 serve）。
#
# 本镜像只在“只要静态文件、不要后端”的场合用，例如把前端单独放到
# 已有反代后面。构建（上下文为 frontend/ 目录）：
#   docker build -f frontend/Dockerfile -t ai-life-frontend frontend/
# 注意：前端用相对路径调 /api/v1，单独部署时必须由
# 前面的反代把 /api/ 与 /mcp 指到后端，否则登录与业务请求会失败；
# 不要直接把本镜像的 80 端口暴露给用户当作完整应用。

FROM nginx:1.27-alpine

COPY . /usr/share/nginx/html/

EXPOSE 80

# 使用 nginx 镜像自带的默认配置（serves /usr/share/nginx/html，
# index.html 为默认页）。需要反代 /api/ 时不要改这里，改
# infra/nginx/default.conf 并走 Compose 的 web 服务。
CMD ["nginx", "-g", "daemon off;"]
