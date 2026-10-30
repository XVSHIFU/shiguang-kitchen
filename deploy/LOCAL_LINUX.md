# Linux 部署与运维

本指南使用 Python 3.12、SQLite 和一个监听 8014 的 Uvicorn 进程。配置和数据库路径由项目根目录的 `.env` 统一管理。

## 初始化

在计划用于部署的机器上进入项目根目录。以下命令为新实例建立本地数据库和共享食材、菜谱目录。启动后在浏览器注册自己的账号。

```bash
python3.12 -m venv backend/.venv
backend/.venv/bin/python -m pip install -r backend/requirements.txt
backend/.venv/bin/python scripts/run_local.py
```

入口为 [http://127.0.0.1:8014/](http://127.0.0.1:8014/)，健康检查为 [http://127.0.0.1:8014/health/ready](http://127.0.0.1:8014/health/ready)。局域网部署可在启动命令后加 `--host 0.0.0.0`，再通过服务器的局域网地址打开 8014。演示模式用 `--demo` 启动，适合独立的体验实例。

## 交给 systemd 常驻

示例单元使用安装目录 `/opt/ai-life-agent` 和专用账号 `ai-life`。先以该账号完成上一节的初始化，并确认它能读取配置和写入数据目录。使用其他路径或账号时，对应修改两个服务单元中的 `User`、`Group`、`WorkingDirectory`、`EnvironmentFile` 和 `ExecStart`。

前台验证成功后用 Ctrl+C 停止前台进程，从安装目录执行：

```bash
sudo install -m 0644 deploy/ai-life-agent.service /etc/systemd/system/
sudo install -m 0644 scripts/systemd/shiguang-weekly-8014.service scripts/systemd/shiguang-weekly-8014.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ai-life-agent.service
sudo systemctl enable --now shiguang-weekly-8014.timer
systemctl status ai-life-agent.service
systemctl list-timers shiguang-weekly-8014.timer
```

在应用的「设置 → 主动任务授权」把每周周报设为「自动」。定时器在每周日北京时间 20:00 运行，为获授权账号生成周报和一条站内通知。重跑同一周时不会重复生成通知。服务的执行记录可用 `journalctl -u shiguang-weekly-8014.service` 查看。

## 管理员与备份

在首次创建服务器管理员前停止 Web 服务。以安装该项目的服务账号，在项目目录执行：

```bash
backend/.venv/bin/python scripts/provision_server_admin.py --credentials-file /path/owned-by-service-user/admin-login.txt
```

把示例路径换成服务账号可写的私有位置。脚本生成管理员账号的初始登录信息，授权文件放在 `DATA_DIR` 下。登录文件和授权文件的权限为 `0600`。启动 Web 服务后，管理员可在「设置 → 隐私与数据」下载或恢复 SQLite 整库备份。恢复会先备份当前库并要求重新登录。

备份实例可分别保存 SQLite 快照、根目录 `.env` 和管理员授权文件。升级前留好快照，使用 `scripts/run_local.py --no-seed` 执行迁移并验证健康检查，再恢复 systemd 常驻。

## 备选容器配置

`compose.yaml`、`backend/Dockerfile` 和 `infra/nginx/default.conf` 提供 PostgreSQL、Redis 和 Nginx 的部署参考。PostgreSQL 的换餐审批已有独立集成检查，Compose 整套部署与 Celery Beat 调度仍需在目标服务器验收。单机自动周报使用本文的 systemd 定时器。[PostgreSQL 验证方法](../backend/README.md#postgresql-换餐审批)
