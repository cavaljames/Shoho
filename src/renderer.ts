import { shoho } from './bridge';
import type { Snapshot, Settings, DrinkRecord } from './types';
function $<T extends HTMLElement = HTMLElement>(selector: string): T { const element = document.querySelector<T>(selector); if (!element) throw new Error(`Missing element: ${selector}`); return element; }
let state: Snapshot, page = 'today', toastTimer: ReturnType<typeof setTimeout>, historyLimit = 30, drinking = false;
const number = (value: number) => value.toLocaleString('zh-CN');
const localDay = (time: number | Date) => { const date = new Date(time); return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`; };
const totalFor = (date: number | Date) => state.records.filter(record => localDay(record.at) === localDay(date)).reduce((sum, record) => sum + record.amount, 0);
const todayRecords = () => state.records.filter(record => localDay(record.at) === localDay(Date.now()));
function toast(message: string) { clearTimeout(toastTimer); $('#toast').textContent = message; $('#toast').hidden = false; toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 4200); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
async function act<T>(callback: () => Promise<T>) { try { return await callback(); } catch (error) { toast(errorMessage(error)); return null; } }
function setPage(next: string) {
  if (!['today', 'history', 'settings'].includes(next)) next = 'today';
  page = next;
  document.querySelectorAll<HTMLElement>('.page').forEach(section => { section.hidden = section.id !== `page-${next}`; });
  document.querySelectorAll<HTMLButtonElement>('[data-page]').forEach(button => { const active = button.dataset.page === next; button.classList.toggle('selected', active); if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current'); });
  if (next === 'settings' && state) fillSettings();
  if (next === 'history' && state) renderHistory();
}
function recordList(element: HTMLElement, records: DrinkRecord[], withDate = false) {
  element.replaceChildren();
  if (!records.length) {
    const empty = document.createElement('div'); empty.className = 'empty-records';
    const icon = document.createElement('span'); icon.textContent = '◒';
    const copy = document.createElement('div'); copy.textContent = withDate ? '还没有饮水足迹，从今天的第一杯开始吧。' : '第一杯水，随时都可以开始。';
    empty.append(icon, copy); element.append(empty); return;
  }
  for (const record of [...records].sort((a, b) => b.at - a.at)) {
    const row = document.createElement('div'); row.className = 'record-row';
    const icon = document.createElement('span'); icon.className = 'record-icon'; icon.textContent = '◒';
    const amount = document.createElement('strong'); amount.textContent = `${record.amount} ml`;
    const time = document.createElement('time'); time.className = 'record-time'; time.dateTime = new Date(record.at).toISOString(); time.textContent = new Intl.DateTimeFormat('zh-CN', withDate ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false } : { hour: '2-digit', minute: '2-digit', hour12: false }).format(record.at);
    const remove = document.createElement('button'); remove.className = 'remove-record'; remove.textContent = '撤销'; remove.setAttribute('aria-label', `撤销 ${time.textContent} 的 ${record.amount} ml 记录`);
    remove.addEventListener('click', async () => { remove.disabled = true; await act(async () => { receive(await shoho.remove(record.id)); toast('已撤销这次记录。'); }); if (remove.isConnected) remove.disabled = false; });
    row.append(icon, amount, time, remove); element.append(row);
  }
}
function render() {
  const total = totalFor(Date.now()), goal = state.settings.goal, percent = Math.round(total / goal * 100);
  $('#today-total').textContent = number(total); $('#goal-number').textContent = `${number(goal)} ml`; $('#goal-percent').textContent = `${percent}%`;
  $<HTMLProgressElement>('#goal-progress').max = goal; $<HTMLProgressElement>('#goal-progress').value = Math.min(total, goal);
  $('#cup-caption').textContent = `${state.settings.cup} ml`;
  $('#remaining-copy').textContent = total >= goal ? '今天的小目标完成啦，好好照顾自己。' : total ? `离今日目标还有 ${number(goal - total)} ml，慢慢来。` : '一小口，也是一个好的开始。';
  $('#record-count').textContent = String(todayRecords().length);
  recordList($('#today-records'), todayRecords());
  $('#reminder-hours').textContent = `${state.settings.start} — ${state.settings.end} · 每 ${state.settings.interval} 分钟`;
  $('#version').textContent = `v${state.version}`;
  updateClock(); if (page === 'history') renderHistory();
}
function updateClock() {
  if (!state) return;
  const now = Date.now();
  $('#date-label').textContent = `${new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }).format(now)} · A FRESH LITTLE DAY`;
  let status = state.status.kind;
  if (status === 'paused' && state.pausedUntil <= now) status = 'active';
  const countdown = $('#countdown'), copy = $('#reminder-copy'), pause = $('#pause-button');
  $('#reminder-status').textContent = { active: '提醒中', off: '已关闭', paused: '暂停中', quiet: '休息中', complete: '已达成' }[status];
  pause.textContent = status === 'paused' ? '▷ 恢复提醒' : 'Ⅱ 暂停 1 小时';
  pause.hidden = ['off', 'complete', 'quiet'].includes(status);
  if (status === 'off') { countdown.textContent = '已关闭'; copy.textContent = '在提醒设置中开启，继续陪你喝水。'; }
  else if (status === 'complete') { countdown.textContent = '完成啦'; copy.textContent = '今天的小目标已达成，明天继续。'; }
  else if (status === 'quiet') { countdown.textContent = state.settings.start; copy.textContent = '现在是休息时段，到点再提醒你。'; }
  else {
    const remaining = Math.max(0, Math.ceil(((status === 'paused' ? state.pausedUntil : state.nextReminderAt) - now) / 1000));
    const minute = String(Math.floor(remaining / 60)).padStart(2, '0'), second = String(remaining % 60).padStart(2, '0');
    countdown.replaceChildren(document.createTextNode(minute)); const span = document.createElement('span'); span.textContent = `:${second}`; countdown.append(span);
    copy.textContent = status === 'paused' ? '留一点安静时间，结束后自动恢复。' : '小喝会在时间到了以后轻轻提醒你。';
  }
}
function renderHistory() {
  const days = Array.from({ length: 7 }, (_, index) => { const date = new Date(); date.setDate(date.getDate() - (6 - index)); return { date, total: totalFor(date) }; });
  const total = days.reduce((sum, day) => sum + day.total, 0), recordedDays = days.filter(day => day.total > 0).length;
  const metrics: [string, number, string][] = [['week-total', total, 'ml'], ['week-days', recordedDays, '/ 7 天'], ['week-average', recordedDays ? Math.round(total / recordedDays) : 0, 'ml']];
  for (const [id, value, unit] of metrics) {
    const small = document.createElement('small'); small.textContent = unit; $(`#${id}`).replaceChildren(document.createTextNode(`${number(value)} `), small);
  }
  const chart = $('#week-chart'); chart.replaceChildren(); const max = Math.max(state.settings.goal * 1.2, ...days.map(day => day.total));
  days.forEach((day, index) => {
    const column = document.createElement('div'); column.className = 'chart-column';
    const value = document.createElement('span'); value.className = 'chart-value'; value.textContent = `${day.total} ml`;
    const track = document.createElement('div'); track.className = 'chart-track';
    const bar = document.createElement('div'); bar.className = 'chart-bar'; bar.style.height = `${day.total / max * 100}%`;
    const target = document.createElement('div'); target.className = 'chart-target'; target.style.bottom = `${state.settings.goal / max * 100}%`;
    const label = document.createElement('span'); label.className = 'chart-label'; label.textContent = index === 6 ? '今天' : `${day.date.getMonth() + 1}/${day.date.getDate()}`;
    column.setAttribute('aria-label', `${label.textContent}：${day.total} ml`); track.append(target, bar); column.append(value, track, label); chart.append(column);
  });
  recordList($('#history-records'), [...state.records].sort((a, b) => b.at - a.at).slice(0, historyLimit), true);
  $('#more-history').hidden = state.records.length <= historyLimit;
}
function fillSettings() {
  for (const [key, value] of Object.entries(state.settings)) {
    const input = $<HTMLFormElement>('#settings-form').elements.namedItem(key) as HTMLInputElement;
    if (typeof value === 'boolean') input.checked = value; else input.value = value;
  }
  ($<HTMLFormElement>('#settings-form').elements.namedItem('launchAtLogin') as HTMLInputElement).disabled = !state.packaged;
  if (!state.packaged) $('#login-caption').textContent = '安装打包后的应用即可开启，开发模式下暂不可用。';
  $('#settings-message').textContent = '';
}
function receive(next: Snapshot) { state = next; render(); }
async function drink(amount: number) {
  if (drinking) return; drinking = true; $<HTMLButtonElement>('#drink-button').disabled = true;
  try {
    const previous = totalFor(Date.now());
    receive(await shoho.drink(amount));
    $<HTMLDialogElement>('#custom-dialog').close();
    toast(previous < state.settings.goal && totalFor(Date.now()) >= state.settings.goal ? '今天的小目标完成啦！每一小口，都算数。' : `记下了 ${amount} ml，给自己一点滋润。`);
  } catch (error) { toast(errorMessage(error)); }
  finally { drinking = false; $<HTMLButtonElement>('#drink-button').disabled = false; }
}
document.querySelectorAll<HTMLButtonElement>('[data-page]').forEach(button => button.addEventListener('click', () => setPage(button.dataset.page ?? 'today')));
$('.brand').addEventListener('click', event => { event.preventDefault(); setPage('today'); });
$<HTMLButtonElement>('#drink-button').addEventListener('click', () => drink(state.settings.cup));
$('#custom-button').addEventListener('click', () => { $<HTMLInputElement>('#custom-amount').value = String(state.settings.cup); $<HTMLDialogElement>('#custom-dialog').showModal(); $<HTMLInputElement>('#custom-amount').select(); });
$('#close-dialog').addEventListener('click', () => $<HTMLDialogElement>('#custom-dialog').close());
document.querySelectorAll<HTMLButtonElement>('[data-amount]').forEach(button => button.addEventListener('click', () => { $<HTMLInputElement>('#custom-amount').value = button.dataset.amount ?? '200'; }));
$('#custom-form').addEventListener('submit', event => { event.preventDefault(); drink(Number($<HTMLInputElement>('#custom-amount').value)); });
$<HTMLButtonElement>('#pause-button').addEventListener('click', () => act(async () => { receive(await shoho.pause(state.pausedUntil > Date.now() ? 0 : 60)); }));
$('#test-reminder').addEventListener('click', () => act(() => shoho.testReminder()));
$('#more-history').addEventListener('click', () => { historyLimit += 30; renderHistory(); });
$<HTMLFormElement>('#settings-form').addEventListener('submit', event => {
  event.preventDefault();
  act(async () => {
    const form = $<HTMLFormElement>('#settings-form'), button = form.querySelector<HTMLButtonElement>('[type=submit]')!;
    const settings = {} as Settings;
    for (const key of ['goal', 'cup', 'interval'] as const) settings[key] = Number((form.elements.namedItem(key) as HTMLInputElement).value);
    for (const key of ['start', 'end'] as const) settings[key] = (form.elements.namedItem(key) as HTMLInputElement).value;
    for (const key of ['enabled', 'systemNotifications', 'launchAtLogin'] as const) settings[key] = (form.elements.namedItem(key) as HTMLInputElement).checked;
    button.disabled = true;
    try { receive(await shoho.saveSettings(settings)); $('#settings-message').textContent = '已保存，按你的节奏来。'; }
    finally { button.disabled = false; }
  });
});
act(async () => { await shoho.onState(receive); await shoho.onNotice(toast); receive(await shoho.getState()); fillSettings(); await shoho.ready(); if (state.storageWarning) toast(state.storageWarning); });
setInterval(updateClock, 1000);
