'use strict';
/* =========================================================
 * app.js — UI 与页面（由 MVP 单文件移植）
 * 视觉、页面结构、SVG 图标系统、确定性展示逻辑全部保留自 MVP；
 * 本地模拟 DB（seed/load/save/localStorage）已移除，
 * 业务数据来自 data.js 的 hydrate()（内存缓存，源头是 API），
 * 写操作走 api.js；Agent 运行时在 agent.js。
 * ========================================================= */

'use strict';
/* =========================================================
 *  AI 饮食与健康生活管家 · 前端（由 MVP 单文件移植，接真实后端）
 *  分层：api.js(请求层) → data.js(缓存/适配/认证) → app.js(UI/页面)
 *        → agent.js(SSE Agent 运行时)
 *  说明：营养数据来自服务端食物库（/foods）；Agent 走真实 SSE 事件流。
 * ========================================================= */

/* ---------------- utils ---------------- */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = p => p + '_' + Math.random().toString(36).slice(2, 9);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const r1 = x => Math.round(x * 10) / 10;
const r0 = x => Math.round(x);

const D = {
  today() { const d = new Date(); d.setHours(0, 0, 0, 0); return d; },
  key(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); },
  parse(k) { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); },
  add(k, n) { const d = D.parse(k); d.setDate(d.getDate() + n); return D.key(d); },
  diff(a, b) { return Math.round((D.parse(a) - D.parse(b)) / 864e5); }, // a - b in days
  todayKey() { return D.key(D.today()); },
  monday(k) { const d = D.parse(k); const wd = (d.getDay() + 6) % 7; d.setDate(d.getDate() - wd); return D.key(d); },
  wd(k) { return '周' + '日一二三四五六'[D.parse(k).getDay()]; },
  wdIdx(k) { return (D.parse(k).getDay() + 6) % 7; },
  md(k) { const d = D.parse(k); return (d.getMonth() + 1) + '/' + d.getDate(); },
  week(k) { const m = D.monday(k); return [0, 1, 2, 3, 4, 5, 6].map(i => D.add(m, i)); },
  now() { return new Date().toISOString(); },
  time(iso) { const d = new Date(iso); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); },
  ago(iso) { const s = (Date.now() - new Date(iso)) / 1000; if (s < 60) return '刚刚'; if (s < 3600) return r0(s / 60) + ' 分钟前'; if (s < 86400) return r0(s / 3600) + ' 小时前'; return r0(s / 86400) + ' 天前'; },
};

/* ---------------- static dictionaries ---------------- */
// n = [kcal, 蛋白质g, 脂肪g, 碳水g] / 100g（示例值）；null = 营养来源缺失
let FOODS = {};
const UNIT = { g: '克', ml: '毫升', piece: '个' };
const unitShort = { g: 'g', ml: 'ml', piece: '个' };
const SLOTS = { breakfast: '早餐', lunch: '午餐', dinner: '晚餐', snack: '加餐' };
const SLOT_EM = { breakfast: '[[sunrise]]', lunch: '[[sun]]', dinner: '[[moon]]', snack: '[[cookie]]' };
const LOC = { fridge: { name: '冷藏层', temp: '4°C', cls: 'cold', em: '[[fridge]]' }, freezer: { name: '冷冻层', temp: '-18°C', cls: 'freeze', em: '[[snow]]' }, pantry: { name: '常温柜', temp: '室温', cls: '', em: '[[cabinet]]' } };

// ing: [foodId, amount(按食品基础单位), optional?]
let RECIPES = [];
let R = {};

/* ---------------- store: 服务端数据的内存缓存 ---------------- */
// S 是服务端数据的内存缓存，由 data.js 的 hydrate() 从 API 填充；
// 不写入 localStorage，刷新页面即失效。
// 业务字典 FOODS / RECIPES / R 同样由 API 填充（见 hydrate 的适配器）。
// 唯一保留在 localStorage 的是纯 UI 偏好：主题（aichef_theme，见 boot）。
let S = null;

/* ---------------- services: nutrition ---------------- */
function gramsOf(foodId, amount) {
  const f = FOODS[foodId];
  if (f.unit === 'g') return { g: amount, basis: 'measured' };
  if (f.unit === 'ml') return f.density ? { g: amount * f.density, basis: 'measured' } : null;
  if (f.unit === 'piece') return f.pieceG ? { g: amount * f.pieceG, basis: 'standardized_portion' } : null;
  return null;
}
// items: [{foodId, amount}] → {v:[kcal,p,f,c], unknown:[names], complete, basis}
function nutritionOf(items) {
  const v = [0, 0, 0, 0]; const unknown = []; const bases = new Set();
  items.forEach(({ foodId, amount }) => {
    const f = FOODS[foodId]; const g = gramsOf(foodId, amount);
    if (!f.n || !g) { unknown.push(f.name); return; }
    bases.add(g.basis);
    for (let i = 0; i < 4; i++) v[i] += g.g / 100 * f.n[i];
  });
  return { v: v.map(r1), unknown, complete: unknown.length === 0, basis: unknown.length ? 'partial' : (bases.has('standardized_portion') ? 'standardized_portion' : 'measured') };
}
function recipeItems(r, servings = 1) { return r.ing.map(([id, a]) => ({ foodId: id, amount: a * servings / r.serv })); }
function recipeNutrition(r, servings = 1) { return nutritionOf(recipeItems(r, servings)); }
function mealNutrition(items) {
  const flat = [];
  items.forEach(it => { if (it.recipeId) flat.push(...recipeItems(R[it.recipeId], it.amount)); else flat.push({ foodId: it.foodId, amount: it.amount }); });
  return nutritionOf(flat);
}

/* ---------------- services: restrictions ---------------- */
function foodHits(foodId, keys) { const f = FOODS[foodId]; return keys.some(k => f.al.includes(k) || f.name.includes(k) || (f.tags || []).includes(k)); }
// returns {blocked:[{label,food}], verify:[foodName]}
function checkRecipe(r, extraKeys = []) {
  const blocked = []; const verify = [];
  const hardKeys = S.restrictions.filter(x => x.hard && x.keys.length).map(x => ({ label: x.label, keys: x.keys, kind: x.kind }));
  if (extraKeys.length) hardKeys.push({ label: extraKeys.join('、'), keys: extraKeys, kind: 'request' });
  r.ing.forEach(([fid]) => {
    hardKeys.forEach(h => { if (foodHits(fid, h.keys)) blocked.push({ label: h.label, food: FOODS[fid].name, kind: h.kind }); });
    if (FOODS[fid].alUnknown) verify.push(FOODS[fid].name);
  });
  return { blocked, verify, ok: blocked.length === 0 };
}

/* ---------------- services: pantry (批次 + 流水) ---------------- */
/* 库存写操作一律走 API；成功后刷新本地缓存。
   服务端按 (user, source_type, source_id, kind) 去重，重复提交返回原结果。 */
async function addBatch({ foodId, qty, expires, location, purchased, kind = 'OPENING', sourceType = 'manual', sourceId, silent }) {
  const f = FOODS[foodId];
  const known = qty !== null && qty !== undefined && qty !== '' && !isNaN(qty);
  const created = await Api.createBatch({ food_id: foodId, qty: known ? Number(qty) : null, unit: f.unit, expires_on: expires || null, location: location || 'fridge', purchased_on: purchased || D.todayKey() });
  await refreshPantry();
  const raw = created && created.batch ? created.batch : created;
  return adaptBatch(raw && raw.id ? raw : { id: raw && raw.id, food_id: foodId, qty: known ? Number(qty) : null, unit: f.unit, expires_on: expires || null, location: location || 'fridge', purchased_on: purchased || D.todayKey() });
}
async function moveBatch(batchId, delta, kind, reason, sourceType, sourceId, idemKey, silent) {
  const bt = S.batches.find(b => b.id === batchId);
  if (!bt) throw new Error('NOT_FOUND');
  if (bt.qtyStatus !== 'known') throw new Error('UNIT_CONVERSION_UNKNOWN');
  const next = r1(bt.remaining + delta);
  if (next < 0) throw new Error('库存不足：剩余 ' + bt.remaining);
  if (kind === 'CONSUME') {
    await Api.consume({ batch_id: batchId, food_id: bt.foodId, amount: Math.abs(delta), unit: bt.unit, reason: reason || '烹饪使用', source_type: sourceType || 'manual_cook', source_id: sourceId || uid('src'), idempotency_key: idemKey || uid('idem') });
  } else {
    await Api.adjustBatch({ batch_id: batchId, delta: r1(delta), reason: reason || kind });
  }
  await refreshPantry();
  return { ok: true };
}
async function setBatchKnown(batchId, qty, reason) {
  // 数量未知批次的盘点：以 adjustments 的 delta 建立可量化基准。
  // 服务端对 unknown 批次的调整语义待联调（见 README）。
  await Api.adjustBatch({ batch_id: batchId, delta: Number(qty), reason: reason || '盘点：建立可量化基准' });
  await refreshPantry();
}

const expDays = bt => bt.expires ? D.diff(bt.expires, D.todayKey()) : 999;
function liveBatches(foodId) { return S.batches.filter(b => b.foodId === foodId && expDays(b) >= 0 && (b.qtyStatus === 'unknown' || b.remaining > 0)); }
function available(foodId) {
  const bs = liveBatches(foodId);
  return { qty: r1(bs.filter(b => b.qtyStatus === 'known').reduce((s, b) => s + b.remaining, 0)), unknown: bs.some(b => b.qtyStatus === 'unknown'), batches: bs };
}
function fefo(foodId, need) {
  const bs = liveBatches(foodId).filter(b => b.qtyStatus === 'known').sort((a, b) => (a.expires || '9') < (b.expires || '9') ? -1 : 1);
  const alloc = []; let left = need;
  bs.forEach(b => { if (left <= 0) return; const take = Math.min(b.remaining, left); alloc.push({ batchId: b.id, amount: r1(take), expires: b.expires, ver: b.version }); left = r1(left - take); });
  return { alloc, short: Math.max(0, r1(left)) };
}
function stockMatch(r) { // 0..1 库存可用度
  const req = r.ing.filter(i => !i[2]);
  let ok = 0;
  req.forEach(([fid, amt]) => { const a = available(fid); if (a.qty >= amt || a.unknown) ok++; else if (a.qty > 0) ok += a.qty / amt; });
  return req.length ? ok / req.length : 1;
}
function urgencyBonus(r) { let s = 0; r.ing.forEach(([fid]) => { available(fid).batches.forEach(b => { const d = expDays(b); if (d <= 2) s += 1; else if (d <= 4) s += .4; }); }); return Math.min(s, 3) / 3; }
function fmtQty(q, unit) { if (q === null || q === undefined) return '数量未知'; return (unit === 'piece' ? r1(q) : r0(q)) + ' ' + unitShort[unit]; }

/* ---------------- services: plan (版本化) ---------------- */
const P = {
  cur() { return S.plan ? S.plan.versions.find(v => v.v === S.plan.active) : null; },
  meals() { const c = P.cur(); return c ? c.meals : {}; },
  dates() { if (!S.plan) return []; return Array.from({ length: S.plan.days }, (_, i) => D.add(S.plan.start, i)); },
  get(date, slot) { return P.meals()[date + '|' + slot]; },
  // 注意：契约没有“提交任意 meals 映射”的端点。整表提交走
  // POST /plans/drafts（服务端生成草稿）+ POST /plans/{id}/commit；
  // 单餐替换走 POST /plans/{id}/replace-meal；恢复走 restore-version。
  // 因此 swap 用两次 replace-meal 实现（会产生两个版本，见 README）。
  async replace(date, slot, recipeId, by = 'user', expected, servings) {
    if (!S.plan) throw new Error('暂无计划');
    const cur = P.get(date, slot);
    const res = await Api.replaceMeal(S.plan.id, { expected_version: expected ?? S.plan.active, target: { local_date: date, slot }, replacement: { recipe_id: recipeId, servings: servings ?? (cur ? cur.sv : 2) } });
    await refreshPlan();
    await recomputePlanShopping();
    return (res && (res.active_version ?? res.activeVersion)) || S.plan.active;
  },
  async swap(a, b) {
    const ma = P.meals()[a], mb = P.meals()[b];
    if (!ma || !mb) throw new Error('交换的两餐中有一餐为空');
    const [da, sa] = a.split('|'), [db, sb] = b.split('|');
    await P.replace(da, sa, mb.r, 'user', undefined, mb.sv);
    await P.replace(db, sb, ma.r, 'user', undefined, ma.sv);
    return S.plan.active;
  },
  async restore(v) {
    if (!S.plan) throw new Error('暂无计划');
    await Api.restoreVersion(S.plan.id, { version: v });
    await refreshPlan();
    await recomputePlanShopping();
    return S.plan.active;
  },
  diff(a, b) { // version numbers
    const A = S.plan && S.plan.versions.find(x => x.v === a), B = S.plan && S.plan.versions.find(x => x.v === b);
    if (!A || !B) return [];
    const keys = [...new Set([...Object.keys(A.meals), ...Object.keys(B.meals)])].sort();
    return keys.map(k => ({ k, from: A.meals[k], to: B.meals[k] }))
      .filter(({ from, to }) => from?.r !== to?.r || from?.sv !== to?.sv);
  },
  candidates(slot, { exclude = [], notId, date } = {}) {
    const dates = P.dates(); const near = new Set();
    if (date) { [-1, 0, 1].forEach(o => { const d = D.add(date, o); ['breakfast', 'lunch', 'dinner'].forEach(s => { const m = P.get(d, s); if (m) near.add(m.r); }); }); }
    return RECIPES.filter(r => r.slots.includes(slot) && r.id !== notId).map(r => {
      const chk = checkRecipe(r, exclude);
      const stock = stockMatch(r), urg = urgencyBonus(r), div = near.has(r.id) ? 0 : 1, conv = r.min <= S.user.maxCook ? 1 : 0.3;
      const score = .35 * stock + .2 * urg + .25 * div + .2 * conv - (chk.verify.length ? .15 : 0);
      return { r, chk, stock, score, tooLong: r.min > S.user.maxCook, repeat: !div };
    }).sort((a, b) => (b.chk.ok - a.chk.ok) || (b.score - a.score));
  },
};

function isEaten(date, slot) { return S.meals.some(m => m.date === date && m.slot === slot && m.planned); }

/* ---------------- services: shopping ---------------- */
function computeGap(meals) {
  if (!S.plan) return [];
  meals = meals || P.meals();
  const T = D.todayKey(); const need = {}; const first = {};
  P.dates().forEach(d => {
    if (D.diff(d, T) < 0) return;
    ['breakfast', 'lunch', 'dinner'].forEach(slot => {
      const m = meals[d + '|' + slot]; if (!m || isEaten(d, slot)) return;
      const r = R[m.r];
      r.ing.forEach(([fid, amt, opt]) => { if (opt) return; need[fid] = (need[fid] || 0) + amt * m.sv / r.serv; if (!first[fid]) first[fid] = d; });
    });
  });
  return Object.keys(need).map(fid => {
    const a = available(fid);
    const incoming = S.shopping.filter(x => x.foodId === fid && ['confirmed', 'purchased'].includes(x.status)).reduce((s, x) => s + (x.qty || 0), 0);
    const gap = Math.max(0, need[fid] - a.qty - incoming);
    return { foodId: fid, need: r1(need[fid]), avail: a.qty, unknown: a.unknown, incoming, gap: FOODS[fid].unit === 'piece' ? Math.ceil(gap) : Math.ceil(gap / 10) * 10, first: first[fid] };
  }).filter(x => x.gap > 0 && !x.unknown || (x.unknown && x.need > x.avail + x.incoming));
}
async function recomputePlanShopping(silent) {
  if (!S.plan) return;
  try {
    await Api.recomputeShopping({ plan_id: S.plan.id });
    await refreshShopping();
  } catch (e) { toast('采购差额重算失败：' + (e.message || e), true); return; }
  if (['shopping', 'home', 'plan'].includes(U.route)) render();
}
async function receiveItem(itemId, { qty, expires, location }) {
  const it = S.shopping.find(x => x.id === itemId);
  if (!it || it.status === 'received') return { dup: true };
  const res = await Api.receiveShoppingItem(itemId, { qty: qty === '' || qty === null || qty === undefined ? null : Number(qty), expires_on: expires || null, location: location || 'fridge' });
  await refreshShopping();
  await refreshPantry();
  const raw = res && res.batch ? res.batch : null;
  return { ok: true, batch: raw ? adaptBatch(raw) : null };
}

/* ---------------- services: meals ---------------- */
async function createMeal({ date, slot, items, source = 'manual', planned = false, note = '', silent, at }) {
  const created = await Api.createMeal({
    date, slot, items: items.map(toApiItem), source, planned, note: note || '', consume_from_pantry: false,
  });
  const raw = created && created.meal ? created.meal : created;
  const m = adaptMeal(raw && raw.id ? raw : { id: uid('ml'), date, slot, items, note, source, planned, at: at || D.now() });
  if (!raw || !raw.nutrition) m.nut = mealNutrition(items); // 服务端未回营养时用本地计算补齐展示
  S.meals.push(m);
  markStale(date, 'meal');
  return m;
}
async function updateMeal(id, items) {
  const updated = await Api.updateMeal(id, { items: items.map(toApiItem) });
  const m = S.meals.find(x => x.id === id);
  if (!m) return;
  const raw = updated && updated.meal ? updated.meal : updated;
  m.items = items;
  if (raw && raw.nutrition) m.nut = adaptMeal(raw).nut;
  else m.nut = mealNutrition(items);
  m.version++;
  markStale(m.date, 'meal');
}
async function deleteMeal(id) {
  const m = S.meals.find(x => x.id === id);
  await Api.deleteMeal(id);
  S.meals = S.meals.filter(x => x.id !== id);
  if (m) markStale(m.date, 'meal');
}

function dayNutrition(date) {
  const ms = S.meals.filter(m => m.date === date);
  const v = [0, 0, 0, 0]; let partial = false;
  ms.forEach(m => { m.nut.v.forEach((x, i) => v[i] += x); if (!m.nut.complete) partial = true; });
  return { v: v.map(r1), partial, count: ms.length };
}

/* ---------------- services: reports ---------------- */
function markStale(date, why) {
  // 报告新鲜度由服务端判定；本地记餐变化后刷新报告列表即可。
  refreshReports();
}

/* ---------------- notifications ---------------- */


/* =========================================================
 *  图形系统（零 emoji）
 *  1) UI 线性图标：24px 网格，stroke=currentColor，随主题变色
 *  2) 食材插画：32px 网格，扁平填色 + 墨线描边（手账贴纸风）
 *  3) 菜品插画：由主要食材插画在餐盘上程序化组合
 *  文本中使用令牌 [[name]] / [[f:foodId]] / [[r:recipeId]]，
 *  写入 DOM 时统一转换为内联 SVG。
 * ========================================================= */
const IC = {
  home: '<path d="M3 11l9-8 9 8"/><path d="M5 9.5V21h14V9.5"/><path d="M10 21v-6h4v6"/>',
  chef: '<path d="M7 17.5c-2.4-.6-4-2.6-4-4.9a4.3 4.3 0 0 1 4.6-4.3 4.8 4.8 0 0 1 8.8 0 4.3 4.3 0 0 1 4.6 4.3c0 2.3-1.6 4.3-4 4.9"/><path d="M7 14v7h10v-7"/><path d="M7 18h10"/>',
  pot: '<path d="M4 10h16v6a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5z"/><path d="M2 10h20"/><path d="M9 6c0-1.5 1-1.5 1-3M14 6c0-1.5 1-1.5 1-3"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/><path d="M8 14h2M14 14h2M8 17.5h2"/>',
  fridge: '<rect x="5" y="2" width="14" height="20" rx="2.5"/><path d="M5 10h14M8.5 5v2.5M8.5 13v3.5"/>',
  book: '<path d="M4 19V5a2 2 0 0 1 2-2h14v15H6a2 2 0 0 0-2 2 2 2 0 0 0 2 2h14"/><path d="M9 7h7M9 10.5h5"/>',
  cart: '<path d="M2.5 4H5l2.4 11.2a1 1 0 0 0 1 .8h9a1 1 0 0 0 1-.8L20.5 8H6.1"/><circle cx="9" cy="20" r="1.4"/><circle cx="17" cy="20" r="1.4"/>',
  utensils: '<path d="M7 3v18M4 3v5a3 3 0 0 0 6 0V3"/><path d="M18 21V3c-2.2 1.6-3.4 4.2-3.4 7.6V13H18"/>',
  drop: '<path d="M12 3s6.5 6.6 6.5 11.3a6.5 6.5 0 0 1-13 0C5.5 9.6 12 3 12 3z"/><path d="M9 14.5a3 3 0 0 0 3 3"/>',
  chart: '<path d="M4 4v16h16"/><path d="M8.5 16v-4M12.5 16V8M16.5 16v-6"/>',
  gear: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8.2 8.2 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
  sunrise: '<path d="M3 20h18M6.5 20a5.5 5.5 0 0 1 11 0"/><path d="M12 4v5M9.5 6.5L12 4l2.5 2.5M4.2 12.2l1.4 1.4M19.8 12.2l-1.4 1.4"/>',
  cookie: '<path d="M20.5 12.5A8.5 8.5 0 1 1 11.5 3.5a3 3 0 0 0 3.5 3.5 3 3 0 0 0 5.5 5.5z"/><path d="M8.5 9.5h.01M8 14h.01M12 12.5h.01M15.5 15.5h.01M11 17h.01"/>',
  snow: '<path d="M12 2v20M3.3 7l17.4 10M3.3 17L20.7 7"/><path d="M9.5 3.5L12 5l2.5-1.5M9.5 20.5L12 19l2.5 1.5"/>',
  cabinet: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M4 12h16M10 7.5h4M10 16.5h4"/>',
  bell: '<path d="M6 16v-5a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 21h4"/>',
  'bell-off': '<path d="M6 16v-5a6 6 0 0 1 9.5-4.9M18 11v5l2 2H8"/><path d="M10 21h4M3 3l18 18"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  clock: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2M5 3L2 6M19 3l3 3"/>',
  timer: '<circle cx="12" cy="14" r="7.5"/><path d="M12 14v-4M10 2h4M12 2v4.5"/>',
  alert: '<path d="M12 3.5L2.5 20h19z"/><path d="M12 10v4.5M12 17.3h.01"/>',
  bolt: '<path d="M13 2L4.5 13.5H11L10 22l8.5-11.5H12z"/>',
  pen: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
  check: '<path d="M5 12.5l4.5 4.5L19.5 7"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  sparkle: '<path d="M11 3l1.8 5.2L18 10l-5.2 1.8L11 17l-1.8-5.2L4 10l5.2-1.8z"/><path d="M18.5 15l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/>',
  bulb: '<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-3.6 10.8c.7.6 1.1 1.3 1.1 2.1v.1h5v-.1c0-.8.4-1.5 1.1-2.1A6 6 0 0 0 12 3z"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="M4.5 6h.01M4.5 12h.01M4.5 18h.01"/>',
  file: '<path d="M6 2.5h8.5l4.5 4.5v14.5H6z"/><path d="M14 2.5V7h5M9 12.5h7M9 16.5h5"/>',
  camera: '<path d="M3 8.5a1.5 1.5 0 0 1 1.5-1.5h2.8L9 4.5h6L16.7 7h2.8A1.5 1.5 0 0 1 21 8.5v10a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z"/><circle cx="12" cy="13.5" r="3.8"/>',
  bookmark: '<path d="M6 3h12v18l-6-4.2L6 21z"/>',
  flame: '<path d="M12 22c4 0 7-2.7 7-6.6 0-4-3-6-4-9.4-1.5 2-2 3.2-2.3 4.6C11.7 9 10.3 7.4 10 4c-3 2.6-5 6-5 11.4C5 19.3 8 22 12 22z"/><path d="M12 22c-1.7 0-3-1.2-3-3 0-2 1.5-3 2-4.5 1 1.3 1.5 1.5 2 1 .7 1 2 2 2 3.5 0 1.8-1.3 3-3 3z"/>',
  bed: '<path d="M3 18V6M3 14h18v4M21 14v-1.5a3 3 0 0 0-3-3h-7V14"/><circle cx="7" cy="11" r="1.8"/><path d="M15 3.5h3l-3 3h3"/>',
  ban: '<circle cx="12" cy="12" r="9"/><path d="M5.7 5.7l12.6 12.6"/>',
  walk: '<circle cx="13" cy="4.5" r="1.8"/><path d="M9.5 22l2.3-7 3.2 3v4M7.5 12l3-3.5 3 2 3.5 1.5M11 8.5l.8 6.5"/>',
  equal: '<path d="M5 9h14M5 15h14"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.4a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1.1.9-1.1 1.6v.4M12 16.8h.01"/>',
  calc: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8.5 7h7M8.5 11.5h.01M12 11.5h.01M15.5 11.5h.01M8.5 15h.01M12 15h.01M15.5 15h.01M8.5 18h.01M12 18h3.5"/>',
  pause: '<path d="M9 5v14M15 5v14"/>',
  play: '<path d="M7 4.5l12.5 7.5L7 19.5z"/>',
  heart: '<path d="M12 20s-7.2-4.4-9-9.2A4.6 4.6 0 0 1 12 6.6a4.6 4.6 0 0 1 9 4.2C19.2 15.6 12 20 12 20z"/>',
  'heart-fill': '<path d="M12 20s-7.2-4.4-9-9.2A4.6 4.6 0 0 1 12 6.6a4.6 4.6 0 0 1 9 4.2C19.2 15.6 12 20 12 20z" fill="currentColor"/>',
  'check-circle': '<circle cx="12" cy="12" r="9"/><path d="M8 12.3l2.8 2.8L16.2 9.5"/>',
  download: '<path d="M12 4v11M7 10.5l5 5 5-5M5 20h14"/>',
  inbox: '<path d="M3 13.5L6 5h12l3 8.5V19H3z"/><path d="M3 13.5h5l1 3h6l1-3h5"/>',
  box: '<path d="M3 7.5l9-4.5 9 4.5v9.5l-9 4.5-9-4.5z"/><path d="M3 7.5l9 4.5 9-4.5M12 12v9.5"/>',
  volume: '<path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16.5 9a4 4 0 0 1 0 6M19.3 6.2a8 8 0 0 1 0 11.6"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20.5 20.5L16 16"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7.5a4 4 0 0 1 8 0V11M12 15v2.5"/>',
  printer: '<path d="M7 8V3h10v5"/><path d="M7 17H4.5V11a2.5 2.5 0 0 1 2.5-2.5h10a2.5 2.5 0 0 1 2.5 2.5v6H17"/><path d="M7 14h10v7H7z"/>',
  trash: '<path d="M4 6.5h16M9.5 6.5V3.5h5v3M6 6.5L7 21h10l1-14.5M10 11v6M14 11v6"/>',
  bag: '<path d="M5 8h14l-1.2 13H6.2z"/><path d="M9 8V6.5a3 3 0 0 1 6 0V8"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.5 8.2-8 9.3C7.5 20.2 4 17 4 12V6z"/><path d="M9 12l2 2 4-4"/>',
  bot: '<rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 4.5V8M9 13v1.5M15 13v1.5M9.5 17.5h5"/><circle cx="12" cy="3.5" r="1"/>',
  basket: '<path d="M3 10h18l-2.2 10H5.2z"/><path d="M7.5 10l4-6.5M16.5 10l-4-6.5M9 14v3M15 14v3"/>',
  hourglass: '<path d="M6 3h12M6 21h12M7.5 3c0 5 4.5 6 4.5 9s-4.5 4-4.5 9M16.5 3c0 5-4.5 6-4.5 9s4.5 4 4.5 9"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>',
  clip: '<path d="M20.5 11l-8.3 8.3a5 5 0 0 1-7-7L13.6 4a3.4 3.4 0 0 1 4.8 4.8L10 17.2a1.8 1.8 0 0 1-2.6-2.6L15 7"/>',
  leaf: '<path d="M5 20c0-9.5 6-15 15.5-15 0 9.5-5.5 15-15 15z"/><path d="M5 20c3-4.5 6.5-7.5 10.5-9.5"/>',
  swap: '<path d="M7 4L4 7l3 3M4 7h16M17 20l3-3-3-3M20 17H4"/>',
  expand: '<path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7"/>',
  refresh: '<path d="M20 11.5a8 8 0 1 1-2.4-5.7L20 8"/><path d="M20 3.5V8h-4.5"/>',
  scale: '<rect x="3.5" y="4" width="17" height="16" rx="3.5"/><path d="M8 10.5a5.5 5.5 0 0 1 8 0M12 10.5l1.8-2"/>',
  rec: '<circle cx="12" cy="12" r="6" fill="currentColor"/>',
  'dot-off': '<circle cx="12" cy="12" r="5.5"/>',
  'dot-obs': '<circle cx="12" cy="12" r="5.5" fill="currentColor" style="color:var(--yolk)"/>',
  'dot-on': '<circle cx="12" cy="12" r="5.5" fill="currentColor" style="color:var(--green-2)"/>',
  pan: '<circle cx="10" cy="13" r="7"/><path d="M17 13h5"/><path d="M8 12.5a2 2 0 1 0 4 0 2 2 0 0 0-4 0"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M5 15V6a1 1 0 0 1 1-1h9"/>' ,
  send: '<path d="M4 12l16-8-6 16-2.5-6.5z"/><path d="M11.5 13.5L20 4"/>',
};
function ico(name, cls = '') {
  const p = IC[name];
  if (!p) return '';
  return `<svg class="ic ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
}

/* ---------------- 用户提供的 Foodlife_Icon_Kit（见 frontend/assets/icons/README.md） ----------------
 * ui/ 是线性图标（stroke=currentColor，跟随控件颜色）：为保证 currentColor 生效且
 * 不违反“fetch 只在 api.js 内”的 smoke 检查，路径以内联字符串同步在 KIT_UI 里；
 * 更新图标时先替换 assets/icons/ui/ 下的文件，再同步这里。
 * ingredients/ 与 compact/ 是固定填色插画，用 <img> 引用（foodImg / iconize）。 */
const KIT_UI = {
  home: '<g fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 11 12 4l8.5 7M5.6 10v8.7A1.3 1.3 0 0 0 6.9 20h10.2a1.3 1.3 0 0 0 1.3-1.3V10M10 20v-4.6a.8.8 0 0 1 .8-.8h2.4a.8.8 0 0 1 .8.8V20"/></g>',
  plan: '<g fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="5.8" width="16" height="14.4" rx="2.2"/><path d="M8.1 4v3.4M15.9 4v3.4M4.3 10.3h15.4m-9.5 3.6h3.7m-3.7 3.1h2.4"/></g>',
  fridge: '<g fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round"><rect x="5.7" y="3.4" width="12.6" height="16.7" rx="2.1"/><path d="M6 10h12m-3.5-3.6v1.5m0 4.7v2.7M8.2 20.1v1m7.6-1v1"/></g>',
  recipes: '<g fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round"><path d="M12 6.4c-1.7-1.5-5-2-8-1.5a1 1 0 0 0-.8 1v11.6a1 1 0 0 0 1.2 1c2.9-.5 5.9 0 7.6 1.4 1.7-1.4 4.7-1.9 7.6-1.4a1 1 0 0 0 1.2-1V5.9a1 1 0 0 0-.8-1c-3-.5-6.3 0-8 1.5V20M6.4 9c1.2-.1 2.2 0 3.2.4m4.8 0c1-.4 2-.5 3.2-.4"/></g>',
  shopping: '<g fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 9.3h13a1 1 0 0 1 1 1.2l-1.2 7.2a2 2 0 0 1-2 1.7H7.7a2 2 0 0 1-2-1.7l-1.2-7.2a1 1 0 0 1 1-1.2Zm2.2 0L10 4.6m6.3 4.7L14 4.6m-4 8.2v3m4-3v3"/></g>',
  journal: '<g fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="7.7"/><path d="M8.8 12.3 11 14.4l4.4-4.6"/></g>',
};
function kitIco(name, cls = '') {
  const p = KIT_UI[name];
  if (!p) return '';
  return `<svg class="ic ${cls}" viewBox="0 0 24 24" aria-hidden="true">${p}</svg>`;
}
/* 包里有新图的 8 种食材：清单/标签/购物行用 compact 版，详情/菜谱卡片/速记 chips 用 ingredients 版；
   其余食材保留原有手绘 glyph，不硬套。 */
const KIT_FOODS = ['egg', 'tomato', 'carrot', 'broccoli', 'shiitake', 'salmon', 'lemon', 'oats'];
const hasKitFood = id => KIT_FOODS.includes(id);
function foodImg(id, variant = 'compact', cls = '') {
  if (!hasKitFood(id)) return foodSvg(id, cls);
  const alt = (FOODS[id] && FOODS[id].name) || id;
  return `<img class="ic food kit${variant === 'ingredients' ? '-lg' : ''} ${cls}" src="assets/icons/${variant}/${id}.svg" alt="${esc(alt)}">`;
}

/* ---------------- 食材插画 ---------------- */
const INK = '#3a2f22';
const ink = (w = 1.3) => `stroke="${INK}" stroke-width="${w}" stroke-linejoin="round" stroke-linecap="round"`;
const shine = (x, y, rx = 2.2, ry = 1.3, rot = -30) => `<ellipse cx="${x}" cy="${y}" rx="${rx}" ry="${ry}" fill="#fff" opacity=".55" transform="rotate(${rot} ${x} ${y})"/>`;
const GLYPH = {
  egg: c => `<path d="M16 3.5c5.2 0 9 7.6 9 14.2A9 9 0 0 1 7 17.7C7 11.1 10.8 3.5 16 3.5z" fill="${c}" ${ink()}/>${shine(12.5, 11, 2, 3.2, 20)}`,
  round: (c, c2 = '#4f8a3c') => `<circle cx="16" cy="18" r="10.5" fill="${c}" ${ink()}/><path d="M11 9.2c1.8 1.2 3.4 1.2 5 0 1.6 1.2 3.2 1.2 5 0-.8 2.4-3 3-5 2.4-2 .6-4.2 0-5-2.4z" fill="${c2}" ${ink(1.1)}/><path d="M16 9V5.5" ${ink(1.4)}/>${shine(11.5, 15)}`,
  lemon: c => `<path d="M3.5 16c1.5-.6 2-1.2 2.6-2.4C8 9.6 11.6 8 16 8s8 1.6 9.9 5.6c.6 1.2 1.1 1.8 2.6 2.4-1.5.6-2 1.2-2.6 2.4C24 22.4 20.4 24 16 24s-8-1.6-9.9-5.6c-.6-1.2-1.1-1.8-2.6-2.4z" fill="${c}" ${ink()}/>${shine(12, 12.5, 3, 1.3, -10)}`,
  leafy: (c, c2 = '#dff0c8') => `<path d="M16 29C7.5 25.2 5 16.5 8.4 7.6c3 1.8 5.4.8 7.6-3.6 2.2 4.4 4.6 5.4 7.6 3.6C27 16.5 24.5 25.2 16 29z" fill="${c}" ${ink()}/><path d="M16 28V9M16 15l-4-3.5M16 20l4.5-3.5M16 24l-4-3" stroke="${c2}" stroke-width="1.4" stroke-linecap="round"/>`,
  broc: (c) => `<path d="M13 19h6l-1 9.5h-4z" fill="#a8cf86" ${ink()}/><circle cx="10" cy="15" r="6" fill="${c}" ${ink()}/><circle cx="22" cy="15" r="6" fill="${c}" ${ink()}/><circle cx="16" cy="9.5" r="6.5" fill="${c}" ${ink()}/><circle cx="14" cy="8" r="1" fill="#fff" opacity=".4"/><circle cx="9" cy="13.5" r="1" fill="#fff" opacity=".4"/>`,
  steak: (c) => `<path d="M5 15c0-5.5 5-9 11.5-9C23 6 27.5 9 27.5 14.5S24 26 16 26C9 26 5 21 5 15z" fill="${c}" ${ink()}/><path d="M9.5 15c2-3 5-1 7-3.5s5-1.5 6.5 1M11 20c2.5-1.5 5 .5 8-1.5" stroke="#fbe4dc" stroke-width="1.6" stroke-linecap="round" fill="none"/><circle cx="21.5" cy="19.5" r="2.3" fill="#fbe4dc" ${ink(1)}/>`,
  drum: (c) => `<path d="M11.5 20.5l-5 5" stroke="${INK}" stroke-width="5.5" stroke-linecap="round"/><path d="M11.5 20.5l-5 5" stroke="#f6ecd8" stroke-width="3" stroke-linecap="round"/><circle cx="5" cy="25" r="2.4" fill="#f6ecd8" ${ink(1.1)}/><circle cx="7.5" cy="27.5" r="2.4" fill="#f6ecd8" ${ink(1.1)}/><path d="M19.5 3.5c5.5 0 9 4 9 9.2 0 6.3-6.2 10.3-12.3 9.8-3-.3-5.2-2.6-5.4-5.5C10.4 11 13.5 3.5 19.5 3.5z" fill="${c}" ${ink()}/>${shine(21, 8.5, 2.6, 1.4)}`,
  fish: (c) => `<path d="M3 16c4.3-6.2 10.6-8.2 16.5-6L27 4.5v23L19.5 22C13.6 24.2 7.3 22.2 3 16z" fill="${c}" ${ink()}/><path d="M13 11c1.6 3 1.6 7 0 10" stroke="#fde6d6" stroke-width="1.4" fill="none" stroke-linecap="round"/><circle cx="8.3" cy="14.8" r="1.4" fill="${INK}"/>`,
  shrimp: (c) => `<path d="M8 7.5c9-3.5 18 2.6 16.2 11.6-1 5-6 7.5-10.5 5.6" stroke="${INK}" stroke-width="8" stroke-linecap="round" fill="none"/><path d="M8 7.5c9-3.5 18 2.6 16.2 11.6-1 5-6 7.5-10.5 5.6" stroke="${c}" stroke-width="5.4" stroke-linecap="round" fill="none"/><path d="M15 7.5l-1 4.5M20.5 10.5l-3 3M23.5 16l-4 1.2" stroke="#fde3d3" stroke-width="1.2" stroke-linecap="round"/><path d="M13.5 24.5l-6 1.5 3 4z" fill="${c}" ${ink(1.1)}/><circle cx="8.5" cy="7.2" r="1" fill="${INK}"/>`,
  bottle: (c, c2 = '#fffdf6') => `<path d="M13 2.5h6v5.5l3.2 4.5v15.5a1.8 1.8 0 0 1-1.8 1.8h-8.8a1.8 1.8 0 0 1-1.8-1.8V12.5L13 8z" fill="${c}" ${ink()}/><rect x="11.5" y="16" width="9" height="7" rx="1" fill="${c2}" ${ink(1)}/><path d="M13 5h6" ${ink(1.1)}/>`,
  carton: (c) => `<path d="M9 10l3-5.5h8L23 10v18.5H9z" fill="#fffdf7" ${ink()}/><path d="M9 10l3-5.5h8L23 10z" fill="${c}" ${ink()}/><path d="M9 15h14v7H9z" fill="${c}" opacity=".85"/><path d="M14 2.5h4v2h-4z" fill="${c}" ${ink(1)}/>`,
  jar: (c) => `<rect x="9" y="4" width="14" height="5" rx="1.5" fill="#6b5a45" ${ink()}/><path d="M8 10.5c0-1 1-1.5 2-1.5h12c1 0 2 .5 2 1.5V26a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 8 26z" fill="${c}" ${ink()}/><rect x="10.5" y="15" width="11" height="6.5" rx="1" fill="#fbf2df" ${ink(1)}/>`,
  wheat: (c) => `<path d="M16 29V8" ${ink(1.5)}/>${[9, 14, 19].map(y => `<ellipse cx="12.5" cy="${y}" rx="3.2" ry="2" fill="${c}" ${ink(1)} transform="rotate(35 12.5 ${y})"/><ellipse cx="19.5" cy="${y}" rx="3.2" ry="2" fill="${c}" ${ink(1)} transform="rotate(-35 19.5 ${y})"/>`).join('')}<ellipse cx="16" cy="5" rx="2" ry="3" fill="${c}" ${ink(1)}/>`,
  rice: (c) => `<path d="M6.5 15c0-5.5 4.2-9 9.5-9s9.5 3.5 9.5 9z" fill="#fffdf7" ${ink()}/><path d="M12 10.5h.5M16 9h.5M19.5 11h.5M14 13h.5M18 13.5h.5" stroke="${INK}" stroke-width="1" stroke-linecap="round" opacity=".5"/><path d="M3.5 15h25a12.5 12.5 0 0 1-25 0z" fill="${c}" ${ink()}/><path d="M8 20.5h16" stroke="#fff" stroke-width="1.4" opacity=".55" stroke-linecap="round"/>`,
  noodle: (c) => `<path d="M8 15c1-6 2-8 3-8M12.5 15c.5-6 1.5-9 2.5-9M17 15c0-6 .5-9 1.5-9M21.5 15c-.5-5 0-7 1-7.5" stroke="${c}" stroke-width="2.2" stroke-linecap="round" fill="none"/><path d="M3.5 15h25a12.5 12.5 0 0 1-25 0z" fill="#7aa7c2" ${ink()}/><path d="M7 21h18" stroke="#fff" stroke-width="1.6" opacity=".55" stroke-dasharray="2 2.5"/>`,
  bread: (c) => `<path d="M6 13.5C2.5 13.5 2.5 6 10 6h12c7.5 0 7.5 7.5 4 7.5V27H6z" fill="${c}" ${ink()}/><path d="M9 13c-1.5 0-1.5-3.5 2-3.5h10c3.5 0 3.5 3.5 2 3.5v11H9z" fill="#f8e4bf"/>`,
  mush: (c) => `<path d="M12.5 17h7l1 10a1.8 1.8 0 0 1-1.8 1.8h-5.4a1.8 1.8 0 0 1-1.8-1.8z" fill="#f4e7cf" ${ink()}/><path d="M3.5 17.5C3.5 9.5 9 4.5 16 4.5S28.5 9.5 28.5 17.5z" fill="${c}" ${ink()}/><circle cx="11" cy="11" r="1.6" fill="#fff" opacity=".6"/><circle cx="19" cy="9" r="1.2" fill="#fff" opacity=".6"/><circle cx="22" cy="13.5" r="1.4" fill="#fff" opacity=".6"/>`,
  carrot: (c) => `<path d="M9 10c3.2-3 8.5-2 10.3 1.3L9.2 29C6.8 23 6.5 15 9 10z" fill="${c}" ${ink()}/><path d="M10.5 15h3M10 20h2.5M9.8 24.5h1.6" ${ink(1)}/><path d="M13.5 8.5c0-3 1-5 3-6M15 9.5c2-2.5 4.5-3.5 7.5-3M12 8.5c-1-2-3-3.5-5-3.5" stroke="#4f8a3c" stroke-width="2" stroke-linecap="round" fill="none"/>`,
  potato: (c) => `<path d="M5 17c0-7 6-11.5 12.5-10.6C24 7.4 27.6 11.6 27 17c-.6 5.5-6 9.6-12.5 8.7C8.5 25 5 22.5 5 17z" fill="${c}" ${ink()}/><path d="M11 13h.01M18 11.5h.01M21.5 17h.01M13 19.5h.01" stroke="${INK}" stroke-width="1.6" stroke-linecap="round" opacity=".55"/>`,
  cuke: (c) => `<path d="M4.5 24.5c-1.8-2.2.2-6 4.3-9.8L19 5.2c3-2.2 7.3.8 6.2 4-1 2.4-9 11.4-14 15.6-2.4 2-5 2.2-6.7-.3z" fill="${c}" ${ink()}/><path d="M9 19.5h.01M13 16h.01M17 12h.01M20.5 9h.01M12.5 20.5h.01M16.5 16.5h.01" stroke="#d9efc6" stroke-width="1.8" stroke-linecap="round"/>`,
  garlic: (c) => `<path d="M16 3.5c.8 4.5 9.5 8 9.5 15.5a9.5 9.5 0 0 1-19 0C6.5 11.5 15.2 8 16 3.5z" fill="${c}" ${ink()}/><path d="M16 10c-2.5 4-3.5 9-2.5 18.3M16 10c2.5 4 3.5 9 2.5 18.3" stroke="${INK}" stroke-width="1" fill="none" opacity=".5"/><path d="M14 3.8l2-1 2 1" ${ink(1)}/>`,
  nut: (c) => `<path d="M16 4.5c4 0 6.5 2.6 6.5 5.6 0 2.2-1.5 3.2-1.5 5.9s1.5 3.7 1.5 5.9c0 3-2.5 5.6-6.5 5.6s-6.5-2.6-6.5-5.6c0-2.2 1.5-3.2 1.5-5.9S9.5 12.3 9.5 10.1c0-3 2.5-5.6 6.5-5.6z" fill="${c}" ${ink()}/><path d="M12.5 9.5h.01M19.5 9.5h.01M16 12h.01M12.5 21.5h.01M19.5 21.5h.01M16 24h.01" stroke="${INK}" stroke-width="1.4" stroke-linecap="round" opacity=".45"/>`,
  cube: (c) => `<path d="M16 5l10 5v12l-10 5-10-5V10z" fill="${c}" ${ink()}/><path d="M6 10l10 5 10-5M16 15v12" ${ink(1.1)} fill="none"/><path d="M16 15l10-5v12l-10 5z" fill="#000" opacity=".06"/>`,
  berry: (c) => `${[[11, 18], [21, 18], [16, 11], [16, 23]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="5.6" fill="${c}" ${ink()}/><path d="M${x - 1.2} ${y - 2.2}l1.2 1 1.2-1" stroke="#cdd6f3" stroke-width="1" fill="none"/>`).join('')}`,
  banana: (c) => `<path d="M5 9.5c1.5 9.5 9.5 16 20.5 13 1.5-.4 1.8 1.6.4 2.4C14.5 31 3 21 3.5 10.2c0-1.4 1.3-1.8 1.5-.7z" fill="${c}" ${ink()}/><path d="M3.5 9.8L4 6.5" stroke="#6b5a2a" stroke-width="2.2" stroke-linecap="round"/><path d="M8 13c2.5 5 7 8.5 13 9.5" stroke="#fff" stroke-width="1.3" opacity=".5" fill="none"/>`,
  melon: (c) => `<ellipse cx="16" cy="17" rx="12" ry="9" fill="${c}" ${ink()}/><path d="M8 11c2 4 2 8 0 12M14 8.5c1.5 5 1.5 12 0 17M20 8.8c1 5 1 11.5 0 16.5" stroke="#cfe3c5" stroke-width="1.3" fill="none"/>`,
  cup: (c) => `<path d="M7 9h18l-2 18.5a1.8 1.8 0 0 1-1.8 1.5h-10.4a1.8 1.8 0 0 1-1.8-1.5z" fill="${c}" ${ink()}/><rect x="5.5" y="5.5" width="21" height="4" rx="1.5" fill="#e6cfe3" ${ink()}/><path d="M9 16h14" stroke="#c99fc6" stroke-width="2.5"/>`,
  herb: (c) => `<path d="M10 29c0-8 1-16 3-25M16 29c0-9 0-17 1-26M22 29c0-8-.5-15-2.5-23" stroke="${INK}" stroke-width="4.2" stroke-linecap="round" fill="none"/><path d="M10 29c0-8 1-16 3-25M16 29c0-9 0-17 1-26M22 29c0-8-.5-15-2.5-23" stroke="${c}" stroke-width="2.2" stroke-linecap="round" fill="none"/><path d="M8 25h16" stroke="#f6f0dc" stroke-width="3"/>`,
  ribs: (c) => `<rect x="4.5" y="9" width="23" height="14" rx="5" fill="${c}" ${ink()}/><path d="M10 6.5v19M16 6.5v19M22 6.5v19" stroke="${INK}" stroke-width="4" stroke-linecap="round"/><path d="M10 6.5v19M16 6.5v19M22 6.5v19" stroke="#f6ecd8" stroke-width="2" stroke-linecap="round"/>`,
};
const FOOD_ART = {
  egg: ['egg', '#f6e3c3'], tomato: ['round', '#e2553a'], oil: ['bottle', '#e9b949'], chicken: ['drum', '#dd935a'], peanut: ['nut', '#cf9f62'],
  cucumber: ['cuke', '#5f9a4a'], broccoli: ['broc', '#4f8a3c'], garlic: ['garlic', '#f6efe1'], salmon: ['fish', '#ef8a62'], lemon: ['lemon', '#f1cf3d'],
  oats: ['wheat', '#dcb36a'], milk: ['carton', '#5c8fb0'], banana: ['banana', '#f2cf4a'], rice: ['rice', '#7aa7c2'], pork: ['steak', '#e08b83'],
  pidan: ['egg', '#5b4e3f'], tofu: ['cube', '#f7efd9'], doubanjiang: ['jar', '#bb432b'], beef: ['steak', '#a8463e'], potato: ['potato', '#cfa36a'],
  carrot: ['carrot', '#ec7a2f'], shrimp: ['shrimp', '#f2895c'], pasta: ['noodle', '#eccb6f'], bread: ['bread', '#d89a52'], lettuce: ['leafy', '#8cc06a'],
  shiitake: ['mush', '#8a5a3c'], bokchoy: ['leafy', '#4f9a52'], soy: ['bottle', '#5a3a28'], yogurt: ['cup', '#fbf5ea'], blueberry: ['berry', '#4a5fa8'],
  ribs: ['ribs', '#c46a52'], wmelon: ['melon', '#6f9a6a'], noodles: ['noodle', '#ecd79a'], scallion: ['herb', '#5f9a4a'], cilantro: ['herb', '#3f7f3a'],
};
function foodInner(id) { const [g, c] = FOOD_ART[id] || ['round', '#ccc']; return GLYPH[g](c); }
function foodSvg(id, cls = '') { return `<svg class="ic food ${cls}" viewBox="0 0 32 32" aria-hidden="true">${foodInner(id)}</svg>`; }
const nest = (inner, x, y, s) => `<svg x="${x}" y="${y}" width="${s}" height="${s}" viewBox="0 0 32 32">${inner}</svg>`;
const SKIP_ART = new Set(['oil', 'soy', 'garlic', 'scallion', 'cilantro']);
function dishFoods(r) { const main = r.ing.filter(([f, , o]) => !o && !SKIP_ART.has(f)).map(([f]) => f); return (main.length ? main : r.ing.map(i => i[0])).slice(0, 3); }
function dishInner(r) {
  const fs = dishFoods(r);
  const pos = fs.length === 1 ? [[9, 9, 14]] : fs.length === 2 ? [[6, 8.5, 12.5], [14, 11, 12.5]] : [[9, 5.5, 13], [5, 14, 10.5], [16.5, 14, 10.5]];
  return `<circle cx="16" cy="16" r="15" fill="#fffdf8" stroke="${INK}" stroke-width="1.1"/><circle cx="16" cy="16" r="11.8" fill="${r.bg}" stroke="${INK}" stroke-width=".6" stroke-dasharray="1.2 1.6"/>` + fs.map((f, i) => nest(foodInner(f), ...pos[i])).join('');
}
function dishSvg(id, cls = '') { const r = R[id]; if (!r) return ''; return `<svg class="ic dish ${cls}" viewBox="0 0 32 32" aria-hidden="true">${dishInner(r)}</svg>`; }

/* 令牌 → SVG */
const TOKEN = /\[\[(?:(f|r):)?([\w-]+)\]\]/g;
function iconize(s) {
  if (typeof s !== 'string' || s.indexOf('[[') < 0) return s;
  return s.replace(TOKEN, (m, k, n) => k === 'f' ? (hasKitFood(n) ? foodImg(n) : (FOOD_ART[n] ? foodSvg(n) : '')) : k === 'r' ? dishSvg(n) : (KIT_UI[n] ? kitIco(n) : (IC[n] ? ico(n) : m)));
}
(function patchInnerHTML() {
  const d = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
  Object.defineProperty(Element.prototype, 'innerHTML', { configurable: true, get() { return d.get.call(this); }, set(v) { d.set.call(this, iconize(v)); } });
})();
const plainText = s => String(s).replace(TOKEN, '').replace(/\s{2,}/g, ' ').trim();

/* =========================================================
 *  UI 层：外壳 / 组件 / 路由 / 首页 / 计划 / 食材
 * ========================================================= */
const U = { route: 'home', planDays: 7, planOffset: 0, expandedPlanHistory: null, changed: null, pantryFilter: 'all', rq: '', rf: {}, rfood: null, mealDate: null, drawer: false, notif: false, sheet: null, dragKey: null, agentMode: null, agentModel: null, agentThinking: false, agentTeam: false };
/* /version 返回的公开信息（版本号 / commit / Agent 提供方 / 识别是否可用），取不到时保持 null，页面静默不显示。 */
let VERINFO = null;
/* 首页临期：接口数据（成功时）或 null（未加载 / 失败时回退本地计算）。 */
let EXPIRING = null;
let EXPIRING_LOADED = false;
/* 拍照识别：当前待识别的文件（示例照片为 null，走演示候选）。 */
let RC_FILE = null;
/* 健康数据导入：最近一次导入结果（渲染后保留展示），导入后刷新习惯数据。 */
let HABIT_IMPORT_RES = null;
/* AI 气泡朗读：当前正在朗读的消息 id（与烹饪朗读 speak() 状态分开）。 */
let SPEAKING_MSG = null;
const HAS_TASTE_PAGE = typeof tastePageHTML === 'function';
const ROUTES = [
  { id: 'home', ico: '[[home]]', name: '今日', title: '今日餐桌' },
  ...(HAS_TASTE_PAGE ? [{ id: 'taste', ico: '[[sparkle]]', name: '换个胃口', title: '换个胃口', hidden: true }] : []),
  { id: 'assistant', ico: '[[chef]]', name: 'AI 管家', title: 'AI 管家' },
  { id: 'plan', ico: '[[plan]]', name: '菜单计划', title: '菜单计划' },
  { id: 'pantry', ico: '[[fridge]]', name: '食材冰箱', title: '食材冰箱' },
  { id: 'recipes', ico: '[[recipes]]', name: '菜谱', title: '菜谱' },
  { id: 'shopping', ico: '[[shopping]]', name: '购物清单', title: '购物清单' },
  { id: 'meals', ico: '[[journal]]', name: '饮食记录', title: '饮食记录' },
  { id: 'habits', ico: '[[drop]]', name: '生活习惯', title: '生活习惯' },
  { id: 'reports', ico: '[[chart]]', name: '周报', title: '周报' },
  { id: 'settings', ico: '[[gear]]', name: '设置', title: '设置与隐私' },
];
const NAV_ROUTES = ROUTES.filter(route => !route.hidden);
const PAGES = {}, AFTER = {};
if (HAS_TASTE_PAGE) {
  PAGES.taste = tastePageHTML;
  AFTER.taste = enterTastePage;
}

/* ---------------- components ---------------- */
function toast(msg, err) {
  const el = document.createElement('div'); el.className = 'toast' + (err ? ' err' : ''); el.innerHTML = msg;
  $('#toasts').appendChild(el); setTimeout(() => { el.style.transition = 'opacity .3s'; el.style.opacity = 0; setTimeout(() => el.remove(), 300); }, 2600);
}
let _modalClose = null;
function modal({ title, body, buttons = [], wide, onMount, onClose }) {
  closeModal();
  const root = $('#modal-root');
  root.innerHTML = `<div class="modal-bg"><div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(plainText(title))}">
    <div class="modal-h"><h3>${title}</h3><button class="icon-btn sp" data-x aria-label="关闭">[[x]]</button></div>
    <div class="modal-b">${body}</div>
    ${buttons.length ? `<div class="modal-f">${buttons.map((b, i) => `<button class="btn ${b.cls || ''}" data-b="${i}">${b.label}</button>`).join('')}</div>` : ''}
  </div></div>`;
  const bg = $('.modal-bg', root);
  bg.addEventListener('mousedown', e => { if (e.target === bg) closeModal(); });
  $('[data-x]', root).onclick = closeModal;
  buttons.forEach((b, i) => { $(`[data-b="${i}"]`, root).onclick = () => { const r = b.fn ? b.fn(root) : undefined; if (r && typeof r.then === 'function') { r.then(v => { if (v !== false && !b.keep) closeModal(); }).catch(() => {}); } else if (r !== false && !b.keep) closeModal(); }; });
  /* 弹窗表单 Enter 提交：焦点在输入框时按 Enter 走主按钮（textarea / 下拉不触发）；
     焦点在选择器搜索框时 Enter 先选中第一项。按钮自身获得焦点时由浏览器默认行为处理。 */
  root.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    const t = e.target;
    if (!t || t.closest('textarea, select, input[type=date]') || t.tagName === 'BUTTON' || t.tagName === 'A') return;
    if (t.closest('.food-picker')) { const first = $('.food-pick', root); if (first) { e.preventDefault(); first.click(); } return; }
    if (t.closest('.meal-add')) { const first = $('.meal-add-list button', root); if (first) { e.preventDefault(); first.click(); } return; }
    if (t.closest('.food-combo')) { const first = $('.food-combo-list button', root); if (first) { e.preventDefault(); first.click(); } return; }
    if (!buttons.length) return;
    const idx = buttons.findIndex(b => (b.cls || '').includes('pri'));
    const btn = $(`[data-b="${idx >= 0 ? idx : buttons.length - 1}"]`, root);
    if (btn) { e.preventDefault(); btn.click(); }
  });
  bindSegs(root);
  _modalClose = onClose || null;
  if (onMount) onMount(root);
  return root;
}
function closeModal() { const root = $('#modal-root'); if (root && root.innerHTML) { root.innerHTML = ''; const f = _modalClose; _modalClose = null; if (f) f(); } }
function commit(msg, err) { render(); if (msg) toast(msg, err); }
function go(route) { location.hash = '#/' + route; }
function badgeExp(bt) {
  const d = expDays(bt);
  if (!bt.expires) return '<span class="badge">无保质期</span>';
  if (d < 0) return `<span class="badge" style="background:var(--ink);color:var(--paper)">已过期 ${-d} 天</span>`;
  if (d === 0) return '<span class="badge r">今天到期</span>';
  if (d === 1) return '<span class="badge r">明天到期</span>';
  if (d <= 3) return `<span class="badge y">${d} 天后到期</span>`;
  return `<span class="badge g">${d} 天</span>`;
}
function nutriCard(nut, servLabel) {
  const names = ['能量', '蛋白质', '脂肪', '碳水'], units = ['kcal', 'g', 'g', 'g'];
  return `<div class="ncard">${nut.v.map((x, i) => `<div class="n"><b>${r0(x)}${nut.complete ? '' : '<small style="font-size:11px">+?</small>'}</b><span>${names[i]} ${units[i]}</span></div>`).join('')}</div>
  <div class="row small muted" style="margin-top:8px">
    ${nut.complete ? '<span class="badge g">完整</span>' : `<span class="badge y">部分已知</span> 缺营养来源：${nut.unknown.map(esc).join('、')}`}
    <span class="badge b">basis: ${nut.basis}</span>${servLabel ? `<span>${servLabel}</span>` : ''}
  </div>`;
}
function emptyState(em, text, btn) { return `<div class="empty"><span class="big">${em}</span>${text}${btn ? `<div style="margin-top:10px">${btn}</div>` : ''}</div>`; }
function pendingActions() { return Object.values(S.actions).filter(a => a.status === 'waiting_approval'); }
function activeShopping() { return S.shopping.filter(x => !['received', 'cancelled'].includes(x.status)); }
function urgentBatches() { return S.batches.filter(b => (b.qtyStatus === 'unknown' || b.remaining > 0) && b.expires && expDays(b) <= 3).sort((a, b) => expDays(a) - expDays(b)); }

/* ---------------- 2026-11-18 UX 改造：选择器 / 速记 / 撤销 ---------------- */
/* seg 分段控件：替代 ≤6 选项的 <select>，点即选中，无二级确认 */
function segHTML(name, options, current, cls = '') {
  return `<div class="seg ${cls}" data-seg="${name}" role="group">${options.map(([v, l]) => `<button type="button" data-v="${v}" class="${String(v) === String(current) ? 'on' : ''}" aria-pressed="${String(v) === String(current)}">${l}</button>`).join('')}</div>`;
}
function segValue(root, name) { const b = $(`.seg[data-seg="${name}"] .on`, root || document); return b ? b.dataset.v : null; }
function bindSegs(root) {
  $$('.seg[data-seg]', root).forEach(g => {
    g.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      $$('button', g).forEach(x => { x.classList.remove('on'); x.setAttribute('aria-pressed', 'false'); });
      b.classList.add('on'); b.setAttribute('aria-pressed', 'true');
    });
  });
}
/* 食材默认：保质期（天）/ 存放位置 / 默认量 —— 前端兜底（后端 FOODS 未给保质期字段）。
   未逐项列出的按类别兜底：叶菜 3 天、蛋奶 7 天、根茎 14 天、干货 90 天。 */
const FOOD_DEFAULTS = {
  egg: { days: 14, loc: 'fridge', qty: 6 }, tomato: { days: 5, loc: 'fridge', qty: 2 }, oil: { days: 180, loc: 'pantry', qty: 500 },
  chicken: { days: 2, loc: 'fridge', qty: 500 }, peanut: { days: 90, loc: 'pantry', qty: 200 }, cucumber: { days: 5, loc: 'fridge', qty: 2 },
  broccoli: { days: 4, loc: 'fridge', qty: 300 }, garlic: { days: 30, loc: 'pantry', qty: 100 }, salmon: { days: 2, loc: 'fridge', qty: 300 },
  lemon: { days: 14, loc: 'fridge', qty: 1 }, oats: { days: 90, loc: 'pantry', qty: 500 }, milk: { days: 7, loc: 'fridge', qty: 1000 },
  banana: { days: 4, loc: 'fridge', qty: 3 }, rice: { days: 180, loc: 'pantry', qty: 1000 }, pork: { days: 2, loc: 'fridge', qty: 300 },
  pidan: { days: 30, loc: 'pantry', qty: 2 }, tofu: { days: 3, loc: 'fridge', qty: 400 }, doubanjiang: { days: 180, loc: 'pantry', qty: 100 },
  beef: { days: 2, loc: 'fridge', qty: 300 }, potato: { days: 14, loc: 'pantry', qty: 500 }, carrot: { days: 14, loc: 'fridge', qty: 300 },
  shrimp: { days: 2, loc: 'fridge', qty: 300 }, pasta: { days: 180, loc: 'pantry', qty: 500 }, bread: { days: 5, loc: 'pantry', qty: 1 },
  lettuce: { days: 3, loc: 'fridge', qty: 200 }, shiitake: { days: 5, loc: 'fridge', qty: 200 }, bokchoy: { days: 3, loc: 'fridge', qty: 300 },
  soy: { days: 180, loc: 'pantry', qty: 250 }, yogurt: { days: 10, loc: 'fridge', qty: 200 }, blueberry: { days: 5, loc: 'fridge', qty: 125 },
  ribs: { days: 2, loc: 'fridge', qty: 500 }, wmelon: { days: 7, loc: 'fridge', qty: 1 }, noodles: { days: 180, loc: 'pantry', qty: 500 },
  scallion: { days: 5, loc: 'fridge', qty: 100 }, cilantro: { days: 3, loc: 'fridge', qty: 50 },
};
function foodDefault(id) {
  const d = FOOD_DEFAULTS[id];
  if (d) return d;
  const f = FOODS[id] || {};
  const name = f.name || '';
  if (/生菜|白菜|香菜|葱|菠菜|青菜|油麦/.test(name)) return { days: 3, loc: 'fridge', qty: 200 };
  if (/蛋|奶|酸奶|豆腐|豆浆/.test(name)) return { days: 7, loc: 'fridge', qty: 1 };
  if (/土豆|胡萝卜|萝卜|洋葱|姜|蒜/.test(name)) return { days: 14, loc: 'fridge', qty: 200 };
  if (/米|面|燕麦|粉|干/.test(name)) return { days: 90, loc: 'pantry', qty: 500 };
  return { days: 7, loc: 'fridge', qty: f.unit === 'piece' ? 1 : 500 };
}
/* 最近使用优先：入库 + 记餐里出现过的食材排在前面 */
function foodUsageScore() {
  const sc = {};
  (S.batches || []).forEach(b => { sc[b.foodId] = (sc[b.foodId] || 0) + 2; });
  (S.meals || []).forEach(m => m.items.forEach(it => { if (it.foodId) sc[it.foodId] = (sc[it.foodId] || 0) + 1; }));
  return sc;
}
function orderedFoods() {
  const sc = foodUsageScore();
  return Object.keys(FOODS).sort((a, b) => (sc[b] || 0) - (sc[a] || 0));
}
/* 食材选择器：搜索框 + 图标网格平铺（替代 <select>），常用在前，点即选中 */
function foodGridItems(q, selected) {
  const query = (q || '').trim();
  const list = orderedFoods().filter(id => {
    if (!query) return true;
    const f = FOODS[id];
    return f.name.includes(query) || (f.tags || []).some(t => t.includes(query));
  });
  if (!list.length) return '<div class="muted small" style="grid-column:1/-1;padding:10px">没有匹配的食材，换个关键词试试</div>';
  return list.map(id => { const f = FOODS[id]; return `<button type="button" class="food-pick ${id === selected ? 'on' : ''}" data-id="${id}">${foodImg(id)}<span>${f.name}</span><span class="u">${UNIT[f.unit]}</span></button>`; }).join('');
}
function foodPickerHTML(selected, id = 'fp') {
  return `<div class="food-picker" data-fp="${id}">
    <input class="input fp-q" type="search" placeholder="搜食材，如：番茄、鸡蛋" aria-label="搜索食材">
    <div class="food-grid">${foodGridItems('', selected)}</div>
    <input type="hidden" class="fp-v" value="${esc(selected || '')}">
  </div>`;
}
function bindFoodPicker(root, onChange, id = 'fp') {
  const box = $(`.food-picker[data-fp="${id}"]`, root);
  if (!box) return;
  const q = $('.fp-q', box), grid = $('.food-grid', box), hid = $('.fp-v', box);
  q.addEventListener('input', () => { grid.innerHTML = foodGridItems(q.value, hid.value); });
  grid.addEventListener('click', e => {
    const b = e.target.closest('.food-pick'); if (!b) return;
    $$('.food-pick', grid).forEach(x => x.classList.remove('on'));
    b.classList.add('on'); hid.value = b.dataset.id;
    if (onChange) onChange(b.dataset.id);
  });
}
function foodPickerValue(root, id = 'fp') { const h = $(`.food-picker[data-fp="${id}"] .fp-v`, root); return h ? h.value : null; }
/* 紧凑版食材联想（识别候选行等空间紧张处）：输入框 + 浮层列表，点即选中 */
function foodComboHTML(foodId) {
  const f = FOODS[foodId];
  return `<div class="food-combo"><input class="input rc-f-q" value="${esc(f ? f.name : '')}" data-v="${esc(foodId || '')}" placeholder="搜食材" autocomplete="off" aria-label="选择食材"><div class="food-combo-list hidden"></div></div>`;
}
function bindFoodCombo(root) {
  $$('.food-combo', root).forEach(box => {
    const inp = $('.rc-f-q', box), list = $('.food-combo-list', box);
    const show = () => {
      const q = inp.value.trim();
      const hits = orderedFoods().filter(id => { const f = FOODS[id]; return !q || f.name.includes(q) || (f.tags || []).some(t => t.includes(q)); }).slice(0, 8);
      list.innerHTML = hits.map(id => `<button type="button" data-id="${id}">${foodImg(id)}<span>${FOODS[id].name}</span><span class="muted small">${UNIT[FOODS[id].unit]}</span></button>`).join('') || '<div class="muted small" style="padding:8px">没有匹配的食材</div>';
      list.classList.remove('hidden');
    };
    inp.addEventListener('focus', show);
    inp.addEventListener('input', show);
    list.addEventListener('click', e => {
      const b = e.target.closest('button[data-id]'); if (!b) return;
      inp.value = FOODS[b.dataset.id].name; inp.dataset.v = b.dataset.id; list.classList.add('hidden');
    });
    inp.addEventListener('blur', () => setTimeout(() => list.classList.add('hidden'), 150));
  });
}
/* 可撤销 toast：删除类操作直接执行，3 秒内可点“撤销”恢复（不再弹模态框确认） */
function toastUndo(msg, undoLabel, onUndo, ms = 3000) {
  const el = document.createElement('div'); el.className = 'toast';
  el.innerHTML = msg + ` <button class="toast-undo">${undoLabel}</button>`;
  $('#toasts').appendChild(el);
  let done = false;
  const finish = () => { if (done) return; done = true; el.style.transition = 'opacity .3s'; el.style.opacity = 0; setTimeout(() => el.remove(), 300); };
  $('button', el).onclick = () => { finish(); if (onUndo) onUndo(); };
  setTimeout(finish, ms);
}

/* ---------------- chrome ---------------- */
function homePendingHTML() {
  const pend = pendingActions();
  return `<h4>[[pen]] 待你确认 · ${pend.length}</h4>
      ${pend.length ? `<ul class="mini-list">${pend.slice(0, 3).map(a => `<li>[[file]] ${esc(a.summary)}</li>`).join('')}</ul><button class="btn sm pri" style="margin-top:10px" onclick="openDrawer()">去审批 →</button>`
      : `<p class="small">AI 提出的修改都需要你盖章后才会生效。</p><button class="btn sm" style="margin-top:6px" onclick="askAI('把周三晚餐换成不含鸡肉的菜')">试试：换掉周三晚餐</button>`}`;
}
function renderChrome() {
  if (!AUTHED || !S) {
    $('#side').innerHTML = `<div class="brand"><div class="brand-logo">[[pot]]</div><div><b>食光管家</b><span>AI KITCHEN JOURNAL</span></div></div><div class="side-foot">${AUTHED ? '正在加载…' : '请先登录'}</div>`;
    $('#top').innerHTML = `<div><h1>${AUTHED ? '加载中' : '登录'}</h1><div class="crumb">食光管家</div></div>`;
    $('#tabbar').innerHTML = '';
    $('#chef').classList.add('hidden');
    return;
  }
  const cnt = { pantry: urgentBatches().length, shopping: activeShopping().length, assistant: pendingActions().length };
  $('#side').innerHTML = `
    <div class="brand"><div class="brand-logo">[[pot]]</div><div><b>食光管家</b><span>AI KITCHEN JOURNAL</span></div></div>
    ${NAV_ROUTES.map(r => {
      const active = U.route === r.id;
      const count = cnt[r.id];
      return `<a class="nav-item${active ? ' active' : ''}" href="#/${r.id}" aria-label="${r.name}${count ? `，${count} 项` : ''}"${active ? ' aria-current="page"' : ''}><span class="ico">${r.ico}</span><span class="lbl">${r.name}</span>${count ? `<span class="count">${count}</span>` : ''}</a>`;
    }).join('')}
    <div class="side-foot">数据保存在服务端<br>营养数值为服务端食物库数据，仅供一般参考，<b>不构成医疗建议</b>。</div>`;
  const r = ROUTES.find(x => x.id === U.route);
  const unread = S.notifs.filter(n => !n.read).length;
  $('#top').innerHTML = `
    <div><h1>${r.title}</h1><div class="crumb">${U.route === 'taste' ? D.md(D.todayKey()) + ' ' + D.wd(D.todayKey()) : `/${r.id} · 计划 ${S.plan ? 'v' + S.plan.active : '未建立'} · ${D.todayKey()} ${D.wd(D.todayKey())}`}</div></div>
    <div class="top-actions">
      <button class="icon-btn" onclick="toggleTheme()" title="切换日间/夜间厨房" aria-label="切换主题">${document.documentElement.dataset.theme === 'dark' ? '[[sun]]' : '[[moon]]'}</button>
      <div style="position:relative">
        <button class="icon-btn" onclick="toggleNotif(event)" aria-label="通知">[[bell]]${unread ? '<span class="dot"></span>' : ''}</button>
        ${U.notif ? notifDropdown() : ''}
      </div>
      <button class="icon-btn" onclick="go('settings')" title="${esc(S.user.name)}" aria-label="个人设置" style="background:var(--primary-soft);color:var(--primary)">[[user]]</button>
    </div>`;
  $('#tabbar').innerHTML = [['home', '[[home]]', '今日'], ['plan', '[[plan]]', '计划'], ['+', '＋', ''], ['pantry', '[[fridge]]', '冰箱'], ['more', '[[menu]]', '更多']].map(([id, ic, nm]) =>
    id === '+' ? `<button class="plus" onclick="openSheet('quick')" aria-label="快捷记录"><span>＋</span></button>` :
      id === 'more' ? `<button onclick="openSheet('more')" class="${['home', 'plan', 'pantry'].includes(U.route) ? '' : 'on'}"><span>${ic}</span>${nm}</button>` :
        `<button class="${U.route === id ? 'on' : ''}" onclick="go('${id}')"><span>${ic}</span>${nm}</button>`).join('');
  const pendingNote = $('#home-pending');
  if (pendingNote) pendingNote.innerHTML = homePendingHTML();
  const pend = pendingActions().length;
  $('#chef').classList.toggle('hidden', U.route === 'assistant' || U.route === 'taste' || U.drawer);
  $('#chef').innerHTML = `[[chef]]${pend ? `<span class="dot">${pend}</span>` : ''}`;
  renderSheet();
}
function notifDropdown() {
  return `<div class="dropdown" onclick="event.stopPropagation()">
    <div class="row" style="padding:4px 8px 8px"><b style="font-family:var(--serif)">通知</b><button class="btn xs ghost sp" onclick="markAllRead()">全部已读</button></div>
    ${S.notifs.length ? S.notifs.slice(0, 12).map(n => `<div class="notif ${n.read ? '' : 'unread'}" onclick="openNotif('${n.id}')"><span class="em">${n.em}</span><div>${esc(n.text)}<span>${D.ago(n.at)}</span></div></div>`).join('') : emptyState('[[bell-off]]', '暂无通知')}
  </div>`;
}
function toggleNotif(e) {
  e.stopPropagation();
  U.notif = !U.notif;
  renderChrome();
  if (U.notif) {
    refreshNotifications().then(loaded => { if (loaded && U.notif) renderChrome(); });
  }
}
function openNotif(id) {
  const n = S.notifs.find(x => x.id === id);
  if (!n) return;
  n.read = true; U.notif = false;
  Api.readNotification(id).catch(() => {});
  if (n.go) location.hash = n.go;
  render();
}
document.addEventListener('click', () => { if (U.notif) { U.notif = false; renderChrome(); } });
function toggleTheme() { const d = document.documentElement; d.dataset.theme = d.dataset.theme === 'dark' ? 'light' : 'dark'; try { localStorage.setItem('aichef_theme', d.dataset.theme); } catch (e) { } renderChrome(); }
function openSheet(k) { U.sheet = k; renderSheet(); }
function renderSheet() {
  const root = $('#sheet-root');
  if (!U.sheet) { root.innerHTML = ''; return; }
  const items = U.sheet === 'quick'
    ? [['[[basket]]', '添加食材', "openAddBatch()"], ['[[camera]]', '拍照识别', "openRecognize()"], ['[[utensils]]', '记一餐', "openAddMeal()"], ['[[drop]]', '喝水 +250', "addWater()"], ['[[bed]]', '记睡眠', "openHabit('sleep')"], ['[[walk]]', '记步数', "openHabit('steps')"], ['[[scale]]', '记体重', "openHabit('weight')"], ['[[chef]]', '问 AI', "openDrawer()"]]
    : NAV_ROUTES.map(r => [r.ico, r.name, `go('${r.id}')`]);
  root.innerHTML = `<div class="sheet-bg" onclick="U.sheet=null;renderSheet()"></div><div class="sheet"><div class="row" style="margin-bottom:12px"><b style="font-family:var(--serif)">${U.sheet === 'quick' ? '快捷记录' : '全部页面'}</b><button class="btn xs ghost sp" onclick="U.sheet=null;renderSheet()">关闭</button></div>
    <div class="sheet-grid">${items.map(([e, n, f]) => `<button onclick="U.sheet=null;renderSheet();${f}"><span>${e}</span>${n}</button>`).join('')}</div></div>`;
}

/* ---------------- 版本 / Agent 模式 / 临期（/version 与 /pantry/expiring） ---------------- */
function versionLineHTML() {
  if (!VERINFO) return '';
  const v = VERINFO.version || '0.2.0';
  const commit = VERINFO.commit || 'dev';
  const provider = VERINFO.agent_provider || (U.agentMode === 'llm' ? 'llm' : 'rule');
  const model = VERINFO.agent_model || U.agentModel || null;
  const agent = provider === 'llm' ? '模型' + (model ? '（' + model + '）' : '') : '规则模式';
  const rec = VERINFO.recognition_available ? '可用' : '未配置';
  return `版本 v${esc(String(v).replace(/^v/, ''))} · commit ${esc(String(commit))} · Agent: ${agent} · 拍照识别：${rec}`;
}
function agentModeLabel() {
  if (VERINFO) {
    if (VERINFO.agent_provider === 'llm') return '模型' + (VERINFO.agent_model ? '（' + VERINFO.agent_model + '）' : '');
    return '规则模式（未配置模型）';
  }
  if (U.agentMode === 'llm') return '模型' + (U.agentModel ? '（' + U.agentModel + '）' : '');
  if (U.agentMode === 'rule') return '规则模式（未配置模型）';
  return '未知（正在读取版本信息）';
}
async function loadVersion() {
  try {
    const v = await Api.getVersion();
    if (!v) return false;
    VERINFO = v;
    if (v.agent_provider === 'llm') { U.agentMode = 'llm'; U.agentModel = v.agent_model || null; }
    else if (v.agent_provider === 'rule') { U.agentMode = 'rule'; U.agentModel = null; }
    return true;
  } catch (e) { return false; }
}
/* 首页临期：调接口拿数据；成功后刷新通知（服务端写临期提醒）；失败回退本地计算。 */
async function refreshExpiring() {
  try {
    const rows = await Api.listExpiring(3);
    EXPIRING = Array.isArray(rows) ? [...rows].sort((a, b) => (a.days_left ?? 999) - (b.days_left ?? 999)) : [];
    EXPIRING_LOADED = true;
    await refreshNotifications();
    return true;
  } catch (e) {
    EXPIRING = null;
    EXPIRING_LOADED = true;
    return false;
  }
}
function downloadBlob(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

function render() {
  if (BOOT.state === 'auth' || !AUTHED) { renderAuthPage(); return; }
  if (BOOT.state === 'error') { $('#page').innerHTML = errorHTML(); renderChrome(); return; }
  if (!S || BOOT.state === 'loading') { $('#page').innerHTML = loadingHTML(); renderChrome(); return; }
  const h = (location.hash || '#/home').replace(/^#\//, '').split('?')[0];
  if (h !== U.route) U.expandedPlanHistory = null;
  U.route = ROUTES.some(r => r.id === h) ? h : 'home';
  if (U.route === 'assistant') {
    const id = new URLSearchParams(location.hash.split('?')[1] || '').get('thread');
    if (S.threads.some(t => t.id === id)) S.activeThread = id;
    if (U.drawer) { U.drawer = false; renderDrawer(); }
  }
  const page = $('#page');
  page.dataset.route = U.route;
  page.innerHTML = stateBanner() + PAGES[U.route]() + '<div class="disclaimer">营养与过敏信息来自服务端食物库，商业食品请核对实际配料表与交叉接触风险。不提供诊断或治疗性饮食建议。</div>' + (versionLineHTML() ? `<div class="version-line">${versionLineHTML()}</div>` : '');
  bindSegs($('#page'));
  AFTER[U.route] && AFTER[U.route]();
  renderChrome();
  renderChat();
  document.title = ROUTES.find(r => r.id === U.route).title + ' · 食光管家';
  if (U.route === 'home' && !EXPIRING_LOADED) {
    refreshExpiring().then(() => { if (U.route === 'home') render(); });
  }
}
let _lastRoute = null;
window.addEventListener('hashchange', () => {
  render();
  if (_lastRoute !== U.route) window.scrollTo(0, 0);
  _lastRoute = U.route;
  if (U.route === 'reports' && AUTHED) {
    refreshReports().then(loaded => { if (loaded && U.route === 'reports' && !weeklyUpdating) render(); });
  }
});

/* =========================================================
 *  首页 Today
 * ========================================================= */
function arcPath(cx, cy, r, a0, a1) {
  const p = a => [cx + r * Math.cos((a - 90) * Math.PI / 180), cy + r * Math.sin((a - 90) * Math.PI / 180)];
  const [x0, y0] = p(a0), [x1, y1] = p(a1);
  return `M${cx},${cy} L${x0.toFixed(1)},${y0.toFixed(1)} A${r},${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(1)},${y1.toFixed(1)} Z`;
}
function mealInner(m) { const it = m.items[0]; if (!it) return ''; return it.recipeId ? dishInner(R[it.recipeId]) : foodInner(it.foodId); }
/* 可点扇形餐盘（2026-11-18 恢复 + 画风升级）：
   - 3 个扇区 = 早/午/晚；盘面是 hero 图同款釉面径向渐变（--glaze-*，深色模式另有深底版）。
   - 扇区按餐次给柔和区分色：早餐蛋黄、午餐番茄、晚餐叶绿；已吃填实色 + 打勾徽，
     未吃淡色 + 虚线描边暗示可点；无计划的扇区中央是淡淡的 + 号。
   - 扇区中央是食物图标：有图标包新图的单食材用 ingredients 版 <image>，菜品/其余用手绘 glyph。
   - 盘心是“已吃 x/3 餐”小圆徽 + 细环形进度；总 kcal 仍在“今日营养”卡片里。
   - 点击行为与原来一致：未记录开记录（openEatPlanned），已记录跳饮食记录页；
     扇区可 Tab 聚焦，Enter/空格触发，与 :focus-visible 样式一致。 */
function plateSVG(T) {
  const nut = dayNutrition(T);
  const slots = ['breakfast', 'lunch', 'dinner'];
  const eatenCount = slots.filter(s => S.meals.some(m => m.date === T && m.slot === s)).length;
  const conf = { breakfast: [0, 120, 'var(--yolk)'], lunch: [120, 240, 'var(--tomato)'], dinner: [240, 360, 'var(--green-2)'] };
  const CX = 120, CY = 120, RING = 2 * Math.PI * 46;
  const secs = slots.map(slot => {
    const [a0, a1, col] = conf[slot];
    const eaten = S.meals.find(m => m.date === T && m.slot === slot);
    const pm = P.get(T, slot);
    const mid = (a0 + a1) / 2, rad = (mid - 90) * Math.PI / 180;
    const ix = CX + 64 * Math.cos(rad), iy = CY + 64 * Math.sin(rad);
    const bx = CX + 90 * Math.cos(rad), by = CY + 90 * Math.sin(rad);
    const act = eaten ? `go('meals')` : `openEatPlanned('${T}','${slot}')`;
    const label = eaten ? `${SLOTS[slot]}（已记录，点击查看）` : (pm && R[pm.r]) ? `${SLOTS[slot]} · 计划：${R[pm.r].t}（点击记录）` : `${SLOTS[slot]}（点击记录）`;
    let icon = '';
    if (eaten) {
      const it = eaten.items[0];
      if (it && !it.recipeId && hasKitFood(it.foodId)) icon = `<image href=\"assets/icons/ingredients/${it.foodId}.svg\" x=\"${(ix - 16).toFixed(1)}\" y=\"${(iy - 16).toFixed(1)}\" width=\"32\" height=\"32\"/>`;
      else { const inner = mealInner(eaten); if (inner) icon = `<svg x=\"${(ix - 17).toFixed(1)}\" y=\"${(iy - 17).toFixed(1)}\" width=\"34\" height=\"34\" viewBox=\"0 0 32 32\">${inner}</svg>`; }
    } else if (pm && R[pm.r]) {
      icon = `<g opacity=\".45\"><svg x=\"${(ix - 17).toFixed(1)}\" y=\"${(iy - 17).toFixed(1)}\" width=\"34\" height=\"34\" viewBox=\"0 0 32 32\">${dishInner(R[pm.r])}</svg></g>`;
    } else {
      icon = `<g stroke=\"${col}\" stroke-width=\"2\" stroke-linecap=\"round\" opacity=\".55\"><path d=\"M${ix.toFixed(1)} ${(iy - 8).toFixed(1)}V${(iy + 8).toFixed(1)}\"/><path d=\"M${(ix - 8).toFixed(1)} ${iy.toFixed(1)}H${(ix + 8).toFixed(1)}\"/></g>`;
    }
    const fill = eaten ? col : `color-mix(in srgb, ${col} 14%, transparent)`;
    const dash = eaten ? '' : ' stroke-dasharray=\"4 3\"';
    const check = eaten ? `<g><circle cx=\"${bx.toFixed(1)}\" cy=\"${by.toFixed(1)}\" r=\"9\" fill=\"var(--card)\" stroke=\"${col}\" stroke-width=\"1.5\"/><path d=\"M${(bx - 3.8).toFixed(1)} ${by.toFixed(1)}l2.8 2.8 4.8-5.6\" fill=\"none\" stroke=\"${col}\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></g>` : '';
    return `<g class=\"sector\" tabindex=\"0\" role=\"button\" aria-label=\"${label}\" onclick=\"${act}\" onkeydown=\"if(event.key==='Enter'||event.key===' '){event.preventDefault();${act}}\"><title>${label}</title>
      <path d=\"${arcPath(CX, CY, 96, a0 + 1.5, a1 - 1.5)}\" style=\"fill:${fill};stroke:${eaten ? 'var(--card)' : col};stroke-width:${eaten ? 3 : 1.5};opacity:${eaten ? .94 : 1}\"${dash}/>
      ${icon}${check}</g>`;
  }).join('');
  const prog = (eatenCount / 3 * RING).toFixed(1);
  return `<svg class=\"plate\" viewBox=\"0 0 240 240\" role=\"img\" aria-label=\"今日餐盘：已记录 ${eatenCount} 餐，约 ${r0(nut.v[0])} 千卡\">
    <defs><radialGradient id=\"plateGlaze\" cx=\".38\" cy=\".3\" r=\".78\"><stop offset=\"0\" style=\"stop-color:var(--glaze-1)\"/><stop offset=\".68\" style=\"stop-color:var(--glaze-2)\"/><stop offset=\"1\" style=\"stop-color:var(--glaze-3)\"/></radialGradient></defs>
    <circle cx=\"120\" cy=\"120\" r=\"117\" fill=\"url(#plateGlaze)\" stroke=\"var(--line-2)\" stroke-width=\"1.5\"/>
    <circle cx=\"120\" cy=\"120\" r=\"106\" fill=\"none\" stroke=\"var(--line)\" stroke-width=\"1\" stroke-dasharray=\"3 4\"/>
    ${secs}
    <circle cx=\"120\" cy=\"120\" r=\"46\" fill=\"var(--card)\" stroke=\"var(--line)\" stroke-width=\"1\"/>
    <circle cx=\"120\" cy=\"120\" r=\"46\" fill=\"none\" stroke=\"var(--green-2)\" stroke-width=\"3.5\" stroke-linecap=\"round\" stroke-dasharray=\"${prog} ${RING.toFixed(1)}\" transform=\"rotate(-90 120 120)\"/>
    <text x=\"120\" y=\"118\" text-anchor=\"middle\" style=\"font:600 20px var(--mono);fill:var(--ink)\">${eatenCount}/3</text>
    <text x=\"120\" y=\"136\" text-anchor=\"middle\" style=\"font-size:10px;fill:var(--muted)\">餐已记录</text></svg>`;
}
/* 首页临期卡片：有接口数据时用接口行（food_name / days_left / expires_on），
   接口失败时 EXPIRING 为 null，回退本地 urgentBatches() 计算，不白屏。 */
function expiringRowsHTML() {
  if (EXPIRING !== null) {
    if (!EXPIRING.length) return '';
    return EXPIRING.slice(0, 5).map(r => {
      const d = r.days_left ?? (r.expires_on ? D.diff(r.expires_on, D.todayKey()) : 999);
      const badge = d < 0 ? `<span class="badge" style="background:var(--ink);color:var(--paper)">已过期 ${-d} 天</span>` : d === 0 ? '<span class="badge r">今天到期</span>' : d === 1 ? '<span class="badge r">明天到期</span>' : `<span class="badge y">${d} 天后到期</span>`;
      const amt = (r.remaining === null || r.remaining === undefined) ? '' : fmtQty(r.remaining, r.unit || 'g');
      return `<li onclick="go('pantry')" style="cursor:pointer">${esc(r.food_name || '')}${amt ? `<span class="small muted">${amt}</span>` : ''}<span class="sp">${badge}</span></li>`;
    }).join('');
  }
  return urgentBatches().slice(0, 5).map(b => `<li onclick="go('pantry')" style="cursor:pointer">${FOODS[b.foodId].em} ${FOODS[b.foodId].name}<span class="sp">${badgeExp(b)}</span></li>`).join('');
}
const DAILY_REF = [1800, 60, 60, 250];
PAGES.home = () => {
  const T = D.todayKey(); const h = new Date().getHours();
  const greet = h < 10 ? '早上好' : h < 14 ? '中午好' : h < 18 ? '下午好' : '晚上好';
  const nut = dayNutrition(T);
  const urg = urgentBatches();
  const shop = activeShopping();
  const water = S.habits.filter(x => x.kind === 'water' && x.date === T).reduce((s, x) => s + x.value, 0);
  const cups = Math.round(water / 250);
  const firstUrg = urg.find(b => expDays(b) >= 0);
  const mealsToday = ['breakfast', 'lunch', 'dinner'].map(slot => {
    const rec = S.meals.filter(m => m.date === T && m.slot === slot);
    const pm = P.get(T, slot);
    const r = pm && R[pm.r];
    if (rec.length) return `<div class="mt done"><div class="em">${rec[0].em}</div><div class="txt"><span class="slot-tag">${SLOTS[slot]} · 已记录 ${D.time(rec[0].at)}</span><b>${esc(rec.map(x => x.title).join('、'))}</b><span class="small muted">${r0(rec.reduce((s, x) => s + x.nut.v[0], 0))} kcal${rec.some(x => !x.nut.complete) ? ' · 部分已知' : ''}</span></div><button class="btn xs ghost" onclick="go('meals')">查看</button></div>`;
    return `<div class="mt"><div class="em">${r ? r.em : '[[utensils]]'}</div><div class="txt"><span class="slot-tag">${SLOTS[slot]} · 计划</span><b>${r ? r.t : '未安排'}</b><span class="small muted">${r ? `[[timer]] ${r.min} 分钟 · ${pm.sv} 份` : ''}</span></div>
      <div class="row" style="flex-wrap:nowrap;gap:6px">${r ? `<button class="btn xs" onclick="startCooking('${r.id}','${T}','${slot}')">[[flame]] 做</button><button class="btn xs pri" onclick="openEatPlanned('${T}','${slot}')">[[check]] 吃了</button>` : `<button class="btn xs" onclick="openAddMeal('${slot}')">记录</button>`}</div></div>`;
  }).join('');
  return `
  <div class="hero">
    <div class="card home-meals">
      <div class="home-greeting">
        <div class="hello">${greet}，${esc(S.user.name)}<small>${D.md(T)} ${D.wd(T)} · 今天的餐盘还空着 ${3 - ['breakfast', 'lunch', 'dinner'].filter(s => S.meals.some(m => m.date === T && m.slot === s)).length} 格</small>
          ${HAS_TASTE_PAGE ? `<a class="taste-ticket" href="#/taste" onclick="rememberTasteEntry(event)">
            <span class="taste-ticket-mark" aria-hidden="true">[[sparkle]]</span>换个胃口 [[expand]]
          </a>` : ''}
        </div>
        <img class="hero-deco" src="assets/icons/hero/tomato-egg-plate.svg" alt="">
      </div>
      <div class="plate-wrap">${plateSVG(T)}<div class="meal-today">${mealsToday}</div></div>
    </div>
    <div class="col home-summary">
      <div class="card">
        <div class="card-h"><h3>今日营养</h3>${nut.partial ? '<span class="badge y">部分已知</span>' : nut.count ? '<span class="badge g">已知完整</span>' : ''}<span class="sp small muted">对照一般参考值</span></div>
        <div class="nutri-bars">${['能量', '蛋白质', '脂肪', '碳水'].map((n, i) => `<div class="nb"><span>${n}</span><div class="progress"><i style="width:${Math.min(100, nut.v[i] / DAILY_REF[i] * 100)}%;background:var(${['--yolk', '--green', '--tomato', '--sky'][i]})"></i></div><span class="mono small">${r0(nut.v[i])}/${DAILY_REF[i]}${i ? 'g' : ''}</span></div>`).join('')}</div>
        <p class="small muted" style="margin:10px 0 0">仅基于已确认的记餐计算；营养来源缺失的食材不计入数值，不做估算填补。</p>
      </div>
      ${firstUrg ? `<div class="note red tilt-r" style="display:flex;gap:12px;align-items:center"><span style="font-size:30px">[[bulb]]</span><div style="flex:1"><b>${FOODS[firstUrg.foodId].name}</b> ${expDays(firstUrg) === 0 ? '今天' : expDays(firstUrg) + ' 天后'}到期<div class="small muted">让 AI 管家从菜谱库里找能用掉它的菜，替换进今晚</div></div><button class="btn sm pri" onclick="askAI('用快过期的食材安排今晚的菜')">问 AI</button></div>` : ''}
      <div class="card">
        <div class="card-h"><h3>[[drop]] 今日饮水</h3><span class="sp mono">${water} ml</span></div>
        <div class="water-glass">${Array.from({ length: 8 }, (_, i) => `<i class="${i < cups ? 'full' : ''}"></i>`).join('')}</div>
        <div class="row"><button class="btn sm" onclick="addWater()">＋ 250 ml</button><button class="btn sm ghost" onclick="go('habits')">全部习惯 →</button><span class="sp small muted">自愿记录 · 未记录 ≠ 没喝</span></div>
      </div>
    </div>
  </div>
  <div class="notes-board">
    <div class="note red tilt-l tape home-list-note"><h4>[[clock]] 临期食材 · ${EXPIRING !== null ? EXPIRING.length : urg.length}</h4>
      ${(EXPIRING !== null ? EXPIRING.length : urg.length) ? `<ul class="mini-list">${expiringRowsHTML()}</ul>` : '<p class="small">暂无临期食材 [[sparkle]]</p>'}
      <button class="btn sm" style="margin-top:10px" onclick="go('pantry')">打开冰箱 →</button></div>
    <div class="note tilt-r tape home-list-note"><h4>[[cart]] 待采购 · ${shop.length}</h4>
      ${shop.length ? `<ul class="mini-list">${shop.slice(0, 5).map(x => `<li>${FOODS[x.foodId].em} ${FOODS[x.foodId].name}<span class="sp mono small">${fmtQty(x.qty, x.unit)}</span></li>`).join('')}</ul>` : '<p class="small">清单是空的</p>'}
      <button class="btn sm" style="margin-top:10px" onclick="go('shopping')">去购物清单 →</button></div>
    <div class="note blue tilt-l tape" id="home-pending">${homePendingHTML()}</div>
    <div class="note green tilt-r tape"><h4>[[gear]] 后台任务</h4>
      <ul class="mini-list">${S.tasks.map(t => `<li>${t.status === 'off' ? '[[dot-off]]' : t.status === 'observe' ? '[[dot-obs]]' : '[[dot-on]]'} ${t.name}<span class="sp small muted">${({ off: '关闭', observe: '观察', auto: '自动', scheduled: '自动' })[S.policies[t.kind]]}</span></li>`).join('')}</ul>
      <button class="btn sm" style="margin-top:10px" onclick="go('settings')">授权设置 →</button></div>
  </div>`;
};
async function addWater() {
  try { await recordHabit('water', D.todayKey(), 250); commit('[[drop]] 已记录 250 ml'); }
  catch (e) { toast('记录失败：' + (e.message || e), true); }
}

/* =========================================================
 *  菜单计划
 * ========================================================= */
PAGES.plan = () => {
  if (!S.plan) return planEmptyHTML();
  const all = P.dates(); const T = D.todayKey();
  const spans = [...new Set([1, 3, 7].map(size => Math.min(size, all.length)))];
  const n = spans.includes(U.planDays) ? U.planDays : spans.at(-1);
  const base = n === 7 ? 0 : Math.max(0, all.indexOf(T));
  const last = all.length - n;
  const start = Math.min(Math.max(0, base + U.planOffset), last);
  const dates = all.slice(start, start + n);
  const slots = ['breakfast', 'lunch', 'dinner'];
  const cells = slots.map(slot => `<div class="sl">${SLOTS[slot]}</div>` + dates.map(d => {
    const m = P.get(d, slot); const key = d + '|' + slot;
    if (!m) return `<div class="sticker empty-slot" onclick="openSlot('${d}','${slot}')">＋ 安排</div>`;
    const r = R[m.r]; const chk = checkRecipe(r); const eaten = isEaten(d, slot);
    return `<div class="sticker ${eaten ? 'eaten' : ''} ${D.diff(d, T) < 0 ? 'past' : ''} ${U.changed === key ? 'changed' : ''}" draggable="true" data-key="${key}" onclick="openSlot('${d}','${slot}')" title="拖动可与其他餐次交换">
      <span class="em">${r.em}</span><b>${r.t}</b><span class="meta">[[timer]]${r.min}分 · ${m.sv}份</span>${chk.verify.length ? '<span class="badge y" style="width:fit-content">[[alert]] 需核对配料</span>' : ''}</div>`;
  }).join('')).join('');
  const versions = [...S.plan.versions].sort((a, b) => b.v - a.v);
  const recent = versions.slice(0, 7);
  const older = versions.slice(7);
  const gap = computeGap();
  return `
  <div class="row" style="margin-bottom:16px">
    <div class="seg">${spans.map(size => `<button class="${n === size ? 'on' : ''}" onclick="U.planDays=${size};U.planOffset=0;render()">${size === 1 ? '单日' : size + ' 日'}</button>`).join('')}</div>
    ${last > 0 ? `<button class="btn sm" aria-label="往前一天" onclick="U.planOffset=${start - base - 1};render()" ${start === 0 ? 'disabled' : ''}>‹</button><button class="btn sm" aria-label="往后一天" onclick="U.planOffset=${start - base + 1};render()" ${start === last ? 'disabled' : ''}>›</button>` : ''}
    <span class="muted small">《${esc(S.plan.title)}》 ${D.md(all[0])} – ${D.md(all.at(-1))} · 当前生效 <b class="mono">v${S.plan.active}</b></span>
    <div class="sp row">
      <button class="btn sm" onclick="simulateConflict()" title="演示乐观锁 CONFLICT">[[bolt]] 模拟并发冲突</button>
      <button class="btn sm pri" onclick="askAI('用现有食材安排三日菜单')">[[sparkle]] 让 AI 重新规划</button>
    </div>
  </div>
  <div class="plan-layout">
    <div class="plan-workspace">
      <section class="card plan-calendar" aria-label="菜单日历">
        <div class="week-scroll" role="region" aria-label="按餐次浏览菜单" tabindex="0"><div class="week" style="--days:${n}">
          <div class="corner"></div>${dates.map(d => `<div class="dh ${d === T ? 'today' : ''}"><b>${D.wd(d)}</b><span>${D.md(d)}</span></div>`).join('')}
          ${cells}
        </div></div>
        <p class="small muted plan-calendar-note">点餐次可以换菜或记餐，拖动可以交换两餐。确认烹饪消耗后才会扣减库存。</p>
      </section>
      <section class="card plan-gaps">
        <div class="card-h"><h3>[[calc]] 采购差额</h3><span class="sp small muted">按 v${S.plan.active} 实时推算</span></div>
        ${gap.length ? `<ul class="mini-list">${gap.slice(0, 6).map(g => `<li>${FOODS[g.foodId].em} ${FOODS[g.foodId].name}<span class="sp mono small">${g.unknown ? '库存数量未知' : '缺 ' + fmtQty(g.gap, FOODS[g.foodId].unit)}</span></li>`).join('')}</ul>` : '<p class="small muted">现有库存足够完成剩余计划</p>'}
        <button class="btn sm" type="button" onclick="go('shopping')">查看购物清单 →</button>
      </section>
    </div>
    <section class="card plan-history" aria-labelledby="plan-history-heading">
      <div class="card-h"><h3 id="plan-history-heading">[[bookmark]] 版本历史</h3><span class="sp badge">${versions.length} 个版本</span></div>
      <ol class="ver-list">${recent.map(planVersionHTML).join('')}</ol>
      ${older.length ? `<details class="plan-history-more" ${U.expandedPlanHistory === S.plan.id ? 'open' : ''}>
        <summary><span class="plan-history-expand">展开更早 ${older.length} 个版本</span><span class="plan-history-collapse">收起旧版本</span></summary>
        <ol class="ver-list" start="8">${older.map(planVersionHTML).join('')}</ol>
      </details>` : ''}
    </section>
  </div>`;
};
function planVersionHTML(v) {
  const active = v.v === S.plan.active;
  const reason = v.reason === 'Agent 草稿提交' ? '批准菜单草稿' :
    v.reason.replace(/^(Agent )?替换 (\d{4}-\d{2}-\d{2}) (breakfast|lunch|dinner|snack)(?= |$)/,
      (_, _agent, date, slot) => `${D.md(date)} ${SLOTS[slot]}换菜`);
  return `<li class="ver ${active ? 'active' : ''}"><span class="vdot" aria-hidden="true"></span><div class="vb">
    <div class="row plan-version-top"><b>v${v.v}</b>${active ? '<span class="badge g">生效中</span>' : ''}<span class="badge ${v.by === 'agent' ? 'p' : ''}">${v.by === 'agent' ? 'AI · 经你审批' : '你'}</span></div>
    ${reason ? `<p>${esc(reason)}</p>` : ''}
    <div class="row plan-version-actions"><span class="small muted">${D.ago(v.at)}</span>
      ${v.v > 1 ? `<button class="btn xs" type="button" onclick="showDiff(${v.basedOn || v.v - 1},${v.v})">差异</button>` : ''}
      ${!active ? `<button class="btn xs" type="button" onclick="confirmRestore(${v.v})">恢复</button>` : ''}</div>
    </div></li>`;
}

AFTER.plan = () => {
  const history = $('.plan-history-more');
  history?.addEventListener('toggle', () => {
    if (history.isConnected) U.expandedPlanHistory = history.open ? S.plan?.id : null;
  });
  $$('.sticker[draggable]').forEach(el => {
    el.addEventListener('dragstart', e => { U.dragKey = el.dataset.key; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', el.dataset.key); });
    el.addEventListener('dragover', e => { e.preventDefault(); el.classList.add('drag-over'); });
    el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
    el.addEventListener('drop', async e => {
      e.preventDefault(); el.classList.remove('drag-over');
      const from = U.dragKey, to = el.dataset.key; U.dragKey = null;
      if (!from || from === to) return;
      try { await P.swap(from, to); U.changed = to; commit(`已交换，保存为 v${S.plan.active} · 采购差额已重算`); } catch (err) { toast(err.message, true); }
    });
  });
  if (U.changed) setTimeout(() => { U.changed = null; }, 800);
};
function openSlot(date, slot) {
  const m = P.get(date, slot);
  const cur = m && R[m.r];
  const eaten = isEaten(date, slot);
  const cands = P.candidates(slot, { notId: m && m.r, date });
  const ok = cands.filter(c => c.chk.ok), blocked = cands.filter(c => !c.chk.ok);
  modal({
    title: `${D.wd(date)} ${D.md(date)} · ${SLOTS[slot]}`, wide: true,
    body: `
      ${cur ? `<div class="row" style="background:var(--paper-2);border-radius:14px;padding:12px">
        <span style="font-size:40px">${cur.em}</span><div><b style="font-family:var(--serif);font-size:17px">${cur.t}</b><div class="small muted">[[timer]] ${cur.min} 分钟 · ${m.sv} 份 · 库存匹配 ${r0(stockMatch(cur) * 100)}%</div></div>
        <div class="sp row">${eaten ? '<span class="badge g">[[check]] 已记录</span>' : D.diff(date, D.todayKey()) <= 0 ? `<button class="btn sm pri" onclick="closeModal();openEatPlanned('${date}','${slot}')">[[check]] 记为已吃</button>` : ''}
        <button class="btn sm" onclick="closeModal();openRecipe('${cur.id}')">看菜谱</button><button class="btn sm" onclick="closeModal();startCooking('${cur.id}','${date}','${slot}')">[[flame]] 开始做</button></div></div>` : ''}
      <div class="section-title">可替换的菜（已按你的饮食限制硬过滤）</div>
      <div class="col" style="gap:8px">${ok.slice(0, 8).map(c => `<div class="row" style="border:1px solid var(--line);border-radius:12px;padding:8px 12px">
        <span style="font-size:26px">${c.r.em}</span><div style="flex:1;min-width:140px"><b>${c.r.t}</b><div class="row" style="gap:5px;margin-top:3px">
          <span class="badge g">库存 ${r0(c.stock * 100)}%</span><span class="badge">[[timer]]${c.r.min}分</span>${c.chk.verify.length ? `<span class="badge y">[[alert]] ${c.chk.verify.join('、')} 配料需核对</span>` : ''}${c.repeat ? '<span class="badge">近期已安排</span>' : ''}${c.tooLong ? '<span class="badge r">超出时长上限</span>' : ''}</div></div>
        <button class="btn sm pri" onclick="doReplace('${date}','${slot}','${c.r.id}')">换成这个</button></div>`).join('') || emptyState('[[help]]', '没有满足约束的候选')}</div>
      ${blocked.length ? `<details style="margin-top:12px"><summary class="small muted" style="cursor:pointer">已排除 ${blocked.length} 道（命中硬约束）</summary><div class="col" style="gap:4px;margin-top:8px">${blocked.map(c => `<div class="danger-line">[[ban]] ${c.r.t} —— 含 ${c.chk.blocked.map(b => b.food).join('、')}（${c.chk.blocked[0].label} · ${c.chk.blocked[0].kind === 'allergy' ? '过敏' : '忌口'}）</div>`).join('')}</div></details>` : ''}
      <p class="small muted" style="margin-top:12px">替换只会生成新版本（v${S.plan.active + 1}），其它餐次、手动购物项和历史版本保持不变。</p>`,
  });
}
async function doReplace(date, slot, rid) {
  const expected = S.plan.active;
  try {
    const v = await P.replace(date, slot, rid, 'user', expected);
    U.changed = date + '|' + slot; closeModal();
    commit(`[[check]] 已保存为 v${v} · 采购差额已重算`);
  } catch (e) {
    if (e && e.code === 'CONFLICT') { await refreshPlan(); closeModal(); showConflictModal(expected, S.plan.active); }
    else toast((e && e.message) || '替换失败', true);
  }
}
function planDiffHTML(change) {
  const [date, slot] = change.k.split('|');
  const label = meal => meal ? `${R[meal.r]?.em || ''} ${esc(R[meal.r]?.t || '菜谱已不可用')} · ${esc(meal.sv)} 份` : '未安排';
  return `<div class="diff-row"><span class="small">${D.md(date)} ${SLOTS[slot]}</span><span class="old">${label(change.from)}</span><span aria-hidden="true">→</span><span class="new">${label(change.to)}</span></div>`;
}
function showDiff(a, b) {
  const d = P.diff(a, b);
  modal({
    title: `差异 v${a} → v${b}`, body: d.length ? d.map(planDiffHTML).join('') : emptyState('[[equal]]', '两个版本内容相同（例如“恢复”操作）'),
    buttons: [{ label: '关闭' }],
  });
}
function confirmRestore(v) {
  const d = P.diff(S.plan.active, v);
  modal({
    title: `恢复 v${v}？`,
    body: `<p>将以 v${v} 的内容<b>新建 v${S.plan.counter + 1}</b>，不会删除任何历史版本。</p>
    <div class="warn-line">↩ 已发生的购买、库存消耗、记餐和已发送的通知<b>不会</b>被回滚。</div>
    <div class="section-title">将发生的变化（${d.length} 处）</div>
    ${d.map(planDiffHTML).join('') || '<p class="muted small">无差异</p>'}`,
    buttons: [{ label: '取消' }, {
      label: '确认恢复', cls: 'pri', fn: async () => {
        try { const nv = await P.restore(v); commit(`已恢复为新版本 v${nv}`); }
        catch (e) { toast((e && e.message) || '恢复失败', true); return false; }
      },
    }],
  });
}
async function simulateConflict() {
  if (!S.plan) { toast('暂无计划', true); return; }
  const stale = S.plan.active;
  const dates = P.dates(); const d = dates[6];
  const cur = P.get(d, 'lunch');
  const alt = P.candidates('lunch', { notId: cur && cur.r }).find(c => c.chk.ok);
  if (!alt) { toast('没有可替换的候选', true); return; }
  try {
    // 模拟另一台设备抢先保存了一个版本
    await P.replace(d, 'lunch', alt.r.id, 'user');
    toast('已模拟另一台设备保存了新版本，正在用旧版本号重试…');
    // 再用旧版本号提交：服务端应返回 409 CONFLICT
    await Api.replaceMeal(S.plan.id, { expected_version: stale, target: { local_date: dates[5], slot: 'dinner' }, replacement: { recipe_id: 'r_broc', servings: 2 } });
    await refreshPlan(); render();
    toast('服务端接受了该请求（未返回 409），请以最新版本为准');
  } catch (e) {
    if (e && e.code === 'CONFLICT') { await refreshPlan(); showConflictModal(stale, S.plan.active); }
    else toast('模拟失败：' + ((e && e.message) || e), true);
  }
}

/* =========================================================
 *  食材冰箱
 * ========================================================= */
PAGES.pantry = () => {
  const live = S.batches.filter(b => b.qtyStatus === 'unknown' || b.remaining > 0);
  const list = U.pantryFilter === 'soon' ? live.filter(b => b.expires && expDays(b) <= 3) : U.pantryFilter === 'unknown' ? live.filter(b => b.qtyStatus === 'unknown') : live;
  const stat = { all: live.length, soon: live.filter(b => b.expires && expDays(b) >= 0 && expDays(b) <= 3).length, exp: live.filter(b => b.expires && expDays(b) < 0).length, unk: live.filter(b => b.qtyStatus === 'unknown').length };
  const shelves = Object.keys(LOC).map(loc => {
    const bs = list.filter(b => b.location === loc).sort((a, b) => expDays(a) - expDays(b));
    return `<div class="shelf ${LOC[loc].cls}"><div class="shelf-h"><span style="font-size:20px">${LOC[loc].em}</span><h3>${LOC[loc].name}</h3><span class="temp">${LOC[loc].temp}</span><span class="sp small muted">${bs.length} 个批次</span></div>
      <div class="jars">${bs.length ? bs.map(jarHTML).join('') : '<span class="muted small" style="padding:10px">这一层空空的</span>'}</div></div>`;
  }).join('');
  const mv = [...S.movements].reverse().slice(0, 10);
  return `
  <div class="card quick-add">
    <div class="row" style="margin-bottom:10px"><b style="font-family:var(--serif)">一行速记</b><span class="small muted">输食材名 + 数量，Enter 即入库；位置、保质期按食材默认，事后可在批次里改</span></div>
    <div class="quick-row">
      <div class="qa-name">${foodComboHTML('')}</div>
      <input class="input qa-qty" id="qa-q" type="number" min="0" step="any" placeholder="数量">
      <button class="btn pri" id="qa-add">入库</button>
      <button class="btn ghost sm" id="qa-more" type="button">更多 ▾</button>
    </div>
    <div id="qa-adv" class="hidden" style="margin-top:10px"><div class="form-grid">
      <div class="f">存放位置${segHTML('qa-loc', Object.entries(LOC).map(([k, l]) => [k, l.name]), 'fridge')}</div>
      <label class="f">保质期至<input class="input" id="qa-e" type="date" value="${D.add(D.todayKey(), 7)}"></label>
      <label class="f">购入日期<input class="input" id="qa-p" type="date" value="${D.todayKey()}"></label></div></div>
    <div class="quick-chips" id="qa-chips">${quickChipsHTML()}</div>
    <div class="paste-box"><button class="btn sm ghost" id="qa-paste-toggle" type="button">批量粘贴入库 ▾</button>
      <div id="qa-paste" class="hidden"><textarea id="qa-paste-text" placeholder="每行一项，例如：&#10;番茄 2个&#10;鸡蛋 6个&#10;牛奶（没数量也行）"></textarea>
      <div class="row" style="margin-top:6px"><button class="btn sm pri" id="qa-paste-go" type="button">解析并入库</button><span class="small muted">没写数量按未知入库；失败的行会单独标出</span></div>
      <div class="paste-res" id="qa-paste-res"></div></div></div>
  </div>
  <div class="row" style="margin-bottom:16px">
    <div class="seg">${[['all', '全部 ' + stat.all], ['soon', '临期/过期 ' + (stat.soon + stat.exp)], ['unknown', '数量未知 ' + stat.unk]].map(([k, l]) => `<button class="${U.pantryFilter === k ? 'on' : ''}" onclick="U.pantryFilter='${k}';render()">${l}</button>`).join('')}</div>
    <div class="sp row"><button class="btn sm" onclick="openRecognize()">[[camera]] 拍照识别</button><button class="btn sm pri" onclick="openAddBatch()">＋ 添加批次</button></div>
  </div>
  <div class="grid g4 keep2" style="margin-bottom:18px">
    <div class="metric"><div class="l">在库批次</div><div class="v">${stat.all}</div><div class="s">同一食材多次购买分批管理</div></div>
    <div class="metric"><div class="l">3 天内到期</div><div class="v" style="color:var(--yolk-ink)">${stat.soon}</div><div class="s">建议先到期先用（FEFO）</div></div>
    <div class="metric"><div class="l">已过期</div><div class="v" style="color:var(--tomato)">${stat.exp}</div><div class="s">不参与采购差额计算</div></div>
    <div class="metric"><div class="l">数量未知</div><div class="v" style="color:var(--muted)">${stat.unk}</div><div class="s">不伪造克数，可盘点补录</div></div>
  </div>
  <div class="fridge">${shelves}</div>
  <div class="section-title">[[list]] 最近库存流水（不可篡改）</div>
  <div class="card" style="padding:8px 16px">${mv.map(movRow).join('') || emptyState('[[list]]', '暂无流水')}</div>`;
};
/* 常用食材一键加：按最近入库 + 使用频率取 8 个，点一下按默认量入库，± 可调数量 */
function quickChipsHTML() {
  const step = f => (f.unit === 'piece' ? 1 : 100);
  return orderedFoods().slice(0, 8).map(id => {
    const f = FOODS[id], d = foodDefault(id);
    return `<div class="quick-chip" data-id="${id}" role="button" tabindex="0" title="点一下按默认量入库">${foodImg(id, 'ingredients')}<span>${f.name}</span><span class="stepper"><button type="button" data-d="-1" aria-label="减少">−</button><b data-q="${d.qty}">${d.qty}${unitShort[f.unit]}</b><button type="button" data-d="1" aria-label="增加">＋</button></span></div>`;
  }).join('');
}
function parsePasteLine(line) {
  const s = line.trim();
  if (!s) return null;
  const m = s.match(/^([^\d\s]+?)\s*(\d+(?:\.\d+)?)?\s*(个|g|克|ml|毫升)?$/);
  if (!m) return { error: '看不懂这一行' };
  const name = m[1];
  const id = Object.keys(FOODS).find(k => FOODS[k].name === name) || Object.keys(FOODS).find(k => (FOODS[k].tags || []).includes(name));
  if (!id) return { error: `没找到食材「${name}」` };
  const f = FOODS[id];
  let qty = m[2] ? parseFloat(m[2]) : null;
  if (m[3] && qty !== null) {
    const u = m[3] === '个' ? 'piece' : (m[3] === 'ml' || m[3] === '毫升' ? 'ml' : 'g');
    if (u !== f.unit) return { error: `「${f.name}」按${UNIT[f.unit]}计，不是${m[3]}` };
  }
  return { foodId: id, qty };
}
AFTER.pantry = () => {
  const page = $('#page');
  bindFoodCombo(page);
  const combo = $('.food-combo .rc-f-q', page);
  let locTouched = false;
  $('.seg[data-seg="qa-loc"]', page).addEventListener('click', () => { locTouched = true; });
  const syncDefaults = () => {
    const id = combo.dataset.v;
    if (!id || !FOODS[id]) return;
    const d = foodDefault(id);
    if (!locTouched) $$('.seg[data-seg="qa-loc"] button', page).forEach(x => x.classList.toggle('on', x.dataset.v === d.loc));
    $('#qa-e', page).value = D.add(D.todayKey(), d.days);
  };
  combo.addEventListener('change', syncDefaults);
  combo.addEventListener('blur', () => setTimeout(syncDefaults, 200));
  const quickAdd = async () => {
    let id = combo.dataset.v;
    if (!id) {
      const name = combo.value.trim();
      id = Object.keys(FOODS).find(k => FOODS[k].name === name);
      if (!id) { toast('没找到这个食材，点下拉里的名字选一下', true); return; }
    }
    const q = $('#qa-q', page).value;
    const adv = !$('#qa-adv', page).classList.contains('hidden');
    const d = foodDefault(id);
    try {
      const bt = await addBatch({ foodId: id, qty: q === '' ? null : parseFloat(q), expires: adv ? ($('#qa-e', page).value || null) : D.add(D.todayKey(), d.days), location: adv ? (segValue(page, 'qa-loc') || d.loc) : d.loc, purchased: adv ? ($('#qa-p', page).value || D.todayKey()) : D.todayKey() });
      await recomputePlanShopping();
      combo.value = ''; combo.dataset.v = ''; $('#qa-q', page).value = '';
      commit(`${FOODS[id].em} 已入库 ${fmtQty(bt.remaining, bt.unit)}`);
    } catch (e) { toast('入库失败：' + (e.message || e), true); }
  };
  $('#qa-add', page).onclick = quickAdd;
  $('#qa-q', page).addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); quickAdd(); } });
  combo.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); quickAdd(); } });
  $('#qa-more', page).onclick = () => { const a = $('#qa-adv', page); a.classList.toggle('hidden'); $('#qa-more', page).textContent = a.classList.contains('hidden') ? '更多 ▾' : '收起 ▴'; };
  $$('#qa-chips .quick-chip', page).forEach(chip => {
    const id = chip.dataset.id, f = FOODS[id];
    const step = f.unit === 'piece' ? 1 : 100;
    chip.addEventListener('click', async e => {
      const st = e.target.closest('.stepper button');
      const b = $('b', chip);
      let q = parseFloat(b.dataset.q);
      if (st) { q = Math.max(step, q + Number(st.dataset.d) * step); b.dataset.q = q; b.textContent = q + unitShort[f.unit]; return; }
      try {
        const d = foodDefault(id);
        const bt = await addBatch({ foodId: id, qty: q, expires: D.add(D.todayKey(), d.days), location: d.loc, purchased: D.todayKey() });
        await recomputePlanShopping();
        commit(`${FOODS[id].em} 已入库 ${fmtQty(bt.remaining, bt.unit)}`);
      } catch (err) { toast('入库失败：' + (err.message || err), true); }
    });
    chip.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); chip.click(); } });
  });
  $('#qa-paste-toggle', page).onclick = () => { const p = $('#qa-paste', page); p.classList.toggle('hidden'); $('#qa-paste-toggle', page).textContent = p.classList.contains('hidden') ? '批量粘贴入库 ▾' : '批量粘贴入库 ▴'; };
  $('#qa-paste-go', page).onclick = async () => {
    const lines = $('#qa-paste-text', page).value.split('\n');
    const res = $('#qa-paste-res', page);
    let ok = 0; const bad = [];
    for (const line of lines) {
      const p = parsePasteLine(line);
      if (!p) continue;
      if (p.error) { bad.push(`${esc(line.trim())} —— ${p.error}`); continue; }
      try {
        const d = foodDefault(p.foodId);
        await addBatch({ foodId: p.foodId, qty: p.qty, expires: D.add(D.todayKey(), d.days), location: d.loc, purchased: D.todayKey() });
        ok++;
      } catch (e) { bad.push(`${esc(line.trim())} —— 入库失败：${esc(e.message || e)}`); }
    }
    await recomputePlanShopping();
    res.innerHTML = (ok ? `<span>已入库 ${ok} 项</span>` : '') + bad.map(b => `<span class="bad">${b}</span>`).join('');
    if (ok) commit(`批量入库 ${ok} 项${bad.length ? '，' + bad.length + ' 行失败' : ''}`);
    else if (!bad.length) toast('请先粘贴内容', true);
  };
};
function jarHTML(b) {
  const f = FOODS[b.foodId]; const d = expDays(b);
  const cls = !b.expires ? '' : d < 0 ? 'expired' : d <= 1 ? 'urgent' : d <= 3 ? 'soon' : '';
  const label = !b.expires ? '' : d < 0 ? '过期' : d === 0 ? '今天' : d === 1 ? '明天' : d > 30 ? '长期' : d + '天';
  return `<div class="jar ${cls}" onclick="openBatch('${b.id}')" role="button" tabindex="0" aria-label="${f.name} ${fmtQty(b.remaining, b.unit)}">
    ${label ? `<span class="exp">${label}</span>` : ''}<span class="em">${f.em}</span><b>${f.name}</b>
    ${b.qtyStatus === 'known' ? `<span class="amt">${fmtQty(b.remaining, b.unit)}</span><div class="lvl"><i style="width:${b.original ? Math.min(100, b.remaining / b.original * 100) : 0}%"></i></div>` : '<span class="badge unk">数量未知</span>'}
  </div>`;
}
const MV_NAME = { OPENING: ['初始入库', 'g'], PURCHASE_IN: ['采购入库', 'g'], CONSUME: ['烹饪消耗', 'r'], DISCARD: ['丢弃', 'r'], ADJUST: ['盘点调整', 'y'], RETURN: ['退货', 'r'] };
function movRow(m) {
  const f = FOODS[m.foodId];
  return `<div class="mv"><span class="small muted mono">${D.md(m.at.slice(0, 10).replace(/T.*/, '')) === 'NaN/NaN' ? '' : new Date(m.at).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })} ${D.time(m.at)}</span>
    <span class="badge ${MV_NAME[m.kind][1]}">${MV_NAME[m.kind][0]}</span><span>${f.em} ${f.name} <span class="muted small">· ${esc(m.reason)}</span></span>
    <span class="delta mono ${m.delta > 0 ? 'pos' : 'neg'}" style="text-align:right">${m.delta === null ? '—' : (m.delta > 0 ? '+' : '') + fmtQty(m.delta, f.unit)}</span></div>`;
}
function openBatch(id) {
  const b = S.batches.find(x => x.id === id); const f = FOODS[b.foodId];
  const mvs = S.movements.filter(m => m.batchId === id).reverse();
  const known = b.qtyStatus === 'known';
  modal({
    title: `${f.em} ${f.name} · 批次详情`,
    body: `<dl class="kv"><dt>剩余</dt><dd class="mono">${known ? fmtQty(b.remaining, b.unit) + ' / 原始 ' + fmtQty(b.original, b.unit) : '数量未知（不参与库存数值计算）'}</dd>
      <dt>到期</dt><dd>${b.expires || '—'} ${badgeExp(b)}</dd><dt>购入</dt><dd>${b.purchased}</dd><dt>位置</dt><dd>${LOC[b.location].name}</dd>
      <dt>批次 ID</dt><dd class="mono small">${b.id} · version ${b.version}</dd></dl>
      ${f.alUnknown ? '<div class="warn-line" style="margin-top:10px">[[alert]] 商业包装食品：过敏原信息未知，请核对实际配料表。</div>' : ''}
      <div class="section-title">变更库存</div>
      ${known ? `<div class="form-grid">
        <div class="f">操作${segHTML('bk', [['CONSUME', '烹饪使用（扣减）'], ['DISCARD', '丢弃（需理由）'], ['ADJUST', '盘点：实际剩余为…']], 'CONSUME')}</div>
        <label class="f"><span id="bql">数量（${unitShort[b.unit]}）</span><input class="input" id="bq" type="number" min="0" step="any" placeholder="例如 ${b.unit === 'piece' ? '1' : '100'}"></label>
        <label class="f" style="grid-column:1/-1">理由<input class="input" id="br" placeholder="例如：已变质 / 盘点误差"></label></div>`
        : `<div class="form-grid"><label class="f">盘点：实际数量（${unitShort[b.unit]}）<input class="input" id="bq" type="number" min="0" step="any"></label><label class="f">理由<input class="input" id="br" value="称重后建立可量化基准"></label></div>`}
      <div class="section-title">此批次流水</div>${mvs.map(movRow).join('')}`,
    buttons: [{ label: '关闭' }, {
      label: '提交变更', cls: 'pri', fn: async root => {
        const q = parseFloat($('#bq', root).value); const reason = $('#br', root).value.trim();
        if (isNaN(q) || q < 0) { toast('请输入有效数量', true); return false; }
        try {
          if (!known) { await setBatchKnown(id, q, reason); commit('已建立可量化库存'); return; }
          const kind = segValue(root, 'bk') || 'CONSUME';
          if ((kind === 'DISCARD' || kind === 'ADJUST') && !reason) { toast('丢弃/盘点必须填写理由', true); return false; }
          let delta = kind === 'ADJUST' ? r1(q - b.remaining) : -q;
          if (delta === 0) { toast('数量没有变化', true); return false; }
          await moveBatch(id, delta, kind, reason || '烹饪使用', kind === 'ADJUST' ? 'adjustment' : kind === 'DISCARD' ? 'discard' : 'manual_cook', uid('src'), uid('idem'));
          commit(`已记录：${MV_NAME[kind][0]} ${fmtQty(Math.abs(delta), b.unit)}`);
        } catch (e) { toast(e.message, true); return false; }
      }
    }],
    onMount: root => { const s = $('.seg[data-seg="bk"]', root); if (s) s.addEventListener('click', () => { const v = segValue(root, 'bk'); $('#bql', root).textContent = (v === 'ADJUST' ? '实际剩余' : '数量') + `（${unitShort[b.unit]}）`; }); },
  });
}
function openAddBatch(pref = {}) {
  const sel = pref.foodId || 'egg';
  const d0 = foodDefault(sel);
  modal({
    title: '＋ 添加食材批次',
    body: `<div class="f">食材</div>${foodPickerHTML(sel)}
      <div class="form-grid" style="margin-top:12px">
      <label class="f"><span id="aul">数量（${UNIT[FOODS[sel].unit]}）</span><input class="input" id="aq" type="number" min="0" step="any" placeholder="留空 = 数量未知"></label>
      <div class="f"><span class="small muted">默认：${LOC[d0.loc].name} · 保质期至 ${D.add(D.todayKey(), d0.days)}</span><button class="btn sm ghost" id="a-more" type="button">更多 ▾</button></div></div>
      <div id="a-adv" class="hidden" style="margin-top:12px"><div class="form-grid">
      <div class="f">存放位置${segHTML('al', Object.entries(LOC).map(([k, l]) => [k, l.name]), d0.loc)}</div>
      <label class="f">保质期至<input class="input" id="ae" type="date" value="${D.add(D.todayKey(), d0.days)}"></label>
      <label class="f">购入日期<input class="input" id="ap" type="date" value="${D.todayKey()}"></label></div></div>
      <p class="small muted">同名食材再次购买会成为新批次，保留各自的保质期。数量未知的批次不会被当作 0 或“充足”。</p>`,
    buttons: [{ label: '取消' }, {
      label: '保存入库', cls: 'pri', fn: async root => {
        const foodId = foodPickerValue(root) || sel; const q = $('#aq', root).value;
        const adv = !$('#a-adv', root).classList.contains('hidden');
        const d = foodDefault(foodId);
        try {
          const bt = await addBatch({ foodId, qty: q === '' ? null : parseFloat(q), expires: adv ? ($('#ae', root).value || null) : D.add(D.todayKey(), d.days), location: adv ? (segValue(root, 'al') || d.loc) : d.loc, purchased: adv ? ($('#ap', root).value || D.todayKey()) : D.todayKey() });
          await recomputePlanShopping(); commit(`${FOODS[foodId].em} 已入库 ${fmtQty(bt.remaining, bt.unit)}`);
        } catch (e) { toast('入库失败：' + (e.message || e), true); return false; }
      }
    }],
    onMount: root => {
      let locTouched = false;
      $('.seg[data-seg="al"]', root).addEventListener('click', () => { locTouched = true; });
      bindFoodPicker(root, id => {
        $('#aul', root).textContent = `数量（${UNIT[FOODS[id].unit]}）`;
        const d = foodDefault(id);
        if (!locTouched) { $$('.seg[data-seg="al"] button', root).forEach(x => x.classList.toggle('on', x.dataset.v === d.loc)); }
        $('#ae', root).value = D.add(D.todayKey(), d.days);
      });
      $('#a-more', root).onclick = () => { const a = $('#a-adv', root); a.classList.toggle('hidden'); $('#a-more', root).textContent = a.classList.contains('hidden') ? '更多 ▾' : '收起 ▴'; };
    },
  });
}
function sampleFridgeImage() {
  const items = ['egg', 'tomato', 'lettuce', 'milk', 'tofu', 'carrot', 'lemon', 'cucumber'];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#e7f0f4"/><rect x="20" y="20" width="600" height="320" rx="18" fill="#f8fbfc" stroke="#b9cdd6" stroke-width="4"/><line x1="20" y1="180" x2="620" y2="180" stroke="#b9cdd6" stroke-width="6"/>${items.map((f, i) => `<svg x="${58 + (i % 4) * 145}" y="${i < 4 ? 46 : 206}" width="96" height="96" viewBox="0 0 32 32">${foodInner(f)}</svg>`).join('')}</svg>`;
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}
function openRecognize(target = 'pantry', preImg) {
  modal({
    title: target === 'pantry' ? '[[camera]] 拍照识别食材' : '[[camera]] 拍照记餐', wide: true,
    body: `<div id="rc-step1"><p>上传冰箱或食物照片，AI 只会返回<b>候选项</b>，必须由你逐项确认后才会${target === 'pantry' ? '入库' : '记录'}。</p>
      <div class="row"><label class="btn pri">选择照片<input type="file" accept="image/*" id="rc-file" hidden></label><button class="btn" id="rc-sample">使用示例照片</button></div></div>
      <div id="rc-step2" class="hidden"><div class="recog-wrap"><img class="recog-img" id="rc-img" alt="待识别照片"><div class="scan-line" id="rc-scan"></div></div>
      <p class="small muted" id="rc-status" aria-live="polite" style="margin:8px 0">正在识别…（只返回候选项，必须由你逐项确认后才会${target === 'pantry' ? '入库' : '记录'}）</p><div id="rc-cands"></div></div>`,
    onMount: root => {
      const go2 = url => { $('#rc-step1', root).classList.add('hidden'); $('#rc-step2', root).classList.remove('hidden'); $('#rc-img', root).src = url; setTimeout(() => showCandidates(root, target), 1500); };
      $('#rc-sample', root).onclick = () => { RC_FILE = null; go2(sampleFridgeImage()); };
      $('#rc-file', root).onchange = e => { const f = e.target.files[0]; if (!f) return; RC_FILE = f; const rd = new FileReader(); rd.onload = () => go2(rd.result); rd.readAsDataURL(f); };
      if (preImg) { RC_FILE = null; go2(preImg); }
    },
  });
}
/* 演示候选：仅在模型未配置（后端 503 MODEL_NOT_CONFIGURED）或使用示例照片时展示，
   状态行与每行都标“演示”，不让人误以为是真识别。 */
const DEMO_CANDS = [
  { foodId: 'egg', qty: 6, conf: '较确定', exp: 14 }, { foodId: 'tomato', qty: 2, conf: '较确定', exp: 5 },
  { foodId: 'lettuce', qty: '', conf: '较确定', exp: 4, note: '无法从图像判断重量' }, { foodId: 'milk', qty: 1000, conf: '不确定', exp: 6, note: '可能是酸奶' },
  { foodId: 'tofu', qty: 400, conf: '较确定', exp: 3 }, { foodId: 'carrot', qty: 200, conf: '不确定', exp: 10 },
  { foodId: 'lemon', qty: 1, conf: '较确定', exp: 12 }, { foodId: 'cucumber', qty: 1, conf: '较确定', exp: 5 },
];
async function showCandidates(root, target) {
  if (!document.body.contains(root) || !$('#rc-scan', root)) return;
  $('#rc-scan', root).remove();
  if (target !== 'pantry') return showMealCandidates(root);
  const statusEl = $('#rc-status', root);
  if (!RC_FILE) {
    renderPantryCandidates(root, DEMO_CANDS, true, '示例照片');
    return;
  }
  statusEl.textContent = '正在调用识别服务…';
  try {
    const res = await Api.recognizeImage(RC_FILE, 'pantry');
    const cands = (res && res.candidates) || [];
    if (!cands.length) { statusEl.textContent = '没有识别到食材，请换一张更清晰的照片再试。'; return; }
    renderPantryCandidates(root, cands.map(c => ({
      foodId: c.food_id || null,
      name: c.name || '',
      qty: c.qty ?? null,
      conf: c.confidence === 'high' ? '较确定' : '不确定',
      exp: c.expires_days ?? null,
      note: c.note || '',
    })), false);
  } catch (e) {
    if (e && e.code === 'MODEL_NOT_CONFIGURED') {
      renderPantryCandidates(root, DEMO_CANDS, true, '未配置模型 key');
      return;
    }
    statusEl.textContent = '识别失败：' + (e && e.message ? e.message : '未知错误') + '。没有写入任何数据，请重试。';
  }
}
/* cands: [{foodId|null, name, qty|null, conf:'较确定'|'不确定', exp:天数|null, note}]；
   isDemo 时状态行写明演示来源，每行加“演示”标记。 */
function renderPantryCandidates(root, cands, isDemo, demoWhy) {
  if (isDemo) {
    $('#rc-status', root).innerHTML = '演示候选（' + esc(demoWhy || '未配置模型 key') + '）—— 以下为示例，未经过模型识别，请核对后再入库。';
  } else {
    $('#rc-status', root).innerHTML = '识别到 <b>' + cands.length + '</b> 个候选（“不确定”项默认不勾选）。请核对食材、数量与保质期。';
  }
  $('#rc-cands', root).innerHTML = `<div class="cand small muted" style="border:0"><span></span><span>食材</span><span>数量</span><span>保质期至</span><span>识别</span><span></span></div>` + cands.map((c, i) => `
    <div class="cand" data-i="${i}"><input type="checkbox" class="rc-ck" ${c.conf === '较确定' ? 'checked' : ''} aria-label="确认此项">
      ${foodComboHTML(c.foodId || '')}
      <input class="input rc-q" type="number" step="any" value="${c.qty === null || c.qty === undefined || c.qty === '' ? '' : c.qty}" placeholder="未知">
      <input class="input rc-e" type="date" value="${c.exp === null || c.exp === undefined ? '' : D.add(D.todayKey(), c.exp)}">
      <span>${isDemo ? '<span class="badge">演示</span> ' : ''}${c.conf === '较确定' ? '<span class="badge g">较确定</span>' : '<span class="badge y">不确定</span>'}${c.note ? `<div class="small muted">${esc(c.note)}</div>` : ''}${!c.foodId && c.name ? `<div class="small muted">识别为「${esc(c.name)}」，请在左侧改选食物库食材</div>` : ''}</span>
      <button class="btn xs ghost" onclick="this.closest('.cand').remove()" aria-label="删除候选">[[x]]</button></div>`).join('') +
    `<div class="row" style="margin-top:14px"><span class="small muted">位置</span>${segHTML('rc-loc', Object.entries(LOC).map(([k, l]) => [k, l.name]), 'fridge')}<button class="btn pri sp" id="rc-ok">确认入库所选</button></div>`;
  bindFoodCombo(root);
  $('#rc-ok', root).onclick = async () => {
    const rows = $$('.cand[data-i]', root).filter(r => $('.rc-ck', r).checked);
    if (!rows.length) { toast('请至少勾选一项', true); return; }
    try {
      let n = 0;
      for (const r of rows) {
        const foodId = $('.rc-f-q', r).dataset.v || '';
        if (!foodId || !FOODS[foodId]) { toast('有一行未选定食物库食材，已跳过该行', true); continue; }
        const q = $('.rc-q', r).value;
        await addBatch({ foodId, qty: q === '' ? null : parseFloat(q), expires: $('.rc-e', r).value || null, location: segValue(root, 'rc-loc') || 'fridge' });
        n++;
      }
      if (!n) { toast('没有可入库的行', true); return; }
      await recomputePlanShopping(); closeModal(); commit(`[[check]] 已确认入库 ${n} 个批次`);
    } catch (e) { toast('入库失败：' + (e.message || e), true); }
  };
}

/* =========================================================
 *  菜谱 / 烹饪模式 / 购物 / 记餐 / 习惯 / 周报 / 设置
 * ========================================================= */

/* ---------------- 菜谱 ---------------- */
const RF = [['quick', '[[timer]] 20 分钟内'], ['stock', '[[fridge]] 现有食材能做'], ['fav', '[[heart]] 收藏'], ['breakfast', '[[sunrise]] 早餐'], ['safe', '[[shield]] 符合我的限制']];
PAGES.recipes = () => {
  let list = RECIPES.map(r => ({ r, m: stockMatch(r), chk: checkRecipe(r) }));
  const q = U.rq.trim();
  if (q) list = list.filter(x => x.r.t.includes(q) || x.r.ing.some(([f]) => FOODS[f].name.includes(q)));
  if (U.rf.quick) list = list.filter(x => x.r.min <= 20);
  if (U.rf.stock) list = list.filter(x => x.m >= .99);
  if (U.rf.fav) list = list.filter(x => S.favorites.includes(x.r.id));
  if (U.rf.breakfast) list = list.filter(x => x.r.slots.includes('breakfast'));
  if (U.rf.safe) list = list.filter(x => x.chk.ok);
  list.sort((a, b) => b.m - a.m);
  return `
  <div class="row" style="margin-bottom:12px"><input class="input" style="max-width:340px" placeholder="搜菜名或食材，如：番茄、豆腐" value="${esc(U.rq)}" oninput="U.rq=this.value;rerenderRecipes()" id="rq">
    <button class="btn sm sp" onclick="openImport()">[[inbox]] 导入菜谱</button></div>
  <div class="chips" style="margin-bottom:18px">${RF.map(([k, l]) => `<button class="chip ${U.rf[k] ? 'on' : ''}" onclick="U.rf.${k}=!U.rf.${k};render()">${l}</button>`).join('')}</div>
  <div class="rgrid" id="rgrid">${list.map(({ r, m, chk }) => `
    <div class="rcard" onclick="openRecipe('${r.id}')">
      <div class="cover recipe-tint" style="--recipe-swatch:${r.bg}">${r.em}<button class="fav" onclick="event.stopPropagation();toggleFav('${r.id}')" aria-label="收藏">${S.favorites.includes(r.id) ? '[[heart-fill]]' : '[[heart]]'}</button></div>
      <div class="body"><h4>${r.t}</h4><div class="meta"><span>[[timer]] ${r.min} 分</span><span>${r.diff}</span><span>${r.serv} 人份</span></div>
        <div class="match"><span>库存</span><div class="progress"><i style="width:${m * 100}%;background:${m >= .99 ? 'var(--green)' : m > .5 ? 'var(--yolk)' : 'var(--tomato)'}"></i></div><span class="mono">${r0(m * 100)}%</span></div>
        <div class="row" style="gap:5px">${chk.ok ? '' : `<span class="badge r">[[ban]] 含${chk.blocked[0].food}</span>`}${chk.verify.length ? '<span class="badge y">[[alert]] 需核对配料</span>' : ''}${recipeNutrition(r).complete ? '' : '<span class="badge">营养部分已知</span>'}</div>
      </div></div>`).join('') || emptyState('[[pan]]', '没有符合筛选条件的菜谱')}</div>`;
};
function rerenderRecipes() { const pos = $('#rq').selectionStart; render(); const el = $('#rq'); el.focus(); el.setSelectionRange(pos, pos); }
async function toggleFav(id) {
  const on = !S.favorites.includes(id);
  try {
    await Api.setFavorite(id, on);
    if (on) S.favorites.push(id); else S.favorites = S.favorites.filter(x => x !== id);
    commit(on ? '[[heart-fill]] 已收藏' : '已取消收藏');
  } catch (e) { toast('收藏失败：' + (e.message || e), true); }
}
function openRecipe(id) {
  const r = R[id]; const chk = checkRecipe(r); let sv = r.serv;
  const body = () => {
    const nut = recipeNutrition(r, 1);
    return `<div class="row recipe-tint" style="--recipe-swatch:${r.bg};border-radius:16px;padding:16px"><span style="font-size:56px">${r.em}</span><div><h2 style="font-size:22px">${r.t}</h2><div class="small">[[timer]] ${r.min} 分钟 · ${r.diff} · 设备：${r.eq.join('、') || '无需'}</div><div class="small" style="opacity:.7">来源：${r.src} · 已审核</div></div></div>
    ${chk.blocked.length ? `<div class="danger-line" style="margin-top:12px">[[ban]] 含有 <b>${chk.blocked.map(b => b.food).join('、')}</b>，与你的饮食限制「${chk.blocked[0].label}」冲突，系统不会将其排入计划。</div>` : ''}
    ${chk.verify.length ? `<div class="warn-line" style="margin-top:12px">[[alert]] ${chk.verify.join('、')} 为商业食品，过敏原信息未知——不代表安全，请核对实际配料表与交叉接触风险。</div>` : ''}
    <div class="grid g2" style="margin-top:14px;align-items:start">
      <div><div class="row"><b style="font-family:var(--serif)">用料</b><span class="sp small muted">份数</span><button class="btn xs" id="sv-" aria-label="减少份数">−</button><b class="mono" id="svv">${sv}</b><button class="btn xs" id="sv+" aria-label="增加份数">＋</button></div>
        <div id="ings">${ingRows(r, sv)}</div></div>
      <div><b style="font-family:var(--serif)">营养（每份）</b><div style="margin-top:8px">${nutriCard(nut)}</div>
        <b style="font-family:var(--serif);display:block;margin-top:14px">步骤</b><ol class="steps-mini">${r.steps.map(s => `<li>${s[0]}</li>`).join('')}</ol></div></div>`;
  };
  modal({
    title: '菜谱详情', wide: true, body: body(),
    buttons: [{ label: S.favorites.includes(id) ? '[[heart-fill]] 已收藏' : '[[heart]] 收藏', fn: () => toggleFav(id) }, { label: '[[cart]] 缺的加入购物清单', fn: () => addMissingToShop(id, sv) }, { label: '[[flame]] 开始烹饪', cls: 'pri', fn: () => setTimeout(() => startCooking(id), 0) }],
    onMount: root => {
      const upd = d => { sv = Math.max(1, Math.min(8, sv + d)); $('#svv', root).textContent = sv; $('#ings', root).innerHTML = ingRows(r, sv); };
      $('[id="sv-"]', root).onclick = () => upd(-1); $('[id="sv+"]', root).onclick = () => upd(1);
    },
  });
}
function ingRows(r, sv) {
  return r.ing.map(([fid, amt, opt]) => {
    const need = amt * sv / r.serv; const a = available(fid); const f = FOODS[fid];
    const enough = a.qty >= need || a.unknown;
    return `<div class="ing-row ${enough || opt ? '' : 'miss'}"><span>${hasKitFood(fid) ? foodImg(fid, 'ingredients') : f.em}</span><b>${f.name}${opt ? ' <span class="muted small">(可选)</span>' : ''}</b><span class="mono small">${fmtQty(need, f.unit)}</span>
      <span class="small">${a.unknown && a.qty < need ? '<span class="badge">有，数量未知</span>' : enough ? '<span class="badge g">有 ' + fmtQty(a.qty, f.unit) + '</span>' : `<span class="badge r">缺 ${fmtQty(need - a.qty, f.unit)}</span>`}</span></div>`;
  }).join('');
}
async function addMissingToShop(id, sv) {
  const r = R[id]; let n = 0;
  try {
    for (const [fid, amt, opt] of r.ing) {
      if (opt) continue; const need = amt * sv / r.serv; const a = available(fid);
      if (a.unknown || a.qty >= need) continue;
      if (S.shopping.some(x => x.foodId === fid && x.origin === 'manual' && !['received', 'cancelled'].includes(x.status))) continue;
      const gap = FOODS[fid].unit === 'piece' ? Math.ceil(need - a.qty) : Math.ceil((need - a.qty) / 10) * 10;
      await Api.createShoppingItem({ food_id: fid, qty: gap, unit: FOODS[fid].unit, status: 'confirmed', note: '来自菜谱：' + r.t }); n++;
    }
    await refreshShopping();
    commit(n ? `[[cart]] 已加入 ${n} 项到购物清单` : '库存充足，或已在清单中');
  } catch (e) { toast('加入购物清单失败：' + (e.message || e), true); }
}
function openImport() {
  modal({
    title: '[[inbox]] 导入菜谱（私有草稿）',
    body: `<label class="f">粘贴网址或文字<textarea class="input" rows="4" id="imp" placeholder="例如：https://example.com/recipe/123 或直接粘贴做法文字"></textarea></label>
    <p class="small muted">导入结果先进入<b>私有草稿</b>，完成来源与许可审核前不会进入推荐；外部网页内容仅作为数据，不会被当作指令执行。</p><div id="imp-r"></div>`,
    buttons: [{ label: '关闭' }, {
      label: '解析', cls: 'pri', keep: true, fn: root => {
        const v = $('#imp', root).value.trim(); if (!v) { toast('请先输入内容', true); return; }
        $('#imp-r', root).innerHTML = '<p class="small muted">解析中…</p>';
        setTimeout(() => { if (!$('#imp-r', root)) return; $('#imp-r', root).innerHTML = `<div class="scard"><div class="scard-h">[[file]] 草稿：凉拌木耳<span class="type">recipe_import · draft</span></div>
          <div class="small">识别用料：木耳 50g、黄瓜 1 根、蒜 10g、醋 15ml<br>步骤 3 步 · 来源：${esc(v.slice(0, 40))}</div>
          <div class="row" style="margin-top:8px"><span class="badge y">待审核</span><span class="badge">许可：未确认</span><span class="badge">“醋” 未映射到营养来源</span></div></div>`; }, 900);
      }
    }],
  });
}

/* ---------------- 烹饪模式 ---------------- */
let CK = null;
function startCooking(id, date, slot, guide = null) {
  // 开始烹饪只做本地 UI 状态（分步计时器用本地时间）；库存消耗只在完成确认时调 POST /pantry/consumptions。
  const r = guide || R[id];
  if (!r?.steps?.length) { toast('这道菜暂时没有烹饪步骤', true); return; }
  closeModal();
  if (CK) exitCooking();
  CK = { id, guide, date: date || D.todayKey(), slot: slot || (new Date().getHours() < 10 ? 'breakfast' : new Date().getHours() < 15 ? 'lunch' : 'dinner'), i: 0, left: r.steps[0][1], run: false, tick: null, session: uid('ck') };
  const el = document.createElement('div'); el.className = 'cook'; el.id = 'cook'; document.body.appendChild(el);
  document.body.style.overflow = 'hidden';
  renderCook();
}
function renderCook() {
  const r = CK.guide || R[CK.id]; const st = r.steps[CK.i]; const total = st[1];
  const pct = total ? (total - CK.left) / total : 0; const C = 2 * Math.PI * 110;
  const mm = String(Math.floor(CK.left / 60)).padStart(2, '0'), ss = String(CK.left % 60).padStart(2, '0');
  $('#cook').innerHTML = `
    <div class="cook-top"><span style="font-size:30px">${r.em}</span><h2>${esc(r.t)}</h2><div class="cook-prog">${r.steps.map((_, i) => `<i class="${i <= CK.i ? 'on' : ''}"></i>`).join('')}</div><button class="btn" onclick="exitCooking()">[[x]] 退出</button></div>
    <div class="cook-body"><div><div class="cook-step-n">STEP ${CK.i + 1} / ${r.steps.length}</div><div class="cook-text" aria-live="polite">${esc(st[0])}</div>
      ${!CK.guide && CK.i === r.steps.length - 1 ? '<p style="color:var(--cook-muted);margin-top:18px">最后一步！完成后可以确认这次用掉了哪些库存。</p>' : ''}</div>
      <div>${total ? `<div class="timer"><svg viewBox="0 0 240 240"><circle cx="120" cy="120" r="110" fill="none" stroke="var(--cook-track)" stroke-width="10"/><circle cx="120" cy="120" r="110" fill="none" stroke="var(--honey)" stroke-width="10" stroke-linecap="round" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - pct)}" style="transition:stroke-dashoffset 1s linear"/></svg>
        <div class="tv"><div><b>${mm}:${ss}</b><span>${CK.left === 0 ? '[[clock]] 时间到' : CK.run ? '计时中' : '步骤计时器'}</span></div></div></div>
        <div class="row" style="justify-content:center;margin-top:14px"><button class="btn" onclick="cookTimer()">${CK.run ? '[[pause]] 暂停' : '[[play]] 开始计时'}</button><button class="btn" onclick="CK.left=Math.max(0,CK.left-30);renderCook()">−30s</button><button class="btn" onclick="CK.left+=30;renderCook()">+30s</button></div>` : '<div class="cook-big" style="text-align:center">[[chef]]</div><p style="text-align:center;color:var(--cook-muted)">这一步无需计时</p>'}</div></div>
    <div class="cook-foot"><button class="btn" onclick="cookGo(-1)" ${CK.i === 0 ? 'disabled' : ''}>‹ 上一步</button><button class="btn" onclick="speak()">[[volume]] 朗读</button>
      ${CK.i < r.steps.length - 1 ? '<button class="btn pri" onclick="cookGo(1)">下一步 ›</button>' : '<button class="btn pri" onclick="finishCooking()">[[check]] 完成烹饪</button>'}</div>`;
}
function cookTimer() {
  CK.run = !CK.run; clearInterval(CK.tick);
  if (CK.run) CK.tick = setInterval(() => { if (!CK) return; CK.left = Math.max(0, CK.left - 1); if (CK.left === 0) { CK.run = false; clearInterval(CK.tick); toast('[[clock]] 这一步的时间到了'); } renderCook(); }, 1000);
  renderCook();
}
function cookGo(d) { clearInterval(CK.tick); CK.run = false; CK.i += d; CK.left = (CK.guide || R[CK.id]).steps[CK.i][1]; renderCook(); }
function speak() {
  const t = (CK.guide || R[CK.id]).steps[CK.i][0];
  if ('speechSynthesis' in window) { speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(t); u.lang = 'zh-CN'; speechSynthesis.speak(u); toast('[[volume]] 正在朗读（浏览器本地 TTS）'); }
  else toast('当前浏览器不支持朗读，请阅读文字步骤', true);
}
function exitCooking() { if (CK) clearInterval(CK.tick); CK = null; $('#cook') && $('#cook').remove(); document.body.style.overflow = ''; if ('speechSynthesis' in window) speechSynthesis.cancel(); }
function finishCooking() {
  if (CK.guide) { exitCooking(); toast('已完成烹饪'); return; }
  const r = R[CK.id]; const ck = { ...CK }; exitCooking();
  const pm = P.get(ck.date, ck.slot); const sv = pm && pm.r === ck.id ? pm.sv : r.serv;
  const rows = r.ing.map(([fid, amt, opt]) => {
    const need = r1(amt * sv / r.serv); const fa = fefo(fid, need); const a = available(fid);
    return { fid, need, opt, alloc: fa.alloc, short: fa.short, unknown: a.unknown && !fa.alloc.length };
  });
  modal({
    title: '[[check]] 烹饪完成 · 确认库存消耗', wide: true,
    body: `<p class="small">系统按<b>先到期先用（FEFO）</b>建议了扣减批次，你可以修改数量或取消勾选。只有确认后才会写入库存流水。</p>
      <div>${rows.map((x, i) => { const f = FOODS[x.fid]; return `<div class="ing-row" style="grid-template-columns:24px 28px 1fr auto"><input type="checkbox" class="cu-ck" data-i="${i}" ${x.alloc.length ? 'checked' : 'disabled'}><span>${f.em}</span>
        <div><b>${f.name}</b> <span class="small muted">需要 ${fmtQty(x.need, f.unit)}</span>
        ${x.alloc.map((a, j) => `<div class="row small" style="gap:6px;margin-top:4px">批次 ${a.expires ? '到期 ' + D.md(a.expires) : ''} → <input class="input cu-q" data-i="${i}" data-j="${j}" type="number" step="any" min="0" value="${a.amount}" style="width:90px;padding:3px 8px"> ${unitShort[f.unit]}</div>`).join('')}
        ${x.unknown ? '<div class="small muted">库存数量未知，无法自动扣减（可在冰箱盘点后再处理）</div>' : ''}${x.short > 0 && !x.unknown && x.alloc.length ? `<div class="small" style="color:var(--tomato)">库存不足 ${fmtQty(x.short, f.unit)}</div>` : ''}${!x.alloc.length && !x.unknown ? '<div class="small muted">无可用库存（可能来自外购）</div>' : ''}</div><span></span></div>`; }).join('')}</div>
      <div class="hr"></div>
      <label class="row" style="gap:8px"><input type="checkbox" id="cu-meal" checked> 同时记一餐：<b>${D.wd(ck.date)} ${SLOTS[ck.slot]} · ${r.t}</b>（我吃 1 份）</label>
      <p class="small muted">记餐与扣库存是两条独立的事实：外卖、在外就餐不会扣库存；同一次烹饪消耗只会入账一次。</p>`,
    buttons: [{ label: '暂不扣减' }, {
      label: '确认消耗', cls: 'pri', fn: async root => {
        const idem = 'cook-' + ck.session; let n = 0;
        const wantMeal = $('#cu-meal', root).checked;
        try {
          for (const cb of $$('.cu-ck', root)) {
            if (!cb.checked) continue; const x = rows[cb.dataset.i];
            for (let j = 0; j < x.alloc.length; j++) {
              const a = x.alloc[j];
              const q = parseFloat($(`.cu-q[data-i="${cb.dataset.i}"][data-j="${j}"]`, root).value);
              if (q > 0) { await moveBatch(a.batchId, -q, 'CONSUME', '烹饪：' + r.t, 'cooking_session', ck.session, idem + '-' + a.batchId); n++; }
            }
          }
          if (wantMeal && !S.meals.some(m => m.date === ck.date && m.slot === ck.slot && m.items.length === 1 && m.items[0].recipeId === r.id)) {
            await createMeal({ date: ck.date, slot: ck.slot, items: [{ recipeId: r.id, amount: 1 }], source: 'cooking', planned: !!(pm && pm.r === r.id) });
          }
          await recomputePlanShopping();
          commit(`[[utensils]] 已扣减 ${n} 个批次${wantMeal ? '，并记录一餐' : ''}`);
        } catch (e) { toast(e.message, true); return false; }
      }
    }],
  });
}

/* ---------------- 购物清单 ---------------- */
const SH_ST = { proposed: '建议', confirmed: '待买', purchased: '已买', received: '已入库', cancelled: '已取消' };
const SH_NEXT = { proposed: 'confirmed', confirmed: 'purchased' };
PAGES.shopping = () => {
  const plan = S.shopping.filter(x => x.origin === 'plan' && x.status !== 'cancelled');
  const man = S.shopping.filter(x => x.origin === 'manual' && x.status !== 'cancelled');
  const sec = (title, items, hint) => `<div class="section-title">${title} <span class="badge">${items.length}</span></div>
    ${hint ? `<p class="small muted" style="margin:-4px 0 10px">${hint}</p>` : ''}
    ${items.length ? `<div class="shop-list">${items.map(siHTML).join('')}</div>` : emptyState('[[basket]]', '这里是空的')}`;
  return `<div class="row" style="margin-bottom:6px">
      <button class="btn sm" onclick="bulkShopAll('confirmed')">全部确认</button><button class="btn sm" onclick="bulkShopAll('purchased')">全部标为已买</button>
      <button class="btn sm sp pri" onclick="openAddShop()">＋ 手动添加</button></div>
    <p class="small muted">状态流：建议 → 待买 → 已买 → <b>收货入库</b>（只有入库才会产生库存批次）。计划变更只会重算“建议”项，不会改动手动项和已确认项。</p>
    <div class="grid g2" style="align-items:start">
      <div>${sec(`[[calendar]] 来自计划 ${S.plan ? 'v' + S.plan.active : ''} 的采购差额`, plan, '差额 = 计划所需 − 可用库存 − 已在途')}</div>
      <div>${sec('[[pen]] 手动添加', man)}</div></div>`;
};
function siHTML(x) {
  const f = FOODS[x.foodId]; const done = ['purchased', 'received'].includes(x.status);
  const steps = ['proposed', 'confirmed', 'purchased', 'received']; const si = steps.indexOf(x.status);
  return `<div class="si ${done ? 'struck' : ''}">
    ${x.status === 'received' ? '<span style="width:20px">[[check-circle]]</span>' : '<span style="width:20px"></span>'}
    <span style="font-size:20px">${f.em}</span>
    <span class="nm"><b>${f.name}</b> <span class="mono small">${x.unknownStock ? '（库存数量未知，请自行判断）' : fmtQty(x.qty, x.unit)}</span>${x.origin === 'plan' && x.need ? `<span class="small muted"> · 需 ${fmtQty(x.need, x.unit)} 有 ${fmtQty(x.avail, x.unit)}${x.first ? ' · ' + D.wd(x.first) + '前' : ''}</span>` : ''}${x.note ? `<span class="small muted"> · ${esc(x.note)}</span>` : ''}</span>
    <span class="flow" title="${steps.map(s => SH_ST[s]).join(' → ')}">${steps.map((s, i) => `<i class="${i <= si ? 'on' : ''}"></i>`).join('')}</span>
    <span class="stamp ${x.status}">${SH_ST[x.status]}</span>
    ${SH_NEXT[x.status] ? `<button class="btn xs" onclick="shopNext('${x.id}')">${x.status === 'proposed' ? '确认' : '已买'}</button>` : x.status === 'purchased' ? `<button class="btn xs pri" onclick="openReceive('${x.id}')">收货入库</button>` : ''}
    ${x.status !== 'received' ? `<button class="btn xs ghost" onclick="shopCancel('${x.id}')" aria-label="移除">[[x]]</button>` : ''}</div>`;
}
async function shopNext(id) {
  const x = S.shopping.find(i => i.id === id);
  if (!x || !SH_NEXT[x.status]) return;
  try { await Api.updateShoppingItem(id, { status: SH_NEXT[x.status] }); await refreshShopping(); commit(`${FOODS[x.foodId].name} → ${SH_ST[SH_NEXT[x.status]]}`); }
  catch (e) { toast('更新失败：' + (e.message || e), true); }
}
async function shopCancel(id) {
  try { await Api.updateShoppingItem(id, { status: 'cancelled' }); await refreshShopping(); commit('已移除'); }
  catch (e) { toast('移除失败：' + (e.message || e), true); }
}
/* 一键全部：不再先勾选再确认，直接把全部可推进的项推到目标状态 */
async function bulkShopAll(to) {
  const order = ['proposed', 'confirmed', 'purchased'];
  const items = S.shopping.filter(x => !['received', 'cancelled'].includes(x.status) && order.indexOf(x.status) < order.indexOf(to));
  if (!items.length) { toast('没有可推进的项目', true); return; }
  let n = 0;
  try {
    for (const x of items) { await Api.updateShoppingItem(x.id, { status: to }); n++; }
    await refreshShopping();
    commit(`已更新 ${n} 项 → ${SH_ST[to]}`);
  } catch (e) { toast('批量更新失败：' + (e.message || e), true); }
}
function openAddShop() {
  modal({
    title: '＋ 添加购物项', body: `<div class="f">食材</div>${foodPickerHTML('lemon')}
      <div class="form-grid" style="margin-top:12px"><label class="f">数量<input class="input" id="sq" type="number" step="any" min="0" value="1"></label><label class="f">备注<input class="input" id="sn" placeholder="可选"></label></div>`,
    buttons: [{ label: '取消' }, {
      label: '添加', cls: 'pri', fn: async root => {
        const fid = foodPickerValue(root) || 'lemon';
        try {
          await Api.createShoppingItem({ food_id: fid, qty: parseFloat($('#sq', root).value) || 1, unit: FOODS[fid].unit, status: 'confirmed', note: $('#sn', root).value });
          await refreshShopping(); commit('已加入清单');
        } catch (e) { toast('添加失败：' + (e.message || e), true); return false; }
      },
    }],
    onMount: root => bindFoodPicker(root),
  });
}
function openReceive(id) {
  const x = S.shopping.find(i => i.id === id); const f = FOODS[x.foodId];
  const d = foodDefault(x.foodId);
  modal({
    title: `[[box]] 收货入库 · ${f.em} ${f.name}`,
    body: `<label class="f">实际数量（${UNIT[f.unit]}）<input class="input" id="rq2" type="number" step="any" min="0" value="${x.qty ?? ''}"></label>
      <div class="row" style="margin-top:10px"><span class="small muted">默认：保质期至 ${D.add(D.todayKey(), d.days)} · ${LOC[d.loc].name}</span><button class="btn sm ghost" id="r-more" type="button">更多 ▾</button></div>
      <div id="r-adv" class="hidden" style="margin-top:10px"><div class="form-grid"><label class="f">保质期至<input class="input" id="re" type="date" value="${D.add(D.todayKey(), d.days)}"></label>
      <div class="f">存放位置${segHTML('rl', Object.entries(LOC).map(([k, l]) => [k, l.name]), d.loc)}</div></div></div>
      <p class="small muted">将创建新库存批次 + 一条 PURCHASE_IN 流水；同一购物项不会重复入库。</p>`,
    buttons: [{ label: '取消' }, {
      label: '确认入库', cls: 'pri', fn: async root => {
        const q = $('#rq2', root).value;
        const adv = !$('#r-adv', root).classList.contains('hidden');
        try {
          const r = await receiveItem(id, { qty: q === '' ? null : parseFloat(q), expires: adv ? ($('#re', root).value || D.add(D.todayKey(), d.days)) : D.add(D.todayKey(), d.days), location: adv ? (segValue(root, 'rl') || d.loc) : d.loc });
          if (r.dup) { toast('该购物项已入库，不会重复入账', true); return false; }
          await recomputePlanShopping(); commit(`[[check-circle]] ${f.name} 已入库到${LOC[adv ? (segValue(root, 'rl') || d.loc) : d.loc].name}`);
        } catch (e) { toast('入库失败：' + (e.message || e), true); return false; }
      }
    }],
    onMount: root => { $('#r-more', root).onclick = () => { const a = $('#r-adv', root); a.classList.toggle('hidden'); $('#r-more', root).textContent = a.classList.contains('hidden') ? '更多 ▾' : '收起 ▴'; }; },
  });
}

/* ---------------- 记餐 ---------------- */
PAGES.meals = () => {
  const T = D.todayKey(); const sel = U.mealDate || T; const week = D.week(sel);
  const ms = S.meals.filter(m => m.date === sel);
  const nut = dayNutrition(sel);
  return `
  <div class="row" style="margin-bottom:12px"><button class="btn sm" onclick="U.mealDate=D.add('${sel}',-7);render()">‹ 上周</button><b style="font-family:var(--serif)">${D.md(week[0])} – ${D.md(week[6])}</b><button class="btn sm" onclick="U.mealDate=D.add('${sel}',7);render()" ${D.diff(week[6], T) >= 0 ? 'disabled' : ''}>下周 ›</button>
    <div class="sp row"><button class="btn sm" onclick="openRecognize('meal')">[[camera]] 拍照记餐</button><button class="btn sm" onclick="voiceQuickMeal()">[[mic]] 语音快速记</button><button class="btn sm pri" onclick="openAddMeal()">＋ 记一餐</button></div></div>
  <div class="daystrip" style="margin-bottom:18px">${week.map(d => { const c = ['breakfast', 'lunch', 'dinner'].map(s => S.meals.some(m => m.date === d && m.slot === s)); return `<div class="day ${d === sel ? 'on' : ''}" onclick="U.mealDate='${d}';render()" ${D.diff(d, T) > 0 ? 'style="opacity:.45"' : ''}><span>${D.wd(d)}</span><b>${D.parse(d).getDate()}</b><div class="dots">${c.map(x => `<i class="${x ? 'on' : ''}"></i>`).join('')}</div></div>`; }).join('')}</div>
  <div class="grid g2" style="grid-template-columns:minmax(0,1.3fr) minmax(0,1fr);align-items:start">
    <div class="card"><div class="card-h"><h3>${D.wd(sel)} ${D.md(sel)} 的餐食</h3><span class="sp small muted">${ms.length} 条记录</span></div>
      <div class="timeline">${['breakfast', 'lunch', 'dinner', 'snack'].map(slot => {
        const list = ms.filter(m => m.slot === slot); const pm = P.get(sel, slot);
        return `<div class="tl"><h4>${SLOT_EM[slot]} ${SLOTS[slot]} ${pm && !list.length ? `<span class="badge">计划：${R[pm.r].t}</span>` : ''}</h4>
          ${list.map(m => `<div class="meal-rec"><span class="em">${m.em}</span><div class="info"><b>${esc(m.title)}</b> ${m.planned ? '<span class="badge g">按计划</span>' : ''}<span class="badge">${({ plan: '计划', manual: '手动', cooking: '烹饪后', photo: '照片确认', agent: 'AI 草稿·已确认' })[m.source] || m.source}</span>
            <div class="nut-inline"><span>${r0(m.nut.v[0])}kcal</span><span>P ${r0(m.nut.v[1])}g</span><span>F ${r0(m.nut.v[2])}g</span><span>C ${r0(m.nut.v[3])}g</span>${m.nut.complete ? '' : '<span style="color:var(--yolk-ink)">部分已知</span>'}${m.version > 1 ? `<span>v${m.version}</span>` : ''}</div></div>
            <button class="btn xs" onclick="openEditMeal('${m.id}')">编辑</button></div>`).join('')}
          ${!list.length ? (D.diff(sel, T) <= 0 ? `<div class="row small muted">未记录 ${pm ? `<button class="btn xs" onclick="openEatPlanned('${sel}','${slot}')">按计划记为已吃</button>` : ''}<button class="btn xs ghost" onclick="openAddMeal('${slot}','${sel}')">手动记录</button></div>` : '<span class="small muted">未来日期</span>') : ''}</div>`;
      }).join('')}</div></div>
    <div class="card"><div class="card-h"><h3>当日营养</h3>${nut.partial ? '<span class="badge y">部分已知</span>' : ''}</div>${nutriCard({ v: nut.v, complete: !nut.partial, unknown: [...new Set(ms.flatMap(m => m.nut.unknown))], basis: nut.partial ? 'partial' : 'standardized_portion' })}
      <p class="small muted" style="margin-top:12px">每条记录保存当时的营养计算快照（数据来源 + 计算版本）。修改份量会生成新版本，并把覆盖这一天的周报标记为“需更新”。</p></div>
  </div>`;
};
function mealForm(items) {
  return `<div id="mf-items">${items.map((it, i) => mealItemRow(it, i)).join('')}</div>
    <div class="meal-add" style="margin:8px 0 14px"><input class="input" id="mf-q" placeholder="＋ 添加菜谱或食材… 搜名字" autocomplete="off" aria-label="添加菜谱或食材"><div class="meal-add-list" id="mf-list"></div></div>
    <div id="mf-nut"></div>`;
}
function mealItemRow(it, i) {
  if (it.recipeId) {
    const r = R[it.recipeId];
    const name = esc(r.t);
    return `<div class="row meal-item-row" data-i="${i}"><span class="meal-item-icon">${r.em}</span><b>${name}</b>
      <div class="meal-portions">
        <button type="button" class="btn ghost" data-portion-step="-0.25" aria-label="减少${name}份量">−</button>
        <input type="number" class="input mf-portion" value="${it.amount}" inputmode="decimal" min="0" step="any" required aria-label="${name}份量">
        <button type="button" class="btn ghost" data-portion-step="0.25" aria-label="增加${name}份量">＋</button>
      </div>
      <span class="small">份</span><button type="button" class="btn xs ghost mf-del" aria-label="移除${name}">[[x]]</button></div>`;
  }
  const f = FOODS[it.foodId]; return `<div class="row" style="border-bottom:1px dashed var(--line);padding:8px 0" data-i="${i}"><span style="font-size:22px">${f.em}</span><b style="min-width:90px">${f.name}</b><input type="number" class="input mf-n" value="${it.amount}" step="any" min="0" style="width:100px"><span class="small">${UNIT[f.unit]}</span><button class="btn xs ghost mf-del sp">[[x]]</button></div>`;
}
function bindMealForm(root, state) {
  const draw = () => { $('#mf-items', root).innerHTML = state.items.map((it, i) => mealItemRow(it, i)).join(''); bind(); upd(); };
  const upd = () => { $('#mf-nut', root).innerHTML = state.items.length ? nutriCard(mealNutrition(state.items)) : '<p class="muted small">请添加至少一项</p>'; };
  const bind = () => {
    $$('[data-i]', $('#mf-items', root)).forEach(row => {
      const i = +row.dataset.i;
      const portion = $('.mf-portion', row);
      const nm = $('.mf-n', row);
      if (portion) {
        const steps = $$('[data-portion-step]', row);
        const syncPortion = () => {
          const amount = portion.valueAsNumber;
          const valid = Number.isFinite(amount) && amount > 0;
          portion.setCustomValidity(valid ? '' : '份量必须大于 0');
          steps[0].disabled = !valid || amount <= 0.25;
          steps[1].disabled = !valid;
          if (valid) {
            state.items[i].amount = amount;
            upd();
          }
        };
        portion.addEventListener('input', syncPortion);
        for (const button of steps) {
          button.onclick = () => {
            const amount = portion.valueAsNumber + Number(button.dataset.portionStep);
            portion.value = Number(amount.toFixed(8));
            syncPortion();
          };
        }
        steps[0].disabled = portion.valueAsNumber <= 0.25;
      }
      if (nm) nm.oninput = () => { state.items[i].amount = parseFloat(nm.value) || 0; upd(); };
      $('.mf-del', row).onclick = () => { state.items.splice(i, 1); draw(); };
    });
  };
  /* 搜索 + 菜谱/食材分组平铺，点即加入（替代带 optgroup 的下拉） */
  const renderAdd = () => {
    const q = ($('#mf-q', root).value || '').trim();
    const recipes = RECIPES.filter(r => !q || r.t.includes(q) || r.ing.some(([f]) => FOODS[f].name.includes(q))).slice(0, 6);
    const foods = orderedFoods().filter(id => !q || FOODS[id].name.includes(q) || (FOODS[id].tags || []).some(t => t.includes(q))).slice(0, 6);
    $('#mf-list', root).innerHTML =
      (recipes.length ? `<div class="grp">菜谱</div>` + recipes.map(r => `<button type="button" data-t="r" data-id="${r.id}">${dishSvg(r.id)}<span>${r.t}</span><span class="muted small sp">${r.min} 分钟</span></button>`).join('') : '') +
      (foods.length ? `<div class="grp">单一食材</div>` + foods.map(id => `<button type="button" data-t="f" data-id="${id}">${foodImg(id)}<span>${FOODS[id].name}</span><span class="muted small sp">${UNIT[FOODS[id].unit]}</span></button>`).join('') : '') ||
      '<div class="muted small" style="padding:8px">没有匹配的菜谱或食材</div>';
  };
  $('#mf-q', root).addEventListener('input', renderAdd);
  $('#mf-list', root).addEventListener('click', e => {
    const b = e.target.closest('button[data-id]'); if (!b) return;
    const t = b.dataset.t, id = b.dataset.id;
    state.items.push(t === 'r' ? { recipeId: id, amount: 1 } : { foodId: id, amount: FOODS[id].unit === 'piece' ? 1 : 100 });
    $('#mf-q', root).value = ''; renderAdd(); draw();
  });
  draw();
  renderAdd();
}
function openAddMeal(slot, date, items = [], source = 'manual') {
  const h = new Date().getHours();
  const st = { items: items.map(x => ({ ...x })) };
  modal({
    title: '[[utensils]] 记一餐', wide: true,
    body: `<div class="form-grid" style="margin-bottom:10px"><label class="f">日期<input class="input" id="md" type="date" value="${date || D.todayKey()}" max="${D.todayKey()}"></label>
      <div class="f">餐次${segHTML('ms', Object.entries(SLOTS), slot || (h < 10 ? 'breakfast' : h < 15 ? 'lunch' : 'dinner'))}</div></div>${mealForm(st.items)}
      <p class="small muted">营养由系统按营养数据库确定性计算，不由 AI 生成数字。记餐<b>不会</b>自动扣减库存。</p>`,
    buttons: [{ label: '取消' }, {
      label: '保存记录', cls: 'pri', fn: async root => {
        if ($$('.mf-portion', root).some(input => !input.reportValidity())) return false;
        if (!st.items.length) { toast('请添加至少一项', true); return false; }
        const d = $('#md', root).value, s = segValue(root, 'ms') || 'lunch'; const pm = P.get(d, s);
        try {
          await createMeal({ date: d, slot: s, items: st.items, source, planned: !!(pm && st.items.length === 1 && st.items[0].recipeId === pm.r) });
          commit('[[check]] 已记录 ' + SLOTS[s]);
        } catch (e) { toast('保存失败：' + (e.message || e), true); return false; }
      }
    }],
    onMount: root => bindMealForm(root, st),
  });
}
function openEatPlanned(date, slot) {
  const pm = P.get(date, slot);
  if (!pm) return openAddMeal(slot, date);
  if (isEaten(date, slot)) { toast('这一餐已经记录过了'); return; }
  openAddMeal(slot, date, [{ recipeId: pm.r, amount: 1 }], 'plan');
}
function openEditMeal(id) {
  const m = S.meals.find(x => x.id === id); const st = { items: JSON.parse(JSON.stringify(m.items)) };
  modal({
    title: `编辑 · ${D.wd(m.date)} ${SLOTS[m.slot]}（当前 v${m.version}）`, wide: true, body: mealForm(st.items),
    buttons: [{
      label: '[[trash]] 删除', cls: 'warn', fn: async () => {
        const snap = { date: m.date, slot: m.slot, items: JSON.parse(JSON.stringify(m.items)), source: m.source, planned: m.planned };
        try {
          await deleteMeal(id);
          commit('已删除记录，相关周报已标记需更新');
          toastUndo('已删除一条记餐', '撤销', async () => {
            try { await createMeal(snap); commit('已恢复记餐'); }
            catch (e) { toast('恢复失败：' + (e.message || e), true); }
          });
        }
        catch (e) { toast('删除失败：' + (e.message || e), true); return false; }
      },
    }, { label: '取消' }, {
      label: '保存为新版本', cls: 'pri', fn: async root => {
        if ($$('.mf-portion', root).some(input => !input.reportValidity())) return false;
        if (!st.items.length) { toast('请添加至少一项', true); return false; }
        try { await updateMeal(id, st.items); commit(`已更新为 v${m.version}，营养已重算`); }
        catch (e) { toast('保存失败：' + (e.message || e), true); return false; }
      },
    }],
    onMount: root => bindMealForm(root, st),
  });
}
async function showMealCandidates(root) {
  const statusEl = $('#rc-status', root);
  let st;
  let warn;
  if (!RC_FILE) {
    st = { items: [{ recipeId: 'r_tomegg', amount: 1 }, { foodId: 'rice', amount: 75 }] };
    warn = '演示候选（示例照片）—— 以下为示例，未经过模型识别，请确认份量。可能是：番茄炒蛋（较确定）、米饭（不确定，按生米 75g 估算）。';
  } else {
    statusEl.textContent = '正在调用识别服务…';
    try {
      const res = await Api.recognizeImage(RC_FILE, 'meal');
      const recipes = (res && res.recipes) || [];
      const items = (res && res.items) || [];
      const validRecipes = recipes.filter(r => r.recipe_id && R[r.recipe_id]);
      if (validRecipes.length) {
        st = { items: validRecipes.map(r => ({ recipeId: r.recipe_id, amount: 1 })) };
        warn = '识别结果：' + validRecipes.map(r => esc(R[r.recipe_id].t) + '（' + (r.confidence === 'high' ? '较确定' : '不确定') + '）').join('、') + '。请确认份量。';
      } else if (items.length) {
        const mapped = items.map(it => {
          let fid = it.food_id && FOODS[it.food_id] ? it.food_id : null;
          if (!fid && it.name) fid = Object.keys(FOODS).find(k => FOODS[k].name === it.name) || Object.keys(FOODS).find(k => (FOODS[k].tags || []).includes(it.name)) || null;
          if (!fid) return null;
          const amt = it.amount ?? (FOODS[fid].unit === 'piece' ? 1 : 100);
          return { foodId: fid, amount: amt, _conf: it.confidence };
        }).filter(Boolean);
        if (!mapped.length) { statusEl.textContent = '没有识别到可记录的食物，请换一张更清晰的照片再试。'; return; }
        st = { items: mapped.map(({ _conf, ...x }) => x) };
        warn = '识别结果：' + mapped.map(x => esc(FOODS[x.foodId].name) + '（' + (x._conf === 'high' ? '较确定' : '不确定') + '）').join('、') + '。照片无法判断精确重量，请确认份量。';
      } else {
        statusEl.textContent = '没有识别到可记录的食物，请换一张更清晰的照片再试。';
        return;
      }
    } catch (e) {
      if (e && e.code === 'MODEL_NOT_CONFIGURED') {
        st = { items: [{ recipeId: 'r_tomegg', amount: 1 }, { foodId: 'rice', amount: 75 }] };
        warn = '演示候选（未配置模型 key）—— 以下为示例，未经过模型识别，请确认份量。可能是：番茄炒蛋（较确定）、米饭（不确定，按生米 75g 估算）。';
      } else {
        statusEl.textContent = '识别失败：' + (e && e.message ? e.message : '未知错误') + '。没有写入任何数据，请重试。';
        return;
      }
    }
  }
  statusEl.innerHTML = '识别到以下<b>候选</b>（照片无法判断精确重量，请确认份量）：';
  $('#rc-cands', root).innerHTML = `<div class="warn-line" style="margin-bottom:8px">[[bot]] ${warn}</div>
    <div class="form-grid"><div class="f">餐次${segHTML('ms', Object.entries(SLOTS), new Date().getHours() < 10 ? 'breakfast' : new Date().getHours() < 15 ? 'lunch' : 'dinner')}</div></div>${mealForm(st.items)}
    <div class="row" style="margin-top:12px"><button class="btn pri sp" id="rc-ok">确认并保存</button></div>`;
  bindMealForm(root, st);
  $('#rc-ok', root).onclick = async () => {
    if (!st.items.length) { toast('请添加至少一项', true); return; }
    try {
      await createMeal({ date: D.todayKey(), slot: segValue(root, 'ms') || 'lunch', items: st.items, source: 'photo' });
      closeModal(); commit('[[check]] 已根据照片候选记录（份量经你确认）');
    } catch (e) { toast('保存失败：' + (e.message || e), true); }
  };
}

/* ---------------- 习惯 ---------------- */
const HB = { water: { n: '饮水', em: '[[drop]]', u: 'ml', col: '--sky', soft: '--sky-soft', sum: true, step: 250 }, sleep: { n: '睡眠', em: '[[bed]]', u: '小时', col: '--plum', soft: '--plum-soft' }, steps: { n: '步数', em: '[[walk]]', u: '步', col: '--green', soft: '--green-soft' }, weight: { n: '体重', em: '[[scale]]', u: 'kg', col: '--yolk', soft: '--yolk-soft' } };
function habitSeries(kind, back = 0) {
  const T = D.todayKey(); return Array.from({ length: 7 }, (_, i) => D.add(T, i - 6 - back * 7)).map(d => {
    const hs = S.habits.filter(h => h.kind === kind && h.date === d); if (!hs.length) return { d, v: null };
    return { d, v: HB[kind].sum ? hs.reduce((s, h) => s + h.value, 0) : hs[hs.length - 1].value };
  });
}
/* 柱状图（2026-11-18）：7 天各一根柱；有记录实心柱 + 顶部数值，缺失天画浅色虚线空框占位
   （表示“没记”，不是 0）。柱高按本周有记录值的范围归一化（最低→短柱、最高→满柱），
   柱顶标注精确数值，不做绝对刻度误导；今天那根柱加深、星期字加粗标色。
   用 flex 柱而不用固定 viewBox 的 SVG：卡片拉宽时 SVG 会连文字一起横向拉伸变形，
   flex 柱的柱宽、间距、字号都随容器缩放，360px 宽卡片里 7 根柱也不会溢出。 */
function barsHTML(series, col) {
  const vals = series.map(x => x.v).filter(v => v !== null); if (!vals.length) return '';
  const mn = Math.min(...vals), mx = Math.max(...vals), rg = mx - mn || 1;
  const fmt = v => v >= 1000 ? Math.round(v).toLocaleString() : (Number.isInteger(v) ? String(v) : r1(v));
  const cols = series.map((p, i) => {
    const day = D.wd(p.d).slice(1);
    if (p.v === null) return `<div class="bar-col"><div class="bar-val">未记</div><div class="bar-empty" title="${D.md(p.d)}：未记"></div><div class="bar-day">${day}</div></div>`;
    const pct = (12 + (p.v - mn) / rg * 56).toFixed(1); // 12%..68%：留出数值与星期字高度，柱 + 字总高不超过 104px 图表区
    return `<div class="bar-col"><div class="bar-val">${fmt(p.v)}</div><div class="bar-fill${i === 6 ? ' today' : ''}" style="height:${pct}%;background:var(${col})" title="${D.md(p.d)}：${p.v}"></div><div class="bar-day${i === 6 ? ' today' : ''}">${day}</div></div>`;
  }).join('');
  return `<div class="bars" role="img" aria-label="近 7 天柱状图">${cols}</div>`;
}
/* 较上周趋势：水/步数用百分比，睡眠/体重用绝对差值；无上周数据则不显示 */
function habitTrend(k, cur, prev) {
  const avg = a => { const v = a.filter(x => x !== null); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };
  const c = avg(cur), p = avg(prev);
  if (c === null || p === null || p === 0) return '';
  const d = c - p;
  if (Math.abs(d) < 1e-9) return '较上周持平';
  const arrow = d > 0 ? '↑' : '↓';
  if (k === 'weight') return `较上周 ${arrow} ${r1(Math.abs(d))} kg`;
  if (k === 'sleep') return `较上周 ${arrow} ${r1(Math.abs(d))} 小时`;
  return `较上周 ${arrow} ${r0(Math.abs(d) / p * 100)}%`;
}
PAGES.habits = () => `<div class="card" style="margin-bottom:16px"><div class="card-h"><h3>[[inbox]] 导入健康数据</h3><span class="sp small muted">导入后自动刷新下方习惯</span></div>
  <p class="small muted" style="margin:0 0 10px">iPhone：健康 App → 头像 → 导出全部健康数据，得到 export.xml 后在此上传；安卓或其他：用 CSV（date,kind,value）导入。</p>
  <div class="row"><button class="btn sm" onclick="downloadHabitTemplate()">[[download]] 下载 CSV 模板</button>
    <label class="btn sm pri">选择文件上传<input type="file" accept=".xml,.csv" hidden onchange="onHabitImportFile(this)"></label>
    <span class="small muted">支持 .xml / .csv</span></div>
  ${HABIT_IMPORT_RES ? `<div id="habit-import-res" style="margin-top:10px">${HABIT_IMPORT_RES}</div>` : '<div id="habit-import-res" style="margin-top:10px"></div>'}</div>
  <p class="small muted" style="margin-top:0">所有习惯均为<b>自愿记录</b>；缺失天画虚线空框占位，不会按 0 算，也不会被当作“没完成”。目标仅为个人设定，不作为医学标准。</p>
  <div class="habit-grid">${Object.entries(HB).map(([k, h]) => {
    const s = habitSeries(k); const today = s[6].v; const vals = s.filter(x => x.v !== null);
    const avg = vals.length ? (k === 'sleep' || k === 'weight' ? r1(vals.reduce((a, b) => a + b.v, 0) / vals.length) : r0(vals.reduce((a, b) => a + b.v, 0) / vals.length)) : null;
    const total = h.sum && vals.length ? r0(vals.reduce((a, b) => a + b.v, 0)).toLocaleString() : null;
    const trend = habitTrend(k, s.map(x => x.v), habitSeries(k, 1).map(x => x.v));
    const quickLabel = { water: '＋ 250 ml', sleep: '记 7.5 小时', steps: '记 8000 步', weight: '记上次体重' }[k];
    const sumParts = [...(total ? [`7 日总和 ${total} ${h.u}`] : []), ...(avg !== null ? [`均值 ${avg} ${h.u}`] : []), ...(trend ? [trend] : []), `记了 ${vals.length} 天`];
    return `<div class="card habit">
      <div class="habit-band" style="background:var(${h.soft})">
        <span class="habit-ico">${h.em}</span>
        <div class="habit-titles"><h3>${h.n}</h3><span class="badge">${vals.length}/7 天有记录</span></div>
        <div class="habit-actions">
          <div class="habit-today">${today === null ? '<span class="norec">今天还没记</span>' : `<b>${today.toLocaleString()} <small>${h.u}</small></b><span>今天</span>`}</div>
          <button class="btn sm pri" onclick="quickHabit('${k}')">${quickLabel}</button>
          <button class="btn sm ghost" onclick="openHabit('${k}')">自定义</button>
        </div>
      </div>
      <div class="habit-chart">${vals.length ? barsHTML(s, h.col) : '<div class="chart-empty">近 7 天暂无记录 · 点右上角一键记一次</div>'}</div>
      <div class="habit-sum">${sumParts.map(p => `<span>${p}</span>`).join('<i class="sep">·</i>')}</div></div>`;
  }).join('')}</div>`;
/* 健康数据导入：CSV 模板前端本地生成下载；文件走 Api.importHabits，结果保留展示并刷新习惯。 */
function downloadHabitTemplate() {
  download('habits-template.csv', 'date,kind,value\n2026-11-17,steps,8000\n2026-11-17,water,500\n', 'text/csv');
  toast('[[download]] 已下载 CSV 模板');
}
async function onHabitImportFile(input) {
  const file = input.files && input.files[0];
  input.value = '';
  if (!file) return;
  const box = $('#habit-import-res');
  if (box) box.innerHTML = '<p class="small muted">正在导入…</p>';
  try {
    const res = await Api.importHabits(file);
    const imported = res.imported ?? 0, skipped = res.skipped ?? 0;
    const failed = Array.isArray(res.failed) ? res.failed : [];
    HABIT_IMPORT_RES = `导入 ${imported} 条、跳过 ${skipped} 条、失败 ${failed.length} 行` +
      (failed.length ? `<div class="col" style="gap:2px;margin-top:6px">${failed.slice(0, 5).map(f => `<span class="small" style="color:var(--tomato)">第 ${esc(String(f.line ?? ''))} 行：${esc(f.reason || '导入失败')}</span>`).join('')}${failed.length > 5 ? `<span class="small muted">…以及另外 ${failed.length - 5} 行</span>` : ''}</div>` : '');
    await refreshHabits();
    render();
    toast(`已导入 ${imported} 条${failed.length ? '，' + failed.length + ' 行失败' : ''}`);
  } catch (e) {
    HABIT_IMPORT_RES = `<span class="small" style="color:var(--tomato)">导入失败：${esc(e.message || e)}</span>`;
    render();
  }
}
/* 卡片上一键记录：有合理默认值就直接记（事后可点“自定义”改）；体重没有默认值时沿用上次，仍没有则进弹窗 */
async function quickHabit(k) {
  const T = D.todayKey();
  try {
    if (k === 'water') { await addWater(); return; }
    if (k === 'sleep') { await recordHabit('sleep', T, 7.5); commit('已记录睡眠 7.5 小时（可点“自定义”改）'); return; }
    if (k === 'steps') { await recordHabit('steps', T, 8000); commit('已记录步数 8000 步（可点“自定义”改）'); return; }
    if (k === 'weight') {
      const last = [...S.habits].filter(x => x.kind === 'weight').sort((a, b) => (b.date < a.date ? -1 : 1))[0];
      if (last) { await recordHabit('weight', T, last.value); commit(`已记录体重 ${last.value} kg（沿用上次，可点“自定义”改）`); }
      else openHabit('weight');
      return;
    }
  } catch (e) { toast('记录失败：' + (e.message || e), true); }
}
function openHabit(k) {
  const h = HB[k];
  modal({
    title: `${h.em} 记录${h.n}`, body: `<div class="form-grid"><label class="f">日期<input class="input" id="hd" type="date" value="${D.todayKey()}" max="${D.todayKey()}"></label><label class="f">数值（${h.u}）<input class="input" id="hv" type="number" step="any" min="0" placeholder="${({ water: 250, sleep: 7.5, steps: 8000, weight: 62 })[k]}"></label></div>
      ${k === 'water' ? '<p class="small muted">饮水按天累加；其它指标同一天以最后一次为准。</p>' : ''}`,
    buttons: [{ label: '取消' }, {
      label: '保存', cls: 'pri', fn: async root => {
        const v = parseFloat($('#hv', root).value);
        if (isNaN(v) || v <= 0) { toast('请输入有效数值', true); return false; }
        try { await recordHabit(k, $('#hd', root).value, v); commit(`已记录${h.n} ${v} ${h.u}`); }
        catch (e) { toast('保存失败：' + (e.message || e), true); return false; }
      },
    }],
  });
}

/* ---------------- 周报 ---------------- */
PAGES.reports = () => typeof weeklyReportPage === 'function' ? weeklyReportPage() :
  emptyState('[[chart]]', '刷新页面后查看周报。');
AFTER.reports = () => { if (typeof renderWeeklyReportText === 'function') renderWeeklyReportText(); };
function download(name, text, type = 'text/markdown') { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: type + ';charset=utf-8' })); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500); }

/* ---------------- 设置 ---------------- */
const POL = [['weekly_report', '[[chart]] 每周周报', '每周日 20:00 根据本周记录生成周报，并发送站内通知'], ['expiry', '[[clock]] 临期提醒', '每天扫描库存，提醒 3 天内到期的食材（不会自动丢弃）'], ['habit_review', '[[drop]] 习惯回顾', '每周总结自愿记录的习惯（不做疾病判断）']];
const PREFERENCE_TONES = [['practical', '清楚实用'], ['warm', '温和自然'], ['concise', '简洁直接']];


function agentPreferencesHTML() {
  const p = S.agentPreferences;
  return `<div class="card-h"><h3>[[chef]] 管家设置</h3></div>
    ${p ? `<form class="agent-preferences-form" onsubmit="event.preventDefault();saveAgentPreferences(this)">
      <fieldset>
        <legend>管家人设</legend>
        ${radioChoices('persona', CHAT_PERSONAS, p.persona || 'custom', true)}
      </fieldset>
      <fieldset>
        <legend>自定义人设</legend>
        <label class="f">管家名称<input class="input" name="name" maxlength="24" value="${esc(p.name)}" placeholder="AI 管家"></label>
        <fieldset><legend class="small">回答语气</legend>${radioChoices('tone', PREFERENCE_TONES, p.tone)}</fieldset>
        <label class="f">做事风格<textarea class="input" name="style" rows="2" maxlength="500" placeholder="如：先给一道最省事的做法，再给替代选项">${esc(p.style)}</textarea></label>
      </fieldset>
      <fieldset>
        <legend>主记忆</legend>
        <label class="f">跨对话记住的内容<textarea class="input" name="memory" rows="4" maxlength="2000" placeholder="如：工作日晚餐优先一锅菜，周末可以慢慢做">${esc(p.memory)}</textarea></label>
        <p class="small muted">保存后，管家回答时会参考这些内容。想让它忘记某条，删掉对应文字后保存。过敏和忌口请在「饮食限制」管理。</p>
      </fieldset>
      <div class="row agent-preferences-actions">
        <button class="btn sm pri" type="submit">保存管家设置</button>
        <button class="btn sm" type="button" data-preferences-reload hidden onclick="reloadAgentPreferences(this)">载入最新设置</button>
        <span class="small muted" data-preferences-status role="status"></span>
      </div>
    </form>` : '<p class="small">管家设置加载失败。</p><button class="btn sm" onclick="reloadAgentPreferences(this)">重新加载</button>'}`;
}

async function saveAgentPreferences(form) {
  const state = S;
  const status = $('[data-preferences-status]', form);
  const submit = $('button[type="submit"]', form);
  const reload = $('[data-preferences-reload]', form);
  const fields = new FormData(form);
  if (submit.disabled) return;
  submit.disabled = true;
  reload.hidden = true;
  status.textContent = '正在保存…';
  try {
    const preferences = await Api.saveAgentPreferences({
      version: state.agentPreferences.version,
      name: fields.get('name'),
      tone: fields.get('tone'),
      persona: fields.get('persona'),
      style: fields.get('style'),
      memory: fields.get('memory'),
    });
    if (S !== state) return;
    S.agentPreferences = preferences;
    status.textContent = '已保存';
    status.classList.remove('field-error');
  } catch (error) {
    if (S !== state) return;
    status.textContent = error.message || '保存失败，请重试';
    status.classList.add('field-error');
    reload.hidden = error.code !== 'PREFERENCES_CONFLICT';
  } finally {
    submit.disabled = false;
  }
}

async function reloadAgentPreferences(button) {
  const state = S;
  button.disabled = true;
  try {
    const prefs = await Api.readAgentPreferences();
    if (S !== state) return;
    S.agentPreferences = prefs;
    const panel = $('#agent-settings');
    if (panel) panel.innerHTML = agentPreferencesHTML();
  } catch (error) {
    if (S === state) toast(error.message || '重新加载失败', true);
  } finally {
    button.disabled = false;
  }
}

function openAgentPreferences() {
  if (U.drawer) closeDrawer();
  go('settings?section=agent');
}

AFTER.settings = () => {
  if (new URLSearchParams(location.hash.split('?')[1] || '').get('section') !== 'agent') return;
  const panel = $('#agent-settings');
  requestAnimationFrame(() => {
    if (U.route === 'settings' && panel?.isConnected) {
      panel.scrollIntoView({ block: 'start' });
      panel.focus({ preventScroll: true });
    }
  });
};

PAGES.settings = () => `<div class="grid g2" style="align-items:start">
  <div class="col" style="gap:16px">
    <div class="card"><div class="card-h"><h3>[[user]] 个人偏好</h3></div><div class="form-grid">
      <label class="f">昵称<input class="input" value="${esc(S.user.name)}" onchange="updateProfile({name:this.value})"></label>
      <label class="f">做饭时间上限（分钟）<input class="input" type="number" value="${S.user.maxCook}" onchange="updateProfile({max_cook_minutes:+this.value})"></label>
      <label class="f">时区<input class="input" value="${S.user.tz}" disabled></label><label class="f">用餐人数<input class="input" type="number" value="${S.user.people}" onchange="updateProfile({people:+this.value})"></label></div>
      <div class="section-title">厨房设备</div><div class="chips">${['灶台', '电饭煲', '微波炉', '烤箱', '空气炸锅'].map(e => `<button class="chip ${S.user.equipment.includes(e) ? 'on' : ''}" onclick="toggleEq('${e}')">${e}</button>`).join('')}</div></div>
    <div class="card"><div class="card-h"><h3>[[shield]] 饮食限制</h3><span class="sp small muted">AI 无权修改</span></div>
      <div>${S.restrictions.map(r => `<span class="restr badge ${r.kind === 'allergy' ? 'r' : r.kind === 'avoid' ? 'y' : 'b'}">${r.kind === 'allergy' ? '过敏' : r.kind === 'avoid' ? '忌口' : '偏好'} · ${esc(r.label)}${r.hard ? ' · 硬约束' : ''}<button onclick="delRestr('${r.id}')" aria-label="删除">[[x]]</button></span>`).join('')}</div>
      <div class="row" style="margin-top:8px">${segHTML('rk', [['allergy', '过敏'], ['avoid', '忌口'], ['pref', '偏好']], 'allergy')}<input class="input" id="rl2" placeholder="如：鸡肉、甲壳类、乳" style="flex:1;min-width:120px"><button class="btn sm pri" onclick="addRestr()">添加</button></div>
      <p class="small muted">过敏与忌口会在服务端对计划、推荐与 AI 提议做硬过滤；配料未知的商品不会被视为安全。</p></div>
    <section class="card agent-settings" id="agent-settings" aria-label="管家设置" tabindex="-1">${agentPreferencesHTML()}</section>
  </div>
  <div class="col" style="gap:16px">
    <div class="card"><div class="card-h"><h3>[[bot]] 主动任务授权</h3></div>
      ${POL.map(([k, n, d]) => `<div class="set-row"><div class="t"><b>${n}</b><span>${d}</span></div><div class="seg">${[['off', '关闭'], ['observe', '观察'], ['auto', '自动']].map(([m, l]) => `<button class="${S.policies[k] === m ? 'on' : ''}" onclick="setPolicy('${k}','${m}')">${l}</button>`).join('')}</div></div>`).join('')}
      <p class="small muted">关闭：不触发；观察：只记录“本应触发”的事件，不调用模型也不通知；自动：按授权执行低风险写入（生成报告/提醒），<b>永远不会自动修改计划或过敏限制</b>。</p>
      ${S.observeLog.length ? `<div class="section-title">观察日志</div>${S.observeLog.slice(0, 4).map(o => `<div class="small" style="padding:4px 0">${D.ago(o.at)} · ${esc(o.text)}</div>`).join('')}` : ''}
      <button class="btn sm" style="margin-top:8px" onclick="runExpiryScan()">[[play]] 立即运行一次临期扫描</button>
      <div class="section-title">Agent 模型</div>
      <div class="set-row"><div class="t"><b>当前 Agent</b><span id="agent-model-line">${agentModeLabel()}</span></div><button class="btn sm" onclick="testAgentConnection()">测试连接</button></div>
      <div id="agent-test-res" class="small muted"></div>
      <p class="small muted">只显示提供方与模型名，不显示、不回显任何 key。</p></div>
    <div class="card"><div class="card-h"><h3>[[lock]] 隐私与数据</h3></div>
      <div class="set-row"><div class="t"><b>导出我的全部数据</b><span>库存、流水、计划版本、记餐、习惯、报告、会话（JSON）</span></div><button class="btn sm" onclick="exportAll()">导出</button></div>
      <div class="set-row"><div class="t"><b>外部模型处理照片/语音</b><span>未授权时不会发送私有媒体给外部模型</span></div><span class="badge g">已授权</span></div>
      ${S.user.serverAdmin ? `<div class="section-title">备份与恢复</div>
      <div class="set-row"><div class="t"><b>备份数据库</b><span>下载整库的 .db 文件。</span></div><button class="btn sm" onclick="downloadBackupFile()">下载备份</button></div>
      <div class="set-row"><div class="t"><b>从备份恢复</b><span>恢复前系统会备份当前数据库，恢复后需要重新登录。</span></div><button class="btn sm" type="button" onclick="document.getElementById('restore-db').click()">选择 .db 文件</button><input id="restore-db" type="file" accept=".db" hidden onchange="onRestoreFile(this)"></div>` : ''}
      <div class="set-row"><div class="t"><b>重新从服务端同步</b><span>刷新食材、计划、记餐等全部数据</span></div><button class="btn sm" onclick="resync()">同步</button></div>
      <div class="set-row" style="border:0"><div class="t"><b style="color:var(--tomato)">删除账户</b><span>撤销访问、取消任务后删除全部数据</span></div><button class="btn sm warn" onclick="confirmDeleteAccount()">删除</button></div></div>
  </div>${versionLineHTML() ? `<div class="version-line">${versionLineHTML()}</div>` : ''}</div>`;
async function toggleEq(e) {
const eq = [...S.user.equipment];
const i = eq.indexOf(e);
if (i >= 0) eq.splice(i, 1); else eq.push(e);
await updateProfile({ equipment: eq});
}
async function addRestr() {
const label = $('#rl2').value.trim(); const kind = segValue(document, 'rk') || 'allergy';
if (!label) { toast('请输入内容', true); return;}
try {
await Api.createRestriction({ kind, label, keys: kind === 'pref'? []: label.split(/[、,，\s]+/).filter(Boolean), hard: kind!== 'pref'});
await refreshMe();
const bad = S.plan? Object.entries(P.meals()).filter(([, m]) =>!checkRecipe(R[m.r]).ok): [];
commit(bad.length? `已添加。[[alert]] 当前计划有 ${bad.length} 餐与新限制冲突，请在计划页替换`: '已添加限制',!!bad.length);
} catch (e) { toast('添加失败：' + (e.message || e), true);}
}
/* 删除限制：直接执行，3 秒内可在 toast 里撤销（不再弹模态框二次确认） */
async function delRestr(id) {
  const r = S.restrictions.find(x => x.id === id);
  if (!r) return;
  try {
    await Api.deleteRestriction(id);
    await refreshMe();
    render();
    toastUndo(`已删除「${esc(r.label)}」${r.kind === 'allergy' ? '（过敏限制）' : ''}`, '撤销', async () => {
      try {
        await Api.createRestriction({ kind: r.kind, label: r.label, keys: r.keys, hard: r.hard });
        await refreshMe(); render(); toast('已恢复限制');
      } catch (e) { toast('恢复失败：' + (e.message || e), true); }
    });
  } catch (e) { toast('删除失败：' + (e.message || e), true); }
}
async function setPolicy(k, m) {
const old = S.policies[k];
try {
await Api.updateAutomationPolicies({ [k]: m});
S.policies[k] = m;
const t = S.tasks.find(x => x.kind === k); if (t) t.status = m === 'auto'? 'scheduled': m;
commit(`授权已更新：${old} → ${m}${m === 'off' && old === 'auto'? '（未执行的任务已取消）': ''}`);
} catch (e) { toast('授权更新失败：' + (e.message || e), true);}
}
function runExpiryScan() {
const urg = urgentBatches().filter(b => expDays(b) >= 0);
const txt = urg.map(b => FOODS[b.foodId].name).slice(0, 4).join('、') + (urg.length > 4? ' 等': '');
const mode = S.policies.expiry;
if (mode === 'off') { toast('临期提醒已关闭，未执行'); return;}
if (mode === 'observe') { S.observeLog.unshift({ at: D.now(), task: 'expiry', text: `本应提醒：${txt} 即将到期（未发送通知）`}); commit('已记录观察事件（未发送通知）'); return;}
// auto：扫描由服务端定时任务执行（每天 08:00），这里只刷新通知列表
refreshNotifications().then(() => commit('服务端每天 08:00 自动扫描临期；已刷新通知'));
}
/* 一键备份：POST /privacy/backup，blob 下载；恢复：二次确认后上传，成功提示重启。 */
async function downloadBackupFile() {
  try {
    const { blob, filename } = await Api.downloadBackup();
    downloadBlob(filename, blob);
    toast('[[download]] 已下载备份：' + filename);
  } catch (e) { toast('备份失败：' + (e.message || e), true); }
}
function onRestoreFile(input) {
  const file = input.files && input.files[0];
  input.value = '';
  if (!file) return;
  modal({
    title: '[[alert]] 从备份恢复？',
    body: `<p>将用 <b>${esc(file.name)}</b> 覆盖当前全部数据。</p>
      <div class="warn-line">[[alert]] 系统会先备份当前数据库。恢复完成后，请重新登录。</div>
      <p class="small muted">恢复失败时原库不受影响。</p>`,
    buttons: [{ label: '取消' }, {
      label: '确认恢复', cls: 'warn', fn: async () => {
        try {
          const res = await Api.uploadRestore(file);
          toast(res.message || '已恢复，请重新登录');
          await hydrate();
          render();
        } catch (e) { toast('恢复失败：' + (e.message || e) + '（原库不受影响）', true); return false; }
      },
    }],
  });
}
/* Agent 模型测试连接：只显示“连接正常（模型名）”或“连接失败：原因”，不回显 key。 */
async function testAgentConnection() {
  const box = $('#agent-test-res');
  if (box) box.textContent = '正在测试连接…';
  try {
    const res = await Api.testAgentConnection();
    const ok = res && res.ok;
    const model = (res && res.model) || VERINFO?.agent_model || U.agentModel || 'deepseek-chat';
    if (box) box.textContent = ok ? '连接正常（' + model + '）' : '连接失败：' + ((res && res.error) || '未知错误');
    if (ok) toast('连接正常（' + model + '）');
  } catch (e) {
    if (box) box.textContent = '连接失败：' + (e.message || e);
  }
}
async function exportAll() {
try {
const res = await Api.privacyExport();
if (res && res.download_url) { window.open(res.download_url, '_blank'); toast('导出已开始下载');}
else if (res && res.content) { download('my-kitchen-data.json', typeof res.content === 'string'? res.content: JSON.stringify(res.content, null, 2), 'application/json'); toast('[[download]] 已导出 JSON');}
else toast('导出请求已提交，请留意通知');
} catch (e) { toast('导出失败：' + (e.message || e), true);}
}
function confirmDeleteAccount() {
modal({
title: '删除账户',
body: `<p>这会软删除你的账户并清理全部数据。请输入密码确认：</p><input class="input" id="dc-pw" type="password" autocomplete="current-password">`,
buttons: [{ label: '取消'}, {
label: '确认删除', cls: 'warn', fn: root => {
const pw = $('#dc-pw', root).value;
if (!pw) { toast('请输入密码', true); return false;}
(async () => {
try {
await Api.deleteAccount({ password: pw});
await Api.logout().catch(() => {});
AUTHED = false; S = null; BOOT.state = 'auth';
closeModal(); render(); toast('账户已删除');
} catch (e) { toast('删除失败：' + (e.message || e), true);}
})();
return false;
},
}],
});
}

function thread() {
  return S.threads.find(t => t.id === S.activeThread) || S.threads[0] ||
    (S.localChatThread ||= { id: 'th-local', title: '新的对话', at: D.now(), msgs: [] });
}

function openDrawer() { if (U.route === 'assistant') return; U.drawer = true; renderDrawer(); renderChrome(); }
function closeDrawer() { U.drawer = false; renderDrawer(); renderChrome(); }
let openingTaskChat = false;
async function askAI(text) {
  if (openingTaskChat || !S) return;
  openingTaskChat = true;
  const state = S;
  try {
    const t = await newThread();
    if (!t || S !== state) return;
    if (U.route !== 'assistant' && !U.drawer) openDrawer();
    send(text, { targetThread: t });
  } finally { openingTaskChat = false; }
}

/* ---------------- render ---------------- */
function chatComposerHTML() {
  const t = thread();
  const run = chatRun(t.id);
  const starting = AGENT_STARTING.has(t.id);
  const busy = run || starting || (t.history && t.history !== 'ready');
  return `<div class="composer">
    ${t.parentId ? `<div class="chat-branch"><span>旁支对话</span><button type="button" class="btn xs ghost" onclick="selectChatThread(thread().parentId)">返回原对话</button></div>` : ''}
    <div class="chat-entry">
      ${quoteMarkup(t.draftQuote, true)}
      ${ATTACH ? `<div class="attach-prev"><img src="${ATTACH.url}" alt="附件预览">已附加图片<button class="btn xs ghost" onclick="ATTACH=null;renderChat()" aria-label="移除附件">[[x]]</button></div>` : ''}
      <textarea class="input" id="ci" rows="2" aria-label="给 AI 管家发消息" placeholder="${REC ? '正在录音… 再点一次结束' : t.draftQuote ? '就引用的内容提问…' : '例如：冰箱里哪些食材快过期了？'}" oninput="thread().draftText=this.value" onkeydown="if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();sendInput()}"></textarea>
      <div class="comp-row">
        <label class="icon-btn" title="添加图片" aria-label="添加图片">[[camera]]<input type="file" accept="image/*" hidden onchange="attachImg(this)"></label>
        <button class="icon-btn ${REC ? 'rec' : ''}" title="语音输入" aria-label="语音输入" onclick="toggleRec()">${REC ? '[[stop]]' : '[[mic]]'}</button>
        ${VERINFO?.agent_thinking_available ? `<button id="chat-thinking" class="btn sm chat-thinking" type="button" aria-pressed="${U.agentThinking}" title="开启后允许模型用更多时间分析" onclick="toggleChatThinking()">[[sparkle]] 深度思考</button>` : ''}
        ${VERINFO?.agent_provider === 'llm' ? `<button id="chat-team" class="btn sm chat-toggle" type="button" aria-pressed="${U.agentTeam}" onclick="toggleChatTeam()">[[bot]] 团队协作</button>` : ''}
        <button type="button" class="btn sm ghost chat-suggest" aria-haspopup="true" aria-expanded="false" title="提问建议" aria-label="提问建议" onclick="openChatSuggestions(this)">[[sparkle]] <span>提问建议</span></button>
        ${run ? '<button class="btn warn chat-send" onclick="cancelRun()">[[stop]] 停止</button>' : `<button class="btn pri chat-send" onclick="sendInput()" ${busy ? 'disabled' : ''}>[[send]] ${starting ? '发送中' : '发送'}</button>`}
      </div>
    </div>
    <div class="chat-note" id="chat-note">${U.agentTeam ? '本轮由顾问分工给出建议。' : '修改菜单、库存等数据前，会请你确认。'}</div>
  </div>`;
}
function toggleChatThinking() {
  U.agentThinking = !U.agentThinking;
  $('#chat-thinking')?.setAttribute('aria-pressed', String(U.agentThinking));
  const composer = $('[data-chat-composer]');
  if (composer) composer.chatMarkup = chatComposerHTML();
}
function toggleChatTeam() {
  U.agentTeam = !U.agentTeam;
  $('#chat-team')?.setAttribute('aria-pressed', String(U.agentTeam));
  const note = $('#chat-note');
  if (note) note.textContent = U.agentTeam ? '本轮由顾问分工给出建议。' : '修改菜单、库存等数据前，会请你确认。';
  const composer = $('[data-chat-composer]');
  if (composer) composer.chatMarkup = chatComposerHTML();
}
function welcomeHTML() {
  return `<div class="chat-welcome"><span class="chat-welcome-mark">[[chef]]</span>
    <h2>今天想做点什么？</h2>
    <p>查一查冰箱里有什么，或用现有食材安排下一餐。</p>
  </div>`;
}
const toolLabels = {
  get_my_pantry: '查看库存', find_expiring_dinner: '匹配临期食材',
  search_recipes: '查找菜谱', create_plan_draft: '生成菜单草稿',
  get_trend_metrics: '汇总记录', search_food_knowledge: '查阅食物资料',
};
const replyMarkdown = window.markdownit?.({ html: false, breaks: true, linkify: false });
if (replyMarkdown) {
  const validateLink = replyMarkdown.validateLink;
  replyMarkdown.validateLink = href => /^https?:\/\//i.test(href) && validateLink(href);
  replyMarkdown.renderer.rules.image = (tokens, index) => {
    const alt = tokens[index].content;
    return replyMarkdown.utils.escapeHtml(alt || '图片');
  };
  replyMarkdown.renderer.rules.link_open = (tokens, index, opts, env, renderer) => {
    tokens[index].attrSet('target', '_blank');
    tokens[index].attrSet('rel', 'noopener noreferrer');
    return renderer.renderToken(tokens, index, opts);
  };
}
function renderReply(node, text) {
  if (!replyMarkdown) { node.textContent = text; return; }
  const range = document.createRange();
  range.selectNodeContents(node);
  node.replaceChildren(range.createContextualFragment(replyMarkdown.render(text)));
}
async function copyReply(id, button) {
  const message = thread().msgs.find(entry => entry.id === id);
  if (!message?.text) return;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(message.text);
    } else {
      const field = document.createElement('textarea');
      field.value = message.text;
      field.readOnly = true;
      field.className = 'chat-copy-buffer';
      button.parentNode.appendChild(field);
      try {
        field.focus({ preventScroll: true });
        field.select();
        if (!document.execCommand('copy')) throw new Error('copy failed');
      } finally {
        field.remove();
        button.focus({ preventScroll: true });
      }
    }
    toast('已复制回复');
  } catch {
    toast('复制失败，可选中文字后复制', true);
  }
}
function msgHTML(m) {
  if (m.role === 'user') return `<div class="msg user" data-message-id="${esc(m.id)}"><div class="chat-user-stack">
    ${quoteMarkup(m.quote)}<div class="bub" data-chat-text>${m.img ? `<img src="${m.img}" alt="用户上传图片">` : ''}${m.voice ? '[[mic]] ' : ''}${esc(m.text)}</div>
    ${chatMessageActions(m)}</div></div>`;
  if (m.role === 'sys') return `<div class="sys-line">${esc(m.text)}</div>`;
  const open = m.traceOpen ?? false;
  const toolRunning = m.trace?.some(step => step.st === 'run');
  const teamRun = m.trace?.some(step => step.tool?.startsWith('team.'));
  const traceLabel = teamRun ? (toolRunning ? '团队协作中' : '团队分工') : (toolRunning ? '正在查询' : '工具记录');
  return `<div class="msg ai" data-message-id="${esc(m.id)}"><div class="av" aria-hidden="true">[[chef]]</div><div class="stack">
    ${m.trace?.length ? `<div class="trace"><button class="trace-h" aria-expanded="${open}" onclick="toggleTrace('${m.id}')">${open ? '▾' : '▸'} ${traceLabel} · ${m.trace.length} 步</button>
      ${open ? m.trace.map(p => `<span class="pill ${p.st}"><span class="st"></span>${esc(toolLabels[p.tool] || p.label)}</span>`).join('') : ''}</div>` : ''}
    ${m.text || m.streaming ? `<div class="chat-answer"><div class="reply-markdown" data-reply-id="${m.id}"></div>${m.streaming && !m.text ? '<span class="chat-wait">正在组织回复…</span>' : ''}</div>` : ''}
    ${chatReferencesHTML(m)}
    ${chatMessageActions(m)}
    ${(m.cards || []).map(cardHTML).join('')}
    ${m.cites ? `<div class="cites">${m.cites.map(c => `<span class="cite" title="${esc(c.v)}">[[clip]] ${esc(c.t)}</span>`).join('')}</div>` : ''}
    ${m.interrupted ? '<div class="sys-line">[[alert]] 页面刷新时该运行尚未结束；已从事件记录恢复到最后状态。</div>' : ''}
    ${m.cancelled ? '<div class="sys-line">■ 已取消（未提交任何写入）</div>' : ''}
  </div></div>`;
}
function toggleTrace(id) { const m = thread().msgs.find(x => x.id === id); m.traceOpen = !m.traceOpen; renderChat(); }
function chatHost() {
  return U.route === 'assistant' ? $('#asst-chat') : (U.drawer ? $('#drawer-chat') : null);
}
function nearChatEnd(messages) {
  return messages.scrollHeight - messages.scrollTop - messages.clientHeight < 48;
}
function renderChatDelta(m) {
  const host = chatHost();
  if (!host) return;
  const messages = $('#msgs', host);
  const reply = messages && messages.querySelector(`[data-reply-id="${CSS.escape(m.id)}"]`);
  if (!reply) return;
  const follow = nearChatEnd(messages);
  const text = splitReplyReferences(m.text).body;
  if (reply.renderedText !== text) {
    renderReply(reply, text);
    reply.renderedText = text;
  }
  if (m.text) reply.nextElementSibling?.remove();
  if (follow) messages.scrollTop = messages.scrollHeight;
}
let pendingChatFrame = 0;
let pendingChatMessage = null;
function scheduleChatDelta(message) {
  pendingChatMessage = message;
  if (pendingChatFrame) return;
  pendingChatFrame = requestAnimationFrame(() => {
    pendingChatFrame = 0;
    renderChatDelta(pendingChatMessage);
  });
}
function renderChat() {
  const host = chatHost();
  if (!host) return;
  if (!$('#msgs', host)) {
    host.innerHTML = '<div class="chat"><div class="msgs" id="msgs" aria-live="polite"></div><div data-chat-composer></div></div>';
    $('[data-chat-composer]', host).style.display = 'contents';
  }
  const t = thread();
  if (t.id !== 'th-local') syncChatLocation(t.id);
  if (t.history === 'idle') { loadThreadHistory(t); return; }
  const messages = $('#msgs', host);
  const sameThread = messages.dataset.thread === t.id;
  const follow = !sameThread || nearChatEnd(messages);
  const previousTop = messages.scrollTop;
  messages.dataset.thread = t.id;
  const list = t.history === 'loading' ? '<p class="chat-welcome" role="status">正在加载对话记录…</p>' :
    t.history === 'failed' ? '<div class="chat-welcome"><p>对话记录加载失败。</p><button class="btn sm" onclick="retryThreadHistory()">重新加载</button></div>' :
    t.msgs.length ? t.msgs.map(msgHTML).join('') : welcomeHTML();
  if (!sameThread || messages.chatMarkup !== list) {
    const expanded = sameThread ? new Set([...messages.querySelectorAll('[data-references][open]')].map(node => node.dataset.references)) : new Set();
    messages.innerHTML = list;
    messages.chatMarkup = list;
    messages.querySelectorAll('[data-references]').forEach(node => { node.open = expanded.has(node.dataset.references); });
    if (activeChatPopover && !activeChatPopover.anchor.isConnected) closeChatPopover();
  }
  const replies = new Map(t.msgs.filter(m => m.role === 'ai').map(m => [m.id, splitReplyReferences(m.text || '').body]));
  messages.querySelectorAll('[data-reply-id]').forEach(node => {
    const text = replies.get(node.dataset.replyId) || '';
    if (node.renderedText !== text) {
      renderReply(node, text);
      node.renderedText = text;
    }
  });
  const composer = $('[data-chat-composer]', host);
  const markup = chatComposerHTML();
  if (composer.chatThread !== t.id || composer.chatMarkup !== markup) {
    const ci = $('#ci', composer);
    const hasFocus = ci && document.activeElement === ci;
    const focusedControl = ['chat-thinking', 'chat-team'].find(id => document.activeElement === document.getElementById(id));
    composer.innerHTML = markup;
    composer.chatMarkup = markup;
    composer.chatThread = t.id;
    const next = $('#ci', composer);
    next.value = t.draftText || '';
    if (hasFocus && sameThread) {
      next.focus({ preventScroll: true });
      next.setSelectionRange(ci.selectionStart, ci.selectionEnd);
    }
    if (focusedControl) document.getElementById(focusedControl)?.focus({ preventScroll: true });
  }
  messages.scrollTop = follow ? messages.scrollHeight : previousTop;
  if (U.route === 'assistant') renderThreadSidebar();
  tickExpiry();
}
function renderDrawer() {
  const root = $('#drawer-root');
  if (!U.drawer) { root.innerHTML = ''; return; }
  root.innerHTML = `<div class="drawer" role="dialog" aria-label="AI 管家"><div class="drawer-h"><div class="av">[[chef]]</div><div>${personaButton()}<div class="ctx-chip">${U.agentMode === 'rule' ? '规则模式（未配置模型）' : U.agentMode === 'llm' ? '模型（' + (U.agentModel || 'deepseek-chat') + '）' : 'Agent 运行时'}</div></div>
    <div class="sp row" style="gap:4px"><button class="btn xs ghost" onclick="newThread()" title="新对话">＋ 新对话</button><button class="btn xs ghost" onclick="openAgentPreferences()" aria-label="管家设置">[[gear]]</button><button class="btn xs ghost" onclick="go('assistant')" title="全屏" aria-label="全屏">⤢</button><button class="icon-btn" onclick="closeDrawer()" aria-label="关闭">[[x]]</button></div></div>
    <div id="drawer-chat" style="display:flex;flex-direction:column;flex:1;min-height:0"></div></div>`;
  renderChat();
}
function renderThreadSidebar() {
  const list = $('#threads');
  if (!list) return;
  const markup = threadsHTML();
  if (list.threadMarkup !== markup) {
    list.innerHTML = markup;
    list.threadMarkup = markup;
  }
}
function threadsHTML() {
  return `<button class="btn sm pri" onclick="newThread()" style="margin-bottom:8px">＋ 新对话</button>` + S.threads.map(t => `<button class="thread ${t.id === S.activeThread ? 'on' : ''}" onclick="selectChatThread('${t.id}')">${esc(t.title)}<span>${t.history === 'ready' ? t.msgs.length : t.messageCount} 条 · ${D.ago(t.at)}</span></button>`).join('');
}
PAGES.assistant = () => `<div class="asst">
  <div class="threads" id="threads">${threadsHTML()}</div>
  <div class="assistant-pane">
    <div class="assistant-head"><span>[[chef]] ${personaButton()}</span><div class="row"><small>${esc(agentModeLabel())}</small><button class="btn xs ghost" onclick="openAgentPreferences()">[[gear]] 管家设置</button></div></div>
    <div id="asst-chat"></div>
  </div>
</div>`;

/* ---------------- input ---------------- */
function attachImg(inp) { const f = inp.files[0]; if (!f) return; const rd = new FileReader(); rd.onload = () => { ATTACH = { url: rd.result }; renderChat(); }; rd.readAsDataURL(f); }
/* 语音识别（浏览器端 Web Speech API，不走后端）：Chrome 可用；不支持时明确提示。
   只做转写填入，不自动发送、不编造文字。 */
function startSpeechRecognition(onResult, onEnd) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { toast('当前浏览器不支持语音识别，请用 Chrome', true); return null; }
  const rec = new SR();
  rec.lang = 'zh-CN';
  rec.interimResults = false;
  rec.maxAlternatives = 1;
  rec.onresult = e => {
    const t = Array.from(e.results).map(r => (r[0] && r[0].transcript) || '').join('').trim();
    if (t) onResult(t);
  };
  rec.onerror = e => {
    if (e && e.error === 'not-allowed') toast('语音识别被拒绝：请允许浏览器使用麦克风', true);
    else if (e && e.error === 'no-speech') toast('没有听到声音，请再试一次', true);
    else toast('语音识别失败，请再试一次', true);
  };
  rec.onend = () => { if (onEnd) onEnd(); };
  try { rec.start(); } catch (err) { toast('语音识别启动失败，请再试一次', true); return null; }
  return rec;
}
function toggleRec() {
  if (REC) { try { REC.rec.stop(); } catch (e) { /* ignore */ } return; }
  const rec = startSpeechRecognition(
    txt => { const ci = $('#ci'); if (ci) { ci.value = (ci.value ? ci.value + ' ' : '') + txt; thread().draftText = ci.value; ci.focus({ preventScroll: true }); } },
    () => { REC = null; renderChat(); }
  );
  if (!rec) return;
  REC = { rec };
  toast('[[mic]] 正在聆听… 再点一次结束（识别结果填入输入框，由你确认再发送）');
  renderChat();
}
/* AI 气泡朗读：speechSynthesis 中文朗读当前气泡文字，再点停止；与烹饪朗读 speak() 状态分开。 */
function speakMsg(id) {
  const m = thread().msgs.find(x => x.id === id);
  if (!m || !m.text) return;
  if (!('speechSynthesis' in window)) { toast('当前浏览器不支持朗读', true); return; }
  if (SPEAKING_MSG === id) { speechSynthesis.cancel(); SPEAKING_MSG = null; renderChat(); return; }
  speechSynthesis.cancel();
  SPEAKING_MSG = id;
  const u = new SpeechSynthesisUtterance(plainText(m.text));
  u.lang = 'zh-CN';
  u.onend = () => { if (SPEAKING_MSG === id) { SPEAKING_MSG = null; renderChat(); } };
  u.onerror = () => { if (SPEAKING_MSG === id) { SPEAKING_MSG = null; renderChat(); } };
  speechSynthesis.speak(u);
  renderChat();
}
/* 记餐语音快速记：把“番茄 2个、鸡蛋 3个”解析进记餐表单，由用户确认份量后保存。 */
function parseMealSpeech(text) {
  const items = [];
  String(text).split(/[、，,；;和]+/).filter(Boolean).forEach(seg => {
    const m = seg.trim().match(/^([^\d]+?)(\d+(?:\.\d+)?)?\s*(个|克|g|ml|毫升)?$/);
    if (!m) return;
    const name = m[1].trim();
    const fid = Object.keys(FOODS).find(k => FOODS[k].name === name) || Object.keys(FOODS).find(k => (FOODS[k].tags || []).includes(name));
    if (!fid) return;
    const qty = m[2] ? parseFloat(m[2]) : null;
    items.push({ foodId: fid, amount: qty ?? (FOODS[fid].unit === 'piece' ? 1 : 100) });
  });
  return items;
}
function voiceQuickMeal() {
  toast('[[mic]] 请说出食材，例如：番茄 2 个、鸡蛋 3 个');
  const rec = startSpeechRecognition(txt => {
    const items = parseMealSpeech(txt);
    if (!items.length) { toast('没听清食材（只认得出食物库里的名字），请再试一次', true); return; }
    openAddMeal(undefined, undefined, items, 'manual');
    toast('已按语音填入 ' + items.length + ' 项，请确认份量后保存');
  });
  if (!rec) return;
}
function sendInput() {
  const t = thread();
  if (chatRun(t.id) || AGENT_STARTING.has(t.id) || (t.history && t.history !== 'ready')) return;
  const input = $('#ci');
  const text = input.value.trim();
  if (!text && !ATTACH) return;
  input.value = '';
  t.draftText = '';
  send(text || '帮我看看这张图里有什么');
}
/* send() 由 agent.js 提供（真实 SSE，见 agent.js）。 */

/* ---------------- runtime ---------------- */
/* Agent 运行时见 agent.js（真实 SSE + 服务端审批）。 */

/* ---------------- actions & approvals ---------------- */
function cardHTML(c) {
  if (c.type === 'approval') return approvalHTML(S.actions[c.id]);
  if (c.type === 'pantry') return `<div class="scard"><div class="scard-h">[[fridge]] 库存快照<span class="type">get_pantry · read-only</span></div><table class="t">${c.ids.map(id => { const b = S.batches.find(x => x.id === id); if (!b) return ''; const f = FOODS[b.foodId]; return `<tr><td>${f.em} ${f.name}</td><td class="mono">${fmtQty(b.remaining, b.unit)}</td><td>${badgeExp(b)}</td></tr>`; }).join('')}</table><button class="btn xs" style="margin-top:8px" onclick="go('pantry')">打开冰箱 →</button></div>`;
  if (c.type === 'recipe') { const r = R[c.id]; const n = recipeNutrition(r, 1); return `<div class="scard" style="display:flex;gap:12px;align-items:center"><span class="recipe-tint" style="--recipe-swatch:${r.bg};font-size:36px;border-radius:12px;width:56px;height:56px;display:grid;place-items:center;flex:none">${r.em}</span><div style="flex:1;min-width:0"><b>${r.t}</b><div class="small muted">[[timer]]${r.min}分 · 库存 ${r0(stockMatch(r) * 100)}% · ${r0(n.v[0])}kcal/份${n.complete ? '' : '（部分已知）'}</div>${c.use ? `<div class="small" style="color:var(--green)">用掉：${c.use.join('、')}</div>` : ''}</div><button class="btn xs" onclick="openRecipe('${r.id}')">详情</button></div>`; }
  if (c.type === 'nutrition') return `<div class="scard"><div class="scard-h">[[leaf]] 今日营养<span class="type">NutritionCard</span></div>${nutriCard({ v: c.v, complete: !c.partial, unknown: c.unknown, basis: c.partial ? 'partial' : 'standardized_portion' })}</div>`;
  if (c.type === 'plandraft') {
    return `<div class="scard"><div class="scard-h">[[calendar]] 菜单草稿<span class="type">PlanDraftCard · ${c.id}</span></div>
      <div class="mini-grid" style="grid-template-columns:40px repeat(${c.dates.length},1fr)"><span></span>${c.dates.map(d => `<span class="h">${D.wd(d)}</span>`).join('')}
      ${['breakfast', 'lunch', 'dinner'].map(s => `<span class="h">${SLOTS[s].slice(0, 1)}</span>` + c.dates.map(d => { const m = c.meals[d + '|' + s]; return `<span class="c" title="${R[m.r].t}">${R[m.r].em} ${R[m.r].t}</span>`; }).join('')).join('')}</div>
      <div class="row small" style="margin-top:8px"><span class="badge g">硬约束 0 冲突</span><span class="badge">采购差额 ${c.gapN} 项</span><span class="badge y">价格覆盖：不足</span><span class="badge y">营养：部分已知</span></div></div>`;
  }
  if (c.type === 'action-links') return `<div class="row">${c.links.map(([l, f]) => `<button class="btn sm" onclick="${f.replace(/"/g, '&quot;')}">${l}</button>`).join('')}</div>`;
  return '';
}
function approvalHTML(a) {
  if (!a) return '';
  const st = a.status;
  const isMenu = a.type === 'commit_plan' || a.type === 'replace_meal';
  const labels = { commit_plan: '菜单草稿', replace_meal: '餐次调整', propose_shopping: '采购建议', commit_meal_record: '饮食记录' };
  const status = { waiting_approval: '待你确认', committed: '已生效', rejected: '已拒绝', expired: '已过期',
    conflict: '计划有更新', failed: '提交失败', approved: '正在批准', committing: '正在保存' }[st];
  if (st === 'superseded') return `<div class="chat-old-proposal">[[file]] 已有新版修改单
    <button class="btn xs ghost" type="button" onclick="openMenuReview('${a.id}')">查看旧稿</button></div>`;
  let preview = '';
  if (a.type === 'replace_meal') {
    preview = `<div class="ap-diff">
      <div class="box old"><span class="em">${R[a.from]?.em || '—'}</span>${esc(R[a.from]?.t || a.oldTitle || '未安排')}</div>
      <span aria-hidden="true">→</span>
      <div class="box"><span class="em">${R[a.to]?.em || ''}</span><b>${esc(R[a.to]?.t || a.newTitle || '菜谱已不可用')}</b>
        <small>${a.servings ? esc(a.servings) + ' 份' : ''}</small></div></div>`;
  } else if (a.type === 'commit_plan') {
    const rows = menuRows(a);
    const firstDay = rows[0]?.local_date;
    const sample = rows.filter(row => row.local_date === firstDay);
    preview = `<div class="chat-approval-preview">${sample.map(row =>
      `<div><span>${D.md(row.local_date)} ${SLOTS[row.slot]}</span><b>${esc(R[row.to]?.t || row.title || '菜谱已不可用')}</b><small>${row.servings ? esc(row.servings) + ' 份' : ''}</small></div>`).join('')}</div>`;
  } else if (a.items?.length) {
    preview = `<div class="chat-approval-preview">${a.items.map(item =>
      `<div><b>${esc(item.name || FOODS[item.food_id]?.name || '食材')}</b><small>${item.qty == null ? '待盘点' : esc(fmtQty(item.qty, item.unit))}</small></div>`).join('')}</div>`;
  }
  const route = a.type === 'propose_shopping' ? 'shopping' : isMenu ? 'plan' : 'meals';
  const left = Math.max(0, new Date(a.expiresAt) - Date.now());
  return `<div class="approval chat-approval" id="ap-${a.id}">
    <div class="ap-h">[[file]] ${labels[a.type] || '修改单'}<span class="chat-approval-status" data-status="${esc(st)}">${status || '待处理'}</span></div>
    ${a.summary ? `<p class="small chat-approval-summary">${esc(a.summary)}</p>` : ''}${preview}
    ${st === 'conflict' ? '<p class="danger-line">生效菜单已有更新，请重新发起。</p>' : ''}
    ${st === 'failed' ? `<p class="danger-line">${esc(a.error || '提交失败')}</p>` : ''}
    <div class="ap-foot">
      ${isMenu ? `<button class="btn xs ghost" type="button" onclick="openMenuReview('${a.id}')">[[book]] ${a.type === 'commit_plan' ? '查看完整菜单' : '查看详情'}</button>` : ''}
      ${st === 'waiting_approval' ? `<button class="btn xs ghost" type="button" onclick="decide('${a.id}','reject')">拒绝</button>${isMenu ? `<button class="btn sm" type="button" onclick="openMenuReview('${a.id}',true)">提出修改</button>` : ''}<button class="btn sm pri" type="button" onclick="decide('${a.id}','approve')">[[check]] 批准</button><span class="exp" data-exp="${a.id}">${approvalExpiry(left)}</span>` : ''}
      ${st === 'committed' ? `<button class="btn xs sp" type="button" onclick="go('${route}')">查看已保存的数据 →</button>` : ''}
    </div></div>`;
}

function approvalExpiry(left) {
  const minutes = Math.max(1, Math.ceil(left / 60000));
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours} 小时 ${minutes % 60} 分后过期` : `${minutes} 分后过期`;
}

let _expT = null;
function tickExpiry() {
  clearTimeout(_expT);
  const els = $$('[data-exp]'); if (!els.length) return;
  _expT = setTimeout(() => {
    let changed = false;
    $$('[data-exp]').forEach(el => {
      const a = S.actions[el.dataset.exp]; if (!a) return; const left = new Date(a.expiresAt) - Date.now();
      if (left <= 0 && a.status === 'waiting_approval') { a.status = 'expired'; changed = true; }
      else el.textContent = approvalExpiry(left);
    });
    if (changed) { renderChat(); renderChrome(); } else tickExpiry();
  }, 1000);
}

function openDatePicker(input) {
  if (!input.matches('input[type="date"]:enabled:not([readonly])') || typeof input.showPicker !== 'function') return false;
  try {
    input.showPicker();
    return true;
  } catch {
    return false;
  }
}

/* ---------------- boot ---------------- */
(function boot() {
  try { const t = localStorage.getItem('aichef_theme'); if (t) document.documentElement.dataset.theme = t; else if (matchMedia('(prefers-color-scheme: dark)').matches) document.documentElement.dataset.theme = 'dark'; } catch (e) { }
  window.addEventListener('api:unauthorized', () => {
    if (!AUTHED) return; // 启动时未登录属于正常情况，不弹提示
    AUTHED = false; S = null; BOOT.state = 'auth';
    toast('登录已过期，请重新登录', true);
    render();
  });
  window.addEventListener('unhandledrejection', e => {
    if (e.reason && e.reason.message) toast(e.reason.message, true);
  });
  if (!location.hash) history.replaceState(null, '', '#/home');
  document.addEventListener('click', e => {
    if (e.target instanceof HTMLInputElement && openDatePicker(e.target)) e.preventDefault();
  });
  document.addEventListener('keydown', e => {
    if ((e.key === 'Enter' || e.key === ' ') && !e.repeat && !e.isComposing &&
        e.target instanceof HTMLInputElement && openDatePicker(e.target)) e.preventDefault();
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !e.defaultPrevented && !$('#chat-panel[open]')) { if ($('#cook')) exitCooking(); else if ($('#modal-root').innerHTML) closeModal(); else if (U.sheet) { U.sheet = null; renderSheet(); } else if (U.drawer) closeDrawer(); } });
  (async () => {
    await Api.getCsrf().catch(() => {});
    await loadVersion().catch(() => {});
    await hydrate();
    if (AUTHED) await refreshExpiring().catch(() => {});
    render();
    _lastRoute = U.route;
  })();
})();
