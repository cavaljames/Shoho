import { shoho } from './bridge';
import type { Snapshot, Settings, DrinkRecord } from './types';

function $<T extends HTMLElement = HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing element: ${selector}`);
  return element;
}
let state: Snapshot, draft: Settings, page = 'today', busy = false, historyLimit = 20;
let historyDay: string | null = null, toastTimer: ReturnType<typeof setTimeout>;
const number = (value: number) => value.toLocaleString('zh-CN');
const dayKey = (at: number | Date) => { const d = new Date(at); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const totalFor = (at: number | Date) => state.records.filter(record => dayKey(record.at) === dayKey(at)).reduce((sum, record) => sum + record.amount, 0);
const todayRecords = () => state.records.filter(record => dayKey(record.at) === dayKey(Date.now()));
function toast(message: string) {
  clearTimeout(toastTimer); $('#toast').textContent = message; $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 3500);
}
async function act(callback: () => Promise<unknown>) { try { await callback(); } catch (error) { toast(error instanceof Error ? error.message : String(error)); } }
function setPage(next: string) {
  page = ['today', 'history', 'settings'].includes(next) ? next : 'today';
  document.querySelectorAll<HTMLElement>('.page').forEach(section => { section.hidden = section.id !== `page-${page}`; });
  document.querySelectorAll<HTMLButtonElement>('[data-page]').forEach(button => { if (button.dataset.page === page) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current'); });
  if (page === 'settings') fillSettings();
  if (page === 'history') renderHistory();
}
function renderRecords(element: HTMLElement, records: DrinkRecord[], date = false) {
  element.replaceChildren();
  if (!records.length) { const empty = document.createElement('div'); empty.className = 'empty-records'; empty.textContent = '暂无记录'; element.append(empty); return; }
  for (const record of records) {
    const row = document.createElement('div'); row.className = 'record-row';
    const name = document.createElement('span'); name.className = 'record-name'; name.textContent = record.label || '饮水'; name.title = record.label || '饮水';
    const amount = document.createElement('strong'); amount.textContent = `${record.amount} ml`;
    const time = document.createElement('time'); time.className = 'record-time'; time.dateTime = new Date(record.at).toISOString();
    time.textContent = new Intl.DateTimeFormat('zh-CN', date ? { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false } : { hour: '2-digit', minute: '2-digit', hour12: false }).format(record.at);
    const remove = document.createElement('button'); remove.className = 'remove-record'; remove.textContent = '撤销'; remove.setAttribute('aria-label', `撤销 ${record.label || '饮水'} ${record.amount} ml 记录`);
    remove.addEventListener('click', () => act(async () => { remove.disabled = true; try { receive(await shoho.remove(record.id)); toast('已撤销'); } finally { if (remove.isConnected) remove.disabled = false; } }));
    row.append(name, amount, time, remove); element.append(row);
  }
}
function renderQuick() {
  $('#quick-presets').replaceChildren();
  $('#quick-presets').style.gridTemplateColumns = `repeat(${Math.min(3, state.settings.presets.length)}, minmax(0, 1fr))`;
  state.settings.presets.forEach(preset => {
    const button = document.createElement('button'); button.className = 'preset-button'; button.dataset.presetId = preset.id; button.disabled = busy;
    button.classList.toggle('is-default', preset.id === state.settings.defaultPresetId);
    button.setAttribute('aria-label', `记录${preset.name} ${preset.amount} ml`);
    const name = document.createElement('span'); name.className = 'preset-name'; name.textContent = preset.name; name.title = preset.name;
    const amount = document.createElement('span'); amount.className = 'preset-amount'; amount.textContent = `＋ ${preset.amount} ml`;
    button.append(name, amount); button.addEventListener('click', () => record(() => shoho.drinkPreset(preset.id))); $('#quick-presets').append(button);
  });
}
function render() {
  const total = totalFor(Date.now()), goal = state.settings.goal;
  $('#today-total').textContent = number(total); $('#goal-number').textContent = `${number(goal)} ml`;
  $('#goal-percent').textContent = `${Math.round(total / goal * 100)}%`;
  $<HTMLProgressElement>('#goal-progress').max = goal; $<HTMLProgressElement>('#goal-progress').value = Math.min(total, goal);
  $('#remaining-copy').textContent = total >= goal ? '今日目标已完成' : `还差 ${number(goal - total)} ml`;
  $('#record-count').textContent = String(todayRecords().length);
  renderQuick(); renderRecords($('#today-records'), [...todayRecords()].sort((a, b) => b.at - a.at).slice(0, 2));
  updateClock(); if (page === 'history') renderHistory();
}
function updateClock() {
  if (!state) return;
  $('#date-label').textContent = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' }).format(Date.now());
  let kind = state.status.kind;
  if (kind === 'paused' && state.pausedUntil <= Date.now()) kind = 'active';
  $('#reminder-status').textContent = { active: '下次提醒', paused: '已暂停', quiet: '开始提醒', off: '提醒已关闭', complete: '今日已完成' }[kind];
  if (kind === 'off' || kind === 'complete') $('#countdown').textContent = '—';
  else if (kind === 'quiet') $('#countdown').textContent = state.settings.start;
  else {
    const seconds = Math.max(0, Math.ceil(((kind === 'paused' ? state.pausedUntil : state.nextReminderAt) - Date.now()) / 1000));
    $('#countdown').textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  }
  $('#pause-button').hidden = ['off', 'complete', 'quiet'].includes(kind);
  $('#pause-button').textContent = kind === 'paused' ? '恢复' : '暂停 1h';
}
function renderHistory() {
  const days = Array.from({ length: 7 }, (_, i) => { const date = new Date(); date.setDate(date.getDate() - 6 + i); return { date, total: totalFor(date) }; });
  $('#week-total').textContent = `${number(days.reduce((sum, day) => sum + day.total, 0))} ml`;
  const max = Math.max(state.settings.goal, ...days.map(day => day.total));
  $('#week-chart').replaceChildren();
  days.forEach((day, i) => {
    const column = document.createElement('button'); column.className = 'chart-column'; column.type = 'button'; column.setAttribute('aria-pressed', String(historyDay === dayKey(day.date)));
    const label = i === 6 ? '今天' : `${day.date.getMonth() + 1}/${day.date.getDate()}`;
    column.setAttribute('aria-label', `查看${label}记录：${day.total} ml`); column.title = `${label} · ${day.total} ml`;
    const value = document.createElement('span'); value.className = 'chart-value'; value.textContent = String(day.total);
    const track = document.createElement('div'); track.className = 'chart-track';
    const bar = document.createElement('div'); bar.className = 'chart-bar'; bar.style.height = `${day.total / max * 100}%`; track.append(bar);
    const caption = document.createElement('span'); caption.className = 'chart-label'; caption.textContent = label;
    column.append(value, track, caption); column.addEventListener('click', () => { historyDay = dayKey(day.date); historyLimit = 20; renderHistory(); }); $('#week-chart').append(column);
  });
  const filtered = state.records.filter(record => !historyDay || dayKey(record.at) === historyDay).sort((a, b) => b.at - a.at);
  $('#history-filter').textContent = historyDay ? `${historyDay.slice(5).replace('-', '/')} 的记录` : '全部记录'; $('#clear-filter').hidden = !historyDay;
  renderRecords($('#history-records'), filtered.slice(0, historyLimit), true); $('#more-history').hidden = filtered.length <= historyLimit;
}
function renderPresetEditor() {
  $('#preset-editor').replaceChildren();
  for (const preset of draft.presets) {
    const row = document.createElement('div'); row.className = 'preset-edit-row'; row.dataset.id = preset.id;
    const radio = document.createElement('input'); radio.type = 'radio'; radio.name = 'defaultPreset'; radio.value = preset.id; radio.checked = preset.id === draft.defaultPresetId; radio.setAttribute('aria-label', `默认快捷项 ${preset.name}`);
    radio.addEventListener('change', () => { draft.defaultPresetId = preset.id; });
    const name = document.createElement('input'); name.type = 'text'; name.value = preset.name; name.required = true; name.maxLength = 12; name.setAttribute('aria-label', '快捷项名称');
    name.addEventListener('input', () => { preset.name = name.value; radio.setAttribute('aria-label', `默认快捷项 ${name.value}`); });
    const amount = document.createElement('input'); amount.type = 'number'; amount.min = '10'; amount.max = '1000'; amount.required = true; amount.value = String(preset.amount); amount.setAttribute('aria-label', '快捷项水量'); amount.addEventListener('input', () => { preset.amount = Number(amount.value); });
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'delete-preset'; remove.textContent = '×'; remove.disabled = draft.presets.length === 1; remove.setAttribute('aria-label', `删除快捷项 ${preset.name}`);
    remove.addEventListener('click', () => { draft.presets = draft.presets.filter(item => item.id !== preset.id); if (draft.defaultPresetId === preset.id) draft.defaultPresetId = draft.presets[0].id; renderPresetEditor(); });
    row.append(radio, name, amount, remove); $('#preset-editor').append(row);
  }
  $<HTMLButtonElement>('#add-preset').disabled = draft.presets.length >= 8;
}
function fillSettings() {
  draft = { ...state.settings, presets: state.settings.presets.map(preset => ({ ...preset })) };
  const form = $<HTMLFormElement>('#settings-form');
  for (const key of ['goal', 'interval', 'start', 'end'] as const) (form.elements.namedItem(key) as HTMLInputElement).value = String(draft[key]);
  for (const key of ['enabled', 'systemNotifications', 'launchAtLogin'] as const) (form.elements.namedItem(key) as HTMLInputElement).checked = draft[key];
  (form.elements.namedItem('launchAtLogin') as HTMLInputElement).disabled = !state.packaged;
  $('#login-caption').textContent = state.packaged ? '' : '安装后可开启';
  $('#notification-settings').hidden = !['macos', 'windows'].includes(state.platform);
  $('#notification-hint').hidden = true; $('#settings-message').textContent = ''; renderPresetEditor();
}
function receive(next: Snapshot) { state = next; render(); }
async function record(operation: () => Promise<Snapshot>) {
  if (busy) return; busy = true; renderQuick();
  try { receive(await operation()); $<HTMLDialogElement>('#custom-dialog').close(); toast('已记录'); }
  catch (error) { toast(error instanceof Error ? error.message : String(error)); }
  finally { busy = false; renderQuick(); }
}
document.querySelectorAll<HTMLButtonElement>('[data-page]').forEach(button => button.addEventListener('click', () => setPage(button.dataset.page || 'today')));
$('#home-button').addEventListener('click', () => setPage('today')); $('#edit-goal').addEventListener('click', () => setPage('settings'));
$('#show-history').addEventListener('click', () => { historyDay = dayKey(Date.now()); setPage('history'); });
$('#clear-filter').addEventListener('click', () => { historyDay = null; historyLimit = 20; renderHistory(); });
$('#more-history').addEventListener('click', () => { historyLimit += 20; renderHistory(); });
$('#pause-button').addEventListener('click', () => act(async () => { receive(await shoho.pause(state.pausedUntil > Date.now() ? 0 : 60)); }));
$('#custom-button').addEventListener('click', () => { $<HTMLInputElement>('#custom-amount').value = String(state.settings.cup); $<HTMLInputElement>('#custom-name').value = ''; $<HTMLDialogElement>('#custom-dialog').showModal(); });
$('#close-dialog').addEventListener('click', () => $<HTMLDialogElement>('#custom-dialog').close());
$('#custom-form').addEventListener('submit', event => { event.preventDefault(); record(() => shoho.drink(Number($<HTMLInputElement>('#custom-amount').value), $<HTMLInputElement>('#custom-name').value.trim() || undefined)); });
$('#add-preset').addEventListener('click', () => { if (draft.presets.length >= 8) return; draft.presets.push({ id: crypto.randomUUID(), name: '自定义', amount: 200 }); renderPresetEditor(); $('#preset-editor').lastElementChild?.querySelector<HTMLInputElement>('[type=text]')?.select(); });
$('#test-reminder').addEventListener('click', () => act(() => shoho.testReminder()));
async function openNotifications() {
  const button = $<HTMLButtonElement>('#notification-settings'); button.disabled = true; $('#notification-hint').hidden = true;
  try { await shoho.openNotificationSettings(); $('#notification-hint').textContent = '已打开系统通知设置，授权状态以系统设置为准。'; $('#notification-hint').hidden = false; }
  finally { button.disabled = false; }
}
$('#notification-settings').addEventListener('click', () => act(openNotifications));
($<HTMLFormElement>('#settings-form').elements.namedItem('systemNotifications') as HTMLInputElement).addEventListener('change', event => {
  if ((event.target as HTMLInputElement).checked) act(openNotifications);
  else $('#notification-hint').hidden = true;
});
$('#settings-form').addEventListener('submit', event => {
  event.preventDefault(); act(async () => {
    const form = $<HTMLFormElement>('#settings-form'), save = form.querySelector<HTMLButtonElement>('[type=submit]')!;
    const settings: Settings = { ...draft, presets: draft.presets.map(preset => ({ ...preset, name: preset.name.trim() })) };
    for (const key of ['goal', 'interval'] as const) settings[key] = Number((form.elements.namedItem(key) as HTMLInputElement).value);
    for (const key of ['start', 'end'] as const) settings[key] = (form.elements.namedItem(key) as HTMLInputElement).value;
    for (const key of ['enabled', 'systemNotifications', 'launchAtLogin'] as const) settings[key] = (form.elements.namedItem(key) as HTMLInputElement).checked;
    settings.cup = settings.presets.find(preset => preset.id === settings.defaultPresetId)!.amount;
    save.disabled = true; try { receive(await shoho.saveSettings(settings)); draft = { ...state.settings, presets: state.settings.presets.map(preset => ({ ...preset })) }; $('#settings-message').textContent = '已保存'; } finally { save.disabled = false; }
  });
});
act(async () => { await shoho.onState(receive); await shoho.onNotice(toast); receive(await shoho.getState()); await shoho.ready(); if (state.storageWarning) toast(state.storageWarning); });
setInterval(updateClock, 1000);
