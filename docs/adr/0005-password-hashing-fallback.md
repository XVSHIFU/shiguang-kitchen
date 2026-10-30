# ADR-0005：密码哈希优先级 argon2id → bcrypt → pbkdf2

- 状态：已采纳
- 日期：2026-11-18

## 背景

契约要求 bcrypt（passlib）/ argon2 可用时优先 argon2id，且绝不明文存密码。
但 passlib 1.7.4 与 bcrypt 4.x 存在已知兼容问题，直接用 passlib 易在启动时报错。

## 决策

- 密码哈希实现（`app/core/security.py`）不依赖 passlib：优先 argon2-cffi
  （argon2id，存为 `argon2$…`）；不可用时用 bcrypt 直调（`bcrypt$…`）；
  两者都不可用时用 `hashlib.pbkdf2_hmac`（SHA-256，60 万次迭代，`pbkdf2$…`）。
- 校验时按存储前缀分派；三种格式互不兼容、不可互相冒充。

## 后果

- 优点：三种环境都能安全存密码；当前环境实际使用 argon2id。
- 代价：哈希格式为项目自有前缀约定，迁移到其他系统时需做格式转换；
  pbkdf2 回落路径仅作兜底，应在 README 中写明（已写）。
