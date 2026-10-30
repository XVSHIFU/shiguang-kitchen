# API 契约（前后端唯一事实来源，OpenAPI 以 FastAPI /openapi.json 为准）

Base: /api/v1 ; Envelope: success {"data":..., "error":null, "request_id":...} ; failure {"data":null,"error":{"code":...,"message":...,"details":{}},"request_id":...}
Auth: HttpOnly SameSite=Lax session cookie `session_id` + CSRF header `X-CSRF-Token` (GET /api/v1/auth/csrf returns token in JSON + cookie `csrf_token`). 改变状态的请求必须带 CSRF；登录/注册除外（但仍建议带）。密码：bcrypt（passlib）/ argon2 可用时优先 argon2id，hash 存 password_hash。
Decimal: JSON 中金额/重量用字符串。
Idempotency: 改变状态的 POST 建议带 Idempotency-Key；库存消耗/收货/计划提交服务端按 (user, source_type, source_id, kind) 去重，重复返回原结果，不重复扣减。

## 路由
- POST /auth/register {email,password,name?} -> {user:{id,email,name}} 201
- POST /auth/login {email,password} -> {user} + set cookie
- POST /auth/logout -> {}
- GET /auth/csrf -> {csrf_token}
- GET /auth/me -> {user, profile, restrictions}
- GET/PATCH /users/me {name, timezone, locale, max_cook_minutes, people, equipment[], taste[]}
- GET/POST/PATCH/DELETE /users/me/restrictions {kind: allergy|avoid|pref, label, keys[], hard}
- GET /foods -> [{id,code,name,unit,piece_g,density_g_ml,allergens[],tags[],nutrients:{kcal,protein,fat,carbs}|null, nutrient_missing:bool}] ; GET /foods/{id}
- GET /recipes?q=&slot=&max_minutes=&exclude_allergen=&favorite_only= -> list ; GET /recipes/{id} {ingredients:[{food_id,amount,unit,optional}], steps:[{text,seconds}], servings, cook_minutes, difficulty, equipment[], slots[], source} ; POST /recipes/{id}/favorite ; DELETE same
- GET/POST /pantry/batches {food_id,qty,unit,expires_on,location,purchased_on} ; GET /pantry/batches/{id} ; GET /pantry/movements ; POST /pantry/consumptions {batch_id?,food_id,amount,unit,reason,source_type,source_id,idempotency_key} FEFO 默认按 food_id 扣最早到期批次；POST /pantry/adjustments {batch_id,delta,reason}
- GET/POST/PATCH/DELETE /shopping/items ; POST /shopping/items/{id}/receive {qty?,expires_on?,location?} -> 入库批次；POST /shopping/recompute {plan_id?}
- GET/POST/PATCH/DELETE /meals {date,slot,items:[{food_id,amount,unit}|{recipe_id,servings}],note,consume_from_pantry:bool} ; nutrition 在服务端用 Decimal 计算，返回 {kcal,protein,fat,carbs, completeness: full|partial|unknown, unknown_items:[]}
- POST /nutrition/estimate {items:[...]} -> 同上营养结果
- POST /plans/drafts {period_start,days:1|3|7,meal_slots[],constraints:{max_cook_minutes,equipment[],avoid_food_ids[]},use_pantry:true} -> {draft_id,meals:[{local_date,slot,recipe_id,servings}],shopping_projection:[{food_id,needed,available,gap,unit}],hard_violations:[],nutrition_completeness}
- GET /plans ; GET /plans/{id} {active_version, versions:[{v,reason,at,meals}]} ; POST /plans/{id}/commit {draft_id} -> {plan_id, active_version} ; POST /plans/{id}/replace-meal {expected_version,target:{local_date,slot},replacement:{recipe_id,servings}} 409 CONFLICT on version mismatch ; POST /plans/{id}/restore-version {version}
- GET/POST/PATCH/DELETE /habits/records {kind: water|sleep|steps|weight|custom, date, value, unit?} ; GET /habits/summary?from&to
- GET /reports ; POST /reports/generate {week_start} -> {report:{metrics:{record_rate,plan_rate,record_days,missing_days,avg_kcal,avg_protein,water_avg,sleep_avg,steps_avg,kcal_by_day[]}, text, status}} ; GET /reports/{id}/export -> markdown text
- GET/POST /agent/threads ; POST /agent/threads/{id}/runs {message} -> {run_id, events_url} ; GET /agent/runs/{id} ; GET /agent/runs/{id}/events (SSE, event types run.started/message.delta/tool.started/tool.completed/approval.required/action.committed/run.completed/run.failed) ; POST /agent/runs/{id}/actions/{action_id}/decision {decision:approve|reject, shown_payload_hash} ; POST /agent/runs/{id}/cancel
- GET/PUT /automation/policies {weekly_report:off|observe|auto, expiry:..., habit_review:...} ; GET /automation/tasks
- GET /notifications ; POST /notifications/{id}/read
- POST /privacy/export -> {download_url|content} ; DELETE /privacy/account {password} -> 软删除+清理
- GET /health/live ; GET /health/ready
- GET /mcp (Streamable HTTP, 见 docs) ; MCP tools: get_my_pantry, search_my_recipes, get_my_meal_plan, search_food_knowledge, propose_shopping_items, request_plan_change (后两者只建草稿/审批)
- GET /search?q= (BM25 关键词检索菜谱/知识，返回带 source 的结果；营养数字不走向量)

## 种子数据（与 MVP 一致）
食物 35 种（egg/tomato/oil/chicken/peanut/cucumber/broccoli/garlic/salmon/lemon/oats/milk/banana/rice/pork/pidan/tofu/doubanjiang/beef/potato/carrot/shrimp/pasta/bread/lettuce/shiitake/bokchoy/soy/yogurt/blueberry/ribs/wmelon/noodles/scallion/cilantro），营养 per100g 同 MVP（pidan/doubanjiang 为 null=unknown），过敏原/标签同 MVP。
菜谱 16 个（r_tomegg, r_kungpao, r_broc, r_salmon, r_oat, r_congee, r_mapo, r_beef, r_shrimp, r_sandwich, r_bokchoy, r_teriyaki, r_yogurt, r_ribs, r_scallion, r_cucumber），配料/步骤/份数/设备/餐次同 MVP。
默认账号：demo@example.com / Demo1234! ，名 小满，限制：花生过敏（硬）、香菜回避（硬）、少油少辣；设备 灶台/电饭煲/微波炉；max_cook 35。
种子库存、计划 v1/v2、记餐、习惯、周报、购物：按 MVP seed() 相对今天动态生成（见 backend/app/seed.py 规范：以 seed 当天为基准，鸡蛋 8+3、番茄3、鸡腿600g 等，计划周一到周日早/午/晚，周五午餐 v2 换成蒜蓉虾仁意面）。
营养计算：N = m(g)/100 * P(per100g)，Decimal；ml 需 density 才能转 g（油 0.92，牛奶 1.03），否则 unknown；piece 需 piece_g；缺失标 unknown/partial。
过敏硬拦截：菜谱含用户硬限制 keys（过敏原/名称/标签命中）时，计划生成与 Agent 替换必须排除，API 返回 hard_violations 或 422 ALLERGY_BLOCKED。

## 应用信息与数据管理接口
- GET /api/v1/version（公开，无需登录）-> {version, commit, agent_provider: "rule"|"llm", agent_model: string|null, recognition_available: bool}；commit 取不到时为 "dev"；agent_provider 有 MODEL_API_KEY 时为 "llm" 否则为 "rule"。
- POST /api/v1/privacy/backup（需登录 + CSRF）-> 下载 .db 文件（文件名 `ai-life-agent-backup-YYYYMMDD.db`，内容为 SQLite 一致性快照，不含 .env/密钥）；Postgres 部署返回 501。
- POST /api/v1/privacy/restore（需登录 + CSRF，multipart，字段名 "file"）-> {restored: true, backup: "app.db.bak-<YYYYMMDD-HHMMSS>", message: "已恢复备份，请重启服务生效"}；校验失败（非 SQLite 文件头、缺核心表 users/foods/pantry_batches/habit_records/meal_records、users 表为空）返回 422 且不碰原库；恢复前先把当前库快照为 bak 文件（保留不删），恢复后需重启服务生效。
- POST /api/v1/habits/import（需登录 + CSRF，multipart，字段名 "file"，限 10MB）-> {imported: n, skipped: n, failed: [{line, reason}]}；接受 Apple 健康 export.xml（步数累加、睡眠仅统计 Asleep 样本时长换算小时、体重取当天最后一条，其他类型忽略；日期取 startDate 本地日期）或 CSV（表头 date,kind,value；kind 限 water/sleep/steps/weight，单位 water ml、sleep 小时、steps 步、weight kg）；按（日期 + 种类）去重覆盖，同一天同一习惯只留一条记录，导入值为当天总量（water 也不累加到旧值上）；source 写 "import"；整行解析失败只记 failed，不中断导入；不支持的文件类型返回 422。
- GET /api/v1/pantry/expiring?days=3（需登录）-> [{batch_id, food_id, food_name, remaining（数量未知时为 null）, unit, expires_on, days_left, location}]；仅含剩余量 >0（或数量未知）且 expires_on 在今天到今天+days 天内的批次，按 days_left 升序；已过期批次不出现。副作用：调用的同时按“同一用户、同一批次、同一天只发一条”写入临期通知（kind="expiry"，text `临期提醒：{food_name} 将在 {days_left} 天后到期（{expires_on}）`，link="#/pantry"）；AutomationPolicy task_kind="expiry" 为 off 的用户不发通知，policy 不存在时默认发。默认天数由 EXPIRY_WARN_DAYS 环境变量控制（默认 3），定时任务 expiry_scan 与启动时扫描用同一规则。
- POST /api/v1/recognition/image（multipart，字段名 file, target）-> 见识别契约（识别同事负责实现）。
- POST /api/v1/agent/test-connection -> {ok, model?, error?}（Agent 测试接口，见 Agent 契约）。
