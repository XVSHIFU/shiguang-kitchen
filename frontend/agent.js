'use strict';
/* =========================================================
 * agent.js — 真实 Agent 运行时（SSE）
 * 流程：POST /agent/threads/{id}/runs {message} → {run_id, events_url}
 *      → EventSource(GET /agent/runs/{id}/events?after=游标，cookie 鉴权)
 * 事件：run.started / message.delta / tool.started / tool.completed /
 *       approval.required / action.committed / run.completed / run.failed
 * 审批：approval.required 事件里的 action 进 S.actions，渲染审批卡；
 *       批准/拒绝调 POST /agent/runs/{id}/actions/{action_id}/decision。
 * 规则模式：后端未配置 LLM key 时会在事件里标注（mode/rule 或
 *       llm_configured=false），前端如实展示“规则模式（未配置模型）”，
 *       不伪装成真模型。断线后用 after 游标重连，最多 5 次。
 * ========================================================= */

const AGENT_STREAMS = new Map();
const AGENT_STARTING = new Set();
let ATTACH = null; // {url} 图片附件（见 send 里的说明）
let REC = null;

/* 服务端 action payload 形态未完全固定，做防御性归一化。 */
function normalizeAction(a) {
  const before = a.before || a.from_recipe || null;
  const after = a.after || a.to_recipe || null;
  return {
    id: a.action_id || a.id,
    runId: a.run_id || a.runId || '',
    type: a.type || '',
    summary: a.summary || a.title || '',
    target: a.target || null,
    from: a.from ?? (before && (before.recipe_id || before.id)) ?? null,
    to: a.to ?? (after && (after.recipe_id || after.id)) ?? null,
    before,
    after,
    oldTitle: a.old_recipe_title || '',
    newTitle: a.new_recipe_title || '',
    diffList: a.diff_list || a.diffList || a.changes || [],
    lines: a.lines || a.details || [],
    items: a.items || null,
    servings: a.servings ?? null,
    meals: a.meals || null,
    date: a.date || (a.target && a.target.local_date) || null,
    slot: a.slot || (a.target && a.target.slot) || null,
    expected: a.expected_version ?? a.expected ?? null,
    hash: a.shown_payload_hash || a.payload_hash || a.hash || '',
    expiresAt: a.expires_at || a.expiresAt || new Date(Date.now() + 15 * 60e3).toISOString(),
    status: a.status || 'waiting_approval',
    warn: a.warn || a.warning || '',
    resultV: a.result_version ?? a.resultV ?? null,
    error: a.error || '',
  };
}

function syncChatLocation(id) {
  if (U.route === 'assistant' && id) {
    const hash = '#/assistant?' + new URLSearchParams({ thread: id });
    if (location.hash !== hash) history.replaceState(history.state, '', hash);
  }
}

function selectChatThread(id) {
  if (!S.threads.some(t => t.id === id)) return;
  closeChatPopover();
  clearChatSelection();
  S.activeThread = id;
  renderChat();
}

function chatRun(threadId = thread().id) {
  const stream = AGENT_STREAMS.get(threadId);
  return stream?.state === S ? stream : null;
}

async function newThread(title = '') {
  const state = S;
  try {
    const body = typeof title === 'object' ? title : title ? { title } : {};
    const created = await Api.createThread(body);
    if (S !== state) return null;
    const t = adaptThread(created);
    t.history = 'ready';
    t.draftQuote = t.originQuote;
    S.threads.unshift(t);
    selectChatThread(t.id);
    return t;
  } catch (e) {
    toast('新建对话失败：' + (e.message || e), true);
    return null;
  }
}

async function loadThreadHistory(t) {
  const state = S;
  t.history = 'loading';
  renderChat();
  try {
    const history = await Api.threadHistory(t.id);
    if (S !== state) return;
    if (history.title) t.title = history.title;
    t.parentId = history.parent_thread_id || null;
    t.originQuote = history.quote || null;
    if (!history.runs.length && t.draftQuote === undefined) t.draftQuote = t.originQuote;
    t.msgs = [];
    for (const run of history.runs) {
      t.msgs.push({ id: run.id + '-user', runId: run.id, role: 'user', text: run.input_text, quote: run.quote });
      const m = { id: run.id + '-reply', runId: run.id, role: 'ai', text: run.text,
        trace: run.trace, cards: [], streaming: run.status === 'running', cancelled: run.status === 'cancelled' };
      if (run.status === 'failed' && !m.text) m.text = '运行失败，请重新发送。';
      for (const payload of run.actions) {
        const a = normalizeAction(payload);
        a.runId = run.id;
        a.threadId = t.id;
        S.actions[a.id] = a;
        m.cards.push({ type: 'approval', id: a.id });
      }
      t.msgs.push(m);
      if (m.streaming && !chatRun(t.id)) startEventStream(t, m, run.last_event_id);
    }
    t.messageCount = t.msgs.length;
    t.history = 'ready';
    renderChrome();
  } catch {
    if (S === state) t.history = 'failed';
  }
  if (S === state && S.activeThread === t.id) renderChat();
}

function retryThreadHistory() {
  const t = thread();
  if (t.history === 'failed') loadThreadHistory(t);
}

/* ---------------- 发送与 SSE ---------------- */
function send(text, opt = {}) {
  if (!S) { toast('正在加载，请稍候', true); return; }
  const t = opt.targetThread || thread();
  if (chatRun(t.id) || AGENT_STARTING.has(t.id)) { toast('这段对话正在回复，请等待或停止', true); return; }
  if (t.history && t.history !== 'ready') { toast('请先加载此对话的历史记录', true); return; }
  const attachment = opt.targetThread ? null : ATTACH;
  const quote = opt.quote || (!opt.targetThread ? t.draftQuote : null);
  const message = { id: uid('m'), role: 'user', text, quote, img: attachment?.url, voice: !!opt.voice };
  const collaborate = !opt.targetThread && U.agentTeam;
  if (!opt.targetThread) {
    ATTACH = null;
    t.draftQuote = null;
    U.agentTeam = false;
  }
  const imgNote = attachment ? '\n（用户附了一张图片：图片内容需后端视觉支持，当前仅发送文字。）' : '';
  runAgent(t, message, text + imgNote, collaborate, opt.recipeAction);
}

async function runAgent(t, message, text, collaborate, recipeAction) {
  const startingId = t.id;
  const state = S;
  AGENT_STARTING.add(startingId);
  let runId;
  let started;
  let notice = '';
  const thinking = VERINFO?.agent_thinking_available ? U.agentThinking : undefined;
  try {
    if (startingId === 'th-local') {
      t = await newThread();
      if (!t || S !== state) return;
      AGENT_STARTING.add(t.id);
    }
    t.msgs.push(message);
    renderChat();
    started = await Api.startRun(t.id, { message: text, thinking, collaborate, quote: message.quote || undefined,
      recipe_action: recipeAction || undefined });
    if (S !== state) return;
    runId = started.run_id;
    if (!runId) throw new Error('没有收到运行结果');
    message.runId = runId;
  } catch (e) {
    if (S !== state) return;
    if (!recipeAction && !t.draftText) {
      t.draftText = message.text;
      if (!t.draftQuote) t.draftQuote = message.quote;
    }
    const pendingId = e.code === 'THREAD_BUSY' && e.details?.status === 'waiting_approval' && e.details.run_id;
    if (!pendingId || t.msgs.some(m => m.runId === pendingId)) {
      t.msgs.push({ id: uid('m'), role: 'ai', text: e.message || '运行启动失败，请重试', cards: [] });
      return;
    }
    runId = pendingId;
    notice = '这个会话还有一张待处理的修改单。请先确认或拒绝，再重新发送。';
  } finally {
    AGENT_STARTING.delete(startingId);
    if (t) AGENT_STARTING.delete(t.id);
    if (S === state) renderChat();
  }
  if (started?.title && started.title !== '新的对话') t.title = started.title;
  else if (t.title === '新的对话' && started) t.title = message.text.slice(0, 28);
  t.at = D.now();
  const cancelled = started?.status === 'cancelled';
  const m = { id: uid('m'), role: 'ai', runId, trace: [], text: notice, cards: [], streaming: !cancelled, cancelled };
  t.msgs.push(m);
  if (!cancelled) startEventStream(t, m);
  renderChat();
}

function startEventStream(t, m, after = 0) {
  const stream = { state: S, id: m.runId, t, m, after, reconnects: 0, es: null };
  AGENT_STREAMS.set(t.id, stream);
  openEventStream(stream);
}

function openEventStream(stream) {
  const { id: runId, t, m } = stream;
  const draw = () => { if (S === stream.state && S.activeThread === t.id) renderChat(); };
  const es = new EventSource(Api.eventsUrl(runId, stream.after || undefined), { withCredentials: true });
  stream.es = es;

  const onEvent = (ev) => {
    if (S !== stream.state || chatRun(t.id) !== stream) { finishEventStream(stream); return; }
    let data = {};
    try { data = (ev.data && JSON.parse(ev.data)) || {}; } catch (e) { data = { text: ev.data }; }
    const payload = data.payload && typeof data.payload === 'object' ? data.payload : data;
    const seq = Number(ev.lastEventId || data.seq || 0);
    if (seq && seq <= stream.after) return;
    if (seq) stream.after = seq;
    stream.reconnects = 0;

    const type = data.type || data.event || ev.type;
    switch (type) {
      case 'run.started': {
        const mode = payload.mode || payload.agent_mode || (payload.llm_configured === false ? 'rule' : payload.llm_configured === true ? 'llm' : null);
        const model = payload.agent_model || payload.model || null;
        if (mode === 'rule' || payload.rule_mode) {
          U.agentMode = 'rule';
          U.agentModel = null;
          m.mode = 'rule';
        } else if (mode === 'llm') {
          U.agentMode = 'llm';
          if (model) U.agentModel = model;
          m.mode = 'llm';
        } else if (mode) {
          U.agentMode = mode;
          m.mode = mode;
        }
        draw();
        break;
      }
      case 'message.delta': {
        m.text += payload.delta || payload.text || '';
        if (S.activeThread === t.id) scheduleChatDelta(m);
        break;
      }
      case 'tool.started': {
        m.trace.push({ label: payload.label || payload.tool || '工具调用', tool: payload.tool || '', st: 'run' });
        draw();
        break;
      }
      case 'tool.completed': {
        const p = [...m.trace].reverse().find((x) => x.st === 'run' && (!payload.tool || x.tool === payload.tool));
        if (p) p.st = payload.error ? 'err' : 'ok';
        draw();
        break;
      }
      case 'approval.required': {
        const a = normalizeAction(payload.action || payload);
        a.runId = runId;
        a.threadId = t.id;
        S.actions[a.id] = a;
        m.cards.push({ type: 'approval', id: a.id });
        m.streaming = false;
        finishEventStream(stream);
        draw();
        renderChrome();
        break;
      }
      case 'action.committed': {
        const a = S.actions[payload.action_id || payload.id];
        if (a) { a.status = 'committed'; a.resultV = payload.result_version ?? payload.active_version ?? a.resultV; }
        t.msgs.push({ id: uid('m'), role: 'sys', text: 'action.committed · ' + (payload.summary || (a && a.summary) || '') });
        refreshNotifications();
        draw();
        renderChrome();
        break;
      }
      case 'run.completed': {
        if (payload.title) t.title = payload.title;
        if (S.activeThread !== t.id) renderThreadSidebar();
        m.streaming = false;
        finishEventStream(stream);
        draw();
        renderChrome();
        break;
      }
      case 'run.cancelled': {
        m.streaming = false;
        m.cancelled = true;
        finishEventStream(stream);
        draw();
        break;
      }
      case 'run.failed': {
        m.streaming = false;
        m.text += '\n\n[[alert]] 运行失败：' + (payload.message || payload.error || '未知错误');
        finishEventStream(stream);
        draw();
        renderChrome();
        break;
      }
      default: {
        // 未知事件类型：不丢弃，写进 trace 方便排查
        if (payload.text || payload.delta) { m.text += payload.text || payload.delta || ''; renderChat(); }
        break;
      }
    }
  };

  ['run.started', 'message.delta', 'tool.started', 'tool.completed', 'approval.required', 'action.committed', 'run.completed', 'run.failed', 'run.cancelled'].forEach((type) => {
    es.addEventListener(type, onEvent);
  });
  es.onmessage = onEvent; // 未具名事件也按 payload.type 分发
  es.onerror = () => {
    es.close();
    if (S !== stream.state || chatRun(t.id) !== stream || !m.streaming) {
      finishEventStream(stream);
      return;
    }
    stream.reconnects += 1;
    if (stream.reconnects > 5) {
      m.streaming = false;
      m.interrupted = true;
      m.text += '\n\n连接中断，刷新页面可重新查看已保存的回复。';
      finishEventStream(stream);
      draw();
      return;
    }
    setTimeout(() => { if (chatRun(t.id) === stream) openEventStream(stream); }, 1500);
  };
}

function finishEventStream(stream) {
  stream.es?.close();
  if (AGENT_STREAMS.get(stream.t.id) === stream) AGENT_STREAMS.delete(stream.t.id);
}

async function cancelRun() {
  const stream = chatRun();
  if (!stream) return;
  try {
    const result = await Api.cancelRun(stream.id);
    if (result.status !== 'cancelled') return;
    stream.m.streaming = false;
    stream.m.cancelled = true;
    finishEventStream(stream);
    renderChat();
  } catch (e) {
    toast('取消请求失败：' + (e.message || e), true);
  }
}

/* ---------------- 审批决定 ---------------- */
async function decide(id, decision) {
  const a = S.actions[id];
  if (!a || a.status !== 'waiting_approval') { toast('这张修改单已处理', true); return; }
  if (Date.now() > new Date(a.expiresAt)) { a.status = 'expired'; renderChat(); return; }
  if (decision === 'reject') {
    try {
      await Api.decideAction(a.runId, a.id, { decision: 'reject', shown_payload_hash: a.hash });
    } catch (e) {
      if (e && e.code !== 'APPROVAL_ALREADY_DECIDED') { toast('拒绝提交失败：' + (e.message || e), true); return; }
    }
    a.status = 'rejected';
    renderChat();
    renderChrome();
    toast('已拒绝，未写入任何数据');
    return;
  }
  a.status = 'approved';
  renderChat();
  try {
    const res = await Api.decideAction(a.runId, a.id, { decision: 'approve', shown_payload_hash: a.hash });
    a.status = 'committing';
    renderChat();
    // 后端随后会通过 action.committed / run.completed 事件确认；若响应已含结果直接采纳
    if (res && (res.status === 'committed' || res.committed)) {
      a.status = 'committed';
      a.resultV = res.result_version ?? res.active_version ?? a.resultV;
      S.threads.find(t => t.id === a.threadId)?.msgs.push({ id: uid('m'), role: 'sys', text: '已保存：' + a.summary });
      await Promise.allSettled([refreshPlan(), refreshMeals(), refreshShopping(), refreshNotifications()]);
      toast('[[bookmark]] 已盖章并保存');
      if (U.route === 'assistant') { renderChat(); renderChrome(); }
      else render();
    }
  } catch (e) {
    if (e && e.code === 'CONFLICT') {
      a.status = 'conflict';
      toast('版本冲突：计划已被修改', true);
    } else if (e && e.code === 'APPROVAL_ALREADY_DECIDED') {
      a.status = 'committed';
      toast('该审批已被处理，正在同步最新状态');
      await refreshPlan();
    } else {
      a.status = 'failed';
      a.error = (e && e.message) || '提交失败';
      toast(a.error, true);
    }
    renderChat();
    renderChrome();
  }
}
