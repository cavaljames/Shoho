use crate::model::{Data, Record, Settings, MINUTE};
use chrono::{Local, TimeZone};
use rusqlite::{params, Connection, Transaction, TransactionBehavior};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

pub const DATABASE_FILE: &str = "sqlite.db";
const SCHEMA_VERSION: i32 = 1;

pub struct Store {
    pub data: Data,
    pub warning: String,
    connection: Connection,
}

fn db_error(error: rusqlite::Error) -> String {
    format!("本地数据库读写失败：{error}")
}

fn validate_data(data: &Data) -> Result<(), String> {
    data.settings.validate()?;
    let mut ids = HashSet::new();
    for (index, record) in data.records.iter().enumerate() {
        if record.id.is_empty()
            || record.amount == 0
            || record.at <= 0
            || Local.timestamp_millis_opt(record.at).single().is_none()
            || !ids.insert(record.id.as_str())
        {
            return Err(format!(
                "第 {} 条历史记录格式不正确或标识重复，已停止操作并保留原数据。",
                index + 1
            ));
        }
    }
    Ok(())
}

fn import_json(path: &Path, at: i64) -> Result<Data, String> {
    let bytes =
        fs::read(path).map_err(|error| format!("无法读取历史 JSON，原文件已保留：{error}"))?;
    let raw: Value = serde_json::from_slice(&bytes)
        .map_err(|error| format!("历史 JSON 无法解析，未完成迁移，原文件已保留：{error}"))?;
    if !raw.is_object() {
        return Err("历史 JSON 格式不正确，未完成迁移，原文件已保留。".into());
    }
    let settings: Settings = serde_json::from_value(
        raw.get("settings")
            .cloned()
            .unwrap_or_else(|| serde_json::json!({})),
    )
    .map_err(|error| format!("历史设置无法解析，未完成迁移：{error}"))?;
    settings
        .validate()
        .map_err(|error| format!("历史设置无效，未完成迁移：{error}"))?;
    // Reuse legacy cup-to-preset conversion, but never silently filter records.
    // In particular, clock rollback must not discard saved future timestamps.
    let mut data = Data::recover(&raw, at);
    data.records = serde_json::from_value(
        raw.get("records")
            .cloned()
            .unwrap_or_else(|| serde_json::json!([])),
    )
    .map_err(|error| format!("历史饮水记录无法解析，未完成迁移：{error}"))?;
    validate_data(&data)?;
    Ok(data)
}

fn create_schema(transaction: &Transaction<'_>) -> Result<(), String> {
    transaction
        .execute_batch(
            "CREATE TABLE app_state (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                settings TEXT NOT NULL,
                paused_until INTEGER NOT NULL,
                next_reminder_at INTEGER NOT NULL
            );
            CREATE TABLE drink_records (
                sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                id TEXT NOT NULL UNIQUE CHECK (length(id) > 0),
                amount INTEGER NOT NULL CHECK (amount > 0 AND amount <= 4294967295),
                at INTEGER NOT NULL CHECK (at > 0),
                label TEXT
            );
            CREATE INDEX drink_records_at ON drink_records(at);
            CREATE TABLE metadata (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);",
        )
        .map_err(db_error)
}

fn write_state(transaction: &Transaction<'_>, data: &Data) -> Result<(), String> {
    let settings = serde_json::to_string(&data.settings).map_err(|error| error.to_string())?;
    transaction
        .execute(
            "INSERT INTO app_state (id, settings, paused_until, next_reminder_at)
         VALUES (1, ?1, ?2, ?3)
         ON CONFLICT(id) DO UPDATE SET settings=excluded.settings,
             paused_until=excluded.paused_until, next_reminder_at=excluded.next_reminder_at",
            params![settings, data.paused_until, data.next_reminder_at],
        )
        .map_err(db_error)?;
    Ok(())
}

fn insert_record(transaction: &Transaction<'_>, record: &Record) -> Result<(), String> {
    transaction
        .execute(
            "INSERT INTO drink_records (id, amount, at, label) VALUES (?1, ?2, ?3, ?4)",
            params![record.id, record.amount, record.at, record.label],
        )
        .map_err(db_error)?;
    Ok(())
}

fn read_data(connection: &Connection) -> Result<Data, String> {
    let (settings, paused_until, next_reminder_at): (String, i64, i64) = connection
        .query_row(
            "SELECT settings, paused_until, next_reminder_at FROM app_state WHERE id=1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(db_error)?;
    let settings = serde_json::from_str(&settings)
        .map_err(|error| format!("数据库中的设置无法解析，已保留数据库：{error}"))?;
    let mut statement = connection
        .prepare("SELECT id, amount, at, label FROM drink_records ORDER BY sequence")
        .map_err(db_error)?;
    let records = statement
        .query_map([], |row| {
            Ok(Record {
                id: row.get(0)?,
                amount: row.get(1)?,
                at: row.get(2)?,
                label: row.get(3)?,
            })
        })
        .map_err(db_error)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(db_error)?;
    let data = Data {
        settings,
        records,
        paused_until,
        next_reminder_at,
    };
    validate_data(&data)?;
    Ok(data)
}

impl Store {
    pub fn load(path: PathBuf, legacy: Option<&Path>, at: i64) -> Result<Self, String> {
        let parent = path.parent().ok_or("数据目录无效。")?;
        fs::create_dir_all(parent).map_err(|error| format!("无法创建数据目录：{error}"))?;
        let mut connection = Connection::open(&path)
            .map_err(|error| format!("无法打开本地数据库，原数据已保留：{error}"))?;
        connection
            .busy_timeout(Duration::from_secs(5))
            .map_err(db_error)?;
        connection
            .pragma_update(None, "synchronous", "FULL")
            .map_err(db_error)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        let version: i32 = transaction
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .map_err(db_error)?;
        let (mut data, warning) = match version {
            0 => {
                let tables: i64 = transaction.query_row(
                    "SELECT count(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
                    [], |row| row.get(0),
                ).map_err(db_error)?;
                if tables != 0 {
                    return Err("数据库结构无法识别，已保留数据库，请勿删除原始 JSON。".into());
                }
                let current_json = parent.join("shoho.json");
                let mut source = None;
                for candidate in [Some(current_json.as_path()), legacy].into_iter().flatten() {
                    if candidate
                        .try_exists()
                        .map_err(|error| format!("无法检查历史数据文件：{error}"))?
                    {
                        source = Some(candidate);
                        break;
                    }
                }
                let data = match source {
                    Some(source) => import_json(source, at)?,
                    None => Data::new(at),
                };
                create_schema(&transaction)?;
                write_state(&transaction, &data)?;
                for record in &data.records {
                    insert_record(&transaction, record)?;
                }
                // Verify every field before committing the migration marker.
                let restored = read_data(&transaction)?;
                if serde_json::to_value(&restored).map_err(|error| error.to_string())?
                    != serde_json::to_value(&data).map_err(|error| error.to_string())?
                {
                    return Err("迁移后数据核对失败，已回滚，原 JSON 已保留。".into());
                }
                transaction
                    .execute(
                        "INSERT INTO metadata (key, value) VALUES ('initialized_at', ?1)",
                        [at.to_string()],
                    )
                    .map_err(db_error)?;
                let warning = if let Some(source) = source {
                    for (key, value) in [
                        ("json_source", source.to_string_lossy().into_owned()),
                        ("json_imported_records", data.records.len().to_string()),
                    ] {
                        transaction
                            .execute(
                                "INSERT INTO metadata (key, value) VALUES (?1, ?2)",
                                params![key, value],
                            )
                            .map_err(db_error)?;
                    }
                    format!(
                        "已迁移 {} 条历史饮水记录，原 JSON 文件已保留。",
                        data.records.len()
                    )
                } else {
                    String::new()
                };
                transaction
                    .pragma_update(None, "user_version", SCHEMA_VERSION)
                    .map_err(db_error)?;
                (data, warning)
            }
            SCHEMA_VERSION => (read_data(&transaction)?, String::new()),
            _ => {
                return Err("数据库版本不受当前小喝支持，请使用匹配的版本；原数据库已保留。".into())
            }
        };
        transaction.commit().map_err(db_error)?;
        if data.paused_until <= at || data.paused_until > at.saturating_add(24 * 60 * MINUTE) {
            data.paused_until = 0;
        }
        data.reset_clock(at);
        Ok(Self {
            data,
            warning,
            connection,
        })
    }

    pub fn update(
        &mut self,
        change: impl FnOnce(&mut Data) -> Result<(), String>,
    ) -> Result<(), String> {
        let mut next = self.data.clone();
        change(&mut next)?;
        validate_data(&next)?;
        let before: HashMap<_, _> = self
            .data
            .records
            .iter()
            .map(|record| (record.id.as_str(), record))
            .collect();
        let after: HashSet<_> = next
            .records
            .iter()
            .map(|record| record.id.as_str())
            .collect();
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        write_state(&transaction, &next)?;
        for record in &self.data.records {
            if !after.contains(record.id.as_str()) {
                transaction
                    .execute("DELETE FROM drink_records WHERE id=?1", [&record.id])
                    .map_err(db_error)?;
            }
        }
        for record in &next.records {
            match before.get(record.id.as_str()) {
                None => insert_record(&transaction, record)?,
                Some(previous) if *previous != record => {
                    transaction
                        .execute(
                            "UPDATE drink_records SET amount=?1, at=?2, label=?3 WHERE id=?4",
                            params![record.amount, record.at, record.label, record.id],
                        )
                        .map_err(db_error)?;
                }
                _ => {}
            }
        }
        transaction.commit().map_err(db_error)?;
        self.data = next;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::now;

    fn sample(at: i64) -> Data {
        let mut data = Data::new(at);
        data.settings.goal = 2100;
        data.settings.interval = 30;
        data.settings.start = "22:00".into();
        data.settings.end = "07:00".into();
        data.settings.enabled = false;
        data.settings.system_notifications = true;
        data.settings.launch_at_login = true;
        data.settings.presets[2].name = "我的碗".into();
        data.settings.presets[2].amount = 450;
        data.settings.default_preset_id = "bowl".into();
        data.settings.sync_cup();
        data.drink_named(30, Some("一小口".into()), at - 400 * 24 * 60 * MINUTE)
            .unwrap();
        data.drink_preset("bowl", at - MINUTE).unwrap();
        data.records.push(Record {
            id: "legacy-extra".into(),
            amount: 1200,
            at: at + MINUTE,
            label: Some("旧版保留下来的完整记录名称".into()),
        });
        data.pause(10, at).unwrap();
        data
    }
    fn write_json(path: &Path, data: &Data) -> Vec<u8> {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let bytes = serde_json::to_vec_pretty(data).unwrap();
        fs::write(path, &bytes).unwrap();
        bytes
    }
    fn count(connection: &Connection) -> i64 {
        connection
            .query_row("SELECT count(*) FROM drink_records", [], |row| row.get(0))
            .unwrap()
    }

    #[test]
    fn migration_preserves_records_settings_pause_and_original_json() {
        let dir = tempfile::tempdir().unwrap();
        let at = now();
        let data = sample(at);
        let source = dir.path().join("shoho.json");
        let bytes = write_json(&source, &data);
        let path = dir.path().join(DATABASE_FILE);
        let store = Store::load(path.clone(), None, at).unwrap();
        assert!(store.data.records == data.records);
        assert_eq!(store.data.settings, data.settings);
        assert_eq!(store.data.paused_until, data.paused_until);
        assert_eq!(store.data.next_reminder_at, data.next_reminder_at);
        assert_eq!(count(&store.connection), 3);
        assert_eq!(
            store
                .connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i32>(0))
                .unwrap(),
            SCHEMA_VERSION
        );
        assert_eq!(fs::read(&source).unwrap(), bytes);
        assert!(store.warning.contains("3 条"));
        assert!(fs::read(path).unwrap().starts_with(b"SQLite format 3\0"));
    }

    #[test]
    fn existing_database_is_authoritative_and_deleted_rows_never_resurrect() {
        let dir = tempfile::tempdir().unwrap();
        let at = now();
        let source = dir.path().join("shoho.json");
        write_json(&source, &sample(at));
        let path = dir.path().join(DATABASE_FILE);
        let mut store = Store::load(path.clone(), None, at).unwrap();
        store
            .update(|data| {
                data.records.clear();
                data.settings.goal = 3000;
                Ok(())
            })
            .unwrap();
        drop(store);
        // A stale JSON file, even a broken one, must not be imported again.
        fs::write(&source, "{old-json-is-now-broken").unwrap();
        let restored = Store::load(path, None, at + 1).unwrap();
        assert!(restored.data.records.is_empty());
        assert_eq!(restored.data.settings.goal, 3000);
        assert!(restored.warning.is_empty());
        assert_eq!(
            restored
                .connection
                .query_row(
                    "SELECT value FROM metadata WHERE key='json_imported_records'",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            "3"
        );
    }

    #[test]
    fn current_tauri_json_takes_precedence_over_electron_json() {
        let dir = tempfile::tempdir().unwrap();
        let at = now();
        let mut current = Data::new(at);
        current.drink(30, at).unwrap();
        write_json(&dir.path().join("shoho.json"), &current);
        let old = dir.path().join("Electron/shoho.json");
        let old_bytes = write_json(&old, &sample(at));
        let store = Store::load(dir.path().join(DATABASE_FILE), Some(&old), at).unwrap();
        assert!(store.data.records == current.records);
        assert_eq!(fs::read(old).unwrap(), old_bytes);
    }

    #[test]
    fn electron_json_without_named_presets_migrates_legacy_cup_and_history() {
        let dir = tempfile::tempdir().unwrap();
        let at = now();
        let old = dir.path().join("Shoho/shoho.json");
        fs::create_dir_all(old.parent().unwrap()).unwrap();
        let bytes = serde_json::to_vec(&serde_json::json!({
            "settings": { "goal": 2300, "cup": 500, "interval": 40 },
            "records": [{ "id": "electron-record", "amount": 500, "at": at - 365 * 24 * 60 * MINUTE }]
        })).unwrap();
        fs::write(&old, &bytes).unwrap();
        let path = dir.path().join("app.shoho.desktop").join(DATABASE_FILE);
        let store = Store::load(path, Some(&old), at).unwrap();
        assert_eq!(store.data.settings.default_preset().amount, 500);
        assert_eq!(store.data.settings.cup, 500);
        assert_eq!(store.data.settings.goal, 2300);
        assert_eq!(store.data.settings.interval, 40);
        assert_eq!(store.data.records[0].id, "electron-record");
        assert!(store.data.records[0].label.is_none());
        assert_eq!(fs::read(old).unwrap(), bytes);
    }

    #[test]
    fn corrupt_json_stops_migration_and_fixed_json_is_retried() {
        let dir = tempfile::tempdir().unwrap();
        let at = now();
        let source = dir.path().join("shoho.json");
        let path = dir.path().join(DATABASE_FILE);
        fs::write(&source, "{bad json").unwrap();
        assert!(Store::load(path.clone(), None, at).is_err());
        assert_eq!(fs::read_to_string(&source).unwrap(), "{bad json");
        let connection = Connection::open(&path).unwrap();
        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i32>(0))
                .unwrap(),
            0
        );
        drop(connection);
        let expected = sample(at);
        write_json(&source, &expected);
        let store = Store::load(path, None, at).unwrap();
        assert!(store.data.records == expected.records);
    }

    #[test]
    fn duplicate_or_invalid_json_records_are_not_silently_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let at = now();
        let source = dir.path().join("shoho.json");
        let path = dir.path().join(DATABASE_FILE);
        let mut data = sample(at);
        data.records.push(data.records[0].clone());
        let bytes = write_json(&source, &data);
        assert!(Store::load(path.clone(), None, at).is_err());
        assert_eq!(fs::read(&source).unwrap(), bytes);
        data.records.pop();
        data.records[0].amount = 0;
        write_json(&source, &data);
        assert!(Store::load(path, None, at).is_err());
    }

    #[test]
    fn interrupted_initial_transaction_rolls_back_and_full_migration_retries() {
        let dir = tempfile::tempdir().unwrap();
        let at = now();
        let data = sample(at);
        write_json(&dir.path().join("shoho.json"), &data);
        let path = dir.path().join(DATABASE_FILE);
        {
            let mut connection = Connection::open(&path).unwrap();
            let transaction = connection.transaction().unwrap();
            create_schema(&transaction).unwrap();
            write_state(&transaction, &data).unwrap();
            insert_record(&transaction, &data.records[0]).unwrap();
            transaction
                .pragma_update(None, "user_version", SCHEMA_VERSION)
                .unwrap();
            // Drop without commit simulates interruption after writing only part of the migration.
        }
        assert!(path.exists());
        let store = Store::load(path, None, at).unwrap();
        assert!(store.data.records == data.records);
        assert_eq!(count(&store.connection), 3);
    }

    #[test]
    fn sqlite_failure_rolls_back_settings_deletions_inserts_and_memory() {
        let dir = tempfile::tempdir().unwrap();
        let at = now();
        let path = dir.path().join(DATABASE_FILE);
        let mut store = Store::load(path.clone(), None, at).unwrap();
        store.update(|data| data.drink(200, at)).unwrap();
        let before = serde_json::to_value(&store.data).unwrap();
        store.connection.execute_batch("CREATE TRIGGER fail_insert BEFORE INSERT ON drink_records BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END;").unwrap();
        let result = store.update(|data| {
            data.settings.goal = 3000;
            data.records.clear();
            data.drink(350, at)
        });
        assert!(result.is_err());
        assert_eq!(serde_json::to_value(&store.data).unwrap(), before);
        assert_eq!(
            serde_json::to_value(read_data(&store.connection).unwrap()).unwrap(),
            before
        );
        store
            .connection
            .execute_batch("DROP TRIGGER fail_insert;")
            .unwrap();
        drop(store);
        let restored = Store::load(path, None, at).unwrap();
        assert_eq!(restored.data.settings.goal, 1800);
        assert_eq!(restored.data.records.len(), 1);
        assert_eq!(restored.data.records[0].amount, 200);
    }

    #[test]
    fn new_records_custom_labels_pause_and_removal_survive_restarts() {
        let dir = tempfile::tempdir().unwrap();
        let at = now();
        let path = dir.path().join(DATABASE_FILE);
        let mut store = Store::load(path.clone(), None, at).unwrap();
        store
            .update(|data| {
                data.settings.presets[2].name = "我的碗".into();
                data.settings.presets[2].amount = 450;
                data.settings.default_preset_id = "bowl".into();
                data.settings.sync_cup();
                data.drink_preset("bowl", at)?;
                data.pause(10, at)
            })
            .unwrap();
        let id = store.data.records[0].id.clone();
        drop(store);
        let mut restored = Store::load(path.clone(), None, at + MINUTE).unwrap();
        assert_eq!(restored.data.settings.cup, 450);
        assert_eq!(restored.data.records[0].label.as_deref(), Some("我的碗"));
        assert_eq!(restored.data.next_reminder_at, at + 10 * MINUTE);
        restored
            .update(|data| {
                data.records.retain(|record| record.id != id);
                Ok(())
            })
            .unwrap();
        drop(restored);
        assert!(Store::load(path, None, at + 2 * MINUTE)
            .unwrap()
            .data
            .records
            .is_empty());
    }

    #[test]
    fn corrupt_database_and_newer_schema_are_preserved_without_json_fallback() {
        let dir = tempfile::tempdir().unwrap();
        let at = now();
        write_json(&dir.path().join("shoho.json"), &sample(at));
        let corrupt = dir.path().join("corrupt.db");
        let bytes = b"this is not a SQLite database";
        fs::write(&corrupt, bytes).unwrap();
        assert!(Store::load(corrupt.clone(), None, at).is_err());
        assert_eq!(fs::read(&corrupt).unwrap(), bytes);
        let future = dir.path().join("future.db");
        let connection = Connection::open(&future).unwrap();
        connection.pragma_update(None, "user_version", 99).unwrap();
        drop(connection);
        let bytes = fs::read(&future).unwrap();
        assert!(Store::load(future.clone(), None, at).is_err());
        assert_eq!(fs::read(future).unwrap(), bytes);
    }

    #[test]
    fn migration_preserves_every_fixture_record_and_setting() {
        let at = now();
        let bytes = match std::env::var_os("SHOHO_MIGRATION_FIXTURE") {
            Some(path) => fs::read(path).unwrap(),
            None => serde_json::to_vec(&sample(at)).unwrap(),
        };
        let raw: Value = serde_json::from_slice(&bytes).unwrap();
        let expected_records: Vec<Record> = serde_json::from_value(raw["records"].clone()).unwrap();
        let expected_settings: Settings = serde_json::from_value(raw["settings"].clone()).unwrap();
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("shoho.json");
        fs::write(&source, &bytes).unwrap();
        let path = dir.path().join(DATABASE_FILE);
        let store = Store::load(path.clone(), None, at).unwrap();
        assert!(
            store.data.records == expected_records,
            "Every record field must survive migration"
        );
        if raw["settings"].get("presets").is_some() {
            assert!(
                store.data.settings == expected_settings,
                "Every setting must survive migration"
            );
        } else {
            assert_eq!(store.data.settings.cup, expected_settings.cup);
            assert_eq!(store.data.settings.goal, expected_settings.goal);
        }
        assert_eq!(count(&store.connection), expected_records.len() as i64);
        assert_eq!(fs::read(&source).unwrap(), bytes);
        drop(store);
        let restored = Store::load(path, None, at).unwrap();
        assert!(
            restored.data.records == expected_records,
            "Records must also survive the next startup"
        );
        println!("Migration verified: {} records, settings and original JSON preserved; restart did not duplicate records.", expected_records.len());
    }

    #[test]
    fn monthly_report_uses_migrated_and_updated_sqlite_records() {
        let dir = tempfile::tempdir().unwrap();
        let at = Local
            .with_ymd_and_hms(2026, 11, 25, 12, 0, 0)
            .single()
            .unwrap()
            .timestamp_millis();
        let timestamp = |month, day| {
            Local
                .with_ymd_and_hms(2026, month, day, 12, 0, 0)
                .single()
                .unwrap()
                .timestamp_millis()
        };
        let mut data = Data::new(at);
        data.settings.goal = 500;
        data.drink(500, timestamp(10, 31)).unwrap();
        data.drink_named(350, Some("一碗".into()), timestamp(11, 1))
            .unwrap();
        data.drink(450, timestamp(11, 5)).unwrap();
        let source = dir.path().join("shoho.json");
        write_json(&source, &data);
        let path = dir.path().join(DATABASE_FILE);
        let mut store = Store::load(path.clone(), None, at).unwrap();
        store
            .update(|data| data.drink(200, timestamp(11, 5)))
            .unwrap();
        drop(store);
        fs::write(source, "{stale-json").unwrap();
        let restored = Store::load(path, None, at).unwrap();
        let report = crate::report::monthly_report(&restored.data, 2026, 11, at).unwrap();
        assert_eq!(
            (report.total, report.average, report.record_count),
            (1000, 40, 3)
        );
        assert_eq!((report.active_days, report.goal_days), (2, 1));
        assert_eq!(report.days[4].total, 650);
    }
}
