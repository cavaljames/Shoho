export interface Settings {
  goal: number;
  cup: number;
  interval: number;
  start: string;
  end: string;
  enabled: boolean;
  systemNotifications: boolean;
  launchAtLogin: boolean;
}
export interface DrinkRecord { id: string; amount: number; at: number }
export type ReminderKind = 'active' | 'off' | 'paused' | 'quiet' | 'complete';
export interface Snapshot {
  settings: Settings;
  records: DrinkRecord[];
  pausedUntil: number;
  nextReminderAt: number;
  status: { kind: ReminderKind; at: number | null };
  platform: string;
  version: string;
  packaged: boolean;
  storageWarning: string;
}
