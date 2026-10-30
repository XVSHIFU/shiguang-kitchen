# 前端开发说明

这套界面使用 HTML、CSS 和原生 JavaScript。FastAPI 从同一端口提供静态文件、API 和 SSE 事件流。启动后打开 [http://127.0.0.1:8014/](http://127.0.0.1:8014/) 即可使用。具体启动命令见 [项目 README](../README.md)。

| 文件 | 用途 |
| --- | --- |
| `index.html` | 入口、脚本加载顺序和静态资源版本。 |
| `styles.css` | 全站主题令牌、桌面和手机布局。 |
| `app.js`、`data.js`、`api.js` | 页面交互、数据适配和 API 请求。 |
| `chat-ui.js`、`chat-ui.css`、`agent.js` | 对话、Markdown 和 SSE 事件消费。 |
| `taste.js`、`taste.css` | 美食转盘、盲牌和美食详情。 |
| `weekly.js` | 周报和导出。 |
| `assets/`、`vendor/` | 食材插画、食物图片和随包依赖。 |

浅色主题的焦橙、蜂蜜黄和浅米灰由 `styles.css` 管理，深色主题共享相同的语义。改颜色请复用主题令牌。发布改过的静态文件时，在 `index.html` 更新它的资源版本。

从根目录执行 `python frontend/tests/smoke_check.py` 可检查前端结构与接口调用约定。安装 Node.js 后，检查还会运行脚本语法校验。

[静态服务说明](STATIC_SERVING.md)
