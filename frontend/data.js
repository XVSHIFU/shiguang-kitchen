'use strict';
/* =========================================================
 * data.js — 服务端数据的内存缓存、适配器与认证
 * S 是内存缓存：hydrate() 从 API 填充，刷新页面即失效，
 * 不写入 localStorage（唯一例外：主题偏好，见 app.js boot）。
 * 后端字段多为 snake_case，前端沿用 MVP 的 camelCase 内部形态，
 * 适配器做两件事：改名 + 容错（字段缺失时给默认值，不炸页面）。
 * 与契约形状不一致的地方会在 README「待联调」里逐条列出。
 * ========================================================= */

const BOOT = { state: 'loading', loadErrors: [], error: null };
let AUTHED = false;

/* ---------------- 适配器：snake_case → MVP 内部形态 ---------------- */
const RECIPE_BG = ['#f8dfd5', '#f6d6c8', '#dce8e0', '#fbe2d4', '#fbeecb', '#efe6d4', '#efe1d3', '#e6e0f1', '#e1ecef', '#f6e3c8'];

function adaptFood(f, idx) {
  const n = f.nutrients || null;
  return {
    id: f.id || f.code,
    code: f.code || f.id,
    name: f.name,
    em: '[[f:' + (f.id || f.code) + ']]',
    unit: f.unit || 'g',
    pieceG: f.piece_g ?? f.pieceG ?? null,
    density: f.density_g_ml ?? f.density ?? null,
    // 营养 per100g：[kcal, 蛋白质, 脂肪, 碳水]；null = 来源缺失，不估算
    n: n ? [n.kcal, n.protein, n.fat, n.carbs].map((v) => (v === null || v === undefined ? null : Number(v))) : null,
    al: f.allergens || [],
    tags: f.tags || [],
    nutrient_missing: !!f.nutrient_missing,
    // MVP 里豆瓣酱是“过敏原信息未知”的商业食品；契约未给单独字段，先按 code 保留
    alUnknown: (f.code || f.id) === 'doubanjiang',
  };
}

function adaptRecipe(r, idx) {
  const ing = (r.ingredients || []).map((i) => [i.food_id || i.foodId, Number(i.amount), i.optional ? 1 : 0]);
  const steps = (r.steps || []).map((s) => [s.text || s[0], Number(s.seconds ?? s[1] ?? 0)]);
  return {
    id: r.id,
    t: r.name || r.title || r.id,
    em: '[[r:' + r.id + ']]',
    bg: RECIPE_BG[(idx || 0) % RECIPE_BG.length],
    min: r.cook_minutes ?? r.min ?? 0,
    diff: r.difficulty || r.diff || '',
    serv: r.servings ?? r.serv ?? 2,
    eq: r.equipment || [],
    slots: r.slots || [],
    ing,
    steps,
    src: r.source || '',
  };
}

function adaptBatch(b) {
  const qty = b.qty ?? b.quantity ?? null;
  const remaining = b.remaining ?? null;
  const known = qty !== null && qty !== undefined || remaining !== null && remaining !== undefined;
  return {
    id: b.id,
    foodId: b.food_id || b.foodId,
    unit: b.unit || (FOODS[b.food_id || b.foodId] || {}).unit || 'g',
    original: known ? Number(qty ?? remaining) : null,
    remaining: known ? Number(remaining ?? qty) : null,
    qtyStatus: known ? 'known' : 'unknown',
    purchased: b.purchased_on || b.purchased || D.todayKey(),
    expires: b.expires_on || b.expires || null,
    location: b.location || 'fridge',
    version: b.version || 1,
    at: b.created_at || b.at || D.now(),
  };
}

function adaptMovement(m) {
  return {
    id: m.id,
    batchId: m.batch_id || m.batchId,
    foodId: m.food_id || m.foodId,
    delta: m.delta === null || m.delta === undefined ? null : Number(m.delta),
    kind: m.kind,
    reason: m.reason || '',
    sourceType: m.source_type || m.sourceType || '',
    sourceId: m.source_id || m.sourceId || '',
    at: m.created_at || m.at || D.now(),
  };
}

function adaptShoppingItem(x) {
  return {
    id: x.id,
    foodId: x.food_id || x.foodId,
    qty: x.qty === null || x.qty === undefined ? null : Number(x.qty),
    unit: x.unit,
    origin: x.origin || 'manual',
    status: x.status || 'proposed',
    note: x.note || '',
    need: x.need === undefined ? undefined : Number(x.need),
    avail: x.avail === undefined ? undefined : Number(x.avail),
    incoming: x.incoming === undefined ? 0 : Number(x.incoming),
    unknownStock: !!x.unknown_stock || !!x.unknownStock,
    first: x.first || null,
    planVersion: x.plan_version || x.planVersion,
    receivedQty: x.received_qty ?? x.receivedQty,
    batchId: x.batch_id || x.batchId,
  };
}

function adaptMeal(m) {
  const items = (m.items || []).map((it) => {
    if (it.recipe_id || it.recipeId) return { recipeId: it.recipe_id || it.recipeId, amount: Number(it.servings ?? it.amount ?? 1) };
    return { foodId: it.food_id || it.foodId, amount: Number(it.amount) };
  });
  const nut = m.nutrition || m.nut || null;
  const v = nut ? [nut.kcal, nut.protein, nut.fat, nut.carbs].map((x) => Number(x || 0)) : [0, 0, 0, 0];
  const unknown = nut ? (nut.unknown_items || nut.unknown || []) : [];
  const first = items[0] || {};
  const title = items.map((it) => (it.recipeId ? (R[it.recipeId] ? R[it.recipeId].t : it.recipeId) : (FOODS[it.foodId] ? FOODS[it.foodId].name : it.foodId))).join(' + ');
  const em = first.recipeId ? '[[r:' + first.recipeId + ']]' : first.foodId ? '[[f:' + first.foodId + ']]' : '[[utensils]]';
  return {
    id: m.id,
    date: m.date,
    slot: m.slot,
    items,
    title,
    em,
    source: m.source || m.source_type || 'manual',
    planned: !!m.planned,
    note: m.note || '',
    nut: { v, unknown, complete: !nut || nut.completeness === 'full', basis: !nut || nut.completeness === 'full' ? 'measured' : 'partial' },
    version: m.version || 1,
    at: m.created_at || m.at || D.now(),
    cookingSession: m.cooking_session || undefined,
    actionId: m.action_id || undefined,
  };
}

function adaptHabit(h) {
  return { id: h.id, kind: h.kind, date: h.date, value: Number(h.value), unit: h.unit || '' };
}

function adaptReport(rp) {
  const m = rp.metrics || {};
  return {
    id: rp.id,
    start: rp.week_start || rp.period_start || rp.start,
    end: rp.week_end || rp.period_end || rp.end,
    status: rp.status || 'fresh',
    at: rp.generated_at || rp.created_at || rp.at || null,
    staleWhy: rp.staleWhy || rp.stale_why,
    metrics: {
      elapsed: (m.record_days ?? m.recordDays ?? 0) + (m.missing_days ?? m.missingDays ?? 0),
      recordDays: m.record_days ?? m.recordDays ?? 0,
      missingDays: m.missing_days ?? m.missingDays ?? 0,
      recordRate: m.record_rate ?? m.recordRate ?? 0,
      planRate: m.plan_rate ?? m.planRate ?? null,
      planJudge: m.plan_judge ?? m.planJudge,
      planDone: m.plan_done ?? m.planDone,
      avgKcal: m.avg_kcal ?? m.avgKcal ?? null,
      avgProtein: m.avg_protein ?? m.avgProtein ?? null,
      partialNut: !!(m.partial_nut ?? m.partialNut),
      waterAvg: m.water_avg ?? m.waterAvg ?? null,
      waterDays: m.water_days ?? m.waterDays ?? '—',
      sleepAvg: m.sleep_avg ?? m.sleepAvg ?? null,
      sleepDays: m.sleep_days ?? m.sleepDays ?? '—',
      stepsAvg: m.steps_avg ?? m.stepsAvg ?? null,
      stepsDays: m.steps_days ?? m.stepsDays ?? '—',
      kcalByDay: m.kcal_by_day || m.kcalByDay || [],
    },
    text: rp.text || '',
  };
}

function adaptNotification(n) {
  return {
    id: n.id,
    em: n.icon || n.em || '[[bell]]',
    text: n.text || n.message || '',
    at: n.created_at || n.at || D.now(),
    read: !!n.read,
    go: n.link || n.go || null,
  };
}

function adaptThread(t) {
  return { id: t.id, title: t.title || '新的对话', at: t.updated_at || t.created_at || D.now(),
    parentId: t.parent_thread_id || null, originQuote: t.quote || null,
    messageCount: t.message_count || 0, history: 'idle', msgs: [] };
}

function adaptPlanDetail(detail, listItem) {
  const versions = (detail.versions || []).map((v) => {
    let meals = {};
    if (Array.isArray(v.meals)) {
      v.meals.forEach((mm) => { meals[(mm.local_date || mm.date) + '|' + mm.slot] = { r: mm.recipe_id || mm.recipeId, sv: mm.servings ?? mm.sv ?? 2 }; });
    } else if (v.meals && typeof v.meals === 'object') {
      Object.entries(v.meals).forEach(([k, mm]) => { meals[k] = { r: mm.r || mm.recipe_id, sv: mm.sv ?? mm.servings ?? 2 }; });
    }
    return { v: v.v ?? v.version, reason: v.reason || '', by: v.by || 'user', at: v.at || v.created_at || D.now(), meals, basedOn: v.based_on ?? (v.v ? v.v - 1 : undefined) };
  });
  const start = (listItem && (listItem.period_start || listItem.start)) || detail.period_start || detail.start || D.monday(D.todayKey());
  const end = detail.period_end || listItem?.period_end;
  return {
    id: detail.id || (listItem && listItem.id) || 'plan',
    title: (listItem && listItem.title) || detail.title || '本周家常菜单',
    start,
    days: listItem?.days || detail.days || (end ? D.diff(end, start) + 1 : 7),
    active: detail.active_version ?? detail.active ?? (versions.length ? versions[versions.length - 1].v : 1),
    counter: versions.reduce((mx, v) => Math.max(mx, v.v || 0), 0),
    versions,
  };
}

/* ---------------- hydrate：启动时从 API 填充 S ---------------- */
async function hydrate() {
  BOOT.state = 'loading';
  BOOT.loadErrors = [];
  BOOT.error = null;
  let me = null;
  try {
    me = await Api.me();
  } catch (e) {
    if (e && e.code === 'UNAUTHORIZED' || e && e.status === 401) { AUTHED = false; BOOT.state = 'auth'; return false; }
    BOOT.state = 'error';
    BOOT.error = (e && e.message) || '无法连接后端';
    return false;
  }
  AUTHED = true;
  const user = me.user || {};
  const profile = user.profile || me.profile || {};
  const S0 = {
    user: {
      name: profile.name || user.name || '小满',
      tz: profile.timezone || 'Asia/Shanghai',
      maxCook: profile.max_cook_minutes ?? 35,
      people: profile.people ?? 2,
      equipment: profile.equipment || [],
      taste: profile.taste || [],
      email: user.email || '',
      serverAdmin: user.server_admin === true,
    },
    restrictions: (user.restrictions || me.restrictions || []).map((r) => ({ id: r.id, kind: r.kind, label: r.label, keys: r.keys || [], hard: !!r.hard })),
    policies: { weekly_report: 'off', expiry: 'off', habit_review: 'off' },
    favorites: [],
    batches: [],
    movements: [],
    shopping: [],
    plan: null,
    meals: [],
    habits: [],
    reports: [],
    notifs: [],
    threads: [],
    agentPreferences: null,
    activeThread: null,
    actions: {},
    tasks: [],
    observeLog: [], // 仅本会话：观察模式的“本应触发”记录，不持久化
  };

  const jobs = {
    foods: Api.listFoods(),
    recipes: Api.listRecipes(),
    batches: Api.listBatches(),
    movements: Api.listMovements(),
    shopping: Api.listShopping(),
    plans: Api.listPlans(),
    meals: Api.listMeals(),
    habits: Api.listHabitRecords(),
    reports: Api.listReports(),
    notifications: Api.listNotifications(),
    policies: Api.getAutomationPolicies(),
    tasks: Api.listAutomationTasks(),
    threads: Api.listThreads(),
    agentPreferences: Api.readAgentPreferences().catch(() => null),
    favorites: Api.listRecipes({ favorite_only: true }),
  };
  const keys = Object.keys(jobs);
  const settled = await Promise.allSettled(keys.map((k) => jobs[k]));
  const got = {};
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') got[keys[i]] = r.value;
    else BOOT.loadErrors.push([keys[i], (r.reason && r.reason.message) || '加载失败']);
  });

  // 食物与菜谱字典是其它页面的基础：失败时页面无法渲染，记为严重错误
  const foods = Array.isArray(got.foods) ? got.foods : [];
  FOODS = {};
  foods.forEach((f, i) => { const a = adaptFood(f, i); FOODS[a.id] = a; });
  const recipes = Array.isArray(got.recipes) ? got.recipes : [];
  RECIPES = recipes.map((r, i) => adaptRecipe(r, i));
  R = Object.fromEntries(RECIPES.map((r) => [r.id, r]));
  S0.favorites = Array.isArray(got.favorites) ? got.favorites.map((r) => r.id) : [];

  S0.batches = Array.isArray(got.batches) ? got.batches.map(adaptBatch) : [];
  S0.movements = Array.isArray(got.movements) ? got.movements.map(adaptMovement) : [];
  S0.shopping = Array.isArray(got.shopping) ? got.shopping.map(adaptShoppingItem) : [];
  S0.meals = Array.isArray(got.meals) ? got.meals.map(adaptMeal) : [];
  S0.habits = Array.isArray(got.habits) ? got.habits.map(adaptHabit) : [];
  S0.reports = Array.isArray(got.reports) ? got.reports.map(adaptReport) : [];
  S0.notifs = Array.isArray(got.notifications) ? got.notifications.map(adaptNotification) : [];
  if (got.policies) S0.policies = { weekly_report: got.policies.weekly_report || 'off', expiry: got.policies.expiry || 'off', habit_review: got.policies.habit_review || 'off' };
  S0.tasks = Array.isArray(got.tasks) ? got.tasks.map((t) => ({ id: t.id, kind: t.kind, name: t.name || t.kind, status: t.status || 'off', next: t.next || '—' })) : [];
  S0.agentPreferences = got.agentPreferences || null;
  S0.threads = Array.isArray(got.threads) ? got.threads.map(adaptThread) : [];
  S0.activeThread = S0.threads[0]?.id || null;

  const plans = Array.isArray(got.plans) ? got.plans : [];
  if (plans.length) {
    try {
      const detail = await Api.getPlan(plans[0].id);
      S0.plan = adaptPlanDetail(detail, plans[0]);
    } catch (e) {
      BOOT.loadErrors.push(['plan-detail', (e && e.message) || '计划详情加载失败']);
      S0.plan = null;
    }
  }

  S = S0;
  BOOT.state = 'ready';
  return true;
}

/* ---------------- 局部刷新器：写操作成功后只刷新受影响的部分 ---------------- */
async function refreshPantry() {
  try { const [b, m] = await Promise.all([Api.listBatches(), Api.listMovements()]); S.batches = b.map(adaptBatch); S.movements = m.map(adaptMovement); return true; }
  catch (e) { toast('库存刷新失败：' + (e.message || e), true); return false; }
}
async function refreshShopping() {
  try { S.shopping = (await Api.listShopping()).map(adaptShoppingItem); return true; }
  catch (e) { toast('购物清单刷新失败：' + (e.message || e), true); return false; }
}
async function refreshMeals() {
  try { S.meals = (await Api.listMeals()).map(adaptMeal); return true; }
  catch (e) { toast('记餐刷新失败：' + (e.message || e), true); return false; }
}
async function refreshHabits() {
  try { S.habits = (await Api.listHabitRecords()).map(adaptHabit); return true; }
  catch (e) { toast('习惯刷新失败：' + (e.message || e), true); return false; }
}
async function refreshReports() {
  const state = S;
  try {
    const reports = await Api.listReports();
    if (S !== state) return false;
    state.reports = reports.map(adaptReport);
    return true;
  }
  catch (e) { toast('周报刷新失败：' + (e.message || e), true); return false; }
}
async function refreshPlan() {
  try {
    const plans = await Api.listPlans();
    if (!plans.length) { S.plan = null; return true; }
    S.plan = adaptPlanDetail(await Api.getPlan(plans[0].id), plans[0]);
    return true;
  } catch (e) { toast('计划刷新失败：' + (e.message || e), true); return false; }
}
async function refreshNotifications() {
  const state = S;
  try {
    const notices = await Api.listNotifications();
    if (S !== state) return false;
    state.notifs = notices.map(adaptNotification);
    return true;
  }
  catch (e) { return false; }
}
async function refreshThreads() {
  try {
    const known = new Map(S.threads.map(t => [t.id, t]));
    const rows = (await Api.listThreads()).map(adaptThread);
    S.threads = rows.map(row => {
      const thread = known.get(row.id);
      if (!thread) return row;
      thread.title = row.title;
      thread.at = row.at;
      thread.messageCount = row.messageCount;
      return thread;
    });
    if (!S.threads.some(t => t.id === S.activeThread)) S.activeThread = S.threads[0]?.id || null;
    return true;
  } catch (e) { return false; }
}
async function refreshMe() {
  try {
    const me = await Api.me();
    const user = me.user || {};
    const profile = user.profile || me.profile || {};
    S.user = { ...S.user, serverAdmin: user.server_admin === true, name: profile.name || user.name || S.user.name, tz: profile.timezone || S.user.tz, maxCook: profile.max_cook_minutes ?? S.user.maxCook, people: profile.people ?? S.user.people, equipment: profile.equipment || S.user.equipment, taste: profile.taste || S.user.taste };
    S.restrictions = (user.restrictions || me.restrictions || []).map((r) => ({ id: r.id, kind: r.kind, label: r.label, keys: r.keys || [], hard: !!r.hard }));
    return true;
  } catch (e) { toast('个人信息刷新失败：' + (e.message || e), true); return false; }
}

/* ---------------- 小工具 ---------------- */
function toApiItem(it) {
  if (it.recipeId) return { recipe_id: it.recipeId, servings: it.amount };
  return { food_id: it.foodId, amount: it.amount, unit: (FOODS[it.foodId] || {}).unit || 'g' };
}

async function updateProfile(patch) {
  try {
    await Api.updateProfile(patch);
    await refreshMe();
    commit('已保存');
  } catch (e) { toast('保存失败：' + (e.message || e), true); }
}

async function recordHabit(kind, date, value) {
  await Api.createHabitRecord({ kind, date, value });
  await refreshHabits();
}

async function markAllRead() {
  const unread = S.notifs.filter((n) => !n.read);
  await Promise.allSettled(unread.map((n) => Api.readNotification(n.id)));
  await refreshNotifications();
  render();
}

function resync() { hydrate().then(() => render()); }
function bootRetry() { hydrate().then(() => render()); }

function loadingHTML() {
  return `<div class="state-page"><div class="card" style="max-width:440px;margin:60px auto"><h2 style="font-size:20px">正在打开你的厨房…</h2><p class="muted">正在从服务端加载食材、菜谱、计划与记录。</p><div class="progress" style="margin-top:14px"><i style="width:60%"></i></div></div></div>`;
}
function errorHTML() {
  return `<div class="state-page"><div class="card" style="max-width:440px;margin:60px auto"><h2 style="font-size:20px">连接后端失败</h2><p class="muted">${esc(BOOT.error || '未知错误')}</p><p class="small muted">请确认后端已启动（见 frontend/README.md 的启动说明），然后重试。</p><button class="btn pri" onclick="bootRetry()">重试</button></div></div>`;
}
function stateBanner() {
  if (!BOOT.loadErrors.length) return '';
  return `<div class="warn-line" style="margin-bottom:14px">[[alert]] 以下内容加载失败，已用空数据展示：${BOOT.loadErrors.map(([k]) => esc(k)).join('、')}。<button class="btn xs sp" onclick="resync()">重试加载</button></div>`;
}
function planEmptyHTML() {
  return `<div class="card" style="max-width:560px;margin:40px auto;text-align:center;padding:32px">
    <div style="font-size:40px">[[calendar]]</div>
    <h2 style="margin:10px 0">还没有菜单计划</h2>
    <p class="muted">让 AI 管家按你的饮食限制和现有库存生成一份，或先从今天的三餐开始。</p>
    <div class="row" style="justify-content:center;margin-top:14px">
      <button class="btn pri" onclick="askAI('用现有食材安排三日菜单')">[[sparkle]] 让 AI 生成三日菜单</button>
      <button class="btn" onclick="createPlanFromScratch()">生成本周计划草稿</button>
    </div></div>`;
}
async function createPlanFromScratch() {
  try {
    const start = D.monday(D.todayKey());
    const draft = await Api.createPlanDraft({ period_start: start, days: 7, meal_slots: ['breakfast', 'lunch', 'dinner'], constraints: { max_cook_minutes: S.user.maxCook, equipment: S.user.equipment, avoid_food_ids: [] }, use_pantry: true });
    const plans = await Api.listPlans();
    if (!plans.length) throw new Error('计划创建后未在列表中找到');
    await Api.commitPlan(plans[0].id, { draft_id: draft.draft_id || draft.id });
    await refreshPlan();
    await recomputePlanShopping();
    commit('已生成本周计划草稿并提交');
  } catch (e) { toast('生成计划失败：' + (e.message || e), true); }
}

function showConflictModal(expected, current) {
  modal({
    title: '[[alert]] 计划已有更新',
    body: `<p>你基于 <b>v${expected}</b> 的修改没有被保存：在此期间计划已保存到了 <b>v${current}</b>。系统不会静默覆盖。</p>
    <pre class="mono small" style="background:var(--paper-2);padding:12px;border-radius:10px;white-space:pre-wrap">${esc(JSON.stringify({ error: { code: 'CONFLICT', message: '计划已有更新，请重新查看差异后确认', details: { expected_version: expected, current_version: current } } }, null, 2))}</pre>`,
    buttons: [
      { label: '查看差异', fn: () => setTimeout(() => showDiff(expected, current), 0) },
      { label: '基于最新版本重新编辑', cls: 'pri', fn: () => { U.route = 'plan'; render(); } },
    ],
  });
}

/* ---------------- 认证页 ---------------- */
let authMode = 'login';
function renderAuthPage() {
  const err = BOOT.authError || '';
  BOOT.authError = '';
  $('#side').innerHTML = `<div class="brand"><div class="brand-logo">[[pot]]</div><div><b>食光管家</b><span>AI KITCHEN JOURNAL</span></div></div><div class="side-foot">前端 · 接真实后端<br>数据保存在服务端，不在浏览器本地。</div>`;
  $('#top').innerHTML = `<div><h1>登录</h1><div class="crumb">/auth · 需要登录后使用</div></div>`;
  $('#tabbar').innerHTML = '';
  $('#chef').classList.add('hidden');
  $('#page').innerHTML = `
  <div class="auth-wrap"><div class="card" style="padding:26px">
    <img class="auth-hero" src="assets/icons/hero/tomato-egg-plate.svg" alt="番茄炒蛋餐盘">
    <h2 style="font-size:22px">欢迎回来</h2>
    <p class="muted small" style="margin:6px 0 16px">登录后使用你的食材、计划与记录。会话用 HttpOnly Cookie 保持，关闭页面后仍需重新登录验证。</p>
    <div class="seg" style="margin-bottom:16px">
      <button class="${authMode === 'login' ? 'on' : ''}" onclick="authMode='login';renderAuthPage()">登录</button>
      <button class="${authMode === 'register' ? 'on' : ''}" onclick="authMode='register';renderAuthPage()">注册</button>
    </div>
    ${err ? `<div class="danger-line" style="margin-bottom:12px">${esc(err)}</div>` : ''}
    <div class="col">
      ${authMode === 'register' ? `<label class="f">昵称<input class="input" id="auth-name" placeholder="例如：小满" autocomplete="nickname"></label>` : ''}
      <label class="f">邮箱<input class="input" id="auth-email" type="email" placeholder="demo@example.com" autocomplete="email" value="demo@example.com"></label>
      <label class="f">密码<input class="input" id="auth-password" type="password" placeholder="至少 8 位" autocomplete="current-password"></label>
      <div class="row">
        <button class="btn pri" style="flex:1" onclick="doAuth()">${authMode === 'login' ? '登录' : '注册并登录'}</button>
        <button class="btn" onclick="fillDemo()">一键填入演示账号</button>
      </div>
      <p class="small muted">演示账号：demo@example.com / Demo1234!（后端种子账号，见 API_CONTRACT.md）。</p>
    </div>
  </div></div>`;
  const em = $('#auth-email');
  if (em) em.focus();
}
function fillDemo() {
  const em = $('#auth-email'), pw = $('#auth-password');
  if (em) em.value = 'demo@example.com';
  if (pw) pw.value = 'Demo1234!';
  toast('已填入演示账号');
}
async function doAuth() {
  const email = ($('#auth-email') || {}).value || '';
  const password = ($('#auth-password') || {}).value || '';
  const name = ($('#auth-name') || {}).value || '';
  if (!email || !password) { BOOT.authError = '请填写邮箱和密码'; renderAuthPage(); return; }
  try {
    if (authMode === 'register') {
      await Api.register({ email, password, name: name || undefined });
    }
    await Api.login({ email, password });
    await Api.getCsrf().catch(() => {});
    const ok = await hydrate();
    if (!ok) { render(); return; }
    U.route = 'home';
    location.hash = '#/home';
    render();
    toast('登录成功，欢迎回来');
  } catch (e) {
    BOOT.authError = (e && e.message) || '登录失败';
    renderAuthPage();
  }
}
async function doLogout() {
  try { await Api.logout(); } catch (e) { /* 退出时失败也照常回到登录页 */ }
  AUTHED = false;
  S = null;
  BOOT.state = 'auth';
  csrfToken = null;
  location.hash = '#/home';
  render();
}
