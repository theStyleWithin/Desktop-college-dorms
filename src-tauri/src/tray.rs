//! The system tray. Two uses:
//!
//! 1. Keep the app running in the tray (a Settings choice, per profile): minimizing the window and/or closing it puts the window away and leaves
//!    an icon whose menu opens the app, jumps straight to Tokenator, the chats, the characters, the Gallery or Settings, or quits. Clicking the icon
//!    shows or hides the window. Launching the app a second time always brings the window back (so a desktop that hides tray icons can't strand it).
//! 2. Keep writing in the background: while a novel is being written, closing the window can hide the app to the system tray instead of
//!    stopping it. The tray icon only exists while the window is hidden, and the window comes back (and the icon goes) when you open it from
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
        if app.tray_by_id("novel").is_none() && app.tray_by_id("main").is_none() {
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

/// Bits of `AppState::tray_flags`.
pub const MINIMIZE: u8 = 1;
pub const CLOSE: u8 = 2;

/// The pages the tray menu can jump to: (menu id, name in the menu, the page the app opens). The page names are the app's own.
pub const MENU_PAGES: [(&str, &str, &str); 5] = [
    ("nav:tokenator", "Tokenator", "tokenator"),
    ("nav:chat", "Dorms (chats)", "chat"),
    ("nav:library", "Characters", "library"),
    ("nav:gallery", "Gallery", "gallery"),
    ("nav:settings", "Settings", "settings"),
];

/// The page a menu item opens, if it is one of the page items.
pub fn nav_target(menu_id: &str) -> Option<&'static str> {
    MENU_PAGES.iter().find(|(id, _, _)| *id == menu_id).map(|(_, _, page)| *page)
}

/// Which of the two tray choices are on.
pub fn flags(app: &AppHandle) -> u8 {
    use tauri::Manager;
    app.try_state::<Shared>().map(|s| s.tray_flags.load(std::sync::atomic::Ordering::SeqCst)).unwrap_or(0)
}

/// Whether the tray icon with the menu is there (so putting the window away can't strand it).
pub fn has_menu_icon(app: &AppHandle) -> bool {
    #[cfg(desktop)]
    { app.tray_by_id("main").is_some() }
    #[cfg(not(desktop))]
    { let _ = app; false }
}

/// Put the window away; the icon is already in the tray.
pub fn put_away(app: &AppHandle) {
    #[cfg(desktop)]
    {
        use tauri::Manager;
        if !has_menu_icon(app) { return; }
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.hide();
            if let Some(st) = app.try_state::<Shared>() { st.hidden.store(true, std::sync::atomic::Ordering::SeqCst); }
        }
    }
    #[cfg(not(desktop))]
    let _ = app;
}

#[cfg(desktop)]
fn build_menu_icon(app: &AppHandle) -> Result<(), String> {
    use std::panic::{catch_unwind, AssertUnwindSafe};
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
    use tauri::{Emitter, Manager};
    if app.tray_by_id("main").is_some() { return Ok(()); }
    // on some Linux desktops there is no tray library: that is a failure to report, not a crash
    let built = catch_unwind(AssertUnwindSafe(|| -> Result<(), String> {
        let open = MenuItem::with_id(app, "open", "Open Desktop College Dorms", true, None::<&str>).map_err(|e| e.to_string())?;
        let quit = MenuItem::with_id(app, "quit", "Quit Desktop College Dorms", true, None::<&str>).map_err(|e| e.to_string())?;
        let sep1 = PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?;
        let sep2 = PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?;
        let pages: Vec<MenuItem<_>> = MENU_PAGES.iter().map(|(id, name, _)| MenuItem::with_id(app, *id, *name, true, None::<&str>).map_err(|e| e.to_string())).collect::<Result<_, _>>()?;
        let mut items: Vec<&dyn tauri::menu::IsMenuItem<_>> = vec![&open, &sep1];
        for p in &pages { items.push(p); }
        items.push(&sep2);
        items.push(&quit);
        let menu = Menu::with_items(app, &items).map_err(|e| e.to_string())?;
        let mut b = TrayIconBuilder::with_id("main").tooltip("Desktop College Dorms").menu(&menu).show_menu_on_left_click(false);
        if let Some(icon) = app.default_window_icon() { b = b.icon(icon.clone()); }
        b.on_menu_event(|app, ev| {
            let id = ev.id.as_ref();
            if id == "quit" { app.exit(0); return; }
            reveal(app);
            if let Some(page) = nav_target(id) { let _ = app.emit("dorms://tray-nav", page); }
        })
        .on_tray_icon_event(|tray, ev| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = ev {
                let app = tray.app_handle();
                let shown = app.get_webview_window("main").map(|w| w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(false)).unwrap_or(false);
                if shown { put_away(app); } else { reveal(app); }
            }
        })
        .build(app)
        .map(|_| ())
        .map_err(|e| e.to_string())
    }));
    match built {
        Ok(r) => r,
        Err(_) => Err("This desktop has no system tray to use.".into()),
    }
}

/// Turn "keep the app in the system tray" on or off (when the window is minimized, when it is closed, both or neither). The icon is made when either
/// is on and removed when both are off; if the system has no tray to use, nothing is turned on and the reason is returned.
#[tauri::command]
pub fn set_tray_mode(app: AppHandle, state: State<'_, Shared>, minimize: bool, close: bool) -> Result<(), String> {
    use std::sync::atomic::Ordering;
    let f = (minimize as u8 * MINIMIZE) | (close as u8 * CLOSE);
    #[cfg(desktop)]
    {
        if f == 0 {
            state.tray_flags.store(0, Ordering::SeqCst);
            let _ = app.remove_tray_by_id("main");
            if state.hidden.load(Ordering::SeqCst) { reveal(&app); }
            return Ok(());
        }
        if let Err(e) = build_menu_icon(&app) { state.tray_flags.store(0, Ordering::SeqCst); return Err(e); }
        state.tray_flags.store(f, Ordering::SeqCst);
        Ok(())
    }
    #[cfg(not(desktop))]
    {
        let _ = (&app, &state, f, Ordering::SeqCst);
        if f == 0 { Ok(()) } else { Err("This device has no system tray.".into()) }
    }
}

/// The page noticed it was hidden: if that is because the window was minimized and the person wants minimizing to put it in the tray, do that.
#[tauri::command]
pub fn tray_hide_if_minimized(app: AppHandle) {
    #[cfg(desktop)]
    {
        use tauri::Manager;
        if flags(&app) & MINIMIZE != 0 && app.get_webview_window("main").map(|w| w.is_minimized().unwrap_or(false)).unwrap_or(false) { put_away(&app); }
    }
    #[cfg(not(desktop))]
    let _ = app;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn menu_items_open_the_pages_they_name() {
        assert_eq!(nav_target("nav:tokenator"), Some("tokenator"));
        assert_eq!(nav_target("nav:settings"), Some("settings"));
        assert_eq!(nav_target("nav:gallery"), Some("gallery"));
        for not_a_page in ["open", "quit", "nav:", "nav:evil", "tokenator", ""] { assert_eq!(nav_target(not_a_page), None, "{not_a_page:?}"); }
        assert!(MENU_PAGES.iter().all(|(id, name, page)| id.starts_with("nav:") && id.len() > 4 && !name.is_empty() && !page.is_empty()));
        let ids: std::collections::HashSet<_> = MENU_PAGES.iter().map(|x| x.0).collect();
        assert_eq!(ids.len(), MENU_PAGES.len(), "no two items share an id");
        assert_ne!(MINIMIZE, CLOSE);
    }
}
