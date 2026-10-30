# ADR-0004：Embedding 维度未配置时禁用向量检索

- 状态：已采纳
- 日期：2026-11-18

## 背景

设计文档 §10 强调 Chat 与 Embedding 是独立能力：不能因 Chat API 存在就假设有
Embedding API；向量维度随模型而变，混用不同模型的向量会破坏排序。

## 决策

- `EMBEDDING_MODEL` / `EMBEDDING_DIMENSION` 均未配置（或维度为 0）时，向量检索
  功能整体禁用；`GET /search` 与 MCP `search_food_knowledge` 均返回 BM25 结果
  并标注 `vector_enabled: false`。
- 不做“默认维度猜测”（如默认 1536）；不把 BM25 分数冒充向量分数或可信度。
- 未来启用时：先以配置的模型做一次真实 embed 探测，核对返回维度与配置一致，
  再建索引版本并记录 `knowledge_index_versions`；维度变化必须全量重建。

## 后果

- 优点：杜绝维度失配导致的静默错误排序；降级行为对用户与调用方透明。
- 代价：在配置 embedding 之前，检索只有关键词一路。
