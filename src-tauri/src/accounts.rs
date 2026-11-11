//! Local profiles, guest mode, and export / eject / import.
//!
//! Profiles are offline: nothing here touches the network. A passcode only keeps other people at the same
//! computer out of your profile *inside the app*; it does not encrypt files on disk, and the UI says so.
//!
//! Eject follows the design of the author's Anti-Social app: save everything to a file first, check the file,
//! and only then (after the user confirms) take the profile off this device. It is not a delete: importing the
//! file brings it all back, here or on another device, and never overwrites an existing profile.

use std::collections::HashMap;
use std::io::{Cursor, Read, Write};
use std::time::{Duration, Instant};

use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use rand_core::OsRng;
use argon2::Argon2;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::State;

use crate::db::{self, Character, Chat, Dorm, Message, Owner, Settings};
use crate::{secrets, AppState, Shared};

type R<T> = Result<T, String>;

fn e<E: std::fmt::Display>(err: E) -> String {
    err.to_string()
}

fn uid() -> String {
    uuid::Uuid::new_v4().to_string()
}

const EXPORT_FORMAT: &str = "desktop-college-dorms/profile";
const EXPORT_VERSION: u32 = 1;
const MAX_JSON_BYTES: u64 = 512 * 1024 * 1024;
const MAX_MEDIA_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 4 * 1024 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Types sent to the web view
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone)]
pub struct ProfileOut {
    pub id: String,
    pub handle: String,
    pub display_name: String,
    pub has_passcode: bool,
    pub created_at: i64,
    pub last_login: i64,
}

impl From<&db::Profile> for ProfileOut {
    fn from(p: &db::Profile) -> Self {
        ProfileOut {
            id: p.id.clone(),
            handle: p.handle.clone(),
            display_name: p.display_name.clone(),
            has_passcode: p.passcode_hash.is_some(),
            created_at: p.created_at,
            last_login: p.last_login,
        }
    }
}

#[derive(Serialize)]
pub struct SessionOut {
    pub signed_in: bool,
    pub guest: bool,
    pub profile: Option<ProfileOut>,
    pub profiles: Vec<ProfileOut>,
    pub ask_on_launch: bool,
    /// Chats, characters and dorms already living in the guest space (so the picker can say so).
    pub guest_items: i64,
}

pub struct PendingExport {
    pub token: String,
    pub bytes: Vec<u8>,
    pub owner: Owner,
    pub file_name: String,
    /// Set once the bytes are known to be on disk (checked by reading them back).
    pub saved: bool,
}

// ---------------------------------------------------------------------------
// Passcodes and handles
// ---------------------------------------------------------------------------

fn hash_pass(p: &str) -> R<String> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default().hash_password(p.as_bytes(), &salt).map(|h| h.to_string()).map_err(e)
}

fn verify_pass(hash: &str, p: &str) -> bool {
    PasswordHash::new(hash).ok().map(|h| Argon2::default().verify_password(p.as_bytes(), &h).is_ok()).unwrap_or(false)
}

fn check_passcode_policy(p: &str) -> R<()> {
    if p.chars().count() < 4 {
        return Err("A passcode needs at least 4 characters.".into());
    }
    if p.chars().count() > 128 {
        return Err("That passcode is too long.".into());
    }
    Ok(())
}

fn clean_handle(h: &str) -> R<String> {
    let h = h.trim();
    let n = h.chars().count();
    if !(2..=24).contains(&n) {
        return Err("A profile name needs 2 to 24 characters.".into());
    }
    if !h.chars().all(|c| c.is_alphanumeric() || matches!(c, ' ' | '_' | '-' | '.')) {
        return Err("Use letters, numbers, spaces, and _ - . only.".into());
    }
    if h.eq_ignore_ascii_case("guest") {
        return Err("\"Guest\" is reserved. Pick another name.".into());
    }
    Ok(h.to_string())
}

fn lock_remaining(st: &AppState, id: &str) -> Option<u64> {
    let f = st.login_fails.lock().unwrap();
    match f.get(id) {
        Some((n, until)) if *n >= 5 && Instant::now() < *until => Some((*until - Instant::now()).as_secs() + 1),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

fn owner_now(st: &AppState) -> R<Owner> {
    let s = st.session.lock().unwrap();
    if s.chosen { Ok(s.profile.clone()) } else { Err("Pick a profile first.".into()) }
}

/// Stop everything that belongs to the profile being left: bot chats, in-flight replies, a half-made export.
fn end_session(st: &AppState) {
    for (_, h) in st.autos.lock().unwrap().drain() {
        h.abort();
    }
    for (_, n) in st.cancels.lock().unwrap().iter() {
        n.notify_one();
    }
    *st.pending_export.lock().unwrap() = None;
}

fn choose(st: &AppState, profile: Option<String>) {
    end_session(st);
    {
        let mut s = st.session.lock().unwrap();
        s.chosen = true;
        s.profile = profile.clone();
        s.no_auto = false;
    }
    let db = st.db.lock().unwrap();
    let mut dev = db::get_device(&db);
    dev.last = Some(profile.clone().unwrap_or_else(|| "guest".into()));
    let _ = db::save_device(&db, &dev);
    if let Some(id) = profile {
        let _ = db::touch_login(&db, &id);
    }
}

fn session_out(st: &AppState) -> R<SessionOut> {
    let (chosen, profile) = {
        let s = st.session.lock().unwrap();
        (s.chosen, s.profile.clone())
    };
    let db = st.db.lock().unwrap();
    let profiles = db::list_profiles(&db).map_err(e)?;
    let current = profile.as_ref().and_then(|id| profiles.iter().find(|p| &p.id == id)).map(ProfileOut::from);
    let guest_items = ["characters", "dorms", "chats"].iter().map(|t| db::count_rows(&db, t, &None)).sum();
    Ok(SessionOut {
        signed_in: chosen,
        guest: chosen && profile.is_none(),
        profile: current,
        profiles: profiles.iter().map(ProfileOut::from).collect(),
        ask_on_launch: db::get_device(&db).ask_on_launch,
        guest_items,
    })
}

/// Where the app is right now. On first call after launch it also performs the automatic sign-in:
/// straight into guest when no profiles exist, otherwise back into the last profile if it has no passcode.
#[tauri::command]
pub fn session_state(state: State<'_, Shared>) -> R<SessionOut> {
    let (chosen, no_auto) = {
        let s = state.session.lock().unwrap();
        (s.chosen, s.no_auto)
    };
    if !chosen && !no_auto {
        let auto: Option<Option<String>> = {
            let db = state.db.lock().unwrap();
            let profiles = db::list_profiles(&db).map_err(e)?;
            let dev = db::get_device(&db);
            if profiles.is_empty() {
                Some(None)
            } else if dev.ask_on_launch {
                None
            } else {
                match dev.last.as_deref() {
                    Some("guest") => Some(None),
                    Some(id) => profiles.iter().find(|p| p.id == id && p.passcode_hash.is_none()).map(|p| Some(p.id.clone())),
                    None => None,
                }
            }
        };
        if let Some(p) = auto {
            choose(&state, p);
        }
    }
    session_out(&state)
}

#[tauri::command]
pub async fn sign_in(state: State<'_, Shared>, profile_id: Option<String>, passcode: Option<String>) -> R<SessionOut> {
    let st: Shared = state.inner().clone();
    if let Some(id) = &profile_id {
        let prof = db::get_profile(&st.db.lock().unwrap(), id).map_err(e)?.ok_or("That profile no longer exists.")?;
        if let Some(hash) = prof.passcode_hash.clone() {
            if let Some(secs) = lock_remaining(&st, id) {
                return Err(format!("Too many wrong passcodes. Try again in {secs} seconds."));
            }
            let given = passcode.unwrap_or_default();
            let ok = tauri::async_runtime::spawn_blocking(move || verify_pass(&hash, &given)).await.map_err(e)?;
            if !ok {
                {
                    let mut f = st.login_fails.lock().unwrap();
                    let entry = f.entry(id.clone()).or_insert((0, Instant::now()));
                    entry.0 += 1;
                    if entry.0 >= 5 {
                        entry.1 = Instant::now() + Duration::from_secs(30);
                    }
                }
                tokio::time::sleep(Duration::from_millis(500)).await;
                return Err("Wrong passcode.".into());
            }
            st.login_fails.lock().unwrap().remove(id);
        }
    }
    choose(&st, profile_id);
    session_out(&st)
}

#[tauri::command]
pub fn sign_out(state: State<'_, Shared>) -> R<SessionOut> {
    end_session(&state);
    {
        let mut s = state.session.lock().unwrap();
        s.chosen = false;
        s.profile = None;
        s.no_auto = true;
    }
    session_out(&state)
}

#[tauri::command]
pub async fn create_profile(
    state: State<'_, Shared>,
    handle: String,
    display_name: Option<String>,
    passcode: Option<String>,
) -> R<SessionOut> {
    let st: Shared = state.inner().clone();
    let handle = clean_handle(&handle)?;
    let display = display_name.map(|d| d.trim().to_string()).filter(|d| !d.is_empty()).unwrap_or_else(|| handle.clone());
    let passcode = passcode.filter(|p| !p.is_empty());
    let hash = match passcode {
        Some(p) => {
            check_passcode_policy(&p)?;
            Some(tauri::async_runtime::spawn_blocking(move || hash_pass(&p)).await.map_err(e)??)
        }
        None => None,
    };
    let id = uid();
    {
        let db = st.db.lock().unwrap();
        if db::handle_taken(&db, &handle).map_err(e)? {
            return Err("That profile name is already used on this device.".into());
        }
        let now = db::now();
        db::insert_profile(&db, &db::Profile { id: id.clone(), handle, display_name: display.clone(), passcode_hash: hash, created_at: now, last_login: now }).map_err(e)?;
        let mut settings = Settings::default();
        settings.user_name = display;
        db::save_settings(&db, &settings, &Some(id.clone())).map_err(e)?;
    }
    choose(&st, Some(id));
    session_out(&st)
}

/// Turn the guest space into a named profile. Everything in it moves over.
#[tauri::command]
pub async fn claim_guest_profile(
    state: State<'_, Shared>,
    handle: String,
    display_name: Option<String>,
    passcode: Option<String>,
) -> R<SessionOut> {
    let st: Shared = state.inner().clone();
    if !matches!(owner_now(&st)?, None) {
        return Err("Only the guest space can be turned into a profile.".into());
    }
    let handle = clean_handle(&handle)?;
    let passcode = passcode.filter(|p| !p.is_empty());
    let hash = match passcode {
        Some(p) => {
            check_passcode_policy(&p)?;
            Some(tauri::async_runtime::spawn_blocking(move || hash_pass(&p)).await.map_err(e)??)
        }
        None => None,
    };
    let id = uid();
    let guest_settings = {
        let db = st.db.lock().unwrap();
        if db::handle_taken(&db, &handle).map_err(e)? {
            return Err("That profile name is already used on this device.".into());
        }
        let gs = db::get_settings(&db, &None);
        let display = display_name.map(|d| d.trim().to_string()).filter(|d| !d.is_empty()).unwrap_or_else(|| handle.clone());
        let now = db::now();
        db::insert_profile(&db, &db::Profile { id: id.clone(), handle, display_name: display.clone(), passcode_hash: hash, created_at: now, last_login: now }).map_err(e)?;
        db::claim_guest(&db, &id).map_err(e)?;
        let mut moved = gs.clone();
        moved.user_name = display;
        db::save_settings(&db, &moved, &Some(id.clone())).map_err(e)?;
        gs
    };
    // API keys follow the data
    let new_owner = Some(id.clone());
    let mut names = vec!["openai".to_string(), "anthropic".to_string()];
    names.extend(guest_settings.profiles.iter().map(|p| format!("custom-{}", p.id)));
    for n in names {
        if let Some(v) = secrets::get(&st.data_dir, &n) {
            let _ = secrets::set(&st.data_dir, &scoped(&new_owner, &n), &v);
            secrets::delete(&st.data_dir, &n);
        }
    }
    choose(&st, Some(id));
    session_out(&st)
}

fn scoped(o: &Owner, name: &str) -> String {
    match o {
        None => name.to_string(),
        Some(id) => format!("{name}@{id}"),
    }
}

/// Change the profile's display name (also the name characters call you in chats).
#[tauri::command]
pub fn update_profile(state: State<'_, Shared>, display_name: String) -> R<SessionOut> {
    let Some(id) = owner_now(&state)? else { return Err("The guest space has no profile to rename. Change your name in Settings.".into()) };
    let name = display_name.trim().to_string();
    if name.is_empty() || name.chars().count() > 40 {
        return Err("A name needs 1 to 40 characters.".into());
    }
    {
        let db = state.db.lock().unwrap();
        db::set_profile_name(&db, &id, &name).map_err(e)?;
        let mut s = db::get_settings(&db, &Some(id.clone()));
        s.user_name = name;
        db::save_settings(&db, &s, &Some(id)).map_err(e)?;
    }
    session_out(&state)
}

#[tauri::command]
pub async fn set_passcode(state: State<'_, Shared>, current: Option<String>, new: Option<String>) -> R<SessionOut> {
    let st: Shared = state.inner().clone();
    let Some(id) = owner_now(&st)? else { return Err("The guest space has no passcode. Make it a profile first.".into()) };
    let prof = db::get_profile(&st.db.lock().unwrap(), &id).map_err(e)?.ok_or("Profile not found.")?;
    if let Some(hash) = prof.passcode_hash.clone() {
        if let Some(secs) = lock_remaining(&st, &id) {
            return Err(format!("Too many wrong passcodes. Try again in {secs} seconds."));
        }
        let given = current.unwrap_or_default();
        if !tauri::async_runtime::spawn_blocking(move || verify_pass(&hash, &given)).await.map_err(e)? {
            tokio::time::sleep(Duration::from_millis(500)).await;
            return Err("Your current passcode isn't right.".into());
        }
    }
    let new_hash = match new.filter(|p| !p.is_empty()) {
        Some(p) => {
            check_passcode_policy(&p)?;
            Some(tauri::async_runtime::spawn_blocking(move || hash_pass(&p)).await.map_err(e)??)
        }
        None => None,
    };
    db::set_passcode_hash(&st.db.lock().unwrap(), &id, new_hash.as_deref()).map_err(e)?;
    session_out(&st)
}

#[tauri::command]
pub fn set_launch_pref(state: State<'_, Shared>, ask_on_launch: bool) -> R<SessionOut> {
    {
        let db = state.db.lock().unwrap();
        let mut d = db::get_device(&db);
        d.ask_on_launch = ask_on_launch;
        db::save_device(&db, &d).map_err(e)?;
    }
    session_out(&state)
}

// ---------------------------------------------------------------------------
// Export format
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Default, Clone)]
struct Counts {
    characters: usize,
    dorms: usize,
    chats: usize,
    messages: usize,
    media: usize,
}

#[derive(Serialize, Deserialize)]
struct ManifestProfile {
    id: String,
    handle: String,
    display_name: String,
    guest: bool,
}

#[derive(Serialize, Deserialize)]
struct Manifest {
    format: String,
    version: u32,
    app_version: String,
    exported_at: i64,
    profile: ManifestProfile,
    counts: Counts,
}

#[derive(Serialize, Deserialize)]
struct Data {
    settings: Settings,
    characters: Vec<Character>,
    dorms: Vec<Dorm>,
    chats: Vec<Chat>,
    messages: Vec<Message>,
    /// Added in v0.4: files made by older versions don't have these.
    #[serde(default)]
    rooms: Vec<db::Room>,
    #[serde(default)]
    mechanics: Vec<db::MechanicRow>,
    #[serde(default)]
    chat_mechanics: Vec<ChatMechanicExport>,
}

#[derive(Serialize, Deserialize)]
struct ChatMechanicExport {
    chat_id: i64,
    mech_id: String,
    enabled: bool,
    state: serde_json::Map<String, serde_json::Value>,
}

struct Parsed {
    manifest: Manifest,
    data: Data,
    media: HashMap<String, Vec<u8>>,
}

fn safe_media_name(n: &str) -> bool {
    !n.is_empty() && !n.contains('/') && !n.contains('\\') && !n.contains("..") && !n.starts_with('.')
}

/// Strictly read a profile file. Used on import and to double check our own export before it is offered.
fn parse_profile_zip(bytes: &[u8]) -> R<Parsed> {
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|_| "That file isn't a Desktop College Dorms profile.".to_string())?;
    if zip.len() > 200_000 {
        return Err("That file has too many parts to be a profile.".into());
    }
    let mut manifest: Option<Manifest> = None;
    let mut data: Option<Data> = None;
    let mut media = HashMap::new();
    let mut total: u64 = 0;
    for i in 0..zip.len() {
        let mut f = zip.by_index(i).map_err(e)?;
        if f.is_dir() {
            continue;
        }
        let name = f.name().to_string();
        let limit = match name.as_str() {
            "manifest.json" => 1024 * 1024,
            "data.json" => MAX_JSON_BYTES,
            n if n.starts_with("media/") && safe_media_name(&n["media/".len()..]) => MAX_MEDIA_BYTES,
            _ => return Err(format!("Unexpected item in the file: {name}")),
        };
        total += f.size();
        if f.size() > limit || total > MAX_TOTAL_BYTES {
            return Err("That file is larger than a profile file can be.".into());
        }
        let mut buf = Vec::with_capacity(f.size() as usize);
        f.by_ref().take(limit + 1).read_to_end(&mut buf).map_err(|_| "The file is damaged (a checksum didn't match).".to_string())?;
        if buf.len() as u64 > limit {
            return Err("That file is larger than a profile file can be.".into());
        }
        match name.as_str() {
            "manifest.json" => manifest = Some(serde_json::from_slice(&buf).map_err(|_| "The file's manifest is unreadable.".to_string())?),
            "data.json" => data = Some(serde_json::from_slice(&buf).map_err(|_| "The file's data is unreadable.".to_string())?),
            n => {
                media.insert(n["media/".len()..].to_string(), buf);
            }
        }
    }
    let manifest = manifest.ok_or("The file has no manifest, so it isn't a profile file.")?;
    let data = data.ok_or("The file has no data.")?;
    if manifest.format != EXPORT_FORMAT {
        return Err("That file isn't a Desktop College Dorms profile.".into());
    }
    if manifest.version > EXPORT_VERSION {
        return Err("That file was made by a newer version of the app. Update the app to import it.".into());
    }
    let c = &manifest.counts;
    if c.characters != data.characters.len() || c.dorms != data.dorms.len() || c.chats != data.chats.len() || c.messages != data.messages.len() {
        return Err("The file's contents don't match what it says it holds, so it is incomplete.".into());
    }
    Ok(Parsed { manifest, data, media })
}

fn civil_date(ms: i64) -> String {
    // days since 1970-01-01 -> y-m-d (Howard Hinnant's algorithm)
    let z = ms / 86_400_000 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    format!("{:04}-{:02}-{:02}", if m <= 2 { y + 1 } else { y }, m, d)
}

#[derive(Serialize)]
pub struct ExportInfo {
    token: String,
    file_name: String,
    size: usize,
    characters: usize,
    dorms: usize,
    chats: usize,
    messages: usize,
    media: usize,
}

fn build_export(st: &AppState, o: &Owner) -> R<(Vec<u8>, ExportInfo, String)> {
    let (characters, dorms, chats, messages, settings, profile, rooms, mechanics, chat_mechanics) = {
        let db = st.db.lock().unwrap();
        let characters = db::list_characters(&db, o).map_err(e)?;
        let dorms = db::list_dorms(&db, o).map_err(e)?;
        let chats = db::list_chats(&db, o).map_err(e)?;
        let mut messages = vec![];
        let mut chat_mechanics = vec![];
        for c in &chats {
            messages.extend(db::list_messages(&db, c.id).map_err(e)?);
            for m in db::list_chat_mechanics(&db, c.id).map_err(e)? {
                chat_mechanics.push(ChatMechanicExport { chat_id: c.id, mech_id: m.mech_id, enabled: m.enabled, state: m.state });
            }
        }
        let rooms = db::list_rooms(&db, o).map_err(e)?;
        let mechanics = db::list_mechanics(&db, o).map_err(e)?;
        let settings = db::get_settings(&db, o);
        let profile = match o {
            Some(id) => db::get_profile(&db, id).map_err(e)?,
            None => None,
        };
        (characters, dorms, chats, messages, settings, profile, rooms, mechanics, chat_mechanics)
    };
    let mut chats = chats;
    for c in chats.iter_mut() {
        c.auto_chat = false; // nobody should come back to bots already talking
    }
    let now = db::now();
    let (handle, display, guest, pid) = match &profile {
        Some(p) => (p.handle.clone(), p.display_name.clone(), false, p.id.clone()),
        None => ("guest".to_string(), settings.user_name.clone(), true, "guest".to_string()),
    };

    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let deflated = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    let stored = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    let mut media_count = 0;
    let mut media_chars = characters.clone();
    let mut seen = std::collections::HashSet::new();
    for c in media_chars.iter_mut() {
        if let Some(m) = &c.media {
            let base = std::path::Path::new(&m.file).file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
            if let Ok(bytes) = std::fs::read(st.data_dir.join(&m.file)) {
                if safe_media_name(&base) && seen.insert(base.clone()) {
                    zip.start_file(format!("media/{base}"), stored).map_err(e)?;
                    zip.write_all(&bytes).map_err(e)?;
                    media_count += 1;
                }
                if let Some(mm) = c.media.as_mut() {
                    mm.file = format!("media/{base}");
                }
            } else {
                c.media = None; // the file is gone; don't promise it
            }
        }
    }
    // the wardrobe travels with the character
    for c in media_chars.iter_mut() {
        let mut keep = Vec::new();
        for (k, o) in c.outfits.clone().into_iter().enumerate() {
            let Ok(bytes) = std::fs::read(st.data_dir.join(&o.file)) else { continue }; // the file is gone; don't promise it
            let base = format!("{}-outfit-{k}.vrm", c.id.chars().filter(|ch| ch.is_ascii_alphanumeric() || *ch == '-').collect::<String>());
            if safe_media_name(&base) && seen.insert(base.clone()) {
                zip.start_file(format!("media/{base}"), stored).map_err(e)?;
                zip.write_all(&bytes).map_err(e)?;
                media_count += 1;
            }
            keep.push(db::Outfit { id: o.id, name: o.name, file: format!("media/{base}") });
        }
        c.outfits = keep;
        if let Some(cur) = &c.outfit { if !c.outfits.iter().any(|x| &x.id == cur) { c.outfit = None; } }
    }
    // room backdrops travel with their rooms
    let mut rooms = rooms;
    for r in rooms.iter_mut() {
        if let Some(f) = r.backdrop.strip_prefix("file:") {
            let base = std::path::Path::new(f).file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
            match std::fs::read(st.data_dir.join(f)) {
                Ok(bytes) if safe_media_name(&base) => {
                    if seen.insert(base.clone()) {
                        zip.start_file(format!("media/{base}"), stored).map_err(e)?;
                        zip.write_all(&bytes).map_err(e)?;
                        media_count += 1;
                    }
                    r.backdrop = format!("file:media/{base}");
                }
                _ => r.backdrop.clear(),
            }
        }
    }
    let counts = Counts { characters: characters.len(), dorms: dorms.len(), chats: chats.len(), messages: messages.len(), media: media_count };
    let manifest = Manifest {
        format: EXPORT_FORMAT.into(),
        version: EXPORT_VERSION,
        app_version: env!("CARGO_PKG_VERSION").into(),
        exported_at: now,
        profile: ManifestProfile { id: pid, handle: handle.clone(), display_name: display, guest },
        counts: counts.clone(),
    };
    // API keys, passcodes and per-device model choices are deliberately not part of the file.
    let mut exported_settings = settings;
    exported_settings.local_model = String::new();
    let data = Data { settings: exported_settings, characters: media_chars, dorms, chats, messages, rooms, mechanics, chat_mechanics };
    zip.start_file("manifest.json", deflated).map_err(e)?;
    zip.write_all(&serde_json::to_vec_pretty(&manifest).map_err(e)?).map_err(e)?;
    zip.start_file("data.json", deflated).map_err(e)?;
    zip.write_all(&serde_json::to_vec(&data).map_err(e)?).map_err(e)?;
    let bytes = zip.finish().map_err(e)?.into_inner();

    // Re-read our own output with the same strict reader that import uses. A file that doesn't check out is never offered.
    let back = parse_profile_zip(&bytes).map_err(|err| format!("The export didn't check out, so nothing was changed: {err}"))?;
    if back.media.len() != media_count {
        return Err("The export didn't check out (media is missing), so nothing was changed.".into());
    }
    let token = uid();
    let file_name = format!("{}-{}.dorms", handle.replace(' ', "_"), civil_date(now));
    let info = ExportInfo {
        token,
        file_name: file_name.clone(),
        size: bytes.len(),
        characters: counts.characters,
        dorms: counts.dorms,
        chats: counts.chats,
        messages: counts.messages,
        media: counts.media,
    };
    Ok((bytes, info, file_name))
}

/// Step one of export and eject: build the file in memory and check it.
#[tauri::command]
pub async fn prepare_export(state: State<'_, Shared>) -> R<ExportInfo> {
    let st: Shared = state.inner().clone();
    let o = owner_now(&st)?;
    let st2 = st.clone();
    let o2 = o.clone();
    let (bytes, info, file_name) = tauri::async_runtime::spawn_blocking(move || build_export(&st2, &o2)).await.map_err(e)??;
    *st.pending_export.lock().unwrap() = Some(PendingExport { token: info.token.clone(), bytes, owner: o, file_name, saved: false });
    Ok(info)
}

/// The file's bytes, for platforms where the web view writes the file (Android's save dialog).
#[tauri::command]
pub fn read_export(state: State<'_, Shared>, token: String) -> R<Response> {
    let g = state.pending_export.lock().unwrap();
    match g.as_ref() {
        Some(p) if p.token == token => Ok(Response::new(p.bytes.clone())),
        _ => Err("That export is no longer available. Start again.".into()),
    }
}

#[derive(Serialize)]
pub struct SaveOut {
    pub size: usize,
    pub path: String,
}

/// Write the export to a normal file path and check it by reading the bytes back from disk.
#[tauri::command]
pub fn save_export(state: State<'_, Shared>, token: String, path: String) -> R<SaveOut> {
    let mut g = state.pending_export.lock().unwrap();
    let p = match g.as_mut() {
        Some(p) if p.token == token => p,
        _ => return Err("That export is no longer available. Start again.".into()),
    };
    if path.starts_with("content:") {
        return Err("This location needs the other save method.".into());
    }
    std::fs::write(&path, &p.bytes).map_err(|err| format!("Could not save the file: {err}"))?;
    let back = std::fs::read(&path).map_err(|err| format!("Could not read the saved file back: {err}"))?;
    if Sha256::digest(&back) != Sha256::digest(&p.bytes) {
        let _ = std::fs::remove_file(&path);
        return Err("The saved file didn't match, so it was removed and nothing was changed.".into());
    }
    p.saved = true;
    Ok(SaveOut { size: back.len(), path })
}

/// The web view saved the file itself (Android) and checked its size; record that.
#[tauri::command]
pub fn confirm_export_saved(state: State<'_, Shared>, token: String, size: usize) -> R<()> {
    let mut g = state.pending_export.lock().unwrap();
    match g.as_mut() {
        Some(p) if p.token == token && p.bytes.len() == size => {
            p.saved = true;
            Ok(())
        }
        _ => Err("The saved file's size didn't match, so nothing was changed.".into()),
    }
}

// ---------------------------------------------------------------------------
// Eject and delete
// ---------------------------------------------------------------------------

fn remove_owner_data(st: &AppState, o: &Owner) -> R<()> {
    let (settings, media_files) = {
        let db = st.db.lock().unwrap();
        let settings = db::get_settings(&db, o);
        let mut files: Vec<String> = db::list_characters(&db, o).map_err(e)?.into_iter().flat_map(|c| c.media.map(|m| m.file).into_iter().chain(c.outfits.into_iter().map(|x| x.file))).collect();
        files.extend(db::list_rooms(&db, o).map_err(e)?.into_iter().filter_map(|r| r.backdrop.strip_prefix("file:").map(str::to_string)));
        (settings, files)
    };
    end_session(st);
    db::wipe_owner(&st.db.lock().unwrap(), o).map_err(e)?;
    for f in media_files {
        let _ = std::fs::remove_file(st.data_dir.join(f));
    }
    let mut names = vec!["openai".to_string(), "anthropic".to_string()];
    names.extend(settings.profiles.iter().map(|p| format!("custom-{}", p.id)));
    for n in names {
        secrets::delete(&st.data_dir, &scoped(o, &n));
    }
    Ok(())
}

fn after_removal(st: &AppState, o: &Owner) {
    if let Some(id) = o {
        let mut s = st.session.lock().unwrap();
        s.chosen = false;
        s.profile = None;
        s.no_auto = true;
        drop(s);
        let db = st.db.lock().unwrap();
        let mut d = db::get_device(&db);
        if d.last.as_deref() == Some(id.as_str()) {
            d.last = None;
        }
        let _ = db::save_device(&db, &d);
    }
}

/// Take the profile off this device. Only works right after an export that was saved and verified.
#[tauri::command]
pub fn eject_profile(state: State<'_, Shared>, token: String) -> R<SessionOut> {
    let o = owner_now(&state)?;
    {
        let g = state.pending_export.lock().unwrap();
        match g.as_ref() {
            Some(p) if p.token == token && p.owner == o && p.saved => {}
            Some(p) if p.token == token && p.owner == o => return Err("The file hasn't been saved yet, so nothing was removed.".into()),
            _ => return Err("That export is no longer available, so nothing was removed. Start again.".into()),
        }
    }
    remove_owner_data(&state, &o)?;
    after_removal(&state, &o);
    session_out(&state)
}

/// Permanently delete the profile (no file). The caller must type its name to confirm.
#[tauri::command]
pub fn delete_profile(state: State<'_, Shared>, confirm: String) -> R<SessionOut> {
    let o = owner_now(&state)?;
    let expected = match &o {
        Some(id) => db::get_profile(&state.db.lock().unwrap(), id).map_err(e)?.map(|p| p.handle).unwrap_or_default(),
        None => "guest".to_string(),
    };
    if confirm.trim().to_lowercase() != expected.to_lowercase() {
        return Err("The name you typed doesn't match, so nothing was deleted.".into());
    }
    remove_owner_data(&state, &o)?;
    after_removal(&state, &o);
    session_out(&state)
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct ImportPreview {
    handle: String,
    display_name: String,
    guest: bool,
    app_version: String,
    exported_at: i64,
    characters: usize,
    dorms: usize,
    chats: usize,
    messages: usize,
    media: usize,
    /// A profile with this exact id is already on this device (importing would be a duplicate).
    already_here: bool,
    handle_taken: bool,
}

fn header(req: &Request<'_>, name: &str) -> String {
    let raw = req.headers().get(name).and_then(|v| v.to_str().ok()).unwrap_or("");
    let b = raw.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Some(h) = raw.get(i + 1..i + 3).and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(h);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn perform_import(st: &AppState, parsed: Parsed, handle: String, display: String, hash: Option<String>) -> R<String> {
    let db = st.db.lock().unwrap();
    if db::handle_taken(&db, &handle).map_err(e)? {
        return Err("That profile name is already used on this device. Pick another.".into());
    }
    let pid = match db::get_profile(&db, &parsed.manifest.profile.id).map_err(e)? {
        Some(_) => uid(), // never overwrite a profile that is already here
        None => parsed.manifest.profile.id.clone(),
    };
    let pid = if pid == "guest" { uid() } else { pid };
    let o: Owner = Some(pid.clone());
    let mut written: Vec<std::path::PathBuf> = vec![];

    db.execute_batch("BEGIN").map_err(e)?;
    let result: R<()> = (|| {
        let now = db::now();
        db::insert_profile(&db, &db::Profile { id: pid.clone(), handle, display_name: display.clone(), passcode_hash: hash, created_at: now, last_login: now }).map_err(e)?;

        let mut dorm_map: HashMap<i64, i64> = HashMap::new();
        for d in &parsed.data.dorms {
            let nd = db::create_dorm(&db, &d.name, None, &o).map_err(e)?;
            dorm_map.insert(d.id, nd.id);
        }

        let mut char_map: HashMap<String, String> = HashMap::new();
        for (i, mut c) in parsed.data.characters.clone().into_iter().enumerate() {
            let taken = !c.id.is_empty() && db.query_row("SELECT 1 FROM characters WHERE id=?1", [&c.id], |_| Ok(())).is_ok();
            let new_id = if c.id.is_empty() || taken { uid() } else { c.id.clone() };
            char_map.insert(c.id.clone(), new_id.clone());
            c.id = new_id;
            if let Some(m) = c.media.as_mut() {
                let base = m.file.strip_prefix("media/").unwrap_or("").to_string();
                match parsed.media.get(&base) {
                    Some(bytes) if safe_media_name(&base) => {
                        let ext = std::path::Path::new(&base).extension().and_then(|x| x.to_str()).unwrap_or("bin");
                        let rel = format!("media/{}-{}-{i}.{ext}", c.id, db::now());
                        let abs = st.data_dir.join(&rel);
                        std::fs::write(&abs, bytes).map_err(e)?;
                        written.push(abs);
                        m.file = rel;
                    }
                    _ => c.media = None,
                }
            }
            let mut kept = Vec::new();
            for (k, mut of) in c.outfits.clone().into_iter().enumerate() {
                let base = of.file.strip_prefix("media/").unwrap_or("").to_string();
                if let Some(bytes) = parsed.media.get(&base).filter(|_| safe_media_name(&base)) {
                    let rel = format!("media/{}-{}-{i}-o{k}.vrm", c.id, db::now());
                    let abs = st.data_dir.join(&rel);
                    std::fs::write(&abs, bytes).map_err(e)?;
                    written.push(abs);
                    of.file = rel;
                    kept.push(of);
                }
            }
            c.outfits = kept;
            if let Some(cur) = &c.outfit { if !c.outfits.iter().any(|x| &x.id == cur) { c.outfit = None; } }
            c.last_used = c.last_used.max(0);
            db::save_character(&db, &c, &o).map_err(e)?;
        }

        // rooms (after the characters, since a room can belong to one) and the dorms' place in them
        let mut room_map: HashMap<i64, i64> = HashMap::new();
        for (i, r) in parsed.data.rooms.iter().enumerate() {
            let mut room = r.clone();
            room.character_id = room.character_id.as_ref().and_then(|c| char_map.get(c).cloned());
            if room.character_id.is_none() { room.owner_kind = "self".into(); }
            let had_file = room.backdrop.starts_with("file:");
            if had_file { room.backdrop.clear(); }
            let mut nr = db::create_room(&db, &room, &o).map_err(e)?;
            if let Some(base) = r.backdrop.strip_prefix("file:media/").filter(|b| had_file && safe_media_name(b)) {
                if let Some(bytes) = parsed.media.get(base) {
                    let ext = std::path::Path::new(base).extension().and_then(|x| x.to_str()).unwrap_or("png");
                    if ["png", "jpg", "jpeg", "webp", "gif", "avif", "bmp"].contains(&ext.to_lowercase().as_str()) {
                        let rel = format!("media/room-{}-{}-{i}.{ext}", nr.id, db::now());
                        let abs = st.data_dir.join(&rel);
                        std::fs::write(&abs, bytes).map_err(e)?;
                        written.push(abs);
                        nr.backdrop = format!("file:{rel}");
                        db::update_room(&db, &nr, &o).map_err(e)?;
                    }
                }
            } else if !had_file {
                // a built-in scene: keep it
                nr.backdrop = r.backdrop.clone();
                db::update_room(&db, &nr, &o).map_err(e)?;
            }
            room_map.insert(r.id, nr.id);
        }
        for d in &parsed.data.dorms {
            if let (Some(rid), Some(nd)) = (d.room_id.and_then(|r| room_map.get(&r)), dorm_map.get(&d.id)) {
                db::set_dorm_room(&db, *nd, Some(*rid), &o).map_err(e)?;
            }
        }
        let mut mech_map: HashMap<String, String> = HashMap::new();
        for m in &parsed.data.mechanics {
            let id = uid();
            db::save_mechanic(&db, &db::MechanicRow { id: id.clone(), name: m.name.clone(), description: m.description.clone(), json: m.json.clone(), created_at: m.created_at }, &o).map_err(e)?;
            mech_map.insert(m.id.clone(), id);
        }

        let mut chat_map: HashMap<i64, i64> = HashMap::new();
        for ch in &parsed.data.chats {
            let ids: Vec<String> = ch.character_ids.iter().filter_map(|i| char_map.get(i).cloned()).collect();
            let dorm = ch.dorm_id.and_then(|d| dorm_map.get(&d).copied());
            db.execute(
                "INSERT INTO chats(dorm_id,name,kind,character_ids,auto_chat,auto_interval_s,turn_mode,max_auto_turns,created_at,updated_at,profile_id,style)
                 VALUES(?1,?2,?3,?4,0,?5,?6,?7,?8,?9,?10,?11)",
                rusqlite::params![dorm, ch.name, ch.kind, serde_json::to_string(&ids).unwrap_or_default(), ch.auto_interval_s.max(5), ch.turn_mode, ch.max_auto_turns.max(1), ch.created_at, ch.updated_at, pid, if ch.style == "phone" { "phone" } else { "chat" }],
            )
            .map_err(e)?;
            chat_map.insert(ch.id, db.last_insert_rowid());
        }
        for m in &parsed.data.messages {
            let Some(chat) = chat_map.get(&m.chat_id) else { continue };
            let cid = m.character_id.as_ref().and_then(|i| char_map.get(i).cloned());
            db.execute(
                "INSERT INTO messages(chat_id,role,character_id,swipes,swipe_index,created_at) VALUES(?1,?2,?3,?4,?5,?6)",
                rusqlite::params![chat, m.role, cid, serde_json::to_string(&m.swipes).unwrap_or_default(), m.swipe_index, m.created_at],
            )
            .map_err(e)?;
        }

        for cm in &parsed.data.chat_mechanics {
            if let (Some(chat), Some(mid)) = (chat_map.get(&cm.chat_id), mech_map.get(&cm.mech_id)) {
                db::save_chat_mechanic(&db, *chat, &db::ChatMechanic { mech_id: mid.clone(), enabled: cm.enabled, state: cm.state.clone() }).map_err(e)?;
            }
        }

        let mut settings = parsed.data.settings.clone();
        settings.user_name = display;
        db::save_settings(&db, &settings, &o).map_err(e)?;
        Ok(())
    })();

    match result {
        Ok(()) => {
            db.execute_batch("COMMIT").map_err(e)?;
            Ok(pid)
        }
        Err(err) => {
            let _ = db.execute_batch("ROLLBACK");
            for f in written {
                let _ = std::fs::remove_file(f);
            }
            Err(err)
        }
    }
}

/// Body: the profile file. Headers: `x-mode` = `inspect` | `import`; for import also `x-handle`, `x-passcode` (optional).
#[tauri::command]
pub async fn import_profile(request: Request<'_>, state: State<'_, Shared>) -> R<serde_json::Value> {
    let st: Shared = state.inner().clone();
    let mode = header(&request, "x-mode");
    let handle = header(&request, "x-handle");
    let passcode = header(&request, "x-passcode");
    let bytes = match request.body() {
        InvokeBody::Raw(b) => b.clone(),
        _ => return Err("Expected a file.".into()),
    };
    let parsed = tauri::async_runtime::spawn_blocking(move || parse_profile_zip(&bytes)).await.map_err(e)??;

    if mode == "inspect" {
        let db = st.db.lock().unwrap();
        let m = &parsed.manifest;
        let preview = ImportPreview {
            handle: m.profile.handle.clone(),
            display_name: m.profile.display_name.clone(),
            guest: m.profile.guest,
            app_version: m.app_version.clone(),
            exported_at: m.exported_at,
            characters: m.counts.characters,
            dorms: m.counts.dorms,
            chats: m.counts.chats,
            messages: m.counts.messages,
            media: m.counts.media,
            already_here: db::get_profile(&db, &m.profile.id).map_err(e)?.is_some(),
            handle_taken: db::handle_taken(&db, &m.profile.handle).map_err(e)?,
        };
        return serde_json::to_value(preview).map_err(e);
    }

    let handle = clean_handle(&handle)?;
    let display = parsed.manifest.profile.display_name.clone();
    let display = if display.trim().is_empty() { handle.clone() } else { display.trim().chars().take(40).collect() };
    let hash = if passcode.is_empty() {
        None
    } else {
        check_passcode_policy(&passcode)?;
        Some(tauri::async_runtime::spawn_blocking(move || hash_pass(&passcode)).await.map_err(e)??)
    };
    let st2 = st.clone();
    let pid = tauri::async_runtime::spawn_blocking(move || perform_import(&st2, parsed, handle, display, hash)).await.map_err(e)??;
    choose(&st, Some(pid));
    serde_json::to_value(session_out(&st)?).map_err(e)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn zip_with(files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut z = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let o = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        for (n, b) in files {
            z.start_file(*n, o).unwrap();
            z.write_all(b).unwrap();
        }
        z.finish().unwrap().into_inner()
    }

    fn manifest(version: u32, characters: usize) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "format": EXPORT_FORMAT, "version": version, "app_version": "0.0.0", "exported_at": 0,
            "profile": {"id": "p", "handle": "h", "display_name": "H", "guest": false},
            "counts": {"characters": characters, "dorms": 0, "chats": 0, "messages": 0, "media": 0}
        }))
        .unwrap()
    }

    fn data() -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({"settings": {}, "characters": [], "dorms": [], "chats": [], "messages": []})).unwrap()
    }

    #[test]
    fn a_well_formed_file_parses() {
        let z = zip_with(&[("manifest.json", &manifest(1, 0)), ("data.json", &data()), ("media/a.png", b"x")]);
        let p = parse_profile_zip(&z).unwrap();
        assert_eq!(p.manifest.profile.handle, "h");
        assert_eq!(p.media["a.png"], b"x");
    }

    #[test]
    fn path_traversal_and_unknown_members_are_refused() {
        for bad in ["../evil", "media/../evil", "media/sub/dir.png", "/abs", "media\\x.png", "other.txt", "media/.hidden"] {
            let z = zip_with(&[("manifest.json", &manifest(1, 0)), ("data.json", &data()), (bad, b"x")]);
            assert!(parse_profile_zip(&z).is_err(), "{bad} should be refused");
        }
    }

    #[test]
    fn missing_pieces_newer_versions_and_wrong_counts_are_refused() {
        assert!(parse_profile_zip(&zip_with(&[("data.json", &data())])).is_err(), "no manifest");
        assert!(parse_profile_zip(&zip_with(&[("manifest.json", &manifest(1, 0))])).is_err(), "no data");
        let newer = zip_with(&[("manifest.json", &manifest(99, 0)), ("data.json", &data())]);
        assert!(parse_profile_zip(&newer).err().unwrap().contains("newer version"));
        let lying = zip_with(&[("manifest.json", &manifest(1, 5)), ("data.json", &data())]);
        assert!(parse_profile_zip(&lying).err().unwrap().contains("incomplete"));
        assert!(parse_profile_zip(b"definitely not a zip").is_err());
        let wrong = serde_json::to_vec(&serde_json::json!({"format": "something/else", "version": 1, "app_version": "", "exported_at": 0,
            "profile": {"id": "p", "handle": "h", "display_name": "H", "guest": false}, "counts": {"characters":0,"dorms":0,"chats":0,"messages":0,"media":0}})).unwrap();
        assert!(parse_profile_zip(&zip_with(&[("manifest.json", &wrong), ("data.json", &data())])).is_err());
    }

    #[test]
    fn handles_follow_the_rules() {
        assert_eq!(clean_handle("  Alex_01  ").unwrap(), "Alex_01");
        assert!(clean_handle("a").is_err());
        assert!(clean_handle(&"x".repeat(25)).is_err());
        assert!(clean_handle("bad/name").is_err());
        assert!(clean_handle("<script>").is_err());
        assert!(clean_handle("Guest").is_err() && clean_handle("gUeSt").is_err(), "guest is reserved");
        assert!(clean_handle("田中 Hiro").is_ok(), "non-Latin names are fine");
    }

    #[test]
    fn passcodes_are_hashed_and_checked() {
        assert!(check_passcode_policy("abc").is_err());
        assert!(check_passcode_policy("abcd").is_ok());
        let h = hash_pass("hunter2!").unwrap();
        assert!(!h.contains("hunter2"), "the passcode is never stored");
        assert!(verify_pass(&h, "hunter2!"));
        assert!(!verify_pass(&h, "hunter3!"));
        assert_ne!(h, hash_pass("hunter2!").unwrap(), "each hash has its own salt");
    }

    #[test]
    fn dates_in_file_names_are_right() {
        assert_eq!(civil_date(0), "1970-01-01");
        assert_eq!(civil_date(1_793_841_600_000), "2026-11-05");
        assert_eq!(civil_date(951_782_400_000), "2000-02-29", "leap day");
    }
}
