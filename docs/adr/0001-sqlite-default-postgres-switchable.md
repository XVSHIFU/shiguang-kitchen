# ADR-0001：默认 SQLite，PostgreSQL 可切换

- 状态：已采纳
- 日期：2026-11-18

## 背景

设计文档以 PostgreSQL + pgvector 为生产基线，但本项目需先在本地 Linux 单机跑通、
交付 zip；部署环境未必有 Postgres。

## 决策

- 默认 `DATABASE_URL=sqlite:///./data/app.db`（`app/db.py` 自动建 `data/` 目录）。
- `DATABASE_URL` 可切换为 `postgresql://` 或显式的 `postgresql+psycopg://`，由 psycopg 连接。
  业务表采用 SQLAlchemy 通用类型。PostgreSQL 换餐审批使用 LangGraph 的检查点表。
- Alembic 迁移以 `Base.metadata.create_all` 为初始迁移（0001），后续迁移手写。

## 后果

- 优点：零依赖启动、测试用临时文件 SQLite 即可；切换 Postgres 只改一个环境变量。
- 代价：SQLite 下无行级锁 `FOR UPDATE` 的等价语义，并发写依赖应用层事务与唯一键；
  切 Postgres 后需回归并发测试。pgvector 需另加可选列/扩展，不在默认路径。
