// UI regression with mocked IPC; Rust tests cover native validation, migration and persistence.
import { chromium } from 'playwright';
import { createServer } from 'vite';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
const server = await createServer(); await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 480, height: 620 } });
const errors = [];
await context.addInitScript(() => {
  const settings = { goal: 1800, cup: 200, presets: [{ id: 'sip', name: '一口', amount: 30 }, { id: 'cup', name: '一杯', amount: 200 }, { id: 'bowl', name: '一碗', amount: 350 }], defaultPresetId: 'cup', interval: 45, start: '00:00', end: '23:59', enabled: true, systemNotifications: false, launchAtLogin: false };
  const state = JSON.parse(localStorage.getItem('shoho-fixture') || 'null') || { settings, records: [], pausedUntil: 0, nextReminderAt: Date.now() + 45 * 60000, platform: 'macos', version: '0.3.1', packaged: false, storageWarning: '' };
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
  assert.deepEqual(errors, []);
  console.log('UI checks passed: compact layout, named presets, add/remove/default, labels, custom records, history filtering, reminder buttons/frame/eight-preset layout, notification settings entry, pause/resume and reload. Native menu and cross-desktop dragging still require OS verification.');
} finally { await browser.close(); await server.close(); }
