// UI regression with mocked IPC; Rust tests cover native validation, migration and persistence.
import { chromium } from 'playwright';
import { createServer } from 'vite';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
const server = await createServer(); await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 480, height: 620 }, timezoneId: 'Asia/Shanghai' });
const errors = [];
await context.addInitScript(() => {
  const settings = { goal: 1800, cup: 200, presets: [{ id: 'sip', name: '一口', amount: 30 }, { id: 'cup', name: '一杯', amount: 200 }, { id: 'bowl', name: '一碗', amount: 350 }], defaultPresetId: 'cup', interval: 45, start: '00:00', end: '23:59', enabled: true, systemNotifications: false, launchAtLogin: false };
  const state = JSON.parse(localStorage.getItem('shoho-fixture') || 'null') || { settings, records: [], pausedUntil: 0, nextReminderAt: Date.now() + 45 * 60000, platform: 'macos', version: '0.4.0', packaged: false, storageWarning: '' };
  let counter = 1; const callbacks = new Map(), listeners = new Map();
  window.__shohoCalls = [];
  const snapshot = () => { const total = state.records.reduce((sum, record) => sum + record.amount, 0); state.status = { kind: !state.settings.enabled ? 'off' : state.pausedUntil > Date.now() ? 'paused' : total >= state.settings.goal ? 'complete' : 'active', at: state.nextReminderAt }; return structuredClone(state); };
  const changed = () => { localStorage.setItem('shoho-fixture', JSON.stringify(state)); for (const [id, listener] of listeners) if (listener.event === 'shoho:changed') callbacks.get(listener.handler)({ event: listener.event, id, payload: snapshot() }); return snapshot(); };
  window.__TAURI_INTERNALS__ = {
    transformCallback: callback => { const id = counter++; callbacks.set(id, callback); return id; },
    invoke: async (command, args) => {
      window.__shohoCalls.push({ command, args });
      if (command === 'plugin:event|listen') { const id = counter++; listeners.set(id, args); return id; }
      if (['window_ready', 'test_reminder', 'dismiss_reminder', 'open_notification_settings'].includes(command)) return;
      if (command === 'get_state') return snapshot();
      if (command === 'get_monthly_report') {
        const key = `${args.year}-${String(args.month).padStart(2, '0')}`;
        const report = JSON.parse(localStorage.getItem('shoho-report-fixtures') || '{}')[key];
        const delay = JSON.parse(localStorage.getItem('shoho-report-delays') || '{}')[key] || 0;
        if (delay) await new Promise(resolve => setTimeout(resolve, delay));
        if (localStorage.getItem('shoho-report-error')) throw new Error('月报暂不可用，请重试');
        if (!report) throw new Error(`Missing monthly fixture: ${key}`);
        return report;
      }
      if (command === 'drink' || command === 'drink_preset') {
        const preset = command === 'drink_preset' ? state.settings.presets.find(preset => preset.id === args.id) : null;
        if (command === 'drink_preset' && !preset) throw new Error('快捷项不存在');
        state.records.push({ id: crypto.randomUUID(), amount: preset?.amount ?? args.amount, label: preset?.name ?? args.label, at: Date.now() }); state.pausedUntil = 0; state.nextReminderAt = Date.now() + state.settings.interval * 60000; return changed();
      }
      if (command === 'remove_record') { state.records = state.records.filter(record => record.id !== args.id); return changed(); }
      if (command === 'save_settings') { state.settings = args.settings; return changed(); }
      if (command === 'pause_reminders') { state.pausedUntil = args.minutes ? Date.now() + args.minutes * 60000 : 0; return changed(); }
      throw new Error(`Unexpected IPC: ${command}`);
    }
  };
});
mkdirSync('test-artifacts', { recursive: true });
const waitTotal = (page, value) => page.waitForFunction(value => document.querySelector('#today-total').textContent === value, value);
const saveSettings = async page => { await page.getByRole('button', { name: '保存设置', exact: true }).click(); await page.waitForFunction(() => document.querySelector('#settings-message').textContent === '已保存'); };
try {
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:1420'); await page.waitForFunction(() => document.querySelector('#date-label').textContent.length > 0);
  await page.waitForFunction(() => [...document.images].every(image => image.complete && image.naturalWidth > 0));
  assert.equal(await page.locator('.preset-button').count(), 3);
  await page.getByRole('button', { name: '记录一口 30 ml', exact: true }).click(); await waitTotal(page, '30');
  await page.locator('#custom-button').click(); await page.locator('#custom-name').fill('半瓶'); await page.locator('#custom-amount').fill('150'); await page.locator('#custom-form [type=submit]').click(); await waitTotal(page, '180');
  await page.getByRole('button', { name: '撤销 一口 30 ml 记录', exact: true }).click(); await waitTotal(page, '150');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const bowl = page.locator('.preset-edit-row[data-id=bowl]'); await bowl.getByLabel('快捷项名称').fill('我的碗'); await bowl.getByLabel('快捷项水量').fill('450'); await bowl.locator('[type=radio]').check();
  await page.locator('[name=goal]').fill('2000');
  await page.locator('[name=systemNotifications]').check();
  await page.waitForFunction(() => window.__shohoCalls.some(call => call.command === 'open_notification_settings'));
  await page.locator('#notification-settings').click();
  assert.equal(await page.evaluate(() => window.__shohoCalls.filter(call => call.command === 'open_notification_settings').length), 2);
  assert.match(await page.locator('#notification-hint').innerText(), /系统通知设置/);
  await page.locator('#add-preset').click(); const bottle = page.locator('.preset-edit-row').last(); await bottle.getByLabel('快捷项名称').fill('一瓶'); await bottle.getByLabel('快捷项水量').fill('500'); await saveSettings(page);
  await page.getByRole('button', { name: '今日', exact: true }).click();
  assert.match(await page.getByRole('button', { name: '记录我的碗 450 ml', exact: true }).getAttribute('class'), /is-default/);
  await page.getByRole('button', { name: '记录我的碗 450 ml', exact: true }).click(); await waitTotal(page, '600');
  await page.getByRole('button', { name: '记录一瓶 500 ml', exact: true }).click(); await waitTotal(page, '1,100');
  await page.getByRole('button', { name: '设置', exact: true }).click(); await page.getByRole('button', { name: '删除快捷项 一瓶', exact: true }).click(); await saveSettings(page);
  await page.screenshot({ path: 'test-artifacts/settings-compact.png', fullPage: true });
  await page.getByRole('button', { name: '今日', exact: true }).click();
  assert.equal(await page.locator('.preset-button').count(), 3);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: 'test-artifacts/compact-today.png' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollHeight > innerHeight), false, JSON.stringify(await page.evaluate(() => ({height:document.documentElement.scrollHeight,sections:[...document.querySelectorAll('#page-today>*,.tabs,.app-header')].map(e=>({name:e.className,height:e.getBoundingClientRect().height,top:e.getBoundingClientRect().top}))}))));
  await page.screenshot({ path: 'test-artifacts/compact-today.png' });
  await page.getByRole('button', { name: '记录', exact: true }).click();
  assert.equal(await page.locator('#week-total').innerText(), '1,100 ml'); assert.equal(await page.locator('.chart-column').count(), 7);
  await page.getByRole('button', { name: '查看今天记录：1100 ml', exact: true }).click(); assert.equal(await page.locator('#clear-filter').isVisible(), true); assert.equal(await page.locator('#history-records .record-row').count(), 3); await page.locator('#clear-filter').click();
  await page.screenshot({ path: 'test-artifacts/history-compact.png' });

  const reminder = await context.newPage(); reminder.on('pageerror', error => errors.push(error.message)); await reminder.setViewportSize({ width: 320, height: 220 }); await reminder.goto('http://127.0.0.1:1420/reminder.html');
  await reminder.waitForFunction(() => document.querySelectorAll('.reminder-option').length === 3);
  assert.equal(await reminder.getByRole('button', { name: '选择我的碗 450 ml', exact: true }).getAttribute('aria-pressed'), 'true'); assert.equal(await reminder.locator('#reminder-drink').innerText(), '记录 ＋450 ml');
  assert.equal(await reminder.evaluate(() => document.activeElement.id), 'reminder-title');
  const frame = await reminder.evaluate(() => { const style = getComputedStyle(document.body, '::after'); return { widths: [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth], colors: [style.borderTopColor, style.borderRightColor, style.borderBottomColor, style.borderLeftColor], background: getComputedStyle(document.body).backgroundColor, height: document.documentElement.scrollHeight }; });
  assert.deepEqual(frame.widths, ['1px', '1px', '1px', '1px']); assert.equal(new Set(frame.colors).size, 1); assert.equal(frame.background, 'rgb(248, 250, 248)'); assert.equal(frame.height, 220);
  await reminder.screenshot({ path: 'test-artifacts/reminder-compact.png' });
  const original = await reminder.evaluate(() => localStorage.getItem('shoho-fixture'));
  await reminder.evaluate(() => { const fixture = JSON.parse(localStorage.getItem('shoho-fixture')); while (fixture.settings.presets.length < 8) fixture.settings.presets.push({ id: `extra-${fixture.settings.presets.length}`, name: `水量${fixture.settings.presets.length}`, amount: 100 }); localStorage.setItem('shoho-fixture', JSON.stringify(fixture)); });
  const expanded = await context.newPage(); await expanded.setViewportSize({ width: 320, height: 328 }); await expanded.goto('http://127.0.0.1:1420/reminder.html'); await expanded.waitForFunction(() => document.querySelectorAll('.reminder-option').length === 8);
  assert.equal(await expanded.evaluate(() => document.documentElement.scrollHeight > innerHeight), false);
  await expanded.screenshot({ path: 'test-artifacts/reminder-eight-presets.png' }); await expanded.close();
  await reminder.evaluate(saved => localStorage.setItem('shoho-fixture', saved), original);

  await reminder.getByRole('button', { name: '选择一杯 200 ml', exact: true }).click(); await reminder.locator('#reminder-drink').click();
  assert.equal(await reminder.evaluate(() => JSON.parse(localStorage.getItem('shoho-fixture')).records.at(-1).label), '一杯'); await reminder.close();
  await page.reload(); await waitTotal(page, '1,300'); await page.locator('#pause-button').click(); await page.waitForFunction(() => document.querySelector('#reminder-status').textContent === '已暂停'); await page.locator('#pause-button').click(); await page.waitForFunction(() => document.querySelector('#reminder-status').textContent === '下次提醒');
  await page.getByRole('button', { name: '设置', exact: true }).click(); await page.getByRole('button', { name: '删除快捷项 我的碗', exact: true }).click(); await saveSettings(page); await page.getByRole('button', { name: '今日', exact: true }).click();
  assert.match(await page.getByRole('button', { name: '记录一口 30 ml', exact: true }).getAttribute('class'), /is-default/);
  await page.getByRole('button', { name: '记录', exact: true }).click(); assert.equal(await page.locator('#history-records .record-name').filter({ hasText: '我的碗' }).count(), 1, 'Saved record labels survive preset deletion');
  await page.getByRole('button', { name: '设置', exact: true }).click(); await page.getByRole('button', { name: '删除快捷项 一杯', exact: true }).click(); assert.equal(await page.locator('.delete-preset').isDisabled(), true);
  await page.getByRole('button', { name: '今日', exact: true }).click(); await page.setViewportSize({ width: 420, height: 540 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.reload(); await waitTotal(page, '1,300'); assert.equal(await page.locator('.preset-button').count(), 2);
  // Fixed report responses test rendering and IPC lifecycle; Rust tests own the calculations.
  await page.clock.setFixedTime(new Date('2026-11-25T12:00:00+08:00'));
  await page.setViewportSize({ width: 480, height: 620 });
  await page.evaluate(() => {
    const fixture = JSON.parse(localStorage.getItem('shoho-fixture'));
    fixture.settings.goal = 1000;
    fixture.records = [
      { id: 'oct-1', amount: 500, at: Date.parse('2026-10-01T08:00:00+08:00') },
      { id: 'oct-2', amount: 500, at: Date.parse('2026-10-31T12:00:00+08:00') },
      { id: 'nov-1', amount: 1000, label: '一瓶', at: Date.parse('2026-11-01T09:00:00+08:00') },
      { id: 'nov-2', amount: 200, label: '一杯', at: Date.parse('2026-11-02T13:00:00+08:00') },
      { id: 'nov-3', amount: 800, label: '一碗', at: Date.parse('2026-11-02T14:00:00+08:00') },
      { id: 'nov-4', amount: 1000, label: '一瓶', at: Date.parse('2026-11-05T19:00:00+08:00') }
    ];
    localStorage.setItem('shoho-fixture', JSON.stringify(fixture));
    const november = {
      year: 2026, month: 11, goal: 1000, daysInMonth: 30, elapsedDays: 25,
      total: 3000, average: 120, activeDays: 3, goalDays: 3, longestStreak: 2, recordCount: 4,
      previous: { year: 2026, month: 10, average: 32, changePercent: 272 },
      days: Array.from({ length: 30 }, (_, index) => ({ date: `2026-11-${String(index + 1).padStart(2, '0')}`, total: [0, 1, 4].includes(index) ? 1000 : 0, count: index === 1 ? 2 : [0, 4].includes(index) ? 1 : 0 })),
      timeSlots: ['凌晨', '上午', '下午', '晚上'].map((label, index) => ({ label, startHour: index * 6, total: index ? 1000 : 0, count: index === 2 ? 2 : index ? 1 : 0 })),
      insights: ['已在 3 天记录饮水，最长连续 2 天。', '2026-11-05 的记录水量最多，共 1000 ml。']
    };
    const october = {
      ...november, month: 10, daysInMonth: 31, elapsedDays: 31, total: 1000, average: 32, activeDays: 2, goalDays: 0, longestStreak: 1, recordCount: 2, previous: null,
      days: Array.from({ length: 31 }, (_, index) => ({ date: `2026-10-${String(index + 1).padStart(2, '0')}`, total: [0, 30].includes(index) ? 500 : 0, count: [0, 30].includes(index) ? 1 : 0 })),
      timeSlots: ['凌晨', '上午', '下午', '晚上'].map((label, index) => ({ label, startHour: index * 6, total: [1, 2].includes(index) ? 500 : 0, count: [1, 2].includes(index) ? 1 : 0 })),
      insights: ['已在 2 天记录饮水，最长连续 1 天。', '2026-10-31 的记录水量最多，共 500 ml。']
    };
    const december = { ...november, month: 12, daysInMonth: 31, elapsedDays: 1, total: 0, average: 0, activeDays: 0, goalDays: 0, longestStreak: 0, recordCount: 0, insights: [], days: Array.from({ length: 31 }, (_, index) => ({ date: `2026-12-${String(index + 1).padStart(2, '0')}`, total: 0, count: 0 })), timeSlots: november.timeSlots.map(slot => ({ ...slot, total: 0, count: 0 })) };
    localStorage.setItem('shoho-report-fixtures', JSON.stringify({ '2026-10': october, '2026-11': november, '2026-12': december }));
  });
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#date-label').textContent.length > 0);
  await page.getByRole('button', { name: '记录', exact: true }).click();
  assert.equal(await page.evaluate(() => window.__shohoCalls.some(call => call.command === 'get_monthly_report')), false, 'Load reports on demand');
  await page.getByRole('button', { name: '月度报告', exact: true }).click();
  const waitReport = async (month, total) => page.waitForFunction(({ month, total }) => !document.querySelector('#report-content').hidden && document.querySelector('#report-month').textContent === month && document.querySelector('#report-total').textContent === total, { month, total });
  await waitReport('2026 年 11 月', '3,000');
  assert.equal(await page.locator('#report-average').innerText(), '120');
  assert.equal(await page.locator('#report-goal-days').innerText(), '3 / 25');
  assert.match(await page.locator('#report-comparison').innerText(), /272%/);
  assert.equal(await page.locator('.report-day').count(), 30);
  assert.equal(await page.locator('.report-day:disabled').count(), 5);
  assert.equal(await page.locator('[data-date="2026-11-01"]').getAttribute('data-level'), 'goal');
  assert.equal(await page.locator('#report-next').isDisabled(), true);
  assert.equal(await page.locator('.report-weekdays span').first().innerText(), '一');
  await page.locator('.report-times summary').click();
  assert.equal(await page.locator('.report-slot').count(), 4);
  await page.locator('.report-notes summary').click();
  assert.match(await page.locator('#report-method').innerText(), /当前每日目标 1,000 ml/);
  await page.screenshot({ path: 'test-artifacts/monthly-report.png', fullPage: true });
  await page.locator('.report-times summary').click(); await page.locator('.report-notes summary').click();
  await page.locator('[data-date="2026-11-02"]').click();
  assert.equal(await page.locator('#history-details').isVisible(), true);
  assert.equal(await page.locator('#history-filter').innerText(), '11/02 的记录');
  assert.equal(await page.locator('#history-records .record-row').count(), 2);
  await page.getByRole('button', { name: '月度报告', exact: true }).click(); await waitReport('2026 年 11 月', '3,000');
  await page.locator('#report-prev').click(); await waitReport('2026 年 10 月', '1,000');
  assert.equal(await page.locator('.report-day').count(), 31);
  assert.equal(await page.locator('#report-prev').isDisabled(), true);
  assert.equal(await page.locator('#report-comparison').innerText(), '上月暂无记录');
  await page.screenshot({ path: 'test-artifacts/monthly-previous.png' });
  // A delayed November response must not replace the more recently selected October.
  await page.evaluate(() => localStorage.setItem('shoho-report-delays', JSON.stringify({ '2026-11': 500 })));
  await page.locator('#report-next').click();
  await page.waitForFunction(() => !document.querySelector('#report-loading').hidden);
  await page.locator('#report-prev').click(); await waitReport('2026 年 10 月', '1,000');
  await page.waitForTimeout(650); await waitReport('2026 年 10 月', '1,000');
  await page.evaluate(() => { localStorage.removeItem('shoho-report-delays'); localStorage.setItem('shoho-report-error', '1'); });
  await page.locator('#report-current').click(); await page.locator('#report-error').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#report-content').isVisible(), false);
  assert.match(await page.locator('#report-error-message').innerText(), /请重试/);
  await page.evaluate(() => localStorage.removeItem('shoho-report-error'));
  await page.locator('#report-retry').click(); await waitReport('2026 年 11 月', '3,000');
  // A tray-style state event should refresh an open report without a page reload.
  await page.evaluate(async () => {
    const reports = JSON.parse(localStorage.getItem('shoho-report-fixtures'));
    Object.assign(reports['2026-11'], { total: 3200, average: 128, activeDays: 4, recordCount: 5 });
    Object.assign(reports['2026-11'].days[24], { total: 200, count: 1 });
    reports['2026-11'].previous.changePercent = 296.8;
    Object.assign(reports['2026-11'].timeSlots[2], { total: 1200, count: 3 });
    reports['2026-11'].insights = ['已在 4 天记录饮水，最长连续 2 天。', '下午（12:00–18:00）记录的水量最多，占 38%。'];
    localStorage.setItem('shoho-report-fixtures', JSON.stringify(reports));
    await window.__TAURI_INTERNALS__.invoke('drink', { amount: 200, label: '一杯' });
  });
  await waitReport('2026 年 11 月', '3,200');
  assert.match(await page.locator('#report-insights').innerText(), /已在 4 天记录饮水/);
  assert.match(await page.locator('#report-comparison').innerText(), /296.8%/);
  await page.setViewportSize({ width: 420, height: 540 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: 'test-artifacts/monthly-narrow.png', fullPage: true });
  // Removing the oldest records must not leave enabled month navigation unresponsive.
  await page.evaluate(() => {
    const fixture = JSON.parse(localStorage.getItem('shoho-fixture'));
    fixture.records.push({ id: 'sep-1', amount: 500, at: Date.parse('2026-09-01T08:00:00+08:00') });
    localStorage.setItem('shoho-fixture', JSON.stringify(fixture));
    const reports = JSON.parse(localStorage.getItem('shoho-report-fixtures'));
    reports['2026-09'] = { ...reports['2026-10'], month: 9, daysInMonth: 30, elapsedDays: 30, total: 500, average: 17, activeDays: 1, recordCount: 1,
      days: Array.from({ length: 30 }, (_, index) => ({ date: `2026-09-${String(index + 1).padStart(2, '0')}`, total: index ? 0 : 500, count: index ? 0 : 1 })),
      timeSlots: reports['2026-10'].timeSlots.map((slot, index) => ({ ...slot, total: index === 1 ? 500 : 0, count: index === 1 ? 1 : 0 })),
      insights: ['已在 1 天记录饮水，最长连续 1 天。', '2026-09-01 的记录水量最多，共 500 ml。'] };
    localStorage.setItem('shoho-report-fixtures', JSON.stringify(reports));
  });
  await page.reload(); await page.waitForFunction(() => document.querySelector('#date-label').textContent.length > 0);
  await page.getByRole('button', { name: '记录', exact: true }).click(); await page.getByRole('button', { name: '月度报告', exact: true }).click(); await waitReport('2026 年 11 月', '3,200');
  await page.locator('#report-prev').click(); await waitReport('2026 年 10 月', '1,000');
  await page.locator('#report-prev').click(); await waitReport('2026 年 9 月', '500');
  await page.evaluate(async () => {
    const reports = JSON.parse(localStorage.getItem('shoho-report-fixtures'));
    for (const key of ['2026-09', '2026-10']) Object.assign(reports[key], { total: 0, average: 0, activeDays: 0, goalDays: 0, longestStreak: 0, recordCount: 0, previous: null, insights: [], days: reports[key].days.map(day => ({ ...day, total: 0, count: 0 })), timeSlots: reports[key].timeSlots.map(slot => ({ ...slot, total: 0, count: 0 })) });
    localStorage.setItem('shoho-report-fixtures', JSON.stringify(reports));
    for (const id of ['sep-1', 'oct-1', 'oct-2']) await window.__TAURI_INTERNALS__.invoke('remove_record', { id });
  });
  await waitReport('2026 年 9 月', '0');
  assert.equal(await page.locator('#report-prev').isDisabled(), true);
  await page.locator('#report-next').click(); await waitReport('2026 年 10 月', '0');
  await page.locator('#report-next').click(); await waitReport('2026 年 11 月', '3,200');
  // Crossing a month boundary follows the current month and leaves future dates disabled.
  await page.clock.setFixedTime(new Date('2026-12-01T00:01:00+08:00'));
  await page.waitForTimeout(1100); await waitReport('2026 年 12 月', '0');
  assert.equal(await page.locator('#report-empty').isVisible(), true);
  assert.equal(await page.locator('#report-analysis').isVisible(), false);
  assert.equal(await page.locator('#report-comparison').isVisible(), false);
  assert.equal(await page.locator('.report-day:disabled').count(), 30);
  await page.screenshot({ path: 'test-artifacts/monthly-empty.png', fullPage: true });
  await page.locator('#report-start').click(); assert.equal(await page.locator('#page-today').isVisible(), true);
  assert.deepEqual(errors, []);
  console.log('UI checks passed: compact layout, named presets, add/remove/default, labels, custom records, history filtering, reminder buttons/frame/eight-preset layout, notification settings entry, pause/resume, reload, monthly metrics/calendar/drilldown/navigation, stale-response handling, retry, live updates, narrow layout, month rollover and empty states. Native menu and cross-desktop dragging still require OS verification.');
} finally { await browser.close(); await server.close(); }
