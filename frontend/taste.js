/* Curated dishes and the discovery page. */
const TASTE_GROUPS = [
  ['all', '随便逛'], ['dessert', '甜品'], ['regional', '地方美食'], ['street', '街头小吃'],
];

const TASTE_DISHES = [
  {
    id: 'mango-sago', category: 'dessert', photo: [0, 0], name: '杨枝甘露', region: '香港', flavor: '冰爽果香',
    description: '芒果打成浓浓的汤底，拌进透亮的西米和微酸的柚子。适合给一顿普通晚饭收个清爽的尾。',
    time: '动手约 20 分钟 · 冷藏另计', ingredients: ['芒果', '西柚', '西米', '牛奶', '椰浆'],
    matches: ['乳制品', '乳', 'milk', 'dairy', 'lactose', '柚子', '椰子', 'coconut'],
    steps: ['煮西米至透亮，过凉水沥干。', '一部分芒果和牛奶、椰浆打成底，余下的切块。', '把西米、芒果块和掰松的西柚果肉拌入，冷藏到喜欢的温度。'],
  },
  {
    id: 'ginger-milk', category: 'dessert', photo: [1, 0], name: '姜撞奶', region: '广东顺德', flavor: '温甜带姜香',
    description: '两样主料就能做一碗。牛奶凝成嫩嫩的奶冻，挖到碗底时，姜香会更明显。',
    time: '约 20 分钟', ingredients: ['老姜', '全脂牛奶', '糖'],
    matches: ['乳制品', '乳', 'milk', 'dairy', 'lactose', '生姜', 'ginger'],
    steps: ['老姜磨碎挤汁，过滤到小碗里。', '加热全脂牛奶和糖，离火稍晾，稍微搅匀碗里的姜汁。', '把热牛奶一次冲进姜汁中，盖住静置，凝固前不要搅动。'],
  },
  {
    id: 'lotus-rice', category: 'dessert', photo: [2, 0], name: '桂花糯米藕', region: '江南', flavor: '软糯桂花香',
    description: '藕孔填满糯米，慢慢煮到软糯。切薄片淋上桂花蜜，冷吃温吃都可以。',
    time: '炖煮约 90 分钟 · 泡米另计', ingredients: ['莲藕', '糯米', '红糖', '桂花蜜'],
    matches: ['藕', '蜂蜜', 'honey', '糯米', 'lotusroot'],
    steps: ['把糯米提前浸泡，莲藕削皮，切下薄薄一段留作盖。', '将泡好的糯米填入藕孔，用牙签固定藕盖，加水和红糖，小火煮到藕软糯。', '晾到方便切片的温度，淋上桂花蜜和少量煮汁。'],
  },
  {
    id: 'shanxi-noodles', category: 'regional', photo: [0, 1], name: '陕西油泼面', region: '陕西', flavor: '葱蒜香辣',
    description: '宽面挂着醋香和辣子。一小勺热油泼下去，葱蒜立刻香起来。辣椒面可以按自己的口味放。',
    time: '用现成宽面约 20 分钟', ingredients: ['小麦宽面', '葱', '蒜', '辣椒面', '生抽', '醋', '食用油'],
    matches: ['小麦', '麸质', 'wheat', 'gluten', '大豆', 'soy', 'soybean', '辣椒', 'chili'],
    steps: ['宽面煮熟捞入耐热碗，可一起烫一把青菜。', '倒入生抽和醋，在面上放上葱蒜末和适量辣椒面。', '加热少量食用油，离火后小心淋到香料上，拌匀就能吃。'],
  },
  {
    id: 'guizhou-fish', category: 'regional', photo: [1, 1], name: '贵州酸汤鱼', region: '贵州', flavor: '酸鲜微辣',
    description: '一锅红酸汤煮得开胃，鱼片吸进番茄的酸香。配一碗白饭，喜欢喝汤的人可以多留一点。',
    time: '约 35 分钟', ingredients: ['鱼片', '番茄', '红酸汤', '豆腐', '葱'],
    matches: ['鱼', '河鲜', '鱼类', 'fish', '西红柿', 'tomato', '大豆', 'soy', 'soybean', '辣椒'],
    steps: ['把番茄炒出汁，加入红酸汤和水煮开，先尝汤底再调味。', '放入豆腐，小火煮一会儿，让汤味互相融合。', '放入鱼片煮熟，出锅前撒葱花。'],
  },
  {
    id: 'yunnan-rice-noodles', category: 'regional', photo: [2, 1], name: '云南菌菇米线', region: '云南风味', flavor: '清鲜菌香',
    description: '滑溜的米线浸在菌菇汤里。家里用香菇和平菇就能做出鲜味，汤清也很有滋味。',
    time: '约 25 分钟', ingredients: ['米线', '香菇', '平菇', '葱', '食用油'],
    matches: ['食用菌', '菌菇', '蘑菇', '菇类', 'mushroom', 'rice'],
    steps: ['将香菇和平菇切好，用少量油炒香。', '加水煮出菌菇香，煮熟后按口味加盐。', '米线按包装说明煮熟，盛入碗里浇菌菇汤，撒葱花。'],
  },
  {
    id: 'takoyaki', category: 'street', photo: [0, 2], name: '章鱼烧', region: '日本大阪', flavor: '外香里软',
    description: '圆滚滚的小丸外面煎香，内里还有章鱼的嚼劲。淋一点酱汁和蛋黄酱，趁热尝正好。',
    time: '约 30 分钟 · 需要章鱼烧烤盘', ingredients: ['章鱼', '小麦面粉', '鸡蛋', '章鱼烧酱', '蛋黄酱', '海苔', '柴鱼片'],
    matches: ['八爪鱼', '软体动物', '甲壳类', '海鲜', '贝类', 'shellfish', 'mollusc', 'mollusk', 'octopus', '鱼', 'fish', '小麦', '麸质', 'wheat', 'gluten', '蛋', 'egg', '大豆', 'soy'],
    steps: ['用小麦面粉、鸡蛋和水调成流动的面糊，把熟章鱼切成小块。', '在烤盘刷油，倒入面糊和章鱼，等边缘定形后转动小丸，煎至里面熟透。', '淋章鱼烧酱和蛋黄酱，撒上海苔和柴鱼片。'],
  },
  {
    id: 'tteokbokki', category: 'street', photo: [1, 2], name: '韩式辣炒年糕', region: '韩国街头', flavor: '甜辣软糯',
    description: '属于一边吃一边停不下来的甜辣口。把酱汁收得浓一点，每根年糕都裹得均匀。',
    time: '约 25 分钟', ingredients: ['年糕', '韩式辣酱', '葱', '芝麻', '少量糖'],
    matches: ['辣椒', 'chili', '芝麻', 'sesame', '小麦', '麸质', 'wheat', 'gluten', '大豆', 'soy', 'soybean', 'rice'],
    steps: ['按包装说明预处理年糕，用水、韩式辣酱和少量糖搅匀。', '倒入年糕，中小火煮软，期间翻动防粘。', '把酱汁收到能裹住年糕，撒葱和芝麻。'],
  },
  {
    id: 'scallion-pancake', category: 'street', photo: [2, 2], name: '葱油饼', region: '街头面点', flavor: '酥脆葱香',
    description: '一层薄脆一层柔软，掰开能看见葱花。刚出平底锅时最好吃，配一杯豆浆也很合适。',
    time: '约 40 分钟', ingredients: ['小麦面粉', '香葱', '食用油', '盐'],
    matches: ['小麦', '麸质', 'wheat', 'gluten', '小葱', 'scallion', 'onion'],
    steps: ['用面粉和温水揉成柔软面团，盖住松弛。', '擀薄，刷油、撒盐和葱花，卷起盘成圆，再轻轻擀开。', '平底锅刷薄油，入饼用中火烙到两面金黄、里面熟透。'],
  },
];

const TASTE_MODES = [['wheel', '[[refresh]]', '美食转盘'], ['cards', '[[file]]', '盲牌']];
const TASTE_WHEEL_TONES = ['var(--honey)', '#ecc1ac', '#e7d2c3', '#f4e1d6', '#dbe3d4', '#e6b5a1', '#eedfb0', '#e3be8f', '#eadcd2'];
const TASTE_SPIN_MS = 4200;
const tasteReducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
let tasteAudio = null;
const TASTE = {
  owner: null, date: '', category: 'all', mode: 'wheel', angle: 0,
  result: null, lastDraw: '', excluded: new Set(), deck: [], revealed: '', run: null, entry: false, sound: false,
};

function tasteFoodKey(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase().replace(/[\s_·-]/g, '');
}

function tasteChoices(category = 'all') {
  const prohibited = (S?.restrictions || [])
    .filter(restriction => restriction.hard || restriction.kind === 'allergy' || restriction.kind === 'avoid')
    .flatMap(restriction => (restriction.keys || []).concat(restriction.label || '')).map(tasteFoodKey).filter(Boolean);
  return TASTE_DISHES.filter(dish => {
    if (category !== 'all' && category !== dish.category) return false;
    const ingredients = dish.ingredients.concat(dish.matches).map(tasteFoodKey);
    return !prohibited.some(key => ingredients.some(food =>
      /^[a-z]+$/.test(key) ? food === key : food.includes(key) || key.includes(food)
    ));
  });
}

function tastePool() {
  return tasteChoices(TASTE.category).filter(dish => !TASTE.excluded.has(dish.id));
}

function tasteShuffle(items) {
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index--) {
    const other = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[other]] = [shuffled[other], shuffled[index]];
  }
  return shuffled;
}

function tasteNewDeck() {
  const pool = tastePool();
  const unpicked = pool.filter(dish => dish.id !== TASTE.lastDraw);
  const available = unpicked.length >= 3 ? unpicked : pool;
  TASTE.deck = tasteShuffle(available).slice(0, 3);
  TASTE.revealed = '';
}

function tastePhoto(dish, variant = '') {
  const [column, row] = dish.photo;
  return `<span class="taste-photo ${variant}" style="--taste-x:${column * 50}%;--taste-y:${row * 50}%" aria-hidden="true"></span>`;
}

function tasteDialHTML(pool) {
  const step = 360 / pool.length;
  const sectors = pool.map((_, index) => {
    const start = index * step;
    const end = start + step;
    return `${TASTE_WHEEL_TONES[index]} ${start}deg ${end - .65}deg, var(--taste-rim-color) ${end - .65}deg ${end}deg`;
  }).join(', ');
  const labels = pool.map((dish, index) => {
    const angle = index * step * Math.PI / 180;
    const won = TASTE.result?.label === '转盘选中' && TASTE.result.id === dish.id;
    return `<span class="taste-dial-label${won ? ' is-winner' : ''}" data-taste-segment="${dish.id}"
      style="--place-x:${(50 + 33 * Math.sin(angle)).toFixed(3)}%;--place-y:${(50 - 33 * Math.cos(angle)).toFixed(3)}%">${esc(dish.name)}</span>`;
  }).join('');
  return `<div class="taste-wheel">
    <div class="taste-needle" aria-hidden="true"></div>
    <div class="taste-rim" data-taste-assemble="rim">
      <div class="taste-rotor" aria-hidden="true" style="transform:rotate(${TASTE.angle}deg);--counter-angle:${-TASTE.angle}deg;--segments:conic-gradient(from ${-step / 2}deg,${sectors})">
        ${labels}
      </div>
      <button class="taste-hub" id="taste-spin" type="button" onclick="spinTaste(this)" ${pool.length < 2 ? 'disabled' : ''}>
        [[refresh]] <span>转一下</span>
      </button>
    </div>
  </div>`;
}

function tasteCardFront(dish) {
  return `${tastePhoto(dish, 'taste-card-photo')}<strong>${esc(dish.name)}</strong>`;
}

function tasteDeckHTML() {
  return `<div class="taste-deck" aria-label="选一张盲牌">
    ${TASTE.deck.map((dish, index) => {
      const revealed = TASTE.revealed === dish.id;
      return `<button class="taste-flip-card${revealed ? ' is-shown' : ''}" type="button" data-taste-card="${index}"
        aria-label="${revealed ? esc(dish.name) : '翻开第 ' + (index + 1) + ' 张盲牌'}" onclick="flipTaste(this)" ${TASTE.revealed ? 'disabled' : ''}>
        <span class="taste-card-turn" aria-hidden="true">
          <span class="taste-card-back"><span class="taste-card-corner">${index + 1}</span><span class="taste-card-symbol">[[chef]]</span><span class="taste-card-back-label">翻开</span></span>
          <span class="taste-card-front">${revealed ? tasteCardFront(dish) : ''}</span>
        </span>
      </button>`;
    }).join('')}
  </div>`;
}

function tasteActivityHTML() {
  const pool = tastePool();
  if (!pool.length) return `<div class="taste-no-choice">
    <span class="taste-empty-mark">[[utensils]]</span>
    <h3>这类暂无合适的菜</h3>
    <p>换个分类，或者请管家按你记录的忌口想一道。</p>
    <button class="btn taste-cream-btn" type="button" onclick="askAI('按我记录的饮食限制，给我一道今天可以试试的新菜。先只给建议。')">[[chef]] 问管家</button>
  </div>`;
  return `<div class="taste-play-area" data-mode="${TASTE.mode}">
    ${TASTE.mode === 'wheel' ? tasteDialHTML(pool) : tasteDeckHTML()}
    <div class="taste-play-actions">
      ${TASTE.mode === 'cards' ? '<button class="btn taste-cream-btn" id="taste-deal" data-lock-taste type="button" onclick="dealTaste()">[[refresh]] 再发一轮</button>' : ''}
      ${TASTE.mode === 'wheel' && pool.length === 1 ? `<button class="btn taste-cream-btn" data-lock-taste type="button" onclick="chooseTasteDish('${pool[0].id}')">看看这道菜</button>` : ''}
      <button class="btn taste-quiet-btn" id="taste-skip" type="button" onclick="finishTasteRun()" hidden>直接揭晓</button>
      <button class="btn taste-quiet-btn taste-jump-result" id="taste-jump-result" type="button" onclick="focusTasteResult()" hidden>查看结果</button>
    </div>
  </div>`;
}

function tasteResultHTML() {
  const pool = tastePool();
  const seed = Number(TASTE.date.replace(/-/g, '')) || 0;
  const winner = pool.find(dish => dish.id === TASTE.result?.id);
  const dish = winner || pool[seed % pool.length];
  if (!dish) return `<div class="taste-result-empty"><h3>等你选个口味</h3><p>从其他分类挑一道，就能在这里查看做法。</p></div>`;
  const note = winner ? TASTE.result.label : '今日推荐';
  return `<div class="taste-result-card" data-taste-dish="${dish.id}">
    <div class="taste-cover" data-taste-assemble="photo">
      ${tastePhoto(dish, 'taste-result-photo')}
      <span class="taste-result-label" data-taste-assemble="stamp">${note}</span>
    </div>
    <div class="taste-result-copy">
      <p class="taste-origin">${esc(dish.region)} <span aria-hidden="true">·</span> ${esc(dish.flavor)}</p>
      <h3 id="taste-dish-name">${esc(dish.name)}</h3>
      <p class="taste-description">${esc(dish.description)}</p>
      <div class="taste-time">[[timer]] ${esc(dish.time)}</div>
      <div class="taste-result-actions">
        <button class="btn pri" type="button" data-lock-taste aria-expanded="false" aria-controls="taste-method" onclick="toggleTasteMethod(this)">[[book]] 看看做法</button>
        <button class="btn" data-lock-taste type="button" onclick="askTasteDish('${dish.id}')">[[chef]] 问管家</button>
        ${pool.length > 1 ? `<button class="btn ghost taste-exclude" data-lock-taste type="button" onclick="excludeTasteDish('${dish.id}')">先跳过这道</button>` : ''}
      </div>
      <div id="taste-method" class="taste-method" hidden>
        <p><b>常见用料</b> ${esc(dish.ingredients.join('、'))}</p>
        <ol>${dish.steps.map(step => `<li>${esc(step)}</li>`).join('')}</ol>
        <button class="btn sm" type="button" data-lock-taste onclick="cookTasteDish('${dish.id}')">[[flame]] 开始做</button>
      </div>
    </div>
  </div>`;
}

function tasteCandidateHTML() {
  const pool = tastePool();
  return `<summary>自己挑一道 <span>${pool.length ? pool.length + ' 道候选' : '暂无候选'}</span></summary>
    ${pool.length ? `<div class="taste-candidate-list">${pool.map(dish => `
      <button type="button" class="taste-candidate" data-lock-taste onclick="chooseTasteDish('${dish.id}',this)" aria-label="看看${esc(dish.name)}">
        ${tastePhoto(dish)}<span><strong>${esc(dish.name)}</strong><small>${esc(dish.region)}</small></span>
      </button>`).join('')}</div>` : '<p>可以换个分类，再看看其他菜。</p>'}`;
}

function tastePageHTML() {
  const date = D.todayKey();
  const owner = S.user.id || S.user.email || S.user;
  if (TASTE.owner !== owner || TASTE.date !== date) {
    cancelTasteRun();
    Object.assign(TASTE, { owner, date, category: 'all', mode: 'wheel', angle: 0, result: null,
      lastDraw: '', excluded: new Set(), deck: [], revealed: '', sound: false });
  }
  if (TASTE.mode === 'cards' && !TASTE.deck.length) tasteNewDeck();
  return `<section id="taste-page" class="taste-page" aria-labelledby="taste-heading">
    <a class="taste-back" href="#/home">[[home]] 回到今日餐桌</a>
    <header class="taste-header">
      <div><h2 id="taste-heading" tabindex="-1">今天吃什么<span>？</span></h2>
        <p>挑个口味，转一下，或者翻一张。</p></div>
      <div class="taste-modes" role="group" aria-label="选菜玩法">
        ${TASTE_MODES.map(([mode, icon, label]) => `<button type="button" data-taste-mode="${mode}" data-lock-taste
          aria-pressed="${mode === TASTE.mode}" onclick="changeTasteMode('${mode}')">${icon} ${label}</button>`).join('')}
      </div>
    </header>
    <div class="taste-toolbar">
      <div class="taste-filters" aria-label="选择美食分类" role="group">
        ${TASTE_GROUPS.map(([category, label]) => `<button type="button" data-taste-filter="${category}" data-lock-taste
          aria-pressed="${category === TASTE.category}" onclick="filterTaste('${category}')">${esc(label)}</button>`).join('')}
      </div>
      <div class="taste-utility">
        <button class="btn sm ghost" id="taste-restore" data-lock-taste type="button" onclick="restoreTasteDishes()" ${TASTE.excluded.size ? '' : 'hidden'}>恢复跳过的菜</button>
        <button class="btn sm taste-sound" type="button" aria-pressed="${TASTE.sound}" onclick="toggleTasteSound(this)">[[volume]] 音效</button>
      </div>
    </div>
    <div id="taste-board" class="taste-board">
      <section class="taste-stage" aria-labelledby="taste-stage-heading">
        <div class="taste-stage-heading"><h3 id="taste-stage-heading">${TASTE.mode === 'wheel' ? '美食转盘' : '翻一张盲牌'}</h3><span id="taste-count">${tastePool().length} 道候选</span></div>
        <div id="taste-activity">${tasteActivityHTML()}</div>
        <div class="taste-stages" aria-hidden="true">
          <span data-taste-step="ready">挑口味</span><span data-taste-step="playing" id="taste-step-playing">${TASTE.mode === 'wheel' ? '转动' : '翻牌'}</span><span data-taste-step="result">揭晓</span>
        </div>
      </section>
      <article id="taste-result" class="taste-result" aria-label="选菜结果">${tasteResultHTML()}</article>
    </div>
    <span class="taste-sr" id="taste-status" role="status"></span>
    <details id="taste-candidates" class="taste-candidates">${tasteCandidateHTML()}</details>
  </section>`;
}

function tasteStatus(text) {
  const status = document.getElementById('taste-status');
  if (status) status.textContent = text;
}

function syncTasteControls() {
  const page = document.getElementById('taste-page');
  if (!page) return;
  const busy = Boolean(TASTE.run);
  const revealed = TASTE.result && (TASTE.mode === 'wheel' || TASTE.revealed);
  page.dataset.phase = busy ? 'playing' : revealed ? 'result' : 'ready';
  page.querySelectorAll('[data-lock-taste]').forEach(button => { button.disabled = busy; });
  page.querySelectorAll('[data-taste-card]').forEach(button => { button.disabled = busy || Boolean(TASTE.revealed); });
  const spin = page.querySelector('#taste-spin');
  if (spin) spin.disabled = busy || tastePool().length < 2;
  const quick = page.querySelector('#taste-skip');
  if (quick) quick.hidden = !busy;
  const jump = page.querySelector('#taste-jump-result');
  if (jump) {
    const dish = tastePool().find(item => item.id === TASTE.result?.id);
    jump.hidden = !dish || busy;
    if (dish) jump.textContent = '查看结果 · ' + dish.name;
  }
}

function drawTasteResult(reveal = false) {
  const result = document.getElementById('taste-result');
  if (!result) return;
  result.innerHTML = tasteResultHTML();
  if (reveal) result.querySelector('.taste-result-copy')?.animate(
    [{ opacity: .78, transform: 'translateY(7px)' }, { opacity: 1, transform: 'none' }],
    { duration: tasteReducedMotion.matches ? 0 : 420, easing: 'cubic-bezier(.16,1,.3,1)' },
  );
}

function updateTasteBoard() {
  const activity = document.getElementById('taste-activity');
  if (!activity) return;
  activity.innerHTML = tasteActivityHTML();
  document.getElementById('taste-stage-heading').textContent = TASTE.mode === 'wheel' ? '美食转盘' : '翻一张盲牌';
  document.getElementById('taste-step-playing').textContent = TASTE.mode === 'wheel' ? '转动' : '翻牌';
  document.getElementById('taste-count').textContent = tastePool().length + ' 道候选';
  document.getElementById('taste-restore').hidden = TASTE.excluded.size === 0;
  document.getElementById('taste-candidates').innerHTML = tasteCandidateHTML();
  document.querySelectorAll('[data-taste-filter]').forEach(button =>
    button.setAttribute('aria-pressed', String(button.dataset.tasteFilter === TASTE.category)));
  document.querySelectorAll('[data-taste-mode]').forEach(button =>
    button.setAttribute('aria-pressed', String(button.dataset.tasteMode === TASTE.mode)));
  drawTasteResult();
  syncTasteControls();
}

function resetTasteChoices() {
  TASTE.angle = 0;
  TASTE.result = null;
  tasteNewDeck();
  updateTasteBoard();
}

function changeTasteMode(mode) {
  if (TASTE.run || mode === TASTE.mode || !TASTE_MODES.some(([id]) => id === mode)) return;
  TASTE.mode = mode;
  resetTasteChoices();
}

function filterTaste(category) {
  if (TASTE.run || category === TASTE.category || !TASTE_GROUPS.some(([id]) => id === category)) return;
  TASTE.category = category;
  resetTasteChoices();
  tasteStatus(tastePool().length + ' 道候选');
}

function excludeTasteDish(id) {
  const pool = tastePool();
  if (TASTE.run || pool.length < 2 || !pool.some(dish => dish.id === id)) return;
  TASTE.excluded.add(id);
  resetTasteChoices();
  document.getElementById('taste-restore')?.focus({ preventScroll: true });
  tasteStatus('已跳过这道菜。');
}

function restoreTasteDishes() {
  if (TASTE.run) return;
  TASTE.excluded.clear();
  resetTasteChoices();
  document.querySelector('[data-taste-filter][aria-pressed="true"]')?.focus({ preventScroll: true });
  tasteStatus('已恢复跳过的菜。');
}

function chooseTasteDish(id, from) {
  const dish = tastePool().find(item => item.id === id);
  if (TASTE.run || !dish) return;
  TASTE.result = { id, label: '你挑的' };
  drawTasteResult(true);
  syncTasteControls();
  tasteStatus('选了' + dish.name);
  if (from) focusTasteResult();
}

function focusTasteResult() {
  const result = document.getElementById('taste-result');
  if (!result) return;
  const top = result.getBoundingClientRect().top;
  if (top < document.getElementById('top').getBoundingClientRect().bottom || top > innerHeight - 90) {
    result.scrollIntoView({ block: 'start', behavior: tasteReducedMotion.matches ? 'instant' : 'smooth' });
  }
  result.querySelector('.taste-result-actions button')?.focus({ preventScroll: true });
}

function dealTaste() {
  if (TASTE.run) return;
  tasteNewDeck();
  document.getElementById('taste-activity').innerHTML = tasteActivityHTML();
  syncTasteControls();
  document.getElementById('taste-deal')?.focus({ preventScroll: true });
  tasteStatus('新一轮盲牌已经发好。');
}

async function toggleTasteSound(button) {
  if (TASTE.sound) {
    TASTE.sound = false;
    button.setAttribute('aria-pressed', 'false');
    return;
  }
  button.disabled = true;
  try {
    const Audio = window.AudioContext || window.webkitAudioContext;
    if (!Audio) throw new Error('AudioContext unavailable');
    tasteAudio ||= new Audio();
    await tasteAudio.resume();
    if (!button.isConnected) return;
    TASTE.sound = true;
    button.setAttribute('aria-pressed', 'true');
    playTasteTone(540, .08);
  } catch {
    if (button.isConnected) toast('当前浏览器无法开启音效', true);
  } finally {
    button.disabled = false;
  }
}

function playTasteTone(frequency, duration) {
  if (!TASTE.sound || document.hidden || tasteAudio?.state !== 'running') return;
  const now = tasteAudio.currentTime;
  const oscillator = tasteAudio.createOscillator();
  const gain = tasteAudio.createGain();
  oscillator.type = 'triangle';
  oscillator.frequency.value = frequency;
  gain.gain.setValueAtTime(.035, now);
  gain.gain.exponentialRampToValueAtTime(.001, now + duration);
  oscillator.connect(gain).connect(tasteAudio.destination);
  oscillator.start(now);
  oscillator.stop(now + duration);
  oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
}

function startTasteRun(job) {
  job.page.classList.remove('taste-arriving');
  TASTE.run = job;
  syncTasteControls();
}

function cancelTasteRun() {
  const job = TASTE.run;
  if (!job) return;
  TASTE.run = null;
  cancelAnimationFrame(job.frame);
  job.animation?.cancel();
  job.tick?.cancel();
}

function finishTasteRun() {
  const job = TASTE.run;
  if (!job) return;
  const restoreFocus = job.keyboard || document.activeElement?.id === 'taste-skip';
  cancelTasteRun();
  if (!job.page.isConnected) return;
  TASTE.lastDraw = job.dish.id;
  TASTE.result = { id: job.dish.id, label: job.mode === 'wheel' ? '转盘选中' : '盲牌揭晓' };
  if (job.mode === 'wheel') {
    TASTE.angle = ((job.target % 360) + 360) % 360;
    job.rotor.style.transform = `rotate(${TASTE.angle}deg)`;
    job.rotor.style.setProperty('--counter-angle', `${-TASTE.angle}deg`);
    job.rotor.querySelectorAll('[data-taste-segment]').forEach(node =>
      node.classList.toggle('is-winner', node.dataset.tasteSegment === job.dish.id));
  } else {
    TASTE.revealed = job.dish.id;
    document.getElementById('taste-activity').innerHTML = tasteActivityHTML();
  }
  drawTasteResult(true);
  syncTasteControls();
  tasteStatus('选中了' + job.dish.name);
  playTasteTone(635, .15);
  if (restoreFocus) document.getElementById(job.mode === 'wheel' ? 'taste-spin' : 'taste-deal')?.focus({ preventScroll: true });
}

function spinTaste(button) {
  const pool = tastePool();
  if (TASTE.run || pool.length < 2) return;
  const page = document.getElementById('taste-page');
  const rotor = page?.querySelector('.taste-rotor');
  if (!rotor) return;
  const options = pool.filter(dish => dish.id !== TASTE.lastDraw);
  const dish = options[Math.floor(Math.random() * options.length)];
  const sectorSize = 360 / pool.length;
  const selected = pool.indexOf(dish);
  const start = TASTE.angle;
  const align = (360 - selected * sectorSize - start + 360) % 360;
  const target = start + 360 * 5 + align;
  const needle = page.querySelector('.taste-needle');
  const job = { mode: 'wheel', dish, page, rotor, target, keyboard: button.matches(':focus-visible') };
  startTasteRun(job);
  if (tasteReducedMotion.matches) { finishTasteRun(); return; }
  rotor.style.setProperty('--counter-angle', '0deg');
  rotor.querySelector('.is-winner')?.classList.remove('is-winner');
  tasteStatus('转盘转起来了。');
  let tick = null;
  let lastSoundAt = -Infinity;
  const started = performance.now();
  function rotate(now) {
    if (TASTE.run !== job) return;
    if (!page.isConnected) { cancelTasteRun(); return; }
    const t = Math.max(0, Math.min(1, (now - started) / TASTE_SPIN_MS));
    if (t === 1) { finishTasteRun(); return; }
    const progress = 1 - (1 - t) ** 3;
    const angle = start + (target - start) * progress;
    rotor.style.transform = `rotate(${angle}deg)`;
    const segment = Math.floor((angle + sectorSize / 2) / sectorSize);
    if (tick !== segment && needle?.animate) {
      tick = segment;
      if (now - lastSoundAt >= 58) {
        playTasteTone(335 + (segment % 3) * 28, .036);
        lastSoundAt = now;
      }
      job.tick?.cancel();
      job.tick = needle.animate([{ transform: 'rotate(-11deg)' }, { transform: 'rotate(0deg)' }],
        { duration: 118, easing: 'ease-out' });
    }
    job.frame = requestAnimationFrame(rotate);
  }
  job.frame = requestAnimationFrame(rotate);
}

function flipTaste(button) {
  const dish = TASTE.deck[Number(button.dataset.tasteCard)];
  const page = document.getElementById('taste-page');
  if (!page || TASTE.run || TASTE.revealed || !dish) return;
  const job = { mode: 'cards', dish, page, keyboard: button.matches(':focus-visible') };
  startTasteRun(job);
  if (tasteReducedMotion.matches) { finishTasteRun(); return; }
  playTasteTone(290, .065);
  button.querySelector('.taste-card-front').innerHTML = tasteCardFront(dish);
  job.animation = button.querySelector('.taste-card-turn').animate(
    [{ transform: 'rotateY(0deg)' }, { transform: 'rotateY(180deg)' }],
    { duration: 1050, fill: 'forwards', easing: 'cubic-bezier(.22,.61,.36,1)' },
  );
  job.animation.finished.then(() => { if (TASTE.run === job) finishTasteRun(); }, () => {});
}

function toggleTasteMethod(button) {
  const method = document.getElementById('taste-method');
  method.hidden = !method.hidden;
  button.setAttribute('aria-expanded', String(!method.hidden));
  button.innerHTML = method.hidden ? '[[book]] 看看做法' : '[[book]] 收起做法';
}

function cookTasteDish(id) {
  const dish = tastePool().find(item => item.id === id);
  if (dish) startCooking(null, null, null, { t: dish.name, em: '[[chef]]', steps: dish.steps.map(step => [step, 0]) });
}

function askTasteDish(id) {
  const dish = tastePool().find(item => item.id === id);
  if (dish) askAI(`我在「换个胃口」看到了${dish.name}，想试试。请给我适合家里做的做法，结合我的饮食限制和现有食材，告诉我缺哪些食材。先只给建议。`);
}

function rememberTasteEntry(event) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
  TASTE.entry = true;
}

function enterTastePage() {
  if (TASTE.run && !TASTE.run.page.isConnected) cancelTasteRun();
  syncTasteControls();
  const page = document.getElementById('taste-page');
  if (!page || !TASTE.entry) return;
  TASTE.entry = false;
  document.getElementById('taste-heading').focus({ preventScroll: true });
  if (tasteReducedMotion.matches || !page.querySelector('.taste-result-label')) return;
  page.classList.add('taste-arriving');
  page.addEventListener('animationend', event => {
    if (event.animationName === 'taste-stamp-desk') page.classList.remove('taste-arriving');
  });
}

window.addEventListener('hashchange', () => {
  if (location.hash.split('?')[0] !== '#/taste') cancelTasteRun();
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) finishTasteRun();
});
tasteReducedMotion.addEventListener('change', event => {
  if (event.matches) {
    document.getElementById('taste-page')?.classList.remove('taste-arriving');
    finishTasteRun();
  }
});
