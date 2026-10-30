# 后端开发说明

后端是 FastAPI 模块化单体。SQLite 为默认数据库，SQLAlchemy 管理事务与模型，Alembic 管理迁移。完整的用户启动步骤见 [项目 README](../README.md)。

## 开发与验证

从项目根目录、在已装好依赖的虚拟环境中运行：

```bash
python scripts/run_local.py --demo
python -m pytest backend/tests
python scripts/smoke_test.py
```

应用启动后可通过 [OpenAPI 文档](http://127.0.0.1:8014/docs) 查看当前路由和参数。[API 契约](../API_CONTRACT.md) 记录核心业务接口与历史示例。

`scripts/smoke_test.py` 默认启动独立的临时 SQLite 测试流程。带 `--base-url` 时会在指定实例注册测试用户并写入业务记录，适用于测试实例。

## PostgreSQL 换餐审批

在单独的空 PostgreSQL 测试库上设置 `SHIGUANG_TEST_POSTGRES_URL`，从项目根目录执行 `python -m pytest -q backend/tests/test_postgres_approval.py`。测试运行 Alembic 迁移，使用多个后端进程验证审批重启恢复、提交中断回滚、并发重复审批和版本冲突。测试库中会保留用到的表和样例记录。

## 模块入口

| 目录 | 职责 |
| --- | --- |
| `app/api/v1/` | HTTP 接口、认证、Agent 事件与审批、备份。 |
| `app/application/` | 库存幂等、计划版本、确定性营养统计、周报。 |
| `app/agents/` | 模型与规则模式、会话上下文、工具和提议。 |
| `app/rag/` | BM25、公开参考资料和来源信息。 |
| `app/models.py` | SQLAlchemy 实体。 |
| `migrations/` | 数据库迁移。 |
| `tests/` | 核心业务与失败分支测试。 |

[项目技术说明](../docs/PROJECT_TECHNICAL.md) · [Linux 部署与运维](../deploy/LOCAL_LINUX.md)
