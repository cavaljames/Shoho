import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { Settings, Snapshot } from './types';
export const shoho = {
  getState: () => invoke<Snapshot>('get_state'),
  drink: (amount: number) => invoke<Snapshot>('drink', { amount }),
  remove: (id: string) => invoke<Snapshot>('remove_record', { id }),
  saveSettings: (settings: Settings) => invoke<Snapshot>('save_settings', { settings }),
  pause: (minutes: number) => invoke<Snapshot>('pause_reminders', { minutes }),
  testReminder: () => invoke<void>('test_reminder'),
  dismiss: () => invoke<void>('dismiss_reminder'),
  ready: () => invoke<void>('window_ready'),
  onState: (callback: (state: Snapshot) => void): Promise<UnlistenFn> => listen<Snapshot>('shoho:changed', event => callback(event.payload)),
  onNotice: (callback: (message: string) => void): Promise<UnlistenFn> => listen<string>('shoho:notice', event => callback(event.payload))
};
