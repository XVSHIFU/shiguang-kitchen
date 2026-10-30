#!/usr/bin/env python3
"""前端 smoke 检查（无后端依赖，纯静态 + node --check）。

用法：python3 frontend/tests/smoke_check.py
退出码 0 = 全部通过；非 0 = 有失败项（逐项打印）。

检查内容：
 1. 必备文件齐全；2. JS 语法（node --check）；3. 全站零 emoji；
 4. localStorage 只有主题偏好（aichef_theme），无业务 key；
 5. 所有 fetch 都在 api.js 内；6. API 路径统一走 /api/v1；
 7. CSRF 逻辑存在；8. 无硬编码密钥（演示账号除外）；
 9. 全部页面齐全（与 MVP 一一对应 + 登录页）；10. 契约端点覆盖；
 11. 本地模拟层已移除；12. index.html 正确引用四个脚本与样式。
"""
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
FAILURES = []
PASSES = []


def check(name, ok, detail=""):
    (PASSES if ok else FAILURES).append(name)
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f" — {detail}" if detail and not ok else ""))


def read(p):
    return (ROOT / p).read_text(encoding="utf-8")


def main():
    files = ["index.html", "styles.css", "api.js", "data.js", "app.js", "agent.js"]
    check("必备文件齐全", all((ROOT / f).exists() for f in files),
          f"缺失：{[f for f in files if not (ROOT / f).exists()]}")

    # 2. JS 语法
    try:
        node = subprocess.run(["node", "--version"], capture_output=True, text=True)
        if node.returncode == 0:
            bad = []
            for f in ["api.js", "data.js", "app.js", "agent.js"]:
                r = subprocess.run(["node", "--check", str(ROOT / f)], capture_output=True, text=True)
                if r.returncode != 0:
                    bad.append(f"{f}: {r.stderr.strip()[:200]}")
            check("JS 语法 node --check", not bad, "; ".join(bad))
        else:
            check("JS 语法 node --check", False, "node 不可用")
    except FileNotFoundError:
        check("JS 语法 node --check", False, "node 不可用")

    texts = {f: read(f) for f in files}

    # 3. 零 emoji（图标一律用 SVG glyph）
    emoji = re.compile(r"[\U0001F000-\U0001FAFF\u2600-\u27BF\u2B00-\u2BFF\uFE0F\u200D]")
    hits = {f: emoji.findall(t) for f, t in texts.items()}
    hits = {f: v for f, v in hits.items() if v}
    check("全站零 emoji", not hits, f"{hits}")

    # 4. localStorage 只有主题偏好
    check("无 localStorage 业务 key（aichef_demo_*）",
          "aichef_demo" not in "".join(texts.values()))
    ls_uses = []
    for f, t in texts.items():
        for m in re.finditer(r"localStorage\.\w+\('([^']+)'", t):
            ls_uses.append((f, m.group(1)))
    check("localStorage 只存主题偏好 aichef_theme",
          all(k == "aichef_theme" for _, k in ls_uses), f"{ls_uses}")

    # 5. fetch 只在 api.js
    fetch_outside = [f for f, t in texts.items() if f != "api.js" and "fetch(" in t]
    check("所有 fetch 都在 api.js 内", not fetch_outside, f"{fetch_outside}")

    # 6. API 路径统一走 /api/v1
    check("api.js 定义 API_BASE = '/api/v1'", "API_BASE = '/api/v1'" in texts["api.js"])
    api_elsewhere = [f for f, t in texts.items()
                     if f != "api.js" and re.search(r"/api/v\d", t)]
    check("其它文件不直写 /api/vN 路径", not api_elsewhere, f"{api_elsewhere}")

    # 7. CSRF
    check("CSRF：取 token（GET /auth/csrf）", "/auth/csrf" in texts["api.js"])
    check("CSRF：写请求带 X-CSRF-Token", "X-CSRF-Token" in texts["api.js"])

    # 8. 无硬编码密钥（演示账号 Demo1234! 除外：它是契约种子账号，仅用于一键填入）
    secrets = []
    for f, t in texts.items():
        for pat in [r"sk-[A-Za-z0-9]{8,}", r"api[_-]?key\s*[:=]\s*['\"][^'\"]{8,}"]:
            if re.search(pat, t, re.I):
                secrets.append((f, pat))
    demo_uses = [f for f, t in texts.items() if "Demo1234!" in t]
    check("无硬编码密钥（sk- / api_key）", not secrets, f"{secrets}")
    check("演示密码只出现在 data.js（一键填入）",
          demo_uses == ["data.js"], f"{demo_uses}")

    # 9. 页面齐全：与 MVP 一一对应 + 新增登录页
    routes = ["home", "assistant", "plan", "pantry", "recipes", "shopping",
              "meals", "habits", "reports", "settings"]
    missing_pages = [r for r in routes if f"PAGES.{r} =" not in texts["app.js"]]
    check("页面齐全（10 个 MVP 页面）", not missing_pages, f"缺失：{missing_pages}")
    check("登录/注册页存在", "renderAuthPage" in texts["data.js"]
          and "fillDemo" in texts["data.js"])

    # 10. 契约端点覆盖（API_CONTRACT.md 路由表）
    contract_paths = [
        "/auth/register", "/auth/login", "/auth/logout", "/auth/csrf", "/auth/me",
        "/users/me", "/users/me/restrictions",
        "/foods", "/recipes", "/recipes/{id}/favorite",
        "/pantry/batches", "/pantry/movements", "/pantry/consumptions", "/pantry/adjustments",
        "/shopping/items", "/shopping/items/{id}/receive", "/shopping/recompute",
        "/meals", "/nutrition/estimate",
        "/plans/drafts", "/plans", "/plans/{id}/commit",
        "/plans/{id}/replace-meal", "/plans/{id}/restore-version",
        "/habits/records", "/habits/summary",
        "/reports", "/reports/generate", "/reports/{id}/export",
        "/agent/threads", "/agent/threads/{id}/runs",
        "/agent/runs/{id}/events", "/agent/runs/{id}/actions/{action_id}/decision",
        "/agent/runs/{id}/cancel",
        "/automation/policies", "/automation/tasks",
        "/notifications", "/notifications/{id}/read",
        "/privacy/export", "/privacy/account",
        "/health/live", "/health/ready",
    ]
    api = texts["api.js"]
    missing = []
    for p in contract_paths:
        # 路径含 {id} 等参数：按分段检查（api.js 里是 '/x/' + encodeURIComponent(id) + '/y' 拼接）
        segs = [s for s in p.split("/") if s and not s.startswith("{")]
        if not all(s in api for s in segs):
            missing.append(p)
    check("契约端点覆盖（api.js）", not missing, f"缺失：{missing}")

    # 11. 本地模拟层已移除（agent.js 的 runAgent 是真实 SSE 版，不在此列）
    sim_markers = ["function seed(", "function load(", "function save(",
                   "LS_KEY", "S.idem", "INTENTS", "mkAction", "weekMetrics("]
    present = [m for m in sim_markers
               if m in texts["app.js"] or m in texts["data.js"] or m in texts["agent.js"]]
    check("本地模拟层已移除（seed/load/save/INTENTS/mkAction）", not present, f"{present}")

    # 12. index.html 引用
    idx = texts["index.html"]
    check("index.html 引用 styles.css + 四个脚本",
          all(s in idx for s in ["styles.css", "api.js", "data.js", "app.js", "agent.js"]))

    print(f"\n{PASSES.__len__()} 通过，{FAILURES.__len__()} 失败")
    if FAILURES:
        print("失败项：")
        for f in FAILURES:
            print(" -", f)
        sys.exit(1)
    print("SMOKE OK")


if __name__ == "__main__":
    main()
