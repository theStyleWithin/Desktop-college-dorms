mod accounts;
mod commands;
mod db;
mod extras;
mod gallerycomments;
mod guide;
mod handoff;
mod itemxfer;
mod llama;
mod llm;
mod netpic;
mod novel;
mod phone;
mod picchat;
mod shelf;
mod starters;
mod tokenator;
mod transfer;
mod tray;
mod deco;
mod emoji;
mod emojiconv;
mod playbook;
mod presence;
mod secrets;
mod unitypkg;
mod viewfolders;

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
    /// A profile being sent to, or received from, another device over the home network.
    pub transfer: Mutex<transfer::TransferState>,
    /// Wrong-passcode tracking per profile: (failures, locked until).
    pub login_fails: Mutex<HashMap<String, (u32, std::time::Instant)>>,
    /// A profile file being brought in piece by piece (so a big file never has to cross into the app in one go, which phones can't do).
    pub staged: Mutex<Option<(String, Arc<Vec<u8>>)>>,
    /// Novels being written, by chat.
    pub novels: Mutex<HashMap<i64, novel::Run>>,
    /// The window is hidden to the tray while a novel is written.
    pub hidden: std::sync::atomic::AtomicBool,
    /// Keep the app in the system tray: bit 1 = when the window is minimized, bit 2 = when it is closed (see `tray.rs`).
    pub tray_flags: std::sync::atomic::AtomicU8,
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
    // started with a card (Sudo Make Art, a file manager): keep it until a profile is open
    handoff::queue(&std::env::args().collect::<Vec<_>>());
    let builder = tauri::Builder::default();
    // a second start hands its cards to the app that is already running instead of opening another window
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| handoff::forwarded(app, &args)));
    builder
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
                transfer: Default::default(),
                login_fails: Default::default(),
                staged: Default::default(),
                novels: Default::default(),
                hidden: Default::default(),
                tray_flags: Default::default(),
            }));
            // backdrops that are GIFs from before they were made lighter: do it once, in the background
            {
                let st: Shared = app.state::<Shared>().inner().clone();
                std::thread::spawn(move || extras::lighten_old_backdrops(&st));
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            shelf::get_shelf,
            shelf::create_shelf_folder,
            shelf::rename_shelf_folder,
            shelf::move_shelf_folder,
            shelf::delete_shelf_folder,
            shelf::move_to_shelf_folder,
            tokenator::tokenator_run,
            tokenator::tokenator_make,
            tokenator::tokenator_chat,
            phone::phone_check,
            transfer::transfer_send_start,
            transfer::transfer_receive_start,
            transfer::transfer_status,
            transfer::transfer_cancel,
            novel::novel_status,
            novel::novel_start,
            novel::novel_stop,
            novel::novels_running,
            tray::tray_available,
            tray::hide_to_tray,
            tray::set_tray_mode,
            tray::tray_hide_if_minimized,
            handoff::import_pending_cards,
            tray::quit_app,
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
            extras::set_room_links,
            extras::add_room_picture,
            extras::set_room_picture_caption,
            extras::remove_room_picture,
            extras::use_room_picture_as_backdrop,
            extras::move_chat,
            extras::list_worlds,
            extras::create_world,
            extras::update_world,
            extras::set_world_setup,
            extras::delete_world,
            extras::set_world_cover,
            extras::clear_world_cover,
            extras::move_rooms_to_world,
            extras::set_room_music,
            extras::clear_room_music,
            extras::set_room_model,
            extras::disk_space,
            extras::room_model_begin,
            extras::room_model_chunk,
            extras::room_model_finish,
            extras::room_model_cancel,
            presence::provider_health,
            presence::list_statuses,
            presence::set_status,
            presence::generate_status,
            gallerycomments::gallery_comments,
            gallerycomments::gallery_comment_counts,
            gallerycomments::add_gallery_comment,
            gallerycomments::edit_gallery_comment,
            gallerycomments::delete_gallery_comment,
            viewfolders::list_view_folders,
            viewfolders::add_view_folder,
            viewfolders::remove_view_folder,
            viewfolders::scan_view_folder,
            viewfolders::view_thumb,
            picchat::gallery_chat,
            viewfolders::create_gallery_folder,
            viewfolders::add_folder_picture,
            viewfolders::remove_folder_picture,
            itemxfer::inspect_staged_item,
            itemxfer::add_staged_item,
            netpic::fetch_picture,
            deco::list_char_deco,
            deco::list_custom_deco,
            deco::save_custom_deco,
            deco::delete_custom_deco,
            deco::set_char_deco,
            deco::clear_char_deco,
            deco::generate_char_deco,
            playbook::list_playbooks,
            playbook::save_playbook,
            playbook::delete_playbook,
            playbook::playbook_templates,
            playbook::get_chat_playbook,
            playbook::set_chat_playbook,
            playbook::set_playbook_values,
            playbook::set_playbook_llm,
            emoji::list_emoji,
            emoji::add_emoji,
            emoji::update_emoji,
            emoji::delete_emoji,
            extras::list_prompts,
            extras::save_prompt,
            extras::delete_prompt,
            extras::list_decor,
            extras::decor_finish,
            extras::rename_decor,
            extras::set_decor_share,
            extras::delete_decor,
            extras::room_package_scan,
            extras::room_package_extract,
            extras::room_package_cleanup,
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
            commands::character_usage,
            commands::set_media,
            commands::set_frame,
            commands::add_outfit,
            commands::set_outfit,
            commands::rename_outfit,
            commands::remove_outfit,
            commands::transcribe_audio,
            commands::test_voice,
            commands::clear_media,
            commands::add_gallery_image,
            commands::link_gallery_file,
            commands::set_gallery_moods,
            commands::remove_gallery_item,
            commands::set_gallery_mode,
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
            accounts::hide_profile,
            accounts::unhide_profile,
            accounts::sign_out,
            accounts::create_profile,
            accounts::claim_guest_profile,
            accounts::update_profile,
            accounts::set_passcode,
            accounts::set_launch_pref,
            accounts::prepare_export,
            accounts::read_export,
            accounts::save_export,
            accounts::save_export_to_uri,
            accounts::confirm_export_saved,
            accounts::eject_profile,
            accounts::delete_profile,
            accounts::import_profile,
            commands::vrm_guard_begin,
            commands::vrm_guard_end,
            commands::set_auto_chat,
        ])
        .on_window_event(|window, event| {
            use tauri::{Emitter, Manager};
            if window.label() != "main" { return; }
            // the person chose to keep the app in the system tray: minimizing, or closing, puts the window away instead (see tray.rs)
            if let tauri::WindowEvent::Resized(_) = event {
                if tray::flags(window.app_handle()) & tray::MINIMIZE != 0 && window.is_minimized().unwrap_or(false) {
                    tray::put_away(window.app_handle());
                }
            }
            // closing the window while a novel is being written: ask first (hide to the tray, or close and stop)
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if tray::flags(window.app_handle()) & tray::CLOSE != 0 && tray::has_menu_icon(window.app_handle()) {
                    api.prevent_close();
                    tray::put_away(window.app_handle());
                    return;
                }
                {
                    if let Some(st) = window.app_handle().try_state::<Shared>() {
                        if !st.novels.lock().unwrap().is_empty() {
                            api.prevent_close();
                            let _ = window.emit("dorms://close-while-writing", ());
                        }
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Desktop College Dorms");
}
