mod commands;
mod db;
mod llama;
mod llm;
mod secrets;

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::Manager;
use tokio::sync::Notify;

pub struct AppState {
    pub app: tauri::AppHandle,
    pub data_dir: PathBuf,
    pub db: Mutex<rusqlite::Connection>,
    pub http: reqwest::Client,
    pub llama: tokio::sync::Mutex<llama::LlamaState>,
    /// Cancel handles for in-flight generations and downloads.
    pub cancels: Mutex<HashMap<String, Arc<Notify>>>,
    pub autos: Mutex<HashMap<i64, tauri::async_runtime::JoinHandle<()>>>,
    pub busy: Mutex<HashSet<i64>>,
}

pub type Shared = Arc<AppState>;

fn resolve_data_dir(app: &tauri::AppHandle) -> PathBuf {
    #[cfg(feature = "portable")]
    {
        if let Some(dir) = std::env::current_exe().ok().and_then(|e| e.parent().map(|p| p.to_path_buf())) {
            return dir.join("DormsData");
        }
    }
    app.path().app_data_dir().expect("no app data dir available")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // WebKitGTK's DMABUF renderer gives blank windows on some GPU/driver combos
    // (notably NVIDIA and a few Mesa/Wayland setups). Turn it off unless the
    // user has set the variable themselves.
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            let data_dir = resolve_data_dir(app.handle());
            std::fs::create_dir_all(data_dir.join("media"))?;
            std::fs::create_dir_all(data_dir.join("models"))?;
            let conn = db::open(&data_dir.join("dorms.db"))?;
            // background chats never survive a restart
            conn.execute("UPDATE chats SET auto_chat=0", [])?;
            // The web view may read avatar media only, never the database or the key file.
            let _ = app.asset_protocol_scope().allow_directory(data_dir.join("media"), true);
            let http = reqwest::Client::builder()
                .user_agent("DesktopCollegeDorms")
                .connect_timeout(Duration::from_secs(20))
                // never follow a redirect from https:// down to plain http://
                .redirect(reqwest::redirect::Policy::custom(|a| {
                    let downgrade = a.url().scheme() == "http" && a.previous().iter().any(|u| u.scheme() == "https");
                    if downgrade { a.stop() } else if a.previous().len() >= 8 { a.stop() } else { a.follow() }
                }))
                .build()?;
            app.manage(Arc::new(AppState {
                app: app.handle().clone(),
                data_dir,
                db: Mutex::new(conn),
                http,
                llama: Default::default(),
                cancels: Default::default(),
                autos: Default::default(),
                busy: Default::default(),
            }));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::list_characters,
            commands::get_character,
            commands::save_character,
            commands::delete_character,
            commands::set_favorite,
            commands::set_media,
            commands::clear_media,
            commands::import_card,
            commands::export_card,
            commands::list_dorms,
            commands::create_dorm,
            commands::rename_dorm,
            commands::delete_dorm,
            commands::list_chats,
            commands::create_chat,
            commands::update_chat,
            commands::delete_chat,
            commands::list_messages,
            commands::add_user_message,
            commands::edit_message,
            commands::delete_message,
            commands::set_swipe,
            commands::clear_chat,
            commands::get_settings,
            commands::save_settings,
            commands::set_api_key,
            commands::has_api_key,
            commands::hardware_info,
            commands::list_models,
            commands::delete_model,
            commands::download_model,
            commands::cancel_download,
            commands::local_engine_status,
            commands::stop_local_engine,
            commands::generate,
            commands::cancel_generation,
            commands::test_provider,
            commands::test_profile,
            commands::list_remote_models,
            commands::vrm_guard_begin,
            commands::vrm_guard_end,
            commands::set_auto_chat,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Desktop College Dorms");
}
