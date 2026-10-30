/* Conversation controls shared by the assistant page and drawer. */
const CHAT_PERSONAS = [
  ['custom', '自定义', '使用你设置的回答语气和做事风格'],
  ['weeknight', '快手掌勺', '先说最省事的做法，适合工作日晚餐'],
  ['flavor', '风味向导', '多讲一点菜的风味、来路和做法'],
  ['pantry', '备餐参谋', '优先用现有食材，顺手列出需要补买的东西'],
];
const CHAT_SUGGESTIONS = [
  '冰箱还有什么？', '哪些食材快过期了？', '用快过期的食材安排今晚的菜',
  '用现有食材安排三日菜单', '今天吃得怎么样？', '帮我生成本周周报',
];

function radioChoices(name, choices, selected, wide = false) {
  return `<div class="chat-choices ${wide ? 'persona-choices' : ''}">${choices.map(([value, label, description]) =>
    `<label><input type="radio" name="${esc(name)}" value="${esc(value)}" ${value === selected ? 'checked' : ''}>
      <span><b>${esc(label)}</b>${description ? `<small>${esc(description)}</small>` : ''}</span></label>`).join('')}</div>`;
}

function personaName(preferences = S?.agentPreferences) {
  const preset = CHAT_PERSONAS.find(([id]) => id === preferences?.persona && id !== 'custom');
  return preset?.[1] || preferences?.name || 'AI 管家';
}

function personaButton() {
  return `<button type="button" class="btn xs ghost chat-persona-button" aria-haspopup="true" aria-expanded="false"
    onclick="openPersonas(this)" aria-label="切换管家人设"><span data-persona-name>${esc(personaName())}</span><span aria-hidden="true">⌄</span></button>`;
}

function refreshPersonaLabels() {
  document.querySelectorAll('[data-persona-name]').forEach(node => { node.textContent = personaName(); });
}

let activeChatPopover = null;
function closeChatPopover() {
  const popup = activeChatPopover;
  if (popup?.matches(':popover-open')) popup.hidePopover();
}

function chatPopover(anchor, label, html) {
  if (activeChatPopover?.anchor === anchor && activeChatPopover.matches(':popover-open')) {
    closeChatPopover();
    return null;
  }
  closeChatPopover();
  const popup = document.createElement('div');
  popup.className = 'chat-popover';
  popup.popover = 'auto';
  popup.setAttribute('aria-label', label);
  popup.innerHTML = html;
  popup.anchor = anchor;
  document.body.append(popup);
  popup.showPopover();
  activeChatPopover = popup;
  anchor.setAttribute('aria-expanded', 'true');
  positionChatFloat(popup, anchor.getBoundingClientRect(), true);
  popup.addEventListener('toggle', event => {
    if (event.newState !== 'closed') return;
    anchor.setAttribute('aria-expanded', 'false');
    if (activeChatPopover === popup) activeChatPopover = null;
    popup.remove();
  });
  if (anchor.matches(':focus-visible')) popup.querySelector('button, a')?.focus({ preventScroll: true });
  return popup;
}

function positionChatFloat(node, anchor, alignLeft) {
  const { width, height } = node.getBoundingClientRect();
  const x = alignLeft ? anchor.left : anchor.left + (anchor.width - width) / 2;
  const y = anchor.top >= height + 14 ? anchor.top - height - 8 : anchor.bottom + 8;
  node.style.left = Math.max(8, Math.min(x, window.innerWidth - width - 8)) + 'px';
  node.style.top = Math.max(8, Math.min(y, window.innerHeight - height - 8)) + 'px';
}

let switchingPersona = false;
function openPersonas(anchor) {
  const selected = S.agentPreferences?.persona || 'custom';
  const markup = CHAT_PERSONAS.map(([id, title, description]) => `
    <button type="button" class="chat-menu-item" data-persona="${id}" aria-pressed="${id === selected}">
      <span><b>${title}</b><small>${description}</small></span>${id === selected ? '[[check]]' : ''}</button>`).join('');
  chatPopover(anchor, '切换管家人设', markup)?.addEventListener('click', event => {
    const button = event.target.closest('[data-persona]');
    if (button) switchPersona(button.dataset.persona);
  });
}

async function switchPersona(id) {
  closeChatPopover();
  if (switchingPersona || id === S.agentPreferences?.persona) return;
  const state = S;
  switchingPersona = true;
  try {
    const current = S.agentPreferences || await Api.readAgentPreferences();
    if (S !== state) return;
    state.agentPreferences = await Api.saveAgentPreferences({ ...current, persona: id });
    if (S === state) {
      refreshPersonaLabels();
      toast('已切换到' + personaName());
    }
  } catch (e) {
    if (S !== state) return;
    if (e.code === 'PREFERENCES_CONFLICT') {
      const current = await Api.readAgentPreferences().catch(() => null);
      if (current && S === state) { state.agentPreferences = current; refreshPersonaLabels(); }
    }
    toast(e.message || '切换失败，请重试', true);
  } finally {
    switchingPersona = false;
  }
}

function openChatSuggestions(anchor) {
  const popup = chatPopover(anchor, '提问建议', CHAT_SUGGESTIONS.map((question, i) =>
    `<button type="button" class="chat-menu-item" data-question="${i}">${question}</button>`).join(''));
  popup?.addEventListener('click', event => {
    const button = event.target.closest('[data-question]');
    if (!button) return;
    closeChatPopover();
    fillChatPrompt(CHAT_SUGGESTIONS[Number(button.dataset.question)]);
  });
}

function fillChatPrompt(prompt) {
  const t = thread();
  if (!t.draftText?.trim()) t.draftText = prompt;
  const input = $('#ci');
  if (!input) return;
  input.value = t.draftText;
  input.focus({ preventScroll: true });
  input.setSelectionRange(input.value.length, input.value.length);
}

function splitReplyReferences(text) {
  const marker = '\n\n**相关参考**\n';
  const offset = text.lastIndexOf(marker);
  if (offset < 0) return { body: text, sources: [] };
  const lines = text.slice(offset + marker.length).trim().split('\n');
  const sources = lines.map(line => line.match(/^- \[(.+) · (程序员做饭指南|CookLikeHOC · 原文)\]\(<(https:\/\/github\.com\/(?:Anduin2017\/HowToCook|Gar-b-age\/CookLikeHOC)\/blob\/[^>]+)>\)$/));
  if (!sources.every(Boolean)) return { body: text, sources: [] };
  return { body: text.slice(0, offset), sources: sources.map(([,title, source, url]) => ({ title, source, url })) };
}

function chatReferencesHTML(message) {
  if (!message.runId || message.streaming) return '';
  const { sources } = splitReplyReferences(message.text || '');
  if (!sources.length) return '';
  return `<details class="chat-references" data-references="${esc(message.id)}">
    <summary>[[book]] 参考菜谱 <span>${sources.length}</span></summary>
    ${sources.map((source, i) => `<div class="chat-reference-row"><a href="${esc(source.url)}" target="_blank" rel="noopener noreferrer"><b>${esc(source.title)}</b><small>${esc(source.source)}</small></a>
      <button type="button" class="btn xs ghost chat-more-btn" data-message="${esc(message.id)}" data-reference="${i}" aria-label="操作：${esc(source.title)}" aria-haspopup="true" aria-expanded="false" onclick="openReferenceActions(this)">···</button></div>`).join('')}
  </details>`;
}

function quoteMarkup(quote, removable = false) {
  if (!quote) return '';
  return `<div class="chat-quote"><span aria-hidden="true">[[clip]]</span>
    <div><small>${quote.kind === 'reference' ? '参考菜谱' : '引用'}</small><span>${esc(quote.text)}</span></div>
    ${removable ? '<button type="button" class="btn xs ghost" onclick="removeChatQuote()" aria-label="移除引用">[[x]]</button>' : ''}</div>`;
}

function quoteFromMessage(message, text, source) {
  if (!message?.runId) return null;
  const picked = (source?.title || text || splitReplyReferences(message.text || '').body).trim().slice(0, 1600);
  if (!picked) return null;
  return { source_run_id: message.runId, text: picked, kind: source ? 'reference' : text ? 'selection' : 'message',
    ...(source ? { url: source.url } : {}) };
}

function addChatQuote(quote, prompt = '') {
  if (!quote) return;
  thread().draftQuote = quote;
  clearChatSelection();
  closeChatPopover();
  renderChat();
  fillChatPrompt(prompt);
}

function removeChatQuote() {
  thread().draftQuote = null;
  renderChat();
  $('#ci')?.focus({ preventScroll: true });
}

let branchingChat = false;
async function askInSideChat(quote) {
  if (branchingChat || !quote) return;
  branchingChat = true;
  const parent = thread();
  clearChatSelection();
  closeChatPopover();
  try {
    const branch = await newThread({ parent_thread_id: parent.id, quote });
    if (branch) $('#ci')?.focus({ preventScroll: true });
  } finally {
    branchingChat = false;
  }
}

function chatMessageActions(message) {
  if (!message.runId || !message.text || message.streaming) return '';
  return `<div class="chat-actions" aria-label="消息操作">
    ${message.role === 'ai' ? `<button type="button" class="btn xs ghost chat-icon-action" aria-label="复制回复" title="复制" onclick="copyReply(this.closest('[data-message-id]').dataset.messageId,this)">[[copy]]</button>
      <button type="button" class="btn xs ghost chat-icon-action" aria-label="朗读回复" title="朗读" onclick="speakMsg(this.closest('[data-message-id]').dataset.messageId)">${SPEAKING_MSG === message.id ? '[[stop]]' : '[[volume]]'}</button>` : ''}
    <button type="button" class="btn xs ghost chat-icon-action" aria-label="引用消息" title="引用" onclick="quoteMessage(this)">[[clip]]</button>
    <button type="button" class="btn xs ghost chat-more-btn" aria-label="更多消息操作" aria-haspopup="true" aria-expanded="false" onclick="openMessageActions(this)">···</button>
  </div>`;
}

function quoteMessage(button) {
  const message = thread().msgs.find(m => m.id === button.closest('[data-message-id]').dataset.messageId);
  addChatQuote(quoteFromMessage(message));
}

function openMessageActions(button) {
  const message = thread().msgs.find(m => m.id === button.closest('[data-message-id]').dataset.messageId);
  const quote = quoteFromMessage(message);
  if (quote) openFollowupActions(button, quote, null, message.role === 'ai');
}

function openReferenceActions(button) {
  const message = thread().msgs.find(m => m.id === button.dataset.message);
  const source = splitReplyReferences(message?.text || '').sources[Number(button.dataset.reference)];
  const quote = source && quoteFromMessage(message, null, source);
  if (quote) openFollowupActions(button, quote, source, true);
}

function openFollowupActions(anchor, quote, source, recipesAllowed) {
  const matched = recipesAllowed ? Object.values(R).filter(recipe => source ? recipe.t === source.title : quote.text.includes(recipe.t)) : [];
  const entries = [
    ['引用到对话', () => addChatQuote(quote)],
    ['在旁支询问', () => askInSideChat(quote)],
  ];
  if (recipesAllowed) {
    entries.push(['问怎么做', () => addChatQuote(quote, '这里提到的菜怎么做？给我备料清单和步骤。')]);
    if (matched.length) {
      entries.push(['加入菜单', () => showRecipeFollowup(quote, matched, 'menu')]);
      entries.push(['准备买料', () => showRecipeFollowup(quote, matched, 'shopping')]);
      entries.push(['开始做饭', () => showRecipeFollowup(quote, matched, 'cook')]);
    } else if (source) {
      entries.push(['开始做饭', () => openSourceGuide(quote, source)]);
    }
  }
  const menu = chatPopover(anchor, '后续操作', entries.map(([label], index) =>
    `<button type="button" class="chat-menu-item" data-chat-action="${index}">${label}</button>`).join(''));
  menu?.addEventListener('click', event => {
    const button = event.target.closest('[data-chat-action]');
    if (!button) return;
    closeChatPopover();
    entries[Number(button.dataset.chatAction)][1]();
  });
}

let selectionTools = null;
let selectionFrame = 0;
function clearChatSelection() {
  selectionTools?.remove();
  selectionTools = null;
}

function updateChatSelection() {
  selectionFrame = 0;
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount || !S) { clearChatSelection(); return; }
  const range = selection.getRangeAt(0);
  const bodyOf = node => (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement)?.closest('[data-chat-text], .reply-markdown');
  const body = bodyOf(range.startContainer);
  if (!body || body !== bodyOf(range.endContainer) || !body.closest('.msgs')?.contains(body)) { clearChatSelection(); return; }
  const message = thread().msgs.find(m => m.id === body.closest('[data-message-id]')?.dataset.messageId);
  const text = selection.toString().trim();
  const quote = !message?.streaming && text && quoteFromMessage(message, text);
  if (!quote) { clearChatSelection(); return; }
  const anchor = range.getBoundingClientRect();
  const viewport = body.closest('.msgs').getBoundingClientRect();
  if (!anchor.width || !anchor.height || anchor.bottom < viewport.top || anchor.top > viewport.bottom) {
    clearChatSelection();
    return;
  }
  if (!selectionTools) {
    selectionTools = document.createElement('div');
    selectionTools.className = 'chat-selection-tools';
    selectionTools.setAttribute('role', 'group');
    selectionTools.setAttribute('aria-label', '划词操作');
    selectionTools.innerHTML = '<button type="button" class="btn xs ghost" data-add-selection>[[clip]] 引用到对话</button><button type="button" class="btn xs ghost" data-branch-selection>旁支询问</button>';
    selectionTools.addEventListener('pointerdown', event => event.preventDefault());
    selectionTools.addEventListener('click', event => {
      const value = selectionTools.quote;
      if (!event.target.closest('button')) return;
      window.getSelection()?.removeAllRanges();
      if (event.target.closest('[data-add-selection]')) addChatQuote(value);
      else askInSideChat(value);
    });
    document.body.append(selectionTools);
  }
  selectionTools.quote = quote;
  positionChatFloat(selectionTools, anchor, false);
}

function scheduleChatSelection() {
  if (!selectionFrame) selectionFrame = requestAnimationFrame(updateChatSelection);
}
document.addEventListener('selectionchange', scheduleChatSelection);
document.addEventListener('scroll', event => {
  const popup = activeChatPopover;
  if (popup?.matches(':popover-open') && !popup.contains(event.target)) {
    if (popup.anchor.isConnected) positionChatFloat(popup, popup.anchor.getBoundingClientRect(), true);
    else closeChatPopover();
  }
  if (selectionTools) scheduleChatSelection();
}, { capture: true, passive: true });
window.addEventListener('resize', () => { clearChatSelection(); closeChatPopover(); });
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || (!selectionTools && !activeChatPopover?.matches(':popover-open'))) return;
  event.preventDefault();
  clearChatSelection();
  closeChatPopover();
});

function openChatPanel(title, body, footer = '') {
  closeChatPopover();
  clearChatSelection();
  $('#chat-panel')?.close();
  const dialog = document.createElement('dialog');
  dialog.id = 'chat-panel';
  dialog.className = 'chat-panel';
  dialog.setAttribute('aria-labelledby', 'chat-panel-title');
  dialog.innerHTML = `<header><h2 id="chat-panel-title">${esc(title)}</h2><button type="button" class="icon-btn" data-close-chat-panel aria-label="关闭侧栏">[[x]]</button></header>
    <div class="chat-panel-body">${body}</div>${footer ? `<footer>${footer}</footer>` : ''}`;
  dialog.addEventListener('click', event => {
    if (event.target.closest('[data-close-chat-panel]')) dialog.close();
  });
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  document.body.append(dialog);
  dialog.showModal();
  return dialog;
}

const MEAL_SLOT_CHOICES = [['breakfast', '早餐'], ['lunch', '午餐'], ['dinner', '晚餐'], ['snack', '加餐']];
function showRecipeFollowup(quote, recipes, kind) {
  if (kind === 'cook' && recipes.length === 1) {
    startCooking(recipes[0].id);
    return;
  }
  const t = thread();
  const title = { menu: '加入菜单', shopping: '准备买料', cook: '开始做饭' }[kind];
  const recipeOptions = recipes.map(recipe => [recipe.id, recipe.t]);
  const choose = recipes.length === 1 ? `<p class="chat-panel-lead">${esc(recipes[0].t)}</p><input type="hidden" name="recipe_id" value="${esc(recipes[0].id)}">` :
    `<fieldset><legend>选择要用的菜</legend>${radioChoices('recipe_id', recipeOptions, recipes[0].id)}</fieldset>`;
  const dialog = openChatPanel(title, `<form id="chat-recipe-form" class="chat-panel-form">${choose}
    ${kind === 'menu' ? `<label class="f">安排日期<input class="input" type="date" name="local_date" value="${D.todayKey()}" required></label>
      <fieldset><legend>餐次</legend>${radioChoices('slot', MEAL_SLOT_CHOICES, 'dinner')}</fieldset>` : ''}
    ${kind !== 'cook' ? `<label class="f">份数<input class="input chat-servings" type="number" name="servings" min="0.01" max="24" step="0.01" value="${recipes[0].serv || 2}" required></label>` : ''}
    <p class="small" role="status" data-recipe-status></p>
  </form>`, `<button type="submit" form="chat-recipe-form" class="btn pri">${kind === 'cook' ? '开始做饭' : '生成待确认单'}</button>`);
  const form = $('#chat-recipe-form', dialog);
  form.addEventListener('submit', event => {
    event.preventDefault();
    const data = new FormData(form);
    const recipe = R[data.get('recipe_id')];
    if (!recipe) return;
    if (kind === 'cook') { dialog.close(); startCooking(recipe.id); return; }
    if (chatRun(t.id) || AGENT_STARTING.has(t.id) || t !== thread()) {
      $('[data-recipe-status]', dialog).textContent = '请等待这段对话中的回复完成后再试。';
      return;
    }
    const date = data.get('local_date') || D.todayKey();
    const slot = data.get('slot') || 'dinner';
    const servings = data.get('servings');
    const prompt = kind === 'menu' ? `把${recipe.t}加入 ${date} ${SLOTS[slot]}（${servings} 份）` : `为${recipe.t}准备 ${servings} 份的食材`;
    dialog.close();
    send(prompt, { targetThread: t, quote, recipeAction: { kind, recipe_id: recipe.id, local_date: date, slot, servings } });
  });
  form.addEventListener('change', event => {
    if (event.target.name === 'recipe_id' && form.elements.servings) {
      form.elements.servings.value = R[event.target.value]?.serv || 2;
    }
  });
}

async function openSourceGuide(quote, source) {
  const dialog = openChatPanel(source.title, `<div class="chat-source-guide">
    <p role="status" data-guide-status>正在查找烹饪步骤…</p>
    <a href="${esc(source.url)}" target="_blank" rel="noopener noreferrer">打开参考原文 ↗</a>
    <button type="button" class="btn sm" data-ask-guide>问管家怎么做</button></div>`);
  $('[data-ask-guide]', dialog).onclick = () => {
    dialog.close();
    addChatQuote(quote, `${source.title}怎么做？请整理食材和分步做法。`);
  };
  try {
    const guide = await Api.cookingGuide(quote.source_run_id, source.url);
    if (!dialog.open) return;
    if (guide.steps.length) {
      dialog.close();
      startCooking(null, null, null, { t: guide.title, em: '[[chef]]', steps: guide.steps.map(step => [step, 0]) });
    } else $('[data-guide-status]', dialog).textContent = '这份参考提供了菜名和原文入口。';
  } catch (e) {
    if (dialog.open) $('[data-guide-status]', dialog).textContent = e.message || '暂时无法加载步骤';
  }
}

function menuRows(action) {
  const rows = action.type === 'replace_meal' ? [{ local_date: action.date, slot: action.slot, to: action.to,
    servings: action.servings ?? R[action.to]?.serv ?? 2, title: action.newTitle }] : action.diffList;
  const order = MEAL_SLOT_CHOICES.map(([id]) => id);
  return rows.filter(row => row.local_date && SLOTS[row.slot]).slice().sort((a, b) =>
    a.local_date.localeCompare(b.local_date) || order.indexOf(a.slot) - order.indexOf(b.slot));
}

function menuRowFields(row, index) {
  const current = R[row.to];
  return `<div class="chat-menu-fields"><label class="f">菜名
    <input name="recipe_${index}" class="input" value="${esc(current?.t || row.title || '')}" placeholder="搜索菜谱"
      aria-label="${esc(SLOTS[row.slot])}菜名" autocomplete="off" required></label>
    <div class="chat-recipe-matches" hidden data-row-matches="${index}"></div>
    <label class="f">份数<input name="servings_${index}" type="number" class="input chat-servings" value="${esc(row.servings ?? 2)}"
      aria-label="${esc(SLOTS[row.slot])}份数" min="0.01" max="24" step="0.01" required></label></div>`;
}

function openMenuReview(id, editInstructions = false) {
  const action = S.actions[id];
  if (!action) return;
  const t = S.threads.find(entry => entry.id === action.threadId) || thread();
  const rows = menuRows(action);
  const canEdit = action.status === 'waiting_approval';
  const dates = [...new Set(rows.map(row => row.local_date))];
  const body = dates.map(date => `<section class="chat-menu-day">
    <h3>${D.wd(date)} <span>${D.md(date)}</span></h3>
    ${rows.map((row, i) => row.local_date !== date ? '' : `<details class="chat-menu-line" ${canEdit ? '' : 'data-readonly'}>
      <summary><span>${SLOTS[row.slot]}</span><b data-row-title="${i}">${esc(R[row.to]?.t || row.title || '菜谱已不可用')}</b><small data-row-servings="${i}">${esc(row.servings ?? 2)} 份</small>${canEdit ? '<span class="chat-row-edit">修改</span>' : ''}</summary>
      ${canEdit ? menuRowFields(row, i) : ''}</details>`).join('')}
  </section>`).join('');
  const content = `<form id="chat-revision-form" class="chat-panel-form">
    ${action.summary ? `<p class="chat-panel-lead">${esc(action.summary)}</p>` : ''}
    ${canEdit ? '<label class="f">想怎么改？<textarea class="input" data-revision-instructions name="instructions" maxlength="600" rows="2" placeholder="例如：晚餐换成番茄炒蛋，改成两人份"></textarea></label>' : ''}
    ${body || '<p>这个草稿还没有可显示的餐次。</p>'}
  </form>`;
  const dialog = openChatPanel(action.type === 'replace_meal' ? '餐次修改单' : '菜单草稿', content, canEdit ?
    '<p role="status" data-revision-status></p><button type="submit" form="chat-revision-form" class="btn pri">生成新版修改单</button>' : '');
  if (!canEdit) return;
  const form = $('#chat-revision-form', dialog);
  form.addEventListener('input', event => {
    const field = event.target;
    if (field.name.startsWith('recipe_')) {
      const i = Number(field.name.slice(7));
      const value = field.value.trim();
      const options = Object.values(R).filter(recipe => !value || recipe.t.includes(value)).slice(0, 8);
      const matches = $('[data-row-matches="' + i + '"]', form);
      field.setCustomValidity('');
      matches.hidden = false;
      matches.innerHTML = options.length ? options.map(recipe =>
        `<button class="btn xs ghost" type="button" data-choice="${esc(recipe.id)}" data-row-index="${i}">${esc(recipe.t)}</button>`).join('') : '<small>没有匹配菜谱</small>';
    }
    if (field.name.startsWith('servings_')) {
      const value = Number(field.value);
      if (value > 0 && value <= 24) $('[data-row-servings="' + field.name.slice(9) + '"]', form).textContent = value + ' 份';
    }
  });
  form.addEventListener('click', event => {
    const choice = event.target.closest('[data-choice]');
    if (!choice) return;
    const i = Number(choice.dataset.rowIndex);
    const recipe = R[choice.dataset.choice];
    if (!recipe) return;
    form.elements['recipe_' + i].value = recipe.t;
    form.elements['recipe_' + i].setCustomValidity('');
    $('[data-row-title="' + i + '"]', form).textContent = recipe.t;
    $('[data-row-matches="' + i + '"]', form).hidden = true;
    form.elements['recipe_' + i].focus({ preventScroll: true });
  });
  form.addEventListener('submit', event => { event.preventDefault(); submitMenuRevision(dialog, t, action, rows); });
  if (editInstructions) $('[data-revision-instructions]', form).focus({ preventScroll: true });
}

async function submitMenuRevision(dialog, t, action, rows) {
  const form = $('#chat-revision-form', dialog);
  const submit = $('[type="submit"]', dialog);
  const status = $('[data-revision-status]', dialog);
  if (submit.disabled) return;
  const edits = [];
  for (const [index, row] of rows.entries()) {
    const field = form.elements['recipe_' + index];
    const name = field.value.trim();
    const servings = Number(form.elements['servings_' + index].value);
    if (name === (R[row.to]?.t || row.title || '') && servings === Number(row.servings ?? 2)) continue;
    const recipe = Object.values(R).find(item => item.t === name);
    if (!recipe) {
      field.closest('details').open = true;
      field.setCustomValidity('请选择菜谱库中已有的菜。');
      field.reportValidity();
      return;
    }
    edits.push({ local_date: row.local_date, slot: row.slot, recipe_id: recipe.id, servings });
  }
  const instructions = form.elements.instructions.value.trim();
  if (!edits.length && !instructions) { status.textContent = '先修改一个餐次，或写下你想怎么改。'; return; }
  const state = S;
  submit.disabled = true;
  status.textContent = instructions ? '管家正在按要求调整…' : '正在生成修改单…';
  try {
    const payload = await Api.reviseAction(action.runId, action.id, { shown_payload_hash: action.hash, instructions, edits });
    if (S !== state) return;
    action.status = 'superseded';
    const revised = normalizeAction(payload);
    revised.runId = action.runId;
    revised.threadId = t.id;
    S.actions[revised.id] = revised;
    const message = t.msgs.find(m => m.role === 'ai' && m.runId === action.runId);
    message?.cards.push({ type: 'approval', id: revised.id });
    if (dialog.open) dialog.close();
    renderChat();
    renderChrome();
    requestAnimationFrame(() => {
      const card = document.getElementById('ap-' + revised.id);
      if (!card) return;
      const messages = card.closest('.msgs');
      if (messages && card.getBoundingClientRect().bottom > messages.getBoundingClientRect().bottom) {
        messages.scrollTop += card.getBoundingClientRect().top - messages.getBoundingClientRect().top - 16;
      }
      card.querySelector('button')?.focus({ preventScroll: true });
    });
    toast('已生成新版修改单');
  } catch (e) {
    status.textContent = e.message || '调整失败，请重试';
  } finally {
    submit.disabled = false;
  }
}
