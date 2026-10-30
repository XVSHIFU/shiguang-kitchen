# 静态服务说明

默认通过 FastAPI 在 8014 提供前端与 API。同源入口可以直接使用会话 Cookie、CSRF 和 SSE。请用 [项目 README](../README.md) 的启动命令打开应用。

`backend/app/main.py` 先注册 API，再挂载 `frontend/`。前端使用哈希路由。直接双击 `index.html` 只能打开静态页面，登录及数据功能需要运行后端。

如采用反向代理，可参考 `infra/nginx/default.conf`。代理需要转发 `/api/v1/`，对 Agent SSE 事件流关闭缓冲，并把浏览器访问的页面和 API 保持在同一来源。
