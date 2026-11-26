//! Cards handed to the app from outside: `desktop-college-dorms --import-card card.png`
//! (what Sudo Make Art's "Send to Desktop College Dorms" runs) or a file opened with the app.
//!
//! The paths wait here until a profile is open; the window then asks for them with
//! `import_pending_cards`, which reads and imports them in Rust, so the web view never names a file path.

use std::path::PathBuf;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::commands::{import_bytes, ImportOut};
use crate::Shared;

type R<T> = Result<T, String>;

static WAITING: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());
const MAX_BYTES: u64 = 64 * 1024 * 1024;

/// Remember the cards named in these arguments. Returns whether there were any.
pub fn queue(args: &[String]) -> bool {
    let found = dorms_core::cli::card_args(args);
    if found.is_empty() { return false; }
    WAITING.lock().unwrap().extend(found);
    true
}

/// A second start of the app (already running): take its cards, show the window, tell the page.
pub fn forwarded(app: &AppHandle, args: &[String]) {
    let any = queue(args);
    crate::tray::reveal(app);
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
    if any { let _ = app.emit("dorms://cards-waiting", ()); }
}

#[derive(Serialize)]
pub struct PendingResult {
    file: String,
    imported: Option<ImportOut>,
    error: Option<String>,
}

/// Import the cards that are waiting. Nothing is taken until a profile is open.
#[tauri::command]
pub fn import_pending_cards(state: State<'_, Shared>) -> R<Vec<PendingResult>> {
    crate::commands::owner(&state)?;
    let paths: Vec<PathBuf> = std::mem::take(&mut *WAITING.lock().unwrap());
    let mut done = Vec::new();
    for p in paths {
        let file = p.file_name().and_then(|n| n.to_str()).unwrap_or("card").to_string();
        let r = (|| -> R<ImportOut> {
            let meta = std::fs::metadata(&p).map_err(|_| "That file could not be found.".to_string())?;
            if !meta.is_file() { return Err("That is not a file.".into()); }
            if meta.len() > MAX_BYTES { return Err("That file is too large to be a character card.".into()); }
            let bytes = std::fs::read(&p).map_err(|e| format!("Could not read it: {e}"))?;
            import_bytes(&state, &bytes, &file)
        })();
        match r {
            Ok(o) => done.push(PendingResult { file, imported: Some(o), error: None }),
            Err(e) => done.push(PendingResult { file, imported: None, error: Some(if e == "NO_CARD" { "that PNG has no character data in it".to_string() } else { e }) }),
        }
    }
    Ok(done)
}
