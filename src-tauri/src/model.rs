use chrono::{DateTime, Datelike, Duration, Local, NaiveTime, TimeZone, Timelike};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;

pub const MINUTE: i64 = 60_000;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct Preset {
    pub id: String,
    pub name: String,
    pub amount: u32,
}
fn default_presets(cup: u32) -> Vec<Preset> {
    [
        ("sip", "一口", 30),
        ("cup", "一杯", cup),
        ("bowl", "一碗", 350),
    ]
    .into_iter()
    .map(|(id, name, amount)| Preset {
        id: id.into(),
        name: name.into(),
        amount,
    })
    .collect()
}
fn valid_label(label: &str) -> bool {
    !label.is_empty()
        && label.trim() == label
        && label.chars().count() <= 12
        && !label.chars().any(char::is_control)
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub goal: u32,
    pub cup: u32,
    pub presets: Vec<Preset>,
    pub default_preset_id: String,
    pub interval: u32,
    pub start: String,
    pub end: String,
    pub enabled: bool,
    pub system_notifications: bool,
    pub launch_at_login: bool,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            goal: 1800,
            cup: 200,
            presets: default_presets(200),
            default_preset_id: "cup".into(),
            interval: 45,
            start: "09:00".into(),
            end: "22:00".into(),
            enabled: true,
            system_notifications: false,
            launch_at_login: false,
        }
    }
}
impl Settings {
    pub fn validate(&self) -> Result<(), String> {
        if !(200..=6000).contains(&self.goal)
            || !(10..=1000).contains(&self.cup)
            || !(5..=180).contains(&self.interval)
        {
            return Err("请检查每日目标、每杯水量和提醒间隔。".into());
        }
        for time in [&self.start, &self.end] {
            if time.len() != 5 || NaiveTime::parse_from_str(time, "%H:%M").is_err() {
                return Err("提醒时间格式不正确。".into());
            }
        }
        if self.start == self.end {
            return Err("提醒开始和结束时间需要不同。".into());
        }
        if self.presets.is_empty() || self.presets.len() > 8 {
            return Err("请保留 1–8 个水量快捷项。".into());
        }
        let mut ids = HashSet::new();
        for preset in &self.presets {
            if preset.id.is_empty()
                || preset.id.len() > 64
                || !preset
                    .id
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-')
                || !ids.insert(&preset.id)
                || !valid_label(&preset.name)
                || !(10..=1000).contains(&preset.amount)
            {
                return Err("快捷项名称需为 1–12 个字，水量为 10–1000 ml，且标识不能重复。".into());
            }
        }
        if !self
            .presets
            .iter()
            .any(|preset| preset.id == self.default_preset_id)
        {
            return Err("请选择一个默认快捷项。".into());
        }
        Ok(())
    }
    pub fn default_preset(&self) -> &Preset {
        self.presets
            .iter()
            .find(|preset| preset.id == self.default_preset_id)
            .unwrap_or(&self.presets[0])
    }
    pub fn sync_cup(&mut self) {
        self.cup = self.default_preset().amount;
    }
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Record {
    pub id: String,
    pub amount: u32,
    pub at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Data {
    pub settings: Settings,
    pub records: Vec<Record>,
    pub paused_until: i64,
    pub next_reminder_at: i64,
}
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Status {
    pub kind: &'static str,
    pub at: Option<i64>,
}

pub fn now() -> i64 {
    Local::now().timestamp_millis()
}
fn local(at: i64) -> DateTime<Local> {
    Local
        .timestamp_millis_opt(at)
        .single()
        .expect("validated timestamp")
}
pub fn day_key(at: i64) -> (i32, u32, u32) {
    let date = local(at);
    (date.year(), date.month(), date.day())
}
fn minute(time: &str) -> u32 {
    let t = NaiveTime::parse_from_str(time, "%H:%M").expect("validated schedule");
    t.hour() * 60 + t.minute()
}
pub fn in_window(settings: &Settings, at: i64) -> bool {
    let date = local(at);
    let current = date.hour() * 60 + date.minute();
    let (start, end) = (minute(&settings.start), minute(&settings.end));
    if start < end {
        current >= start && current < end
    } else {
        current >= start || current < end
    }
}
fn next_start(settings: &Settings, at: i64) -> i64 {
    let date = local(at);
    let start = minute(&settings.start);
    // Search real instants so nonexistent or repeated DST wall times remain safe.
    let mut candidate =
        date.with_second(0).unwrap().with_nanosecond(0).unwrap() + Duration::minutes(1);
    for _ in 0..(3 * 24 * 60) {
        if candidate.hour() * 60 + candidate.minute() == start {
            return candidate.timestamp_millis();
        }
        candidate += Duration::minutes(1);
    }
    at + 24 * 60 * MINUTE
}
impl Data {
    pub fn new(at: i64) -> Self {
        Self {
            settings: Settings::default(),
            records: vec![],
            paused_until: 0,
            next_reminder_at: at + 45 * MINUTE,
        }
    }
    pub fn recover(raw: &Value, at: i64) -> Self {
        let mut data = Self::new(at);
        if let Ok(mut settings) = serde_json::from_value::<Settings>(raw["settings"].clone()) {
            if raw["settings"].get("presets").is_none() {
                settings.presets = default_presets(settings.cup);
                settings.default_preset_id = "cup".into();
            }
            if settings.validate().is_ok() {
                settings.sync_cup();
                data.settings = settings;
            }
        }
        let mut ids = HashSet::new();
        if let Some(records) = raw["records"].as_array() {
            data.records = records
                .iter()
                .filter_map(|raw| serde_json::from_value::<Record>(raw.clone()).ok())
                .filter(|record| {
                    !record.id.is_empty()
                        && record.id.len() < 100
                        && (10..=1000).contains(&record.amount)
                        && record.label.as_ref().is_none_or(|label| valid_label(label))
                        && record.at > 0
                        && record.at <= at
                        && Local.timestamp_millis_opt(record.at).single().is_some()
                        && ids.insert(record.id.clone())
                })
                .collect();
        }
        if let Some(until) = raw["pausedUntil"]
            .as_i64()
            .filter(|until| *until > at && *until < at + 24 * 60 * MINUTE)
        {
            data.paused_until = until;
        }
        // Keep a snoozed reminder across restarts, without replaying old reminders.
        data.next_reminder_at = if data.paused_until > at {
            data.paused_until
        } else {
            at + i64::from(data.settings.interval) * MINUTE
        };
        data
    }
    pub fn total(&self, at: i64) -> u64 {
        self.records
            .iter()
            .filter(|record| day_key(record.at) == day_key(at))
            .map(|record| u64::from(record.amount))
            .sum()
    }
    pub fn status(&self, at: i64) -> Status {
        let (kind, when) = if !self.settings.enabled {
            ("off", None)
        } else if self.paused_until > at {
            ("paused", Some(self.paused_until))
        } else if !in_window(&self.settings, at) {
            ("quiet", Some(next_start(&self.settings, at)))
        } else if self.total(at) >= u64::from(self.settings.goal) {
            ("complete", None)
        } else {
            ("active", Some(self.next_reminder_at))
        };
        Status { kind, at: when }
    }
    pub fn drink(&mut self, amount: u32, at: i64) -> Result<(), String> {
        self.drink_named(amount, None, at)
    }
    pub fn drink_named(
        &mut self,
        amount: u32,
        label: Option<String>,
        at: i64,
    ) -> Result<(), String> {
        if !(10..=1000).contains(&amount) {
            return Err("每次记录的水量需要在 10–1000 ml 之间。".into());
        }
        if label.as_ref().is_some_and(|label| !valid_label(label)) {
            return Err("记录名称需为 1–12 个字。".into());
        }
        self.records.push(Record {
            id: uuid::Uuid::new_v4().to_string(),
            amount,
            at,
            label,
        });
        self.paused_until = 0;
        self.reset_clock(at);
        Ok(())
    }
    pub fn drink_preset(&mut self, id: &str, at: i64) -> Result<(), String> {
        let preset = self
            .settings
            .presets
            .iter()
            .find(|preset| preset.id == id)
            .cloned()
            .ok_or("这个快捷项已不存在，请重新选择。")?;
        self.drink_named(preset.amount, Some(preset.name), at)
    }
    pub fn pause(&mut self, minutes: u32, at: i64) -> Result<(), String> {
        if ![0, 10, 30, 60].contains(&minutes) {
            return Err("暂停时长无效。".into());
        }
        self.paused_until = if minutes == 0 {
            0
        } else {
            at + i64::from(minutes) * MINUTE
        };
        self.next_reminder_at = if minutes == 0 {
            at + i64::from(self.settings.interval) * MINUTE
        } else {
            self.paused_until
        };
        Ok(())
    }
    pub fn reset_clock(&mut self, at: i64) {
        self.next_reminder_at = if self.paused_until > at {
            self.paused_until
        } else {
            at + i64::from(self.settings.interval) * MINUTE
        };
    }
    pub fn tick(&mut self, at: i64, previous: i64) -> bool {
        let gap = at - previous;
        if !(0..=90_000).contains(&gap) || day_key(at) != day_key(previous) {
            self.reset_clock(at);
            return false;
        }
        let status = self.status(at);
        if status.kind == "active" && self.next_reminder_at <= at {
            self.next_reminder_at = at + i64::from(self.settings.interval) * MINUTE;
            return true;
        }
        false
    }
    pub fn wait_millis(&self, at: i64) -> u64 {
        let status = self.status(at);
        let target = status.at.unwrap_or(at + 30_000);
        (target - at).clamp(100, 30_000) as u64
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn at(day: u32, hour: u32, minute: u32) -> i64 {
        Local
            .with_ymd_and_hms(2026, 11, day, hour, minute, 0)
            .single()
            .unwrap()
            .timestamp_millis()
    }
    #[test]
    fn local_day_boundary() {
        let mut data = Data::new(at(5, 10, 0));
        data.drink(200, at(5, 23, 59)).unwrap();
        data.drink(350, at(6, 0, 0)).unwrap();
        assert_eq!(data.total(at(5, 10, 0)), 200);
        assert_eq!(data.total(at(6, 0, 0)), 350);
    }
    #[test]
    fn schedule_edges_and_overnight() {
        let mut settings = Settings::default();
        assert!(!in_window(&settings, at(5, 8, 59)));
        assert!(in_window(&settings, at(5, 9, 0)));
        assert!(!in_window(&settings, at(5, 22, 0)));
        settings.start = "22:00".into();
        settings.end = "07:00".into();
        assert!(in_window(&settings, at(5, 23, 0)));
        assert!(in_window(&settings, at(6, 6, 59)));
        assert!(!in_window(&settings, at(6, 7, 0)));
    }
    #[test]
    fn quiet_time_has_next_local_start() {
        let data = Data::new(at(5, 10, 0));
        assert_eq!(data.status(at(5, 8, 0)).at, Some(at(5, 9, 0)));
        assert_eq!(data.status(at(5, 23, 0)).at, Some(at(6, 9, 0)));
    }
    #[test]
    fn snooze_and_restart_keep_ten_minute_deadline() {
        let mut data = Data::new(at(5, 10, 0));
        data.pause(10, at(5, 10, 0)).unwrap();
        assert_eq!(data.status(at(5, 10, 0)).kind, "paused");
        let raw = serde_json::to_value(&data).unwrap();
        let restored = Data::recover(&raw, at(5, 10, 1));
        assert_eq!(restored.next_reminder_at, at(5, 10, 10));
        assert!(data.tick(at(5, 10, 10), at(5, 10, 9)));
        assert!(!data.tick(at(5, 10, 10), at(5, 10, 10)));
    }
    #[test]
    fn goal_and_disabled_prevent_reminders() {
        let mut data = Data::new(at(5, 10, 0));
        data.settings.goal = 200;
        data.drink(200, at(5, 10, 0)).unwrap();
        assert_eq!(data.status(at(5, 10, 1)).kind, "complete");
        assert_eq!(data.status(at(6, 10, 0)).kind, "active");
        data.settings.enabled = false;
        assert_eq!(data.status(at(6, 10, 0)).kind, "off");
    }
    #[test]
    fn sleep_clock_changes_and_midnight_do_not_burst() {
        let mut data = Data::new(at(5, 10, 0));
        data.next_reminder_at = at(5, 10, 0);
        assert!(!data.tick(at(5, 12, 0), at(5, 10, 0)));
        assert_eq!(data.next_reminder_at, at(5, 12, 45));
        assert!(!data.tick(at(5, 11, 0), at(5, 12, 0)));
        assert_eq!(data.next_reminder_at, at(5, 11, 45));
        assert!(!data.tick(at(6, 0, 0), at(5, 23, 59)));
    }
    #[test]
    fn invalid_inputs_are_rejected() {
        let mut settings = Settings {
            goal: 0,
            ..Settings::default()
        };
        assert!(settings.validate().is_err());
        settings = Settings::default();
        settings.start = "29:00".into();
        assert!(settings.validate().is_err());
        let mut data = Data::new(at(5, 10, 0));
        assert!(data.drink(0, at(5, 10, 0)).is_err());
        assert!(data.pause(1, at(5, 10, 0)).is_err());
        assert!(serde_json::from_value::<Settings>(serde_json::json!({"goal": -1})).is_err());
    }
    #[test]
    fn recover_preserves_valid_legacy_records() {
        let now = at(5, 10, 0);
        let raw = serde_json::json!({"settings":{"goal":-1}, "records":[{"id":"ok","at":now-1,"amount":200},{"id":"ok","at":now-1,"amount":200},{"id":"bad","at":now,"amount":0},{"id":"future","at":now+1,"amount":200}]});
        let data = Data::recover(&raw, now);
        assert_eq!(data.settings.goal, 1800);
        assert_eq!(data.records.len(), 1);
        assert_eq!(data.records[0].id, "ok");
    }
    #[test]
    fn legacy_cup_amount_becomes_default_named_preset() {
        let at = at(5, 10, 0);
        let raw = serde_json::json!({"settings":{"cup":500},"records":[{"id":"old","amount":200,"at":at-1}]});
        let data = Data::recover(&raw, at);
        assert_eq!(data.settings.default_preset().name, "一杯");
        assert_eq!(data.settings.default_preset().amount, 500);
        assert_eq!(data.records.len(), 1);
        assert!(data.records[0].label.is_none());
        data.settings.validate().unwrap();
    }
    #[test]
    fn named_presets_record_snapshot_labels_and_allow_a_small_sip() {
        let mut data = Data::new(at(5, 10, 0));
        data.settings.presets[0].name = "一小口".into();
        data.settings.presets[0].amount = 20;
        data.drink_preset("sip", at(5, 10, 0)).unwrap();
        data.settings.presets[0].name = "一大口".into();
        assert_eq!(data.records[0].label.as_deref(), Some("一小口"));
        assert_eq!(data.records[0].amount, 20);
        assert!(data.drink_preset("deleted", at(5, 10, 0)).is_err());
        assert!(data.drink_named(9, None, at(5, 10, 0)).is_err());
        assert!(data
            .drink_named(20, Some("  ".into()), at(5, 10, 0))
            .is_err());
    }
    #[test]
    fn preset_validation_rejects_empty_duplicate_or_missing_default() {
        let mut settings = Settings::default();
        settings.presets.clear();
        assert!(settings.validate().is_err());
        settings = Settings::default();
        settings.presets[0].id = settings.presets[1].id.clone();
        assert!(settings.validate().is_err());
        settings = Settings::default();
        settings.default_preset_id = "missing".into();
        assert!(settings.validate().is_err());
        settings = Settings::default();
        settings.presets[0].name = "\n".into();
        assert!(settings.validate().is_err());
    }
}
