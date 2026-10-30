# ADR-0006：Celery + Redis 可配，Redis 不可用时不阻塞 CRUD

- 状态：已采纳
- 日期：2026-11-18

## 背景

设计文档 §11 以 Celery + Redis Broker、PostgreSQL Task Ledger/Outbox 为事实来源；
Redis 故障只应影响任务分发，不能拖垮普通 CRUD。

## 决策

- Celery app（`app/tasks.py`）的 broker/result backend 均由 `CELERY_BROKER_URL` /
  `CELERY_RESULT_BACKEND` 配置，默认 `redis://localhost:6379/0`。
- 任务（`weekly_report` / `expiry_scan`）每次执行都新建独立 DB Session，
  先读 `automation_policies` 与任务表状态再决定是否写入；任务表是事实来源。
- `CELERY_EAGER=true` 时任务同步执行（`task_always_eager`），无 Redis 也能冒烟；
  API 进程启动不连接 Redis，Celery 绝不是启动阻塞项。
- Outbox 表与业务写在同一事务；`dispatch_outbox` 任务负责标记发布。

## 后果

- 优点：本地无 Redis 也能完整跑通 API 与测试；部署 Redis 后只需改环境变量。
- 代价：eager 模式下任务与请求同进程执行，不适合耗时任务；生产必须配 Redis
  并跑独立 worker/beat。
