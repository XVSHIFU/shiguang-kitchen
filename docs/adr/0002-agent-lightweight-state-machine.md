# ADR-0002：Agent 不用 LangGraph，用轻量自研状态机

- 状态：适用于单机 SQLite 和其他现有流程。PostgreSQL 换餐审批已接入 LangGraph。
- 日期：2026-11-18

## 背景

设计文档 ADR-04 指定 LangGraph 为唯一 Agent 运行时（含 checkpoint / interrupt）。
但本后端以“先跑通、可测试”为首要目标：LangGraph 的图、checkpoint schema、
interrupt 恢复语义会显著增加依赖与调试成本，且其 checkpoint 表与业务库耦合。

## 决策

- 用自研状态机实现 Agent（`app/agents/engine.py`）：路由 → 只读工具 → 提议 action
  → `waiting_approval` → 用户决策 → 服务端事务提交。
- 状态全部持久化在业务表（`agent_threads` / `agent_runs` / `agent_run_events` /
  `agent_actions` / `approvals`），与设计文档 §8 的状态机、事件类型、
  审批协议（payload_hash + expected_version + 幂等提交）对齐。
- SSE 回放直接读 `agent_run_events`（`seq_no` 单调），不依赖 Redis Pub/Sub。

## 后果

- 优点：无额外运行时依赖；审批、幂等、恢复逻辑可直接用 pytest 覆盖；
  行为与 LangGraph 方案在接口层面等价（run/action/event 模型一致）。
- 代价：放弃 LangGraph 的 checkpoint/断点续跑能力；长流程中断恢复需自行保证
  （当前 run 为同步执行 + DB 事件回放，重启后可从事件与 action 状态恢复，
  但执行中的 run 不跨进程续跑）。如未来需要多步长时任务，再评估引入 LangGraph，
  届时以本表结构为迁移基线。

## PostgreSQL 换餐审批

每张换餐修改单在 PostgreSQL 保存自己的 LangGraph 检查点，和提议记录一起提交。审批接口校验用户、载荷和有效期后，沿原检查点恢复。检查点和业务服务共用事务，提交中断会一起回滚，保留原待审批状态。原有 SSE 仍从业务事件表读取。
