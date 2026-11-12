mod accounts;
mod commands;
mod db;
mod extras;
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
    pub session: Mutex<Session>,
    /// Export waiting to be saved (and, for eject, confirmed): (token, file bytes, profile it came from).
    pub pending_export: Mutex<Option<crate::accounts::PendingExport>>,
    /// Wrong-passcode tracking per profile: (failures, locked until).
    pub login_fails: Mutex<HashMap<String, (u32, std::time::Instant)>>,
    /// A profile file being brought in piece by piece (so a big file never has to cross into the app in one go, which phones can't do).
    pub staged: Mutex<Option<(String, Arc<Vec<u8>>)>>,
}

pub type Shared = Arc<AppState>;

/// Which local profile (or the guest space) is open. Only the backend decides this; the web view can't pick
/// another profile's data by sending a different id.
#[derive(Default)]
pub struct Session {
    pub chosen: bool,
    /// `None` = guest space.
    pub profile: Option<String>,
    /// Set after an explicit sign-out so the app doesn't just reopen the last profile.
    pub no_auto: bool,
}

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
            // Voice input: WebKitGTK keeps getUserMedia off and refuses microphone requests unless the app opts in.
            // Only audio capture is allowed (never camera or screen), and only the app's own pages can ask.
            #[cfg(target_os = "linux")]
            if let Some(w) = tauri::Manager::get_webview_window(app, "main") {
                let _ = w.with_webview(|wv| {
                    use webkit2gtk::{glib::prelude::Cast, PermissionRequestExt, SettingsExt, UserMediaPermissionRequest, UserMediaPermissionRequestExt, WebViewExt};
                    let view = wv.inner();
                    if let Some(settings) = WebViewExt::settings(&view) { settings.set_enable_media_stream(true); }
                    view.connect_permission_request(|_, request| {
                        if let Some(m) = request.downcast_ref::<UserMediaPermissionRequest>() {
                            if m.is_for_audio_device() && !m.is_for_video_device() { request.allow(); } else { request.deny(); }
                            return true;
                        }
                        false
                    });
                });
            }
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
                session: Default::default(),
                pending_export: Default::default(),
                login_fails: Default::default(),
                staged: Default::default(),
            }));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            accounts::stage_begin,
            accounts::stage_chunk,
            accounts::stage_clear,
            accounts::inspect_staged,
            accounts::import_staged,
            extras::list_personas,
            extras::save_persona,
            extras::delete_persona,
            extras::set_persona_avatar,
            extras::set_persona_frame,
            extras::clear_persona_avatar,
            extras::set_active_persona,
            extras::set_profile_avatar,
            extras::set_profile_avatar_frame,
            extras::clear_profile_avatar,
            extras::list_lorebooks,
            extras::save_lorebook,
            extras::delete_lorebook,
            extras::list_folders,
            extras::create_folder,
            extras::move_folder,
            extras::rename_folder,
            extras::delete_folder,
            extras::set_folder_cover,
            extras::set_folder_frame,
            extras::clear_folder_cover,
            extras::move_characters,
            extras::reorder_characters,
            extras::set_folder_cover_char,
            extras::list_notes,
            extras::save_note,
            extras::delete_note,
            extras::list_rooms,
            extras::create_room,
            extras::update_room,
            extras::delete_room,
            extras::set_room_backdrop,
            extras::set_dorm_room,
            extras::set_room_music,
            extras::clear_room_music,
            extras::set_room_model,
            extras::clear_room_model,
            extras::set_room_model_cfg,
            extras::set_dorm_music,
            extras::clear_dorm_music,
            extras::list_mechanics,
            extras::import_mechanic,
            extras::delete_mechanic,
            extras::chat_mechanics,
            extras::set_chat_mechanic,
            extras::reset_chat_mechanic,
            extras::set_chat_variable,
            commands::list_characters,
            commands::get_character,
            commands::save_character,
            commands::delete_character,
            commands::set_favorite,
            commands::set_media,
            commands::set_frame,
            commands::add_outfit,
            commands::set_outfit,
            commands::rename_outfit,
            commands::remove_outfit,
            commands::transcribe_audio,
            commands::test_voice,
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
            accounts::session_state,
            accounts::sign_in,
            accounts::sign_out,
            accounts::create_profile,
            accounts::claim_guest_profile,
            accounts::update_profile,
            accounts::set_passcode,
            accounts::set_launch_pref,
            accounts::prepare_export,
            accounts::read_export,
            accounts::save_export,
            accounts::confirm_export_saved,
            accounts::eject_profile,
            accounts::delete_profile,
            accounts::import_profile,
            commands::vrm_guard_begin,
            commands::vrm_guard_end,
            commands::set_auto_chat,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Desktop College Dorms");
}
