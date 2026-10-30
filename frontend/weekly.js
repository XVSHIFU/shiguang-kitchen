/* The report is a snapshot. Dates after its coverage are kept out of the missing-day count. */
const weeklyNumberFormat = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 });
let weeklyUpdating = false;

function weeklyNumber(value) {
  return value == null || !Number.isFinite(Number(value)) ? '—' : weeklyNumberFormat.format(Number(value));
}

function reportWeekLabel(report) {
  const first = D.parse(report.start);
  const last = D.parse(report.end);
  const start = first.getFullYear() + '年' + (first.getMonth() + 1) + '月' + first.getDate() + '日';
  const endYear = first.getFullYear() === last.getFullYear() ? '' : last.getFullYear() + '年';
  const endMonth = endYear || last.getMonth() !== first.getMonth() ? (last.getMonth() + 1) + '月' : '';
  return `${start} — ${endYear}${endMonth}${last.getDate()}日`;
}

function reportGeneratedLabel(timestamp) {
  if (!timestamp) return '';
  const iso = /(?:Z|[+-]\d{2}:\d{2})$/.test(timestamp) ? timestamp : timestamp + 'Z';
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '';
  return '生成于 ' + D.md(D.key(date)) + ' ' + D.time(iso);
}

function latestWeeklyReports() {
  const snapshots = [...S.reports].sort((a, b) =>
    b.start.localeCompare(a.start) || (b.at || '').localeCompare(a.at || ''));
  const weeks = new Set();
  return snapshots.filter(report => {
    if (weeks.has(report.start)) return false;
    weeks.add(report.start);
    return true;
  });
}

function openReportWeeks(button) {
  const reports = latestWeeklyReports();
  const popup = chatPopover(button, '选择周报周次', reports.map((report, index) =>
    `<button type="button" class="chat-menu-item" data-report-index="${index}" aria-pressed="${report.id === button.dataset.reportId}">
      ${esc(reportWeekLabel(report))}</button>`).join(''));
  popup?.addEventListener('click', event => {
    const entry = event.target.closest('[data-report-index]');
    if (!entry) return;
    history.replaceState(null, '', '#/reports?week=' + reports[Number(entry.dataset.reportIndex)].start);
    closeChatPopover();
    render();
    $('.weekly-week-picker')?.focus({ preventScroll: true });
  });
}

function weeklyEnergyChart(report) {
  const { elapsed, kcalByDay } = report.metrics;
  const dates = D.week(report.start);
  const today = D.todayKey();
  const max = Math.max(1, ...kcalByDay.filter(value => value != null && Number.isFinite(Number(value))).map(Number));
  const days = dates.map((date, index) => {
    const amount = kcalByDay[index];
    const recorded = index < elapsed && amount != null && Number.isFinite(Number(amount));
    const awaiting = index >= elapsed;
    const label = recorded ? weeklyNumber(amount) : awaiting ? (date > today ? '未到' : '未纳入') : '未记';
    const level = recorded ? Math.max(0, Math.min(100, Number(amount) / max * 100)) : 0;
    return `<li class="weekly-day" data-day-state="${recorded ? 'recorded' : awaiting ? 'awaiting' : 'missing'}" ${date === today ? 'aria-current="date"' : ''}>
      <div class="weekly-day-amount">${label}</div>
      <div class="weekly-day-track" aria-hidden="true"><div class="weekly-day-bar" ${recorded ? `style="--bar-height:${level}%"` : ''}></div></div>
      <time datetime="${date}"><b>${D.wd(date)}</b><small>${D.md(date)}</small></time>
    </li>`;
  });
  return `<div class="weekly-chart-header"><h4>每日能量</h4><span>kcal</span></div>
    <ol class="weekly-days" aria-label="每日记录餐食的能量">${days.join('')}</ol>`;
}

function weeklyHabitRow(kind, metrics) {
  const { em, n, u } = HB[kind];
  const amount = metrics[kind + "Avg"];
  const days = metrics[kind + "Days"];
  return `<div class="weekly-habit-row">
    <dt>${em} ${n}</dt>
    <dd><span>${amount == null ? '未记录' : `<strong>${weeklyNumber(amount)}</strong> <small>${u}</small>`}</span>
      ${amount == null || !Number.isFinite(Number(days)) ? '' : `<small>${weeklyNumber(days)} 天有记录</small>`}</dd>
  </div>`;
}

function weeklyReportPage() {
  const reports = latestWeeklyReports();
  const currentWeek = D.monday(D.todayKey());
  const week = new URLSearchParams(location.hash.split('?')[1] || '').get('week');
  const report = reports.find(item => item.start === week) || reports[0];
  const current = reports.find(item => item.start === currentWeek);
  const primary = current ? '更新本周周报' : '生成本周周报';
  if (!report) return `<section class="weekly-report weekly-empty">
    <h2>还没有周报</h2><p>生成一份周报，查看这一周的餐食和生活习惯记录。</p>
    <button class="btn pri" type="button" data-weekly-update="${currentWeek}" onclick="generateWeeklyReport(this)" ${weeklyUpdating ? 'disabled' : ''}>[[chart]] ${primary}</button>
  </section>`;
  const m = report.metrics;
  const otherDays = Math.max(0, 7 - m.elapsed);
  const coverage = m.elapsed ? [m.recordDays + ' 天有饮食记录', m.missingDays ? m.missingDays + ' 天未记' : '',
    otherDays ? otherDays + ' 天未纳入' : ''].filter(Boolean).join(' · ') : '这一周还没有统计日期';
  const generated = reportGeneratedLabel(report.at);
  return `<article class="weekly-report" aria-labelledby="weekly-range">
    <header class="weekly-header">
      <div><h2 id="weekly-range">${esc(reportWeekLabel(report))}</h2>
        <p>${[report.start === currentWeek ? '本周' : '', generated].filter(Boolean).join(' · ')}</p></div>
      <div class="weekly-actions">
        ${reports.length > 1 ? `<button class="btn sm weekly-week-picker" type="button" data-report-id="${esc(report.id)}" aria-haspopup="true" aria-expanded="false" onclick="openReportWeeks(this)">[[calendar]] 切换周次</button>` : ''}
        <button class="btn sm" type="button" data-report-id="${esc(report.id)}" onclick="openReportExport(this)" aria-haspopup="true" aria-expanded="false">[[download]] 导出</button>
        <button class="btn sm pri" type="button" data-weekly-update="${currentWeek}" onclick="generateWeeklyReport(this)" ${weeklyUpdating ? 'disabled' : ''}>[[refresh]] ${primary}</button>
      </div>
    </header>
    ${report.status === 'stale' ? `<div class="weekly-stale" role="status"><span>[[alert]] 这周的记录有更新。</span>
      <button class="btn sm" type="button" data-weekly-update="${esc(report.start)}" onclick="generateWeeklyReport(this)" ${weeklyUpdating ? 'disabled' : ''}>更新这份周报</button></div>` : ''}
    <div class="weekly-columns">
      <section class="weekly-food">
        <header class="weekly-section-heading"><h3>饮食记录</h3><p>${coverage}</p></header>
        ${m.avgKcal != null || m.planRate != null ? `<dl class="weekly-food-summary">
          ${m.avgKcal != null ? `<div><dt>记录日平均能量</dt><dd><strong>${weeklyNumber(m.avgKcal)}</strong> <small>kcal</small></dd></div>` : ''}
          ${m.avgProtein != null ? `<div><dt>记录日平均蛋白质</dt><dd><strong>${weeklyNumber(m.avgProtein)}</strong> <small>g</small></dd></div>` : ''}
          ${m.planRate != null ? `<div><dt>计划餐次确认率</dt><dd><strong>${weeklyNumber(m.planRate)}</strong> <small>%</small></dd></div>` : ''}
        </dl>` : ''}
        ${weeklyEnergyChart(report)}
        <p class="weekly-chart-note">能量只汇总已记录餐食的已知数值。</p>
      </section>
      <section class="weekly-habits">
        <header class="weekly-section-heading"><h3>生活习惯</h3><p>按有记录的日期计算平均</p></header>
        <dl>
          ${['water', 'sleep', 'steps'].map(kind => weeklyHabitRow(kind, m)).join('')}
        </dl>
        <a class="btn sm" href="#/habits">查看生活习惯 →</a>
      </section>
    </div>
    ${report.text.trim() ? `<details class="weekly-text">
      <summary>查看文字周报</summary>
      <div class="reply-markdown" data-weekly-text="${esc(report.id)}"></div>
    </details>` : ''}
  </article>`;
}

function renderWeeklyReportText() {
  const body = $('[data-weekly-text]');
  if (!body) return;
  const report = S.reports.find(item => item.id === body.dataset.weeklyText);
  if (report) renderReply(body, report.text);
}

async function generateWeeklyReport(button) {
  if (weeklyUpdating) return;
  const accountState = S;
  weeklyUpdating = true;
  $$('[data-weekly-update]').forEach(control => { control.disabled = true; });
  button.textContent = '正在生成…';
  try {
    const result = await Api.generateReport({ week_start: button.dataset.weeklyUpdate });
    if (S !== accountState) return;
    const report = adaptReport(result.report);
    S.reports = [report, ...S.reports.filter(item => item.id !== report.id)];
    if (U.route === 'reports') history.replaceState(null, '', '#/reports?week=' + report.start);
    toast('已按最新记录生成周报');
  } catch (error) {
    if (S === accountState) toast(error.message || '周报生成失败，请重试', true);
  } finally {
    weeklyUpdating = false;
    if (S === accountState && U.route === 'reports') render();
  }
}

function openReportExport(button) {
  const popup = chatPopover(button, '导出周报', '<button type="button" class="chat-menu-item" data-export="md">下载 Markdown</button><button type="button" class="chat-menu-item" data-export="print">打印或保存 PDF</button>');
  popup?.addEventListener('click', async event => {
    const action = event.target.closest('[data-export]')?.dataset.export;
    if (!action) return;
    closeChatPopover();
    if (action === 'print') {
      const notes = $('.weekly-text');
      if (notes && !notes.open) {
        notes.open = true;
        window.addEventListener('afterprint', () => { notes.open = false; }, { once: true });
      }
      window.print();
      return;
    }
    const report = S.reports.find(item => item.id === button.dataset.reportId);
    if (!report) return;
    try {
      const { markdown } = await Api.exportReport(report.id);
      download(`weekly-report-${report.start}.md`, markdown);
      toast('已导出 Markdown');
    } catch (error) {
      toast(error.message || '导出失败，请重试', true);
    }
  });
}
