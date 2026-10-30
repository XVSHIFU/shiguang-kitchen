'use strict';
/* =========================================================
 * api.js — 与后端对话的唯一模块
 * 契约：~/workspace/ai-life-agent/API_CONTRACT.md
 *   Base /api/v1；信封 {data, error, request_id}；
 *   HttpOnly session cookie + X-CSRF-Token；
 *   Decimal（金额/重量）用字符串传输，本模块不做数值转换。
 * 约定：
 *   - 所有 fetch 都经过这里；其它文件禁止直接 fetch。
 *   - 改变状态的请求自动带 CSRF（先 GET /auth/csrf 取 token，放内存，不持久化）。
 *   - 改变状态的 POST 默认带 Idempotency-Key（crypto.randomUUID）。
 *   - 401 会派发 api:unauthorized 事件，由 data.js 接管跳登录页；
 *     登录/注册本身不派发（dispatch401: false）。
 *   - 409 / 422 以 ApiError(code, message, details) 抛出，调用方按码处理。
 * ========================================================= */

class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message || code || '请求失败');
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details || {};
  }
}

const API_BASE = '/api/v1';
let csrfToken = null; // 只放内存；刷新页面后重新 GET /auth/csrf

// csrf_token cookie 是 httponly=False，后端双重提交校验以它为准。
// 登录会换发一个新的 csrf cookie，若只认内存里旧值就会 403，
// 所以每次都先读 cookie，只有 cookie 缺失时才去 /auth/csrf 取。
function readCookie(name) {
  const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : null;
}

async function getCsrf() {
  const fromCookie = readCookie('csrf_token');
  if (fromCookie) { csrfToken = fromCookie; return csrfToken; }
  if (csrfToken) return csrfToken;
  try {
    const r = await fetch(API_BASE + '/auth/csrf', { credentials: 'include' });
    if (r.ok) {
      const j = await r.json().catch(() => null);
      csrfToken = (j && j.data && j.data.csrf_token) || (j && j.csrf_token) || null;
    }
  } catch (e) { /* 未登录或后端未就绪时取不到 token 是正常的 */ }
  return csrfToken;
}

async function request(path, opts = {}, _retried) {
  const { method = 'GET', body, csrf = true, idempotency = false, dispatch401 = true } = opts;
  const headers = { 'Content-Type': 'application/json' };
  if (method !== 'GET') {
    if (csrf) {
      await getCsrf();
      if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
    }
    if (idempotency && window.crypto && crypto.randomUUID) {
      headers['Idempotency-Key'] = crypto.randomUUID();
    }
  }
  let res;
  try {
    res = await fetch(API_BASE + path, {
      method,
      headers,
      credentials: 'include',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    throw new ApiError(0, 'NETWORK_ERROR', '网络不可达：请确认后端正在运行（' + (e.message || e) + '）');
  }
  const text = await res.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch (e) { /* 非 JSON 响应按原文处理 */ }
  const err = payload && payload.error;
  if (!res.ok || err) {
    const code = (err && err.code) || ('HTTP_' + res.status);
    // CSRF token 过期/换发导致 403 时清掉缓存、按最新 cookie 重试一次。
    if (res.status === 403 && code === 'CSRF_FAILED' && !_retried && method !== 'GET') {
      csrfToken = null;
      return request(path, opts, true);
    }
    const message = (err && err.message) || ('请求失败（HTTP ' + res.status + '）');
    if (res.status === 401 && dispatch401) {
      window.dispatchEvent(new CustomEvent('api:unauthorized'));
    }
    throw new ApiError(res.status, code, message, err && err.details);
  }
  return payload && payload.data !== undefined ? payload.data : payload;
}

/* multipart 通道：文件上传（识别 / 导入 / 恢复）。
   不设 Content-Type（浏览器自动带 boundary），其余与 request() 一致：
   CSRF、401 派发、409/422 按 ApiError 抛出。 */
async function requestForm(path, formData, opts = {}, _retried) {
  const { dispatch401 = true } = opts;
  await getCsrf();
  const headers = {};
  if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
  let res;
  try {
    res = await fetch(API_BASE + path, { method: 'POST', headers, credentials: 'include', body: formData });
  } catch (e) {
    throw new ApiError(0, 'NETWORK_ERROR', '网络不可达：请确认后端正在运行（' + (e.message || e) + '）');
  }
  const text = await res.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch (e) { /* 非 JSON 响应按原文处理 */ }
  const err = payload && payload.error;
  if (!res.ok || err) {
    const code = (err && err.code) || ('HTTP_' + res.status);
    if (res.status === 403 && code === 'CSRF_FAILED' && !_retried) {
      csrfToken = null;
      return requestForm(path, formData, opts, true);
    }
    const message = (err && err.message) || ('请求失败（HTTP ' + res.status + '）');
    if (res.status === 401 && dispatch401) {
      window.dispatchEvent(new CustomEvent('api:unauthorized'));
    }
    throw new ApiError(res.status, code, message, err && err.details);
  }
  return payload && payload.data !== undefined ? payload.data : payload;
}

/* 备份下载通道：POST /privacy/backup 返回 .db 二进制（非 JSON 信封），
   单独走 blob 通道，解析 Content-Disposition 里的文件名。 */
async function requestBackupBlob(path) {
  await getCsrf();
  const headers = {};
  if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
  let res;
  try {
    res = await fetch(API_BASE + path, { method: 'POST', headers, credentials: 'include' });
  } catch (e) {
    throw new ApiError(0, 'NETWORK_ERROR', '网络不可达：请确认后端正在运行（' + (e.message || e) + '）');
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let code = 'HTTP_' + res.status, message = text || ('请求失败（HTTP ' + res.status + '）');
    try { const j = JSON.parse(text); if (j.error) { code = j.error.code; message = j.error.message; } } catch (e) { /* 纯文本错误 */ }
    if (res.status === 401) window.dispatchEvent(new CustomEvent('api:unauthorized'));
    throw new ApiError(res.status, code, message);
  }
  const blob = await res.blob();
  const cd = res.headers.get('Content-Disposition') || '';
  const m = cd.match(/filename\*?=(?:UTF-8''|")?([^";\n]+)/i);
  const filename = m ? decodeURIComponent(m[1].replace(/"$/, '')) : 'ai-life-agent-backup.db';
  return { blob, filename };
}

const q = (params) => {
  const s = new URLSearchParams();
  Object.entries(params || {}).forEach(([k, v]) => {
    if (v === undefined || v === null || v === '') return;
    s.set(k, String(v));
  });
  const str = s.toString();
  return str ? '?' + str : '';
};

const Api = {
  /* ---- auth / 用户 ---- */
  getCsrf,
  register: (body) => request('/auth/register', { method: 'POST', body, csrf: true, dispatch401: false }),
  login: (body) => request('/auth/login', { method: 'POST', body, csrf: true, dispatch401: false }),
  logout: () => request('/auth/logout', { method: 'POST', body: {}, idempotency: true }),
  me: () => request('/auth/me'),
  updateProfile: (body) => request('/users/me', { method: 'PATCH', body, idempotency: true }),
  listRestrictions: () => request('/users/me/restrictions'),
  createRestriction: (body) => request('/users/me/restrictions', { method: 'POST', body, idempotency: true }),
  updateRestriction: (id, body) => request('/users/me/restrictions/' + encodeURIComponent(id), { method: 'PATCH', body, idempotency: true }),
  deleteRestriction: (id) => request('/users/me/restrictions/' + encodeURIComponent(id), { method: 'DELETE' }),

  /* ---- 食物 / 菜谱 ---- */
  listFoods: () => request('/foods'),
  getFood: (id) => request('/foods/' + encodeURIComponent(id)),
  listRecipes: (params) => request('/recipes' + q(params)),
  getRecipe: (id) => request('/recipes/' + encodeURIComponent(id)),
  setFavorite: (id, on) => on
    ? request('/recipes/' + encodeURIComponent(id) + '/favorite', { method: 'POST', body: {}, idempotency: true })
    : request('/recipes/' + encodeURIComponent(id) + '/favorite', { method: 'DELETE' }),

  /* ---- 版本 / 备份恢复 / 识别 / 导入 / 临期 / Agent 测试 ---- */
  getVersion: () => request('/version', { dispatch401: false }),
  downloadBackup: () => requestBackupBlob('/privacy/backup'),
  uploadRestore: (file) => {
    const fd = new FormData();
    fd.append('file', file);
    return requestForm('/privacy/restore', fd);
  },
  importHabits: (file) => {
    const fd = new FormData();
    fd.append('file', file);
    return requestForm('/habits/import', fd);
  },
  listExpiring: (days) => request('/pantry/expiring' + q({ days: days ?? 3 })),
  recognizeImage: (file, target) => {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('target', target || 'pantry');
    return requestForm('/recognition/image', fd);
  },
  testAgentConnection: () => request('/agent/test-connection', { method: 'POST', body: {}, idempotency: true }),

  /* ---- 冰箱 / 库存 ---- */
  listBatches: () => request('/pantry/batches'),
  createBatch: (body) => request('/pantry/batches', { method: 'POST', body, idempotency: true }),
  getBatch: (id) => request('/pantry/batches/' + encodeURIComponent(id)),
  listMovements: () => request('/pantry/movements'),
  consume: (body) => request('/pantry/consumptions', { method: 'POST', body, idempotency: true }),
  adjustBatch: (body) => request('/pantry/adjustments', { method: 'POST', body, idempotency: true }),

  /* ---- 购物 ---- */
  listShopping: () => request('/shopping/items'),
  createShoppingItem: (body) => request('/shopping/items', { method: 'POST', body, idempotency: true }),
  updateShoppingItem: (id, body) => request('/shopping/items/' + encodeURIComponent(id), { method: 'PATCH', body, idempotency: true }),
  deleteShoppingItem: (id) => request('/shopping/items/' + encodeURIComponent(id), { method: 'DELETE' }),
  receiveShoppingItem: (id, body) => request('/shopping/items/' + encodeURIComponent(id) + '/receive', { method: 'POST', body, idempotency: true }),
  recomputeShopping: (body) => request('/shopping/recompute', { method: 'POST', body: body || {}, idempotency: true }),

  /* ---- 记餐 / 营养 ---- */
  listMeals: (params) => request('/meals' + q(params)),
  createMeal: (body) => request('/meals', { method: 'POST', body, idempotency: true }),
  updateMeal: (id, body) => request('/meals/' + encodeURIComponent(id), { method: 'PATCH', body, idempotency: true }),
  deleteMeal: (id) => request('/meals/' + encodeURIComponent(id), { method: 'DELETE' }),
  estimateNutrition: (body) => request('/nutrition/estimate', { method: 'POST', body }),

  /* ---- 计划 ---- */
  createPlanDraft: (body) => request('/plans/drafts', { method: 'POST', body, idempotency: true }),
  listPlans: () => request('/plans'),
  getPlan: (id) => request('/plans/' + encodeURIComponent(id)),
  commitPlan: (id, body) => request('/plans/' + encodeURIComponent(id) + '/commit', { method: 'POST', body, idempotency: true }),
  replaceMeal: (id, body) => request('/plans/' + encodeURIComponent(id) + '/replace-meal', { method: 'POST', body, idempotency: true }),
  restoreVersion: (id, body) => request('/plans/' + encodeURIComponent(id) + '/restore-version', { method: 'POST', body, idempotency: true }),

  /* ---- 习惯 ---- */
  listHabitRecords: (params) => request('/habits/records' + q(params)),
  createHabitRecord: (body) => request('/habits/records', { method: 'POST', body, idempotency: true }),
  updateHabitRecord: (id, body) => request('/habits/records/' + encodeURIComponent(id), { method: 'PATCH', body, idempotency: true }),
  deleteHabitRecord: (id) => request('/habits/records/' + encodeURIComponent(id), { method: 'DELETE' }),
  habitSummary: (params) => request('/habits/summary' + q(params)),

  /* ---- 周报 ---- */
  listReports: () => request('/reports'),
  generateReport: (body) => request('/reports/generate', { method: 'POST', body, idempotency: true }),
  exportReport: (id) => request('/reports/' + encodeURIComponent(id) + '/export'),

  /* ---- Agent ---- */
  readAgentPreferences: () => request('/agent/preferences'),
  saveAgentPreferences: (body) => request('/agent/preferences', { method: 'PUT', body }),
  listThreads: () => request('/agent/threads'),
  threadHistory: (id) => request('/agent/threads/' + encodeURIComponent(id) + '/history'),
  createThread: (body) => request('/agent/threads', { method: 'POST', body: body || {}, idempotency: true }),
  startRun: (threadId, body) => request('/agent/threads/' + encodeURIComponent(threadId) + '/runs', { method: 'POST', body, idempotency: true }),
  getRun: (runId) => request('/agent/runs/' + encodeURIComponent(runId)),
  eventsUrl: (runId, after) => API_BASE + '/agent/runs/' + encodeURIComponent(runId) + '/events' + (after !== undefined && after !== null ? '?after=' + encodeURIComponent(after) : ''),
  decideAction: (runId, actionId, body) => request('/agent/runs/' + encodeURIComponent(runId) + '/actions/' + encodeURIComponent(actionId) + '/decision', { method: 'POST', body, idempotency: true }),
  reviseAction: (runId, actionId, body) => request('/agent/runs/' + encodeURIComponent(runId) + '/actions/' + encodeURIComponent(actionId) + '/revise', { method: 'POST', body, idempotency: true }),
  cookingGuide: (runId, url) => request('/agent/runs/' + encodeURIComponent(runId) + '/cooking-guide?' + new URLSearchParams({ url })),
  cancelRun: (runId) => request('/agent/runs/' + encodeURIComponent(runId) + '/cancel', { method: 'POST', body: {}, idempotency: true }),

  /* ---- 自动化 / 通知 / 隐私 ---- */
  getAutomationPolicies: () => request('/automation/policies'),
  updateAutomationPolicies: (body) => request('/automation/policies', { method: 'PUT', body, idempotency: true }),
  listAutomationTasks: () => request('/automation/tasks'),
  listNotifications: () => request('/notifications'),
  readNotification: (id) => request('/notifications/' + encodeURIComponent(id) + '/read', { method: 'POST', body: {}, idempotency: true }),
  privacyExport: () => request('/privacy/export', { method: 'POST', body: {}, idempotency: true }),
  deleteAccount: (body) => request('/privacy/account', { method: 'DELETE', body }),
  healthLive: () => request('/health/live'),
  healthReady: () => request('/health/ready'),
};
