// UI-only regression checks. Tauri IPC is mocked here; Rust tests cover native rules and persistence.
import { chromium } from 'playwright';
import { createServer } from 'vite';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
const server = await createServer(); await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1160, height: 820 } });
const errors = [];
await context.addInitScript(() => {
  const settings = { goal: 1800, cup: 200, interval: 45, start: '00:00', end: '23:59', enabled: true, systemNotifications: false, launchAtLogin: false };
  let saved = JSON.parse(localStorage.getItem('shoho-fixture') || 'null');
  let state = saved || { settings, records: [], pausedUntil: 0, nextReminderAt: Date.now() + 45 * 60000, platform: 'macos', version: '0.2.1', packaged: false, storageWarning: '' };
  let counter = 1; const callbacks = new Map(), listeners = new Map();
  const snapshot = () => { const total = state.records.reduce((sum, record) => sum + record.amount, 0); state.status = { kind: !state.settings.enabled ? 'off' : state.pausedUntil > Date.now() ? 'paused' : total >= state.settings.goal ? 'complete' : 'active', at: state.nextReminderAt }; return structuredClone(state); };
  const changed = () => { localStorage.setItem('shoho-fixture', JSON.stringify(state)); for (const [id, listener] of listeners) if (listener.event === 'shoho:changed') callbacks.get(listener.handler)({ event: listener.event, id, payload: snapshot() }); return snapshot(); };
  window.__TAURI_INTERNALS__ = {
    transformCallback: callback => { const id = counter++; callbacks.set(id, callback); return id; },
    invoke: async (command, args) => {
      if (command === 'plugin:event|listen') { const id = counter++; listeners.set(id, args); return id; }
      if (command === 'window_ready' || command === 'test_reminder' || command === 'dismiss_reminder') return;
      if (command === 'get_state') return snapshot();
      if (command === 'drink') { state.records.push({ id: crypto.randomUUID(), amount: args.amount, at: Date.now() }); state.pausedUntil = 0; state.nextReminderAt = Date.now() + state.settings.interval * 60000; return changed(); }
      if (command === 'remove_record') { state.records = state.records.filter(record => record.id !== args.id); return changed(); }
      if (command === 'save_settings') { if (args.settings.start === args.settings.end) throw new Error('提醒开始和结束时间需要不同。'); state.settings = args.settings; return changed(); }
      if (command === 'pause_reminders') { state.pausedUntil = args.minutes ? Date.now() + args.minutes * 60000 : 0; return changed(); }
      throw new Error(`Unexpected IPC: ${command}`);
    }
  };
});
mkdirSync('test-artifacts', { recursive: true });
try {
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:1420');
  await page.waitForFunction(() => document.querySelector('#date-label').textContent.length > 0);
  await page.waitForFunction(() => [...document.images].every(image => image.complete && image.naturalWidth > 0));
  await page.locator('#drink-button').click();
  await page.waitForFunction(() => document.querySelector('#today-total').textContent === '200');
  await page.locator('#custom-button').click(); await page.locator('#custom-amount').fill('350');
  await page.locator('#custom-form [type=submit]').click();
  await page.waitForFunction(() => document.querySelector('#today-total').textContent === '550');
  await page.getByRole('button', { name: /撤销.*200 ml/ }).click();
  await page.waitForFunction(() => document.querySelector('#today-total').textContent === '350');
  await page.getByRole('button', { name: '饮水足迹' }).click();
  assert.equal(await page.locator('#week-total').innerText(), '350 ml');
  assert.equal(await page.locator('.chart-column').count(), 7);
  await page.getByRole('button', { name: '提醒设置' }).click();
  await page.locator('[name=goal]').fill('2000'); await page.locator('[name=cup]').fill('250');
  await page.getByRole('button', { name: '保存设置' }).click();
  await page.waitForFunction(() => document.querySelector('#settings-message').textContent.includes('已保存'));
  await page.getByRole('button', { name: '今日喝水' }).click();
  await page.locator('#pause-button').click();
  await page.waitForFunction(() => document.querySelector('#reminder-status').textContent === '暂停中');
  await page.locator('#pause-button').click();
  await page.waitForFunction(() => document.querySelector('#reminder-status').textContent === '提醒中');
  await page.screenshot({ path: 'test-artifacts/tauri-ui.png' });
  await page.setViewportSize({ width: 860, height: 650 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.reload(); await page.waitForFunction(() => document.querySelector('#today-total').textContent === '350');
  assert.deepEqual(errors, []);
  console.log('UI checks passed with mocked Tauri IPC: record, custom amount, undo, history, settings, pause/resume, layout and reload.');
} finally { await browser.close(); await server.close(); }
