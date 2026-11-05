use crate::model::Data;
use serde_json::Value;
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

pub struct Store {
    pub data: Data,
    pub path: PathBuf,
    pub warning: String,
}
impl Store {
    pub fn load(path: PathBuf, legacy: Option<&Path>, at: i64) -> Result<Self, String> {
        let mut warning = String::new();
        let source = if path.exists() {
            Some(path.as_path())
        } else {
            legacy.filter(|file| file.exists())
        };
        let data = if let Some(source) = source {
            let bytes = fs::read(source).map_err(|error| format!("无法读取饮水数据：{error}"))?;
            match serde_json::from_slice::<Value>(&bytes) {
                Ok(raw) if raw.is_object() => Data::recover(&raw, at),
                _ => {
                    let backup = source.with_file_name(format!("shoho.json.backup-{at}"));
                    fs::copy(source, backup)
                        .map_err(|error| format!("无法备份损坏数据：{error}"))?;
                    warning = "本地数据文件无法解析，已保留备份并使用默认设置。".into();
                    Data::new(at)
                }
            }
        } else {
            Data::new(at)
        };
        let store = Self {
            data,
            path,
            warning,
        };
        store.write(&store.data)?;
        Ok(store)
    }
    fn write(&self, data: &Data) -> Result<(), String> {
        let parent = self.path.parent().ok_or("数据目录无效。")?;
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        let mut file =
            tempfile::NamedTempFile::new_in(parent).map_err(|error| error.to_string())?;
        serde_json::to_writer_pretty(&mut file, data).map_err(|error| error.to_string())?;
        file.flush().map_err(|error| error.to_string())?;
        file.as_file()
            .sync_all()
            .map_err(|error| error.to_string())?;
        file.persist(&self.path)
            .map_err(|error| format!("无法保存饮水数据：{error}"))?;
        Ok(())
    }
    pub fn update(
        &mut self,
        change: impl FnOnce(&mut Data) -> Result<(), String>,
    ) -> Result<(), String> {
        let mut next = self.data.clone();
        change(&mut next)?;
        self.write(&next)?;
        self.data = next;
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{now, MINUTE};
    #[test]
    fn migration_copies_without_touching_electron_data() {
        let dir = tempfile::tempdir().unwrap();
        let old = dir.path().join("Shoho/shoho.json");
        let new = dir.path().join("app.shoho.desktop/shoho.json");
        fs::create_dir_all(old.parent().unwrap()).unwrap();
        let mut data = Data::new(now());
        data.drink(350, now()).unwrap();
        let bytes = serde_json::to_vec(&data).unwrap();
        fs::write(&old, &bytes).unwrap();
        let store = Store::load(new.clone(), Some(&old), now()).unwrap();
        assert_eq!(store.data.records.len(), 1);
        assert_eq!(fs::read(&old).unwrap(), bytes);
        assert!(new.exists());
        fs::write(&old, "{}").unwrap();
        let restored = Store::load(new, Some(&old), now()).unwrap();
        assert_eq!(restored.data.records.len(), 1);
    }
    #[test]
    fn failed_write_does_not_change_in_memory_records() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::load(dir.path().join("state.json"), None, now()).unwrap();
        let blocker = dir.path().join("not-a-directory");
        fs::write(&blocker, "blocked").unwrap();
        store.path = blocker.join("state.json");
        assert!(store.update(|data| data.drink(200, now())).is_err());
        assert!(store.data.records.is_empty());
    }
    #[test]
    fn corrupt_data_is_backed_up() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("shoho.json");
        fs::write(&path, "{bad json").unwrap();
        let at = now();
        let store = Store::load(path, None, at).unwrap();
        assert!(!store.warning.is_empty());
        assert_eq!(
            fs::read_to_string(dir.path().join(format!("shoho.json.backup-{at}"))).unwrap(),
            "{bad json"
        );
    }
    #[test]
    fn pause_and_records_survive_restart() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("shoho.json");
        let at = now();
        let mut store = Store::load(path.clone(), None, at).unwrap();
        store
            .update(|data| {
                data.drink(250, at)?;
                data.pause(10, at)
            })
            .unwrap();
        let restored = Store::load(path, None, at + MINUTE).unwrap();
        assert_eq!(restored.data.records[0].amount, 250);
        assert_eq!(restored.data.next_reminder_at, at + 10 * MINUTE);
    }
}
