//! Keep writing in the background: while a novel is being written, closing the window can hide the app to the system tray instead of
//! stopping it. The tray icon only exists while the window is hidden, and the window comes back (and the icon goes) when you open it from
//! the tray or when the novel is finished. Phones have no tray: there the app has to stay open.

use tauri::{AppHandle, State};

use crate::Shared;

/// Whether this device can hide the app to a tray at all.
#[tauri::command]
pub fn tray_available() -> bool {
    cfg!(desktop)
}

/// Put the window away and leave an icon in the tray (Open / Quit). Fails, leaving the window as it was, if the system has no tray to use.
#[tauri::command]
pub fn hide_to_tray(app: AppHandle, state: State<'_, Shared>) -> Result<(), String> {
    #[cfg(desktop)]
    {
        use std::panic::{catch_unwind, AssertUnwindSafe};
        use tauri::menu::{Menu, MenuItem};
        use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
        use tauri::Manager;
        let window = app.get_webview_window("main").ok_or("The window isn't there.")?;
        if app.tray_by_id("novel").is_none() {
            // on some Linux desktops there is no tray library: that is a failure to report, not a crash
            let built = catch_unwind(AssertUnwindSafe(|| -> Result<(), String> {
                let open = MenuItem::with_id(&app, "open", "Open Desktop College Dorms", true, None::<&str>).map_err(|e| e.to_string())?;
                let quit = MenuItem::with_id(&app, "quit", "Quit (stops writing)", true, None::<&str>).map_err(|e| e.to_string())?;
                let menu = Menu::with_items(&app, &[&open, &quit]).map_err(|e| e.to_string())?;
                let mut b = TrayIconBuilder::with_id("novel").tooltip("Desktop College Dorms: still writing your novel").menu(&menu);
                if let Some(icon) = app.default_window_icon() {
                    b = b.icon(icon.clone());
                }
                b.on_menu_event(|app, ev| match ev.id.as_ref() {
                    "open" => reveal(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, ev| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = ev {
                        reveal(tray.app_handle());
                    }
                })
                .build(&app)
                .map(|_| ())
                .map_err(|e| e.to_string())
            }));
            match built {
                Ok(Ok(())) => {}
                Ok(Err(e)) => return Err(format!("Couldn't make a tray icon: {e}")),
                Err(_) => return Err("This desktop has no system tray to hide to.".into()),
            }
        }
        window.hide().map_err(|e| e.to_string())?;
        state.hidden.store(true, std::sync::atomic::Ordering::SeqCst);
        Ok(())
    }
    #[cfg(not(desktop))]
    {
        let _ = (&app, &state);
        Err("This device has no system tray. Keep the app open while it writes.".into())
    }
}

/// Bring the window back and take the tray icon away.
pub fn reveal(app: &AppHandle) {
    #[cfg(desktop)]
    {
        use tauri::Manager;
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.show();
            let _ = w.unminimize();
            let _ = w.set_focus();
        }
        let _ = app.remove_tray_by_id("novel");
        if let Some(st) = app.try_state::<Shared>() {
            st.hidden.store(false, std::sync::atomic::Ordering::SeqCst);
        }
    }
    #[cfg(not(desktop))]
    let _ = app;
}

/// Quit the whole app (what "Close anyway" does).
#[tauri::command]
pub fn quit_app(app: AppHandle) {
    app.exit(0);
}
