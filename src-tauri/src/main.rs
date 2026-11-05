#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod model;
mod storage;

use model::{now, Data, Settings, Status};
use serde::Serialize;
use std::{
    path::PathBuf,
    sync::{Arc, Condvar, Mutex},
    thread,
    time::Duration,
};
use storage::Store;
use tauri::{
    image::Image,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_notification::NotificationExt;

#[derive(Clone)]
struct Backend(Arc<Shared>);
struct Shared {
    store: Mutex<Store>,
    wake: Condvar,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    #[serde(flatten)]
    data: Data,
    status: Status,
    platform: &'static str,
    version: &'static str,
    packaged: bool,
    storage_warning: String,
}
impl Backend {
    fn snapshot(&self) -> Result<Snapshot, String> {
        let store = self.0.store.lock().map_err(|_| "本地数据暂不可用。")?;
        Ok(Snapshot {
            data: store.data.clone(),
            status: store.data.status(now()),
            platform: std::env::consts::OS,
            version: env!("CARGO_PKG_VERSION"),
            packaged: !cfg!(debug_assertions),
            storage_warning: store.warning.clone(),
        })
    }
    fn update(&self, change: impl FnOnce(&mut Data) -> Result<(), String>) -> Result<(), String> {
        self.0
            .store
            .lock()
            .map_err(|_| "本地数据暂不可用。")?
            .update(change)?;
        self.0.wake.notify_one();
        Ok(())
    }
}
fn authorize(window: &WebviewWindow, main_only: bool) -> Result<(), String> {
    if window.label() == "main" || (!main_only && window.label() == "reminder") {
        Ok(())
    } else {
        Err("不允许的请求来源。".into())
    }
}
fn notice(app: &AppHandle, message: impl ToString) {
    let _ = app.emit("shoho:notice", message.to_string());
}
fn broadcast(app: &AppHandle) {
    if let Ok(snapshot) = app.state::<Backend>().snapshot() {
        let _ = app.emit("shoho:changed", &snapshot);
        if let Err(error) = update_tray(app, &snapshot) {
            notice(app, error);
        }
    }
}
fn dismiss(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("reminder") {
        let _ = window.close();
    }
}
fn internal_url(url: &tauri::Url) -> bool {
    url.scheme() == "tauri"
        || url.host_str() == Some("tauri.localhost")
        || (cfg!(debug_assertions)
            && url.host_str() == Some("127.0.0.1")
            && url.port() == Some(1420))
}
fn open_main(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        window.unminimize().map_err(|error| error.to_string())?;
        window.show().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
        return Ok(());
    }
    let builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("小喝 · Shoho")
        .inner_size(480.0, 620.0)
        .min_inner_size(420.0, 540.0)
        .visible(false)
        .center()
        .on_navigation(internal_url);
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true);
    builder.build().map_err(|error| error.to_string())?;
    Ok(())
}
fn open_reminder(app: &AppHandle) -> Result<(), String> {
    // Window creation is performed on a worker thread, avoiding WebView2's synchronous command deadlock.
    if let Some(window) = app.get_webview_window("reminder") {
        window.show().map_err(|error| error.to_string())?;
        return Ok(());
    }
    let snapshot = app.state::<Backend>().snapshot()?;
    let height = 166.0 + 54.0 * snapshot.data.settings.presets.len().div_ceil(3) as f64;
    let mut builder =
        WebviewWindowBuilder::new(app, "reminder", WebviewUrl::App("reminder.html".into()))
            .title("喝一小口 · Shoho")
            .inner_size(320.0, height)
            .decorations(false)
            .shadow(false)
            .transparent(false)
            .background_color(tauri::window::Color(248, 250, 248, 255))
            .resizable(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .focused(false)
            .visible(false)
            .on_navigation(internal_url);
    if let Ok(Some(monitor)) = app.primary_monitor() {
        let area = monitor.work_area();
        let scale = monitor.scale_factor();
        let x = (f64::from(area.position.x) + f64::from(area.size.width)) / scale - 344.0;
        let y = (f64::from(area.position.y) + f64::from(area.size.height)) / scale - height - 24.0;
        builder = builder.position(x, y);
    }
    builder.build().map_err(|error| error.to_string())?;
    if snapshot.data.settings.system_notifications {
        if let Err(error) = app
            .notification()
            .builder()
            .title("小喝 · 该喝一口水啦")
            .body("让眼睛休息一下，也给自己补点水。")
            .show()
        {
            notice(app, format!("系统通知未送达，提醒浮窗仍可使用：{error}"));
        }
    }
    Ok(())
}
fn update_tray(app: &AppHandle, snapshot: &Snapshot) -> tauri::Result<()> {
    let Some(tray) = app.tray_by_id("shoho") else {
        return Ok(());
    };
    let total = snapshot.data.total(now());
    let title = format!("今日已喝 {total} / {} ml", snapshot.data.settings.goal);
    let menu = Menu::new(app)?;
    menu.append(&MenuItem::with_id(
        app,
        "summary",
        &title,
        false,
        None::<&str>,
    )?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    for preset in &snapshot.data.settings.presets {
        menu.append(&MenuItem::with_id(
            app,
            format!("preset:{}", preset.id),
            format!("记录{} · {} ml", preset.name, preset.amount),
            true,
            None::<&str>,
        )?)?;
    }
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(
        app,
        "pause",
        if snapshot.data.paused_until > now() {
            "恢复提醒"
        } else {
            "暂停提醒 1 小时"
        },
        true,
        None::<&str>,
    )?)?;
    menu.append(&MenuItem::with_id(
        app,
        "toggle",
        if snapshot.data.settings.enabled {
            "关闭提醒"
        } else {
            "开启提醒"
        },
        true,
        None::<&str>,
    )?)?;
    menu.append(&MenuItem::with_id(
        app,
        "open",
        "打开小喝",
        true,
        None::<&str>,
    )?)?;
    menu.append(&MenuItem::with_id(
        app,
        "quit",
        "退出小喝",
        true,
        None::<&str>,
    )?)?;
    tray.set_tooltip(Some(format!(
        "小喝 · {total} / {} ml",
        snapshot.data.settings.goal
    )))?;
    tray.set_menu(Some(menu))?;
    Ok(())
}
fn create_tray(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(target_os = "macos")]
    let icon = Image::from_bytes(include_bytes!("../../assets/trayTemplate.png"))?;
    #[cfg(not(target_os = "macos"))]
    let icon = Image::from_bytes(include_bytes!("../../assets/icon.png"))?;
    TrayIconBuilder::with_id("shoho")
        .icon(icon)
        .icon_as_template(cfg!(target_os = "macos"))
        .tooltip("小喝 · Shoho")
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| {
            let action = event.id().as_ref().to_string();
            let app = app.clone();
            thread::spawn(move || {
                let backend = app.state::<Backend>();
                let result = match action.as_str() {
                    "open" => open_main(&app),
                    action if action.starts_with("preset:") => {
                        backend.update(|data| data.drink_preset(&action[7..], now()))
                    }
                    "toggle" => backend.update(|data| {
                        data.settings.enabled = !data.settings.enabled;
                        data.reset_clock(now());
                        Ok(())
                    }),
                    "pause" => backend.update(|data| {
                        data.pause(if data.paused_until > now() { 0 } else { 60 }, now())
                    }),
                    "quit" => {
                        app.exit(0);
                        Ok(())
                    }
                    _ => Ok(()),
                };
                match result {
                    Ok(()) => {
                        if action.starts_with("preset:") || action == "pause" || action == "toggle"
                        {
                            dismiss(&app);
                            broadcast(&app);
                        }
                    }
                    Err(error) => notice(&app, error),
                }
            });
        })
        .build(app)?;
    update_tray(app, &app.state::<Backend>().snapshot()?)?;
    Ok(())
}
fn scheduler(app: AppHandle, backend: Backend) {
    thread::spawn(move || {
        let mut previous = now();
        let mut previous_kind = String::new();
        loop {
            let mut store = match backend.0.store.lock() {
                Ok(store) => store,
                Err(_) => break,
            };
            let at = now();
            let old_clock = store.data.next_reminder_at;
            let due = store.data.tick(at, previous);
            previous = at;
            let status = store.data.status(at);
            let changed = status.kind != previous_kind || old_clock != store.data.next_reminder_at;
            previous_kind = status.kind.to_string();
            let wait = store.data.wait_millis(at);
            drop(store);
            if due {
                if let Err(error) = open_reminder(&app) {
                    notice(&app, error);
                }
            }
            if changed {
                if status.kind != "active" {
                    dismiss(&app);
                }
                broadcast(&app);
            }
            let store = match backend.0.store.lock() {
                Ok(store) => store,
                Err(_) => break,
            };
            if backend
                .0
                .wake
                .wait_timeout(store, Duration::from_millis(wait))
                .is_err()
            {
                break;
            }
        }
    });
}

#[tauri::command]
fn get_state(window: WebviewWindow, backend: State<'_, Backend>) -> Result<Snapshot, String> {
    authorize(&window, false)?;
    backend.snapshot()
}
#[tauri::command]
async fn drink(
    window: WebviewWindow,
    app: AppHandle,
    backend: State<'_, Backend>,
    amount: u32,
    label: Option<String>,
) -> Result<Snapshot, String> {
    authorize(&window, false)?;
    backend.update(|data| match label {
        Some(label) => data.drink_named(amount, Some(label), now()),
        None => data.drink(amount, now()),
    })?;
    dismiss(&app);
    broadcast(&app);
    backend.snapshot()
}
#[tauri::command]
async fn drink_preset(
    window: WebviewWindow,
    app: AppHandle,
    backend: State<'_, Backend>,
    id: String,
) -> Result<Snapshot, String> {
    authorize(&window, false)?;
    backend.update(|data| data.drink_preset(&id, now()))?;
    dismiss(&app);
    broadcast(&app);
    backend.snapshot()
}
#[tauri::command]
async fn remove_record(
    window: WebviewWindow,
    app: AppHandle,
    backend: State<'_, Backend>,
    id: String,
) -> Result<Snapshot, String> {
    authorize(&window, true)?;
    backend.update(|data| {
        let length = data.records.len();
        data.records.retain(|record| record.id != id);
        if data.records.len() == length {
            return Err("这条记录已经不存在了。".into());
        }
        Ok(())
    })?;
    broadcast(&app);
    backend.snapshot()
}
#[tauri::command]
async fn save_settings(
    window: WebviewWindow,
    app: AppHandle,
    backend: State<'_, Backend>,
    mut settings: Settings,
) -> Result<Snapshot, String> {
    authorize(&window, true)?;
    settings.validate()?;
    settings.sync_cup();
    let previous = backend.snapshot()?.data.settings;
    let changed_login = previous.launch_at_login != settings.launch_at_login;
    if changed_login {
        if cfg!(debug_assertions) && settings.launch_at_login {
            return Err("开机启动需要安装打包后的应用才能开启。".into());
        }
        if settings.launch_at_login {
            app.autolaunch().enable()
        } else {
            app.autolaunch().disable()
        }
        .map_err(|error| error.to_string())?;
    }
    let result = backend.update(|data| {
        data.settings = settings;
        data.reset_clock(now());
        Ok(())
    });
    if let Err(error) = result {
        if changed_login {
            let rollback = if previous.launch_at_login {
                app.autolaunch().enable()
            } else {
                app.autolaunch().disable()
            };
            if let Err(rollback_error) = rollback {
                notice(&app, rollback_error);
            }
        }
        return Err(error);
    }
    dismiss(&app);
    broadcast(&app);
    backend.snapshot()
}
#[tauri::command]
async fn pause_reminders(
    window: WebviewWindow,
    app: AppHandle,
    backend: State<'_, Backend>,
    minutes: u32,
) -> Result<Snapshot, String> {
    authorize(&window, false)?;
    backend.update(|data| data.pause(minutes, now()))?;
    dismiss(&app);
    broadcast(&app);
    backend.snapshot()
}
#[tauri::command]
async fn test_reminder(window: WebviewWindow, app: AppHandle) -> Result<(), String> {
    authorize(&window, true)?;
    open_reminder(&app)
}
#[tauri::command]
async fn dismiss_reminder(window: WebviewWindow, app: AppHandle) -> Result<(), String> {
    authorize(&window, false)?;
    dismiss(&app);
    Ok(())
}
// This narrow command opens only the OS notification pane; the frontend cannot supply a URL.
#[tauri::command]
async fn open_notification_settings(window: WebviewWindow, app: AppHandle) -> Result<(), String> {
    authorize(&window, true)?;
    #[cfg(target_os = "macos")]
    {
        let url = format!(
            "x-apple.systempreferences:com.apple.preference.notifications?id={}",
            app.config().identifier
        );
        let status = std::process::Command::new("/usr/bin/open")
            .arg(url)
            .status()
            .map_err(|error| format!("无法打开系统通知设置：{error}"))?;
        if !status.success() {
            return Err("无法打开系统通知设置，请在系统设置中选择通知。".into());
        }
        Ok(())
    }
    #[cfg(target_os = "windows")]
    {
        let _ = app;
        std::process::Command::new("explorer.exe")
            .arg("ms-settings:notifications")
            .spawn()
            .map_err(|error| format!("无法打开系统通知设置：{error}"))?;
        Ok(())
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = app;
        Err("请在系统设置中打开通知权限。".into())
    }
}
#[tauri::command]
async fn window_ready(window: WebviewWindow) -> Result<(), String> {
    authorize(&window, false)?;
    window.show().map_err(|error| error.to_string())
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            let app = app.clone();
            thread::spawn(move || {
                if let Err(error) = open_main(&app) {
                    notice(&app, error);
                }
            });
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--background"]),
        ))
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            get_state,
            drink,
            drink_preset,
            remove_record,
            save_settings,
            pause_reminders,
            test_reminder,
            dismiss_reminder,
            window_ready,
            open_notification_settings
        ])
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let legacy = app.path().data_dir()?.join("Shoho/shoho.json");
            // Test overrides are honored only by debug builds.
            let path = if cfg!(debug_assertions) {
                std::env::var_os("SHOHO_USER_DATA")
                    .map(PathBuf::from)
                    .unwrap_or(data_dir)
            } else {
                data_dir
            };
            let isolated = cfg!(debug_assertions) && std::env::var_os("SHOHO_USER_DATA").is_some();
            let store = Store::load(
                path.join("shoho.json"),
                if isolated { None } else { Some(&legacy) },
                now(),
            )?;
            let backend = Backend(Arc::new(Shared {
                store: Mutex::new(store),
                wake: Condvar::new(),
            }));
            app.manage(backend.clone());
            create_tray(app.handle())?;
            // An explicit Quit menu keeps Cmd+Q working while normal window closure retains the tray.
            #[cfg(target_os = "macos")]
            {
                use tauri::menu::{PredefinedMenuItem, Submenu};
                let quit = MenuItem::with_id(app, "quit", "退出小喝", true, Some("CmdOrCtrl+Q"))?;
                let menu = Menu::with_items(
                    app,
                    &[
                        &Submenu::with_items(
                            app,
                            "Shoho",
                            true,
                            &[
                                &PredefinedMenuItem::about(app, Some("关于小喝"), None)?,
                                &quit,
                            ],
                        )?,
                        &Submenu::with_items(
                            app,
                            "编辑",
                            true,
                            &[
                                &PredefinedMenuItem::undo(app, None)?,
                                &PredefinedMenuItem::redo(app, None)?,
                                &PredefinedMenuItem::cut(app, None)?,
                                &PredefinedMenuItem::copy(app, None)?,
                                &PredefinedMenuItem::paste(app, None)?,
                                &PredefinedMenuItem::select_all(app, None)?,
                            ],
                        )?,
                    ],
                )?;
                app.set_menu(menu)?;
                app.on_menu_event(|app, event| {
                    if event.id().as_ref() == "quit" {
                        app.exit(0);
                    }
                });
            }
            if !std::env::args().any(|arg| arg == "--background") {
                open_main(app.handle())?;
            }
            scheduler(app.handle().clone(), backend);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("小喝无法启动");
    app.run(|app, event| match event {
        tauri::RunEvent::ExitRequested { api, code, .. } if code.is_none() => api.prevent_exit(),
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen { .. } => {
            let app = app.clone();
            thread::spawn(move || {
                if let Err(error) = open_main(&app) {
                    notice(&app, error);
                }
            });
        }
        _ => {}
    });
}
