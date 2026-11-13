//! Rooms (places a dorm happens in) and mechanic packs (optional story layers a person switches on per chat),
//! and how both reach the prompt.

use dorms_core::mechanics::{self as mech, Bundle, Event};
use rusqlite::Connection;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::ipc::Request;
use tauri::State;

use crate::commands::{e, emit, header, owner, raw_body, uid};
use crate::db::{self, ChatMechanic, MechanicRow, Room};
use crate::{AppState, Shared};

type R<T> = Result<T, String>;

const MAX_PACK_BYTES: usize = 8 * 1024 * 1024;
const MAX_BACKDROP_BYTES: usize = 40 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct RoomOut {
    #[serde(flatten)]
    room: Room,
    /// Absolute path of an uploaded backdrop (for the web view), when there is one.
    backdrop_path: Option<String>,
    /// Absolute path of the room's background music, when it has some.
    music_path: Option<String>,
    /// Absolute path of the imported 3D scene, when it has one.
    model_path: Option<String>,
}

fn room_out(st: &AppState, room: Room) -> RoomOut {
    let backdrop_path = room.backdrop.strip_prefix("file:").map(|f| st.data_dir.join(f).to_string_lossy().to_string());
    let music_path = Some(room.music.as_str()).filter(|m| !m.is_empty()).map(|m| st.data_dir.join(m).to_string_lossy().to_string());
    let model_path = Some(room.model.as_str()).filter(|m| !m.is_empty()).map(|m| st.data_dir.join(m).to_string_lossy().to_string());
    RoomOut { room, backdrop_path, music_path, model_path }
}

const KINDS: [&str; 13] = [
    "living_room", "bedroom", "kitchen", "bathroom", "dining_room", "games_room", "office", "garage", "garden", "balcony", "basement", "rooftop", "other",
];

fn clean_room(mut r: Room, o: &db::Owner, db: &Connection) -> R<Room> {
    r.name = r.name.chars().filter(|c| !c.is_control()).collect::<String>().trim().chars().take(80).collect();
    if r.name.is_empty() {
        return Err("Give the room a name.".into());
    }
    if !KINDS.contains(&r.kind.as_str()) {
        r.kind = "other".into();
    }
    r.description = r.description.trim().chars().take(4000).collect();
    if r.owner_kind != "character" {
        r.owner_kind = "self".into();
        r.character_id = None;
    }
    if let Some(cid) = r.character_id.clone() {
        if db::get_character(db, &cid, o).map_err(e)?.is_none() {
            r.character_id = None;
            r.owner_kind = "self".into();
        }
    }
    // a backdrop is either one of the built-in scenes or a file the app itself saved: never an arbitrary path
    if !(r.backdrop.is_empty() || r.backdrop.starts_with("preset:") && r.backdrop.len() < 40 || r.backdrop.starts_with("file:media/room-") && !r.backdrop.contains("..")) {
        r.backdrop.clear();
    }
    Ok(r)
}

#[tauri::command]
pub fn list_rooms(state: State<'_, Shared>) -> R<Vec<RoomOut>> {
    let o = owner(&state)?;
    let rooms = db::list_rooms(&state.db.lock().unwrap(), &o).map_err(e)?;
    Ok(rooms.into_iter().map(|r| room_out(&state, r)).collect())
}

#[tauri::command]
pub fn create_room(state: State<'_, Shared>, room: Room) -> R<RoomOut> {
    let o = owner(&state)?;
    let db = state.db.lock().unwrap();
    let mut r = clean_room(room, &o, &db)?;
    // an upload only ever comes through set_room_backdrop, which needs the room to exist first
    if r.backdrop.starts_with("file:") {
        r.backdrop.clear();
    }
    r.music.clear();
    r.music_name.clear();
    r.model.clear(); // a 3D scene only comes through set_room_model
    r.model_name.clear();
    r.model_scale = 1.0; r.model_rot = 0.0; r.model_y = 0.0; r.model_share = false;
    let r = db::create_room(&db, &r, &o).map_err(e)?;
    Ok(room_out(&state, r))
}

#[tauri::command]
pub fn update_room(state: State<'_, Shared>, room: Room) -> R<RoomOut> {
    let o = owner(&state)?;
    let db = state.db.lock().unwrap();
    let old = db::get_room(&db, room.id, &o).map_err(e)?.ok_or("Room not found")?;
    let mut r = clean_room(room, &o, &db)?;
    if r.backdrop.starts_with("file:") && r.backdrop != old.backdrop {
        r.backdrop = old.backdrop.clone(); // the file can't be swapped from outside
    }
    r.music = old.music.clone(); // music, too, only changes through its own commands
    r.music_name = old.music_name.clone();
    // the 3D scene, how it is set and whether it may be shared change only through their own commands, too
    r.model = old.model.clone(); r.model_name = old.model_name.clone();
    r.model_scale = old.model_scale; r.model_rot = old.model_rot; r.model_y = old.model_y; r.model_share = old.model_share;
    if old.backdrop.starts_with("file:") && r.backdrop != old.backdrop {
        let _ = std::fs::remove_file(state.data_dir.join(old.backdrop.trim_start_matches("file:")));
    }
    db::update_room(&db, &r, &o).map_err(e)?;
    Ok(room_out(&state, db::get_room(&db, r.id, &o).map_err(e)?.ok_or("Room not found")?))
}

#[tauri::command]
pub fn delete_room(state: State<'_, Shared>, id: i64) -> R<()> {
    let o = owner(&state)?;
    let db = state.db.lock().unwrap();
    if let Some(r) = db::get_room(&db, id, &o).map_err(e)? {
        if let Some(f) = r.backdrop.strip_prefix("file:") {
            let _ = std::fs::remove_file(state.data_dir.join(f));
        }
        if !r.music.is_empty() {
            let _ = std::fs::remove_file(state.data_dir.join(&r.music));
        }
        if !r.model.is_empty() {
            let _ = std::fs::remove_file(state.data_dir.join(&r.model));
        }
    }
    db::delete_room(&db, id, &o).map_err(e)
}

/// Body: raw image bytes. Headers: `x-room-id`, `x-file-name` (percent-encoded).
#[tauri::command]
pub fn set_room_backdrop(request: Request<'_>, state: State<'_, Shared>) -> R<RoomOut> {
    let id: i64 = header(&request, "x-room-id").parse().map_err(|_| "Save the room first")?;
    let name = header(&request, "x-file-name");
    let bytes = raw_body(&request)?;
    if bytes.len() > MAX_BACKDROP_BYTES {
        return Err("That image is too large (40 MB at most).".into());
    }
    let ext = std::path::Path::new(&name).extension().and_then(|x| x.to_str()).unwrap_or("").to_lowercase();
    if !["png", "jpg", "jpeg", "webp", "gif", "avif", "bmp"].contains(&ext.as_str()) {
        return Err("A backdrop has to be an image (JPG, PNG, WebP or GIF).".into());
    }
    let o = owner(&state)?;
    let db = state.db.lock().unwrap();
    let mut r = db::get_room(&db, id, &o).map_err(e)?.ok_or("Save the room first")?;
    let rel = format!("media/room-{}-{}.{ext}", r.id, db::now());
    std::fs::write(state.data_dir.join(&rel), bytes).map_err(e)?;
    if let Some(old) = r.backdrop.strip_prefix("file:") {
        let _ = std::fs::remove_file(state.data_dir.join(old));
    }
    r.backdrop = format!("file:{rel}");
    db::update_room(&db, &r, &o).map_err(e)?;
    Ok(room_out(&state, r))
}

const MUSIC_EXTS: [&str; 8] = ["mp3", "ogg", "oga", "opus", "wav", "m4a", "aac", "flac"];
const MAX_MUSIC_BYTES: usize = 120 * 1024 * 1024;

fn music_file(req: &Request<'_>, stem: &str) -> R<(Vec<u8>, String, String)> {
    let name = header(req, "x-file-name");
    let bytes = raw_body(req)?;
    if bytes.len() > MAX_MUSIC_BYTES {
        return Err("That audio file is too large (120 MB at most).".into());
    }
    let ext = std::path::Path::new(&name).extension().and_then(|x| x.to_str()).unwrap_or("").to_lowercase();
    if !MUSIC_EXTS.contains(&ext.as_str()) {
        return Err("Background music has to be an audio file (MP3, OGG, WAV, M4A, AAC or FLAC).".into());
    }
    let shown: String = std::path::Path::new(&name).file_name().and_then(|n| n.to_str()).unwrap_or("music").chars().filter(|c| !c.is_control()).take(120).collect();
    Ok((bytes.to_vec(), format!("media/music-{stem}-{}.{ext}", db::now()), shown))
}

/// Body: raw audio bytes. Headers: `x-room-id`, `x-file-name` (percent-encoded).
#[tauri::command]
pub fn set_room_music(request: Request<'_>, state: State<'_, Shared>) -> R<RoomOut> {
    let id: i64 = header(&request, "x-room-id").parse().map_err(|_| "Save the room first")?;
    let (bytes, rel, shown) = music_file(&request, &format!("room{id}"))?;
    let o = owner(&state)?;
    let db = state.db.lock().unwrap();
    let mut r = db::get_room(&db, id, &o).map_err(e)?.ok_or("Save the room first")?;
    std::fs::write(state.data_dir.join(&rel), bytes).map_err(e)?;
    if !r.music.is_empty() {
        let _ = std::fs::remove_file(state.data_dir.join(&r.music));
    }
    r.music = rel;
    r.music_name = shown;
    db::update_room(&db, &r, &o).map_err(e)?;
    Ok(room_out(&state, r))
}

#[tauri::command]
pub fn clear_room_music(state: State<'_, Shared>, id: i64) -> R<RoomOut> {
    let o = owner(&state)?;
    let db = state.db.lock().unwrap();
    let mut r = db::get_room(&db, id, &o).map_err(e)?.ok_or("Room not found")?;
    if !r.music.is_empty() {
        let _ = std::fs::remove_file(state.data_dir.join(&r.music));
    }
    r.music.clear();
    r.music_name.clear();
    db::update_room(&db, &r, &o).map_err(e)?;
    Ok(room_out(&state, r))
}

const MODEL_EXTS: [&str; 3] = ["glb", "gltf", "fbx"];
/// The one-piece upload (`set_room_model`) holds the whole file in memory, so it stays small; the chunked upload below goes straight to disk.
const MAX_MODEL_BYTES: usize = 300 * 1024 * 1024;
/// A sanity limit for the chunked upload, so a wrong file can't fill the disk.
const MAX_MODEL_UPLOAD: u64 = 8 * 1024 * 1024 * 1024;

/// Is this a 3D model the app can use? Checks the name's extension and the first bytes, so a renamed picture or archive is not saved as a "model".
fn check_model(name: &str, head: &[u8]) -> R<String> {
    let ext = std::path::Path::new(name).extension().and_then(|x| x.to_str()).unwrap_or("").to_lowercase();
    if ext == "unitypackage" {
        return Err("A .unitypackage isn't sent as a model: choose it in the room's 3D model field, which opens it and takes the room out.".into());
    }
    if !MODEL_EXTS.contains(&ext.as_str()) {
        return Err("A 3D room has to be a .glb, .gltf or .fbx file (or a .unitypackage, chosen in the room's 3D model field).".into());
    }
    let ok = match ext.as_str() {
        "glb" => head.starts_with(b"glTF"),
        "fbx" => head.starts_with(b"Kaydara FBX Binary") || head.iter().take(40).all(|b| b.is_ascii()),
        _ => head.iter().skip_while(|b| b.is_ascii_whitespace()).next() == Some(&b'{'),
    };
    if !ok {
        return Err("That file doesn't look like a valid 3D model.".into());
    }
    Ok(ext)
}

fn shown_name(name: &str) -> String {
    std::path::Path::new(name).file_name().and_then(|n| n.to_str()).unwrap_or("room").chars().filter(|c| !c.is_control()).take(120).collect()
}

/// Make `rel` (a file already in the data folder) the room's model. A newly imported model is **not** marked as shareable.
fn install_model(st: &AppState, id: i64, rel: String, shown: String) -> R<RoomOut> {
    let o = owner(st)?;
    let db = st.db.lock().unwrap();
    let mut r = match db::get_room(&db, id, &o).map_err(e)? {
        Some(r) => r,
        None => {
            let _ = std::fs::remove_file(st.data_dir.join(&rel));
            return Err("Save the room first".into());
        }
    };
    if !r.model.is_empty() {
        let _ = std::fs::remove_file(st.data_dir.join(&r.model));
    }
    r.model = rel;
    r.model_name = shown;
    r.model_scale = 1.0; r.model_rot = 0.0; r.model_y = 0.0;
    r.model_share = false; // the owner has to say so
    db::update_room(&db, &r, &o).map_err(e)?;
    Ok(room_out(st, r))
}

/// Body: raw model bytes (.glb, .gltf with everything inside it, or .fbx). Headers: `x-room-id`, `x-file-name` (percent-encoded).
/// For small files; the app itself uses the chunked upload (`room_model_begin` / `room_model_chunk` / `room_model_finish`), which has no such limit.
#[tauri::command]
pub fn set_room_model(request: Request<'_>, state: State<'_, Shared>) -> R<RoomOut> {
    let id: i64 = header(&request, "x-room-id").parse().map_err(|_| "Save the room first")?;
    let name = header(&request, "x-file-name");
    let bytes = raw_body(&request)?;
    if bytes.len() > MAX_MODEL_BYTES {
        return Err("That file is too big for a single upload.".into());
    }
    let ext = check_model(&name, &bytes[..bytes.len().min(64)])?;
    let rel = format!("media/roommodel-{id}-{}.{ext}", db::now());
    std::fs::write(state.data_dir.join(&rel), &*bytes).map_err(e)?;
    install_model(&state, id, rel, shown_name(&name))
}

fn upload_path(st: &AppState, token: &str) -> R<std::path::PathBuf> {
    let safe: String = token.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').collect();
    if safe.is_empty() || safe.len() > 64 || safe != token {
        return Err("The file transfer was cancelled.".into());
    }
    Ok(st.data_dir.join("media").join(format!(".roomup-{safe}")))
}

fn human(b: u64) -> String {
    let g = b as f64 / 1_073_741_824.0;
    if g >= 1.0 { format!("{g:.1} GB") } else { format!("{:.0} MB", b as f64 / 1_048_576.0) }
}

#[derive(Serialize)]
pub struct DiskSpace {
    /// Free space where the app keeps its data, in bytes (0 when it can't be found out).
    free: u64,
    total: u64,
}

/// How much room there is on the drive that holds the app's data.
#[tauri::command]
pub fn disk_space(state: State<'_, Shared>) -> DiskSpace {
    DiskSpace { free: fs4::available_space(&state.data_dir).unwrap_or(0), total: fs4::total_space(&state.data_dir).unwrap_or(0) }
}

/// Start a chunked upload of a room model: the pieces are written straight to a file on disk, so a model of any size works,
/// as long as the drive has the room (`size` is the file's size: a file that clearly won't fit is refused before anything is copied).
#[tauri::command]
pub fn room_model_begin(state: State<'_, Shared>, size: Option<u64>) -> R<String> {
    if let (Some(size), Ok(free)) = (size, fs4::available_space(&state.data_dir)) {
        // a little spare room is kept, so the drive isn't filled to the brim
        let need = size + 200 * 1024 * 1024;
        if free < need {
            return Err(format!("There isn't enough free space for this 3D file: it is {} and this device has {} free (about {} is needed). Free some space, or try a smaller room.", human(size), human(free), human(need)));
        }
    }
    // leftovers of uploads that never finished (an hour old or more)
    if let Ok(rd) = std::fs::read_dir(state.data_dir.join("media")) {
        for f in rd.flatten() {
            if f.file_name().to_string_lossy().starts_with(".roomup-") {
                let old = f.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).map(|d| d.as_secs() > 3600).unwrap_or(true);
                if old { let _ = std::fs::remove_file(f.path()); }
            }
        }
    }
    // ... and unpacked Unity packages that were never finished
    if let Ok(rd) = std::fs::read_dir(state.data_dir.join("media")) {
        for f in rd.flatten() {
            if f.file_name().to_string_lossy().starts_with("pkgtmp-") {
                let old = f.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).map(|d| d.as_secs() > 3600).unwrap_or(true);
                if old { let _ = std::fs::remove_dir_all(f.path()); }
            }
        }
    }
    let token = uid();
    std::fs::write(upload_path(&state, &token)?, b"").map_err(e)?;
    Ok(token)
}

/// One piece (base64) of the file. Returns how many bytes there are so far.
#[tauri::command]
pub fn room_model_chunk(state: State<'_, Shared>, token: String, data: String) -> R<u64> {
    use base64::Engine;
    use std::io::Write;
    let bytes = base64::engine::general_purpose::STANDARD.decode(data.trim()).map_err(|_| "That piece of the file was damaged on the way in.".to_string())?;
    let path = upload_path(&state, &token)?;
    let have = std::fs::metadata(&path).map_err(|_| "The file transfer was cancelled.".to_string())?.len();
    if have + bytes.len() as u64 > MAX_MODEL_UPLOAD {
        let _ = std::fs::remove_file(&path);
        return Err("That file is far too large to be a 3D room (8 GB at most).".into());
    }
    let mut f = std::fs::OpenOptions::new().append(true).open(&path).map_err(|_| "The file transfer was cancelled.".to_string())?;
    f.write_all(&bytes).map_err(|err| {
        let _ = std::fs::remove_file(&path);
        format!("Couldn't save the file (is the disk full?): {err}")
    })?;
    Ok(have + bytes.len() as u64)
}

/// The whole file is there: check it and make it the room's model.
#[tauri::command]
pub fn room_model_finish(state: State<'_, Shared>, id: i64, token: String, file_name: String) -> R<RoomOut> {
    use std::io::Read;
    let path = upload_path(&state, &token)?;
    let fail = |m: &str| -> R<RoomOut> { let _ = std::fs::remove_file(&path); Err(m.to_string()) };
    let mut head = [0u8; 64];
    let n = match std::fs::File::open(&path).and_then(|mut f| f.read(&mut head)) {
        Ok(n) => n,
        Err(_) => return Err("The file transfer was cancelled.".into()),
    };
    let ext = match check_model(&file_name, &head[..n]) {
        Ok(x) => x,
        Err(m) => return fail(&m),
    };
    let rel = format!("media/roommodel-{id}-{}.{ext}", db::now());
    if let Err(err) = std::fs::rename(&path, state.data_dir.join(&rel)) {
        return fail(&format!("Couldn't save the file: {err}"));
    }
    install_model(&state, id, rel, shown_name(&file_name))
}

fn scan_path(st: &AppState, token: &str) -> R<std::path::PathBuf> {
    let p = upload_path(st, token)?;
    Ok(std::path::PathBuf::from(format!("{}.scan.json", p.display())))
}

fn pkg_dir(st: &AppState, token: &str) -> R<std::path::PathBuf> {
    upload_path(st, token)?; // checks the token
    Ok(st.data_dir.join("media").join(format!("pkgtmp-{token}")))
}

/// A Unity package that was sent with the chunked upload: look inside it (writes nothing), and refuse it with a plain reason if it can't become a room.
#[tauri::command]
pub async fn room_package_scan(state: State<'_, Shared>, token: String) -> R<crate::unitypkg::PkgReport> {
    let st: Shared = state.inner().clone();
    let path = upload_path(&st, &token)?;
    let sp = scan_path(&st, &token)?;
    tokio::task::spawn_blocking(move || {
        let run = || -> R<crate::unitypkg::PkgReport> {
            let size = std::fs::metadata(&path).map_err(|_| "The file transfer was cancelled.".to_string())?.len();
            if size > crate::unitypkg::MAX_PACKAGE_BYTES {
                return Err("That package is too big (4 GB at most).".into());
            }
            let scan = crate::unitypkg::scan(&path)?;
            let rep = crate::unitypkg::report(&scan)?;
            std::fs::write(&sp, serde_json::to_vec(&scan).map_err(|err| err.to_string())?).map_err(|err| err.to_string())?;
            Ok(rep)
        };
        let r = run();
        if r.is_err() {
            let _ = std::fs::remove_file(&path);
            let _ = std::fs::remove_file(&sp);
        }
        r
    })
    .await
    .map_err(|err| err.to_string())?
}

/// Unpack the chosen models (and the pictures the package's materials use) from a scanned package into a temporary folder.
/// `for_decor` is for a library of props (more room is allowed than for one room).
#[tauri::command]
pub async fn room_package_extract(state: State<'_, Shared>, token: String, model_guids: Vec<String>, for_decor: Option<bool>) -> R<crate::unitypkg::Extracted> {
    let st: Shared = state.inner().clone();
    let path = upload_path(&st, &token)?;
    let sp = scan_path(&st, &token)?;
    let dir = pkg_dir(&st, &token)?;
    let free = fs4::available_space(&st.data_dir).unwrap_or(0);
    let max = if for_decor.unwrap_or(false) { crate::unitypkg::MAX_DECOR_BYTES } else { crate::unitypkg::MAX_ROOM_BYTES };
    tokio::task::spawn_blocking(move || {
        let scan: crate::unitypkg::Scan = serde_json::from_slice(&std::fs::read(&sp).map_err(|_| "The package isn't here any more. Choose it again.".to_string())?)
            .map_err(|_| "The package isn't here any more. Choose it again.".to_string())?;
        let r = crate::unitypkg::extract(&path, &scan, &model_guids, &dir, free, max);
        if r.is_err() {
            let _ = std::fs::remove_dir_all(&dir);
        }
        r
    })
    .await
    .map_err(|err| err.to_string())?
}

/// Throw away everything a package import left behind (the uploaded package, its scan and the unpacked folder).
#[tauri::command]
pub fn room_package_cleanup(state: State<'_, Shared>, token: String) {
    if let Ok(p) = upload_path(&state, &token) { let _ = std::fs::remove_file(p); }
    if let Ok(p) = scan_path(&state, &token) { let _ = std::fs::remove_file(p); }
    if let Ok(p) = pkg_dir(&state, &token) { let _ = std::fs::remove_dir_all(p); }
}

#[tauri::command]
pub fn room_model_cancel(state: State<'_, Shared>, token: String) {
    if let Ok(p) = upload_path(&state, &token) { let _ = std::fs::remove_file(p); }
}

#[tauri::command]
pub fn clear_room_model(state: State<'_, Shared>, id: i64) -> R<RoomOut> {
    let o = owner(&state)?;
    let db = state.db.lock().unwrap();
    let mut r = db::get_room(&db, id, &o).map_err(e)?.ok_or("Room not found")?;
    if !r.model.is_empty() {
        let _ = std::fs::remove_file(state.data_dir.join(&r.model));
    }
    r.model.clear(); r.model_name.clear();
    r.model_scale = 1.0; r.model_rot = 0.0; r.model_y = 0.0; r.model_share = false;
    db::update_room(&db, &r, &o).map_err(e)?;
    Ok(room_out(&state, r))
}

/// How the 3D scene is set (size multiplier, turn in degrees, height shift in metres) and whether it may be shared.
#[tauri::command]
pub fn set_room_model_cfg(state: State<'_, Shared>, id: i64, scale: f64, rot: f64, y: f64, share: bool) -> R<RoomOut> {
    let o = owner(&state)?;
    let db = state.db.lock().unwrap();
    let mut r = db::get_room(&db, id, &o).map_err(e)?.ok_or("Room not found")?;
    if r.model.is_empty() {
        return Err("This room has no 3D model.".into());
    }
    let fin = |v: f64, d: f64| if v.is_finite() { v } else { d };
    r.model_scale = fin(scale, 1.0).clamp(0.01, 100.0);
    r.model_rot = fin(rot, 0.0).rem_euclid(360.0);
    r.model_y = fin(y, 0.0).clamp(-50.0, 50.0);
    r.model_share = share;
    db::update_room(&db, &r, &o).map_err(e)?;
    Ok(room_out(&state, r))
}

#[derive(Serialize)]
pub struct DormOut {
    #[serde(flatten)]
    dorm: db::Dorm,
    music_path: Option<String>,
}

pub fn dorm_out(st: &AppState, dorm: db::Dorm) -> DormOut {
    let music_path = Some(dorm.music.as_str()).filter(|m| !m.is_empty()).map(|m| st.data_dir.join(m).to_string_lossy().to_string());
    DormOut { dorm, music_path }
}

/// Body: raw audio bytes. Headers: `x-dorm-id`, `x-file-name` (percent-encoded).
#[tauri::command]
pub fn set_dorm_music(request: Request<'_>, state: State<'_, Shared>) -> R<DormOut> {
    let id: i64 = header(&request, "x-dorm-id").parse().map_err(|_| "Dorm not found")?;
    let (bytes, rel, shown) = music_file(&request, &format!("dorm{id}"))?;
    let o = owner(&state)?;
    let db = state.db.lock().unwrap();
    let d = db::get_dorm(&db, id, &o).map_err(e)?.ok_or("Dorm not found")?;
    std::fs::write(state.data_dir.join(&rel), bytes).map_err(e)?;
    if !d.music.is_empty() {
        let _ = std::fs::remove_file(state.data_dir.join(&d.music));
    }
    db::set_dorm_music(&db, id, &rel, &shown, &o).map_err(e)?;
    Ok(dorm_out(&state, db::get_dorm(&db, id, &o).map_err(e)?.ok_or("Dorm not found")?))
}

#[tauri::command]
pub fn clear_dorm_music(state: State<'_, Shared>, id: i64) -> R<DormOut> {
    let o = owner(&state)?;
    let db = state.db.lock().unwrap();
    let d = db::get_dorm(&db, id, &o).map_err(e)?.ok_or("Dorm not found")?;
    if !d.music.is_empty() {
        let _ = std::fs::remove_file(state.data_dir.join(&d.music));
    }
    db::set_dorm_music(&db, id, "", "", &o).map_err(e)?;
    Ok(dorm_out(&state, db::get_dorm(&db, id, &o).map_err(e)?.ok_or("Dorm not found")?))
}

#[tauri::command]
pub fn set_dorm_room(state: State<'_, Shared>, id: i64, room_id: Option<i64>) -> R<()> {
    let o = owner(&state)?;
    db::set_dorm_room(&state.db.lock().unwrap(), id, room_id, &o).map_err(e)
}

fn kind_label(k: &str) -> String {
    k.replace('_', " ")
}

fn room_block(db: &Connection, chat: &db::Chat, o: &db::Owner) -> String {
    let Some(dorm) = chat.dorm_id.and_then(|d| db::get_dorm(db, d, o).ok().flatten()) else { return String::new() };
    let Some(room) = dorm.room_id.and_then(|r| db::get_room(db, r, o).ok().flatten()) else { return String::new() };
    let mut s = format!("Setting: {}", room.name);
    if room.kind != "other" {
        s.push_str(&format!(" (a {})", kind_label(&room.kind)));
    }
    s.push('.');
    match (&room.owner_kind[..], room.character_id.as_ref().and_then(|c| db::get_character(db, c, o).ok().flatten())) {
        ("character", Some(c)) => s.push_str(&format!(" This is {}'s own place.", c.card.name)),
        _ => s.push_str(" This is {{user}}'s own space."),
    }
    if !room.description.trim().is_empty() {
        s.push_str(&format!("\n{}", room.description.trim()));
    }
    s.push_str("\nKeep the scene in this place unless the story moves it.");
    s
}

fn style_block(chat: &db::Chat) -> String {
    if chat.style == "phone" {
        "{{char}} and {{user}} are texting each other on their phones, not talking face to face. Write {{char}}'s reply as text messages: short and casual, the way this character would type. No *actions* and no narration. You may send up to three short messages in a row; put a blank line between them.".into()
    } else {
        String::new()
    }
}

// ---------------------------------------------------------------------------
// Mechanic packs
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct VarOut {
    id: String,
    name: String,
    kind: String,
    min: Option<f64>,
    max: Option<f64>,
    description: String,
}

#[derive(Serialize)]
pub struct MechanicOut {
    id: String,
    name: String,
    description: String,
    tags: Vec<String>,
    /// relations | status | phone | vars: which built-in panel shows it
    app: &'static str,
    variables: Vec<VarOut>,
    entries: usize,
    reactions: usize,
    /// the pack ships its own interface code, which this app doesn't run
    has_ui: bool,
}

fn mech_out(row: &MechanicRow) -> Option<MechanicOut> {
    let b = mech::parse_bundle(&row.json).ok()?;
    Some(MechanicOut {
        id: row.id.clone(),
        name: b.name.clone(),
        description: b.description.chars().take(600).collect(),
        tags: b.tags.clone(),
        app: mech::app_kind(&b),
        variables: b
            .variables
            .iter()
            .map(|v| VarOut { id: v.id.clone(), name: if v.name.is_empty() { v.id.clone() } else { v.name.clone() }, kind: v.kind.clone(), min: v.min, max: v.max, description: v.description.clone() })
            .collect(),
        entries: b.entries.len(),
        reactions: b.reactions.len(),
        has_ui: b.root_component.is_some(),
    })
}

#[tauri::command]
pub fn list_mechanics(state: State<'_, Shared>) -> R<Vec<MechanicOut>> {
    let o = owner(&state)?;
    let rows = db::list_mechanics(&state.db.lock().unwrap(), &o).map_err(e)?;
    Ok(rows.iter().filter_map(mech_out).collect())
}

/// Body: the text of a `.bundle.json`. A pack with the same name replaces the old one (chats keep their progress).
#[tauri::command]
pub fn import_mechanic(request: Request<'_>, state: State<'_, Shared>) -> R<MechanicOut> {
    let bytes = raw_body(&request)?;
    if bytes.len() > MAX_PACK_BYTES {
        return Err("That file is too large to be a mechanic pack.".into());
    }
    let text = std::str::from_utf8(bytes).map_err(|_| "That file isn't text.".to_string())?;
    let b = mech::parse_bundle(text)?;
    let o = owner(&state)?;
    let db = state.db.lock().unwrap();
    let existing = db::list_mechanics(&db, &o).map_err(e)?.into_iter().find(|m| m.name == b.name);
    let row = MechanicRow {
        id: existing.as_ref().map(|m| m.id.clone()).unwrap_or_else(uid),
        name: b.name.clone(),
        description: b.description.clone(),
        json: text.to_string(),
        created_at: existing.map(|m| m.created_at).unwrap_or_else(db::now),
    };
    db::save_mechanic(&db, &row, &o).map_err(e)?;
    mech_out(&row).ok_or_else(|| "Couldn't read that pack.".into())
}

#[tauri::command]
pub fn delete_mechanic(state: State<'_, Shared>, id: String) -> R<()> {
    let o = owner(&state)?;
    db::delete_mechanic(&state.db.lock().unwrap(), &id, &o).map_err(e)
}

fn pack(db: &Connection, id: &str, o: &db::Owner) -> R<(MechanicRow, Bundle)> {
    let row = db::get_mechanic(db, id, o).map_err(e)?.ok_or("That pack isn't in your library any more.")?;
    let b = mech::parse_bundle(&row.json)?;
    Ok((row, b))
}

#[tauri::command]
pub fn chat_mechanics(state: State<'_, Shared>, chat_id: i64) -> R<Vec<ChatMechanic>> {
    let o = owner(&state)?;
    let db = state.db.lock().unwrap();
    db::get_chat(&db, chat_id, &o).map_err(e)?.ok_or("Chat not found")?;
    db::list_chat_mechanics(&db, chat_id).map_err(e)
}

#[tauri::command]
pub fn set_chat_mechanic(state: State<'_, Shared>, chat_id: i64, mech_id: String, enabled: bool) -> R<Vec<ChatMechanic>> {
    let o = owner(&state)?;
    let db = state.db.lock().unwrap();
    db::get_chat(&db, chat_id, &o).map_err(e)?.ok_or("Chat not found")?;
    let (_, b) = pack(&db, &mech_id, &o)?;
    let mut cm = db::list_chat_mechanics(&db, chat_id).map_err(e)?.into_iter().find(|m| m.mech_id == mech_id).unwrap_or(ChatMechanic { mech_id: mech_id.clone(), enabled, state: mech::init_state(&b) });
    cm.enabled = enabled;
    db::save_chat_mechanic(&db, chat_id, &cm).map_err(e)?;
    db::list_chat_mechanics(&db, chat_id).map_err(e)
}

#[tauri::command]
pub fn reset_chat_mechanic(state: State<'_, Shared>, chat_id: i64, mech_id: String) -> R<Vec<ChatMechanic>> {
    let o = owner(&state)?;
    let db = state.db.lock().unwrap();
    db::get_chat(&db, chat_id, &o).map_err(e)?.ok_or("Chat not found")?;
    let (_, b) = pack(&db, &mech_id, &o)?;
    let was = db::list_chat_mechanics(&db, chat_id).map_err(e)?.into_iter().find(|m| m.mech_id == mech_id).map(|m| m.enabled).unwrap_or(true);
    db::save_chat_mechanic(&db, chat_id, &ChatMechanic { mech_id, enabled: was, state: mech::init_state(&b) }).map_err(e)?;
    db::list_chat_mechanics(&db, chat_id).map_err(e)
}

/// The person nudges a variable themselves (for example to start at a different affection).
#[tauri::command]
pub fn set_chat_variable(state: State<'_, Shared>, chat_id: i64, mech_id: String, path: String, value: Value) -> R<Vec<ChatMechanic>> {
    let o = owner(&state)?;
    let db = state.db.lock().unwrap();
    db::get_chat(&db, chat_id, &o).map_err(e)?.ok_or("Chat not found")?;
    let (_, b) = pack(&db, &mech_id, &o)?;
    let mut cm = db::list_chat_mechanics(&db, chat_id).map_err(e)?.into_iter().find(|m| m.mech_id == mech_id).ok_or("Switch the pack on for this chat first.")?;
    mech::apply_op(&mut cm.state, &b, &path, "set", &value);
    db::save_chat_mechanic(&db, chat_id, &cm).map_err(e)?;
    db::list_chat_mechanics(&db, chat_id).map_err(e)
}

/// Switched-on packs of a chat, parsed.
fn active(db: &Connection, chat_id: i64, o: &db::Owner) -> Vec<(ChatMechanic, Bundle)> {
    db::list_chat_mechanics(db, chat_id)
        .unwrap_or_default()
        .into_iter()
        .filter(|m| m.enabled)
        .filter_map(|m| {
            let row = db::get_mechanic(db, &m.mech_id, o).ok().flatten()?;
            let b = mech::parse_bundle(&row.json).ok()?;
            Some((m, b))
        })
        .collect()
}

/// Everything beyond the character card that goes into the system prompt: the room, the texting style, the packs.
pub fn extra_system(db: &Connection, chat: &db::Chat, o: &db::Owner, recent: &str) -> String {
    let mut parts = vec![room_block(db, chat, o), style_block(chat)];
    for (cm, b) in active(db, chat.id, o) {
        parts.push(mech::prompt_block(&b, &cm.state, recent));
    }
    parts.into_iter().filter(|p| !p.trim().is_empty()).collect::<Vec<_>>().join("\n\n")
}

/// The person said something: keyword reactions of every switched-on pack run.
pub fn on_user_message(st: &AppState, db: &Connection, chat_id: i64, o: &db::Owner, text: &str) {
    let mut any = false;
    for (mut cm, b) in active(db, chat_id, o) {
        if !mech::react(&mut cm.state, &b, &Event::UserMessage(text)).is_empty() || cm.state.contains_key("_directives") {
            let _ = db::save_chat_mechanic(db, chat_id, &cm);
            any = true;
        }
    }
    if any {
        emit(st, "dorms://mechanics", json!({ "chat_id": chat_id }));
    }
}

/// A character replied: take the hidden directives out of the text and apply them, then run the reactions to the
/// reply and to the turn finishing. Returns the text to show.
pub fn after_reply(st: &AppState, db: &Connection, chat_id: i64, o: &db::Owner, text: &str, character_turns: u64) -> String {
    let packs = active(db, chat_id, o);
    if packs.is_empty() {
        return text.to_string();
    }
    let known: Vec<String> = packs.iter().flat_map(|(_, b)| b.variables.iter().map(|v| v.id.clone())).collect();
    let (clean, directives) = mech::extract_directives(text, &known);
    for (mut cm, b) in packs {
        for d in directives.iter().filter(|d| b.variables.iter().any(|v| v.id == d.path.split('.').next().unwrap_or(""))) {
            mech::apply_op(&mut cm.state, &b, &d.path, &d.op, &d.value);
        }
        mech::react(&mut cm.state, &b, &Event::CharacterMessage(&clean));
        mech::end_turn(&mut cm.state);
        mech::react(&mut cm.state, &b, &Event::TurnComplete(character_turns));
        let _ = db::save_chat_mechanic(db, chat_id, &cm);
    }
    emit(st, "dorms://mechanics", json!({ "chat_id": chat_id }));
    clean
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

/// Not a real limit on writing: only a guard against a runaway paste filling the disk.
const MAX_NOTE_BYTES: usize = 25 * 1024 * 1024;

#[tauri::command]
pub fn list_notes(state: State<'_, Shared>) -> R<Vec<db::Note>> {
    let o = owner(&state)?;
    db::list_notes(&state.db.lock().unwrap(), &o).map_err(e)
}

/// Creates the note when `id` is empty. Returns it as saved.
#[tauri::command]
pub fn save_note(state: State<'_, Shared>, note: db::Note) -> R<db::Note> {
    if note.body.len() > MAX_NOTE_BYTES || note.title.len() > 1000 {
        return Err("That note is too large to save.".into());
    }
    let o = owner(&state)?;
    let db = state.db.lock().unwrap();
    let now = db::now();
    let existing = if note.id.is_empty() { None } else { db::list_notes(&db, &o).map_err(e)?.into_iter().find(|n| n.id == note.id) };
    let saved = db::Note {
        id: existing.as_ref().map(|n| n.id.clone()).unwrap_or_else(uid),
        title: note.title.chars().filter(|c| !c.is_control() || *c == ' ').collect(),
        body: note.body,
        pinned: note.pinned,
        created_at: existing.map(|n| n.created_at).unwrap_or(now),
        updated_at: now,
    };
    db::save_note(&db, &saved, &o).map_err(e)?;
    Ok(saved)
}

#[tauri::command]
pub fn delete_note(state: State<'_, Shared>, id: String) -> R<()> {
    let o = owner(&state)?;
    db::delete_note(&state.db.lock().unwrap(), &id, &o).map_err(e)
}

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct FolderOut {
    #[serde(flatten)]
    folder: db::Folder,
    cover_path: Option<String>,
}

fn folder_out(st: &AppState, f: db::Folder) -> FolderOut {
    let cover_path = f.cover.as_ref().map(|c| st.data_dir.join(c).to_string_lossy().to_string());
    FolderOut { folder: f, cover_path }
}

fn clean_folder_name(n: &str) -> R<String> {
    let n: String = n.chars().filter(|c| !c.is_control()).collect::<String>().trim().chars().take(60).collect();
    if n.is_empty() { Err("Give the folder a name.".into()) } else { Ok(n) }
}

#[tauri::command]
pub fn list_folders(state: State<'_, Shared>) -> R<Vec<FolderOut>> {
    let o = owner(&state)?;
    let l = db::list_folders(&state.db.lock().unwrap(), &o).map_err(e)?;
    Ok(l.into_iter().map(|f| folder_out(&state, f)).collect())
}

#[tauri::command]
pub fn create_folder(state: State<'_, Shared>, name: String, parent: Option<String>) -> R<FolderOut> {
    let o = owner(&state)?;
    let name = clean_folder_name(&name)?;
    let db = state.db.lock().unwrap();
    let all = db::list_folders(&db, &o).map_err(e)?;
    // a new folder may sit inside an existing one
    let parent = match parent {
        Some(p) if !p.is_empty() => {
            if !all.iter().any(|f| f.id == p) { return Err("That folder doesn't exist any more.".into()); }
            if db::folder_chain(&all, &p).len() >= db::MAX_FOLDER_DEPTH { return Err("Folders can only be nested a few levels deep.".into()); }
            Some(p)
        }
        _ => None,
    };
    if db::list_folders(&db, &o).map_err(e)?.len() >= 500 {
        return Err("That's a lot of folders. Delete some first.".into());
    }
    let f = db::Folder { id: uid(), name, cover: None, frame: None, created_at: db::now(), parent, cover_char: None };
    db::save_folder(&db, &f, &o).map_err(e)?;
    Ok(folder_out(&state, f))
}

#[tauri::command]
pub fn rename_folder(state: State<'_, Shared>, id: String, name: String) -> R<FolderOut> {
    let o = owner(&state)?;
    let name = clean_folder_name(&name)?;
    let db = state.db.lock().unwrap();
    let mut f = db::get_folder(&db, &id, &o).map_err(e)?.ok_or("Folder not found")?;
    f.name = name;
    db::save_folder(&db, &f, &o).map_err(e)?;
    Ok(folder_out(&state, f))
}

#[tauri::command]
pub fn delete_folder(state: State<'_, Shared>, id: String) -> R<()> {
    let o = owner(&state)?;
    let db = state.db.lock().unwrap();
    if let Some(f) = db::get_folder(&db, &id, &o).map_err(e)? {
        if let Some(c) = &f.cover {
            let _ = std::fs::remove_file(state.data_dir.join(c));
        }
    }
    db::delete_folder(&db, &id, &o).map_err(e)
}

/// Put a folder inside another (or back at the top level with `parent: null`).
#[tauri::command]
pub fn move_folder(state: State<'_, Shared>, id: String, parent: Option<String>) -> R<FolderOut> {
    let o = owner(&state)?;
    let db = state.db.lock().unwrap();
    let all = db::list_folders(&db, &o).map_err(e)?;
    let mut f = all.iter().find(|f| f.id == id).cloned().ok_or("Folder not found")?;
    let parent = parent.filter(|p| !p.is_empty());
    if let Some(p) = &parent {
        if !all.iter().any(|x| &x.id == p) { return Err("That folder doesn't exist any more.".into()); }
    }
    db::can_nest(&all, &id, parent.as_deref())?;
    f.parent = parent;
    db::save_folder(&db, &f, &o).map_err(e)?;
    Ok(folder_out(&state, f))
}

/// Body: raw image bytes. Headers: `x-folder-id`, `x-file-name` (percent-encoded).
#[tauri::command]
pub fn set_folder_cover(request: Request<'_>, state: State<'_, Shared>) -> R<FolderOut> {
    let id = header(&request, "x-folder-id");
    let name = header(&request, "x-file-name");
    let bytes = raw_body(&request)?;
    if bytes.len() > MAX_BACKDROP_BYTES {
        return Err("That image is too large (40 MB at most).".into());
    }
    let ext = std::path::Path::new(&name).extension().and_then(|x| x.to_str()).unwrap_or("").to_lowercase();
    if !["png", "jpg", "jpeg", "webp", "gif", "avif", "bmp"].contains(&ext.as_str()) {
        return Err("A folder picture has to be an image (JPG, PNG, WebP or GIF).".into());
    }
    let o = owner(&state)?;
    let db = state.db.lock().unwrap();
    let mut f = db::get_folder(&db, &id, &o).map_err(e)?.ok_or("Folder not found")?;
    let safe: String = f.id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').collect();
    let rel = format!("media/folder-{safe}-{}.{ext}", db::now());
    std::fs::write(state.data_dir.join(&rel), bytes).map_err(e)?;
    if let Some(old) = &f.cover {
        let _ = std::fs::remove_file(state.data_dir.join(old));
    }
    f.cover = Some(rel);
    f.frame = None;
    db::save_folder(&db, &f, &o).map_err(e)?;
    Ok(folder_out(&state, f))
}

#[tauri::command]
pub fn set_folder_frame(state: State<'_, Shared>, id: String, frame: Option<db::Frame>) -> R<FolderOut> {
    let o = owner(&state)?;
    let db = state.db.lock().unwrap();
    let mut f = db::get_folder(&db, &id, &o).map_err(e)?.ok_or("Folder not found")?;
    f.frame = frame.and_then(|x| x.clean());
    db::save_folder(&db, &f, &o).map_err(e)?;
    Ok(folder_out(&state, f))
}

#[tauri::command]
pub fn clear_folder_cover(state: State<'_, Shared>, id: String) -> R<FolderOut> {
    let o = owner(&state)?;
    let db = state.db.lock().unwrap();
    let mut f = db::get_folder(&db, &id, &o).map_err(e)?.ok_or("Folder not found")?;
    if let Some(old) = f.cover.take() {
        let _ = std::fs::remove_file(state.data_dir.join(old));
    }
    f.frame = None;
    db::save_folder(&db, &f, &o).map_err(e)?;
    Ok(folder_out(&state, f))
}

/// File characters into a folder (or back to the top level with `folder: null`).
#[tauri::command]
pub fn move_characters(state: State<'_, Shared>, ids: Vec<String>, folder: Option<String>) -> R<()> {
    let o = owner(&state)?;
    let db = state.db.lock().unwrap();
    if let Some(f) = &folder {
        db::get_folder(&db, f, &o).map_err(e)?.ok_or("That folder doesn't exist any more.")?;
    }
    for id in ids {
        if let Some(mut c) = db::get_character(&db, &id, &o).map_err(e)? {
            c.folder = folder.clone();
            c.order = None; // lands at the end of its new folder
            db::save_character(&db, &c, &o).map_err(e)?;
        }
    }
    Ok(())
}

/// Put characters in the order given (the order of the cards on screen). Cards not named keep their place after these.
#[tauri::command]
pub fn reorder_characters(state: State<'_, Shared>, ids: Vec<String>) -> R<()> {
    let o = owner(&state)?;
    let db = state.db.lock().unwrap();
    for (i, id) in ids.iter().enumerate() {
        if let Some(mut c) = db::get_character(&db, id, &o).map_err(e)? {
            c.order = Some(i as i64);
            db::save_character(&db, &c, &o).map_err(e)?;
        }
    }
    Ok(())
}

/// Use a character's picture as the folder's picture (`None` goes back to the folder's own picture or the plain folder).
#[tauri::command]
pub fn set_folder_cover_char(state: State<'_, Shared>, id: String, character: Option<String>) -> R<FolderOut> {
    let o = owner(&state)?;
    let db = state.db.lock().unwrap();
    let mut f = db::get_folder(&db, &id, &o).map_err(e)?.ok_or("Folder not found")?;
    if let Some(c) = &character {
        db::get_character(&db, c, &o).map_err(e)?.ok_or("That character doesn't exist any more.")?;
    }
    f.cover_char = character.filter(|c| !c.is_empty());
    db::save_folder(&db, &f, &o).map_err(e)?;
    Ok(folder_out(&state, f))
}

// ---------------------------------------------------------------------------
// Decorations: the profile's library of 3D props (furniture, plants, food...), each kept as a .glb
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct DecorOut {
    #[serde(flatten)]
    item: db::DecorItem,
    /// Absolute path of the .glb (for the web view).
    path: String,
}

fn decor_out(st: &AppState, item: db::DecorItem) -> DecorOut {
    let path = st.data_dir.join(&item.file).to_string_lossy().to_string();
    DecorOut { item, path }
}

fn clean_decor_name(n: &str) -> R<String> {
    let n: String = n.chars().filter(|c| !c.is_control()).collect::<String>().trim().chars().take(80).collect();
    if n.is_empty() { Err("Give the decoration a name.".into()) } else { Ok(n) }
}

#[tauri::command]
pub fn list_decor(state: State<'_, Shared>) -> R<Vec<DecorOut>> {
    let o = owner(&state)?;
    let l = db::list_decor(&state.db.lock().unwrap(), &o).map_err(e)?;
    Ok(l.into_iter().map(|d| decor_out(&state, d)).collect())
}

/// A .glb that was sent with the chunked upload becomes a decoration in the library. A new one is **not** marked as shareable.
#[tauri::command]
pub fn decor_finish(state: State<'_, Shared>, token: String, name: String) -> R<DecorOut> {
    use std::io::Read;
    let path = upload_path(&state, &token)?;
    let fail = |m: &str| -> R<DecorOut> { let _ = std::fs::remove_file(&path); Err(m.to_string()) };
    let name = match clean_decor_name(&name) { Ok(n) => n, Err(m) => return fail(&m) };
    let mut head = [0u8; 64];
    let n = match std::fs::File::open(&path).and_then(|mut f| f.read(&mut head)) {
        Ok(n) => n,
        Err(_) => return Err("The file transfer was cancelled.".into()),
    };
    if !head[..n].starts_with(b"glTF") {
        return fail("That isn't a valid 3D model (a decoration is saved as a .glb).");
    }
    let bytes = std::fs::metadata(&path).map(|m| m.len() as i64).unwrap_or(0);
    let o = owner(&state)?;
    let db = state.db.lock().unwrap();
    if db::list_decor(&db, &o).map_err(e)?.len() >= 2000 {
        return fail("That's a lot of decorations. Delete some first.");
    }
    let id = uid();
    let rel = format!("media/decor-{id}.glb");
    if let Err(err) = std::fs::rename(&path, state.data_dir.join(&rel)) {
        return fail(&format!("Couldn't save the file: {err}"));
    }
    let item = db::DecorItem { id, name, file: rel, bytes, share: false, created_at: db::now() };
    db::save_decor(&db, &item, &o).map_err(e)?;
    Ok(decor_out(&state, item))
}

#[tauri::command]
pub fn rename_decor(state: State<'_, Shared>, id: String, name: String) -> R<DecorOut> {
    let o = owner(&state)?;
    let db = state.db.lock().unwrap();
    let mut d = db::get_decor(&db, &id, &o).map_err(e)?.ok_or("That decoration doesn't exist any more.")?;
    d.name = clean_decor_name(&name)?;
    db::save_decor(&db, &d, &o).map_err(e)?;
    Ok(decor_out(&state, d))
}

/// Mark a decoration as allowed (or not allowed) to be shared in an exported profile. This is the owner's own word about the seller's terms.
#[tauri::command]
pub fn set_decor_share(state: State<'_, Shared>, id: String, share: bool) -> R<DecorOut> {
    let o = owner(&state)?;
    let db = state.db.lock().unwrap();
    let mut d = db::get_decor(&db, &id, &o).map_err(e)?.ok_or("That decoration doesn't exist any more.")?;
    d.share = share;
    db::save_decor(&db, &d, &o).map_err(e)?;
    Ok(decor_out(&state, d))
}

#[tauri::command]
pub fn delete_decor(state: State<'_, Shared>, id: String) -> R<()> {
    let o = owner(&state)?;
    let db = state.db.lock().unwrap();
    if let Some(d) = db::get_decor(&db, &id, &o).map_err(e)? {
        let _ = std::fs::remove_file(state.data_dir.join(&d.file));
    }
    db::delete_decor(&db, &id, &o).map_err(e)
}

// ---------------------------------------------------------------------------
// Lorebooks
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn list_lorebooks(state: State<'_, Shared>) -> R<Vec<db::Lorebook>> {
    let o = owner(&state)?;
    db::list_lorebooks(&state.db.lock().unwrap(), &o).map_err(e)
}

/// Creates the book when `id` is empty. The book is read as leniently as a card's own book and stored in its clean form.
#[tauri::command]
pub fn save_lorebook(state: State<'_, Shared>, lorebook: db::Lorebook) -> R<db::Lorebook> {
    let name: String = lorebook.name.chars().filter(|c| !c.is_control()).collect::<String>().trim().chars().take(100).collect();
    if name.is_empty() {
        return Err("Give the lorebook a name.".into());
    }
    let mut warnings = vec![];
    let mut book = dorms_core::CharacterBook::from_value(&lorebook.book, &mut warnings);
    book.name = name.clone();
    if book.entries.len() > 5000 {
        return Err("That lorebook has too many entries (5000 at most).".into());
    }
    let o = owner(&state)?;
    let db = state.db.lock().unwrap();
    let now = db::now();
    let existing = if lorebook.id.is_empty() { None } else { db::list_lorebooks(&db, &o).map_err(e)?.into_iter().find(|b| b.id == lorebook.id) };
    let saved = db::Lorebook {
        id: existing.as_ref().map(|b| b.id.clone()).unwrap_or_else(uid),
        name,
        book: serde_json::to_value(&book).map_err(e)?,
        created_at: existing.map(|b| b.created_at).unwrap_or(now),
        updated_at: now,
    };
    db::save_lorebook(&db, &saved, &o).map_err(e)?;
    Ok(saved)
}

#[tauri::command]
pub fn delete_lorebook(state: State<'_, Shared>, id: String) -> R<()> {
    let o = owner(&state)?;
    db::delete_lorebook(&state.db.lock().unwrap(), &id, &o).map_err(e)
}

/// The character's card with every attached lorebook's entries added to the book inside the card.
pub fn card_with_lorebooks(db: &Connection, o: &db::Owner, c: &db::Character) -> dorms_core::CharacterData {
    let mut card = c.card.clone();
    if c.lorebooks.is_empty() {
        return card;
    }
    let books = db::list_lorebooks(db, o).unwrap_or_default();
    for id in &c.lorebooks {
        let Some(b) = books.iter().find(|b| &b.id == id) else { continue };
        let mut w = vec![];
        let extra = dorms_core::CharacterBook::from_value(&b.book, &mut w);
        match card.character_book.as_mut() {
            Some(own) => own.entries.extend(extra.entries),
            None => card.character_book = Some(extra),
        }
    }
    card
}

// ---------------------------------------------------------------------------
// Personas and profile pictures
// ---------------------------------------------------------------------------

const AVATAR_EXTS: [&str; 6] = ["png", "jpg", "jpeg", "gif", "webp", "bmp"];
const MAX_AVATAR_BYTES: usize = 25 * 1024 * 1024;

fn avatar_file(req: &Request<'_>, stem: &str) -> R<(Vec<u8>, String)> {
    let name = header(req, "x-file-name");
    let bytes = raw_body(req)?;
    if bytes.len() > MAX_AVATAR_BYTES {
        return Err("That picture is too large (25 MB at most).".into());
    }
    let ext = std::path::Path::new(&name).extension().and_then(|x| x.to_str()).unwrap_or("").to_lowercase();
    if !AVATAR_EXTS.contains(&ext.as_str()) {
        return Err("A picture has to be a PNG, JPG, GIF (animated is fine) or WebP image.".into());
    }
    let safe: String = stem.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').collect();
    Ok((bytes.to_vec(), format!("media/avatar-{safe}-{}.{ext}", db::now())))
}

#[derive(Serialize)]
pub struct PersonaOut {
    #[serde(flatten)]
    persona: db::Persona,
    avatar_path: Option<String>,
}

fn persona_out(st: &AppState, p: db::Persona) -> PersonaOut {
    let avatar_path = p.avatar.as_ref().map(|a| st.data_dir.join(a).to_string_lossy().to_string());
    PersonaOut { persona: p, avatar_path }
}

fn clean_text(s: &str, max: usize) -> String {
    s.chars().filter(|c| !c.is_control() || *c == '\n' || *c == '\t').take(max).collect::<String>().trim().to_string()
}

#[tauri::command]
pub fn list_personas(state: State<'_, Shared>) -> R<Vec<PersonaOut>> {
    let o = owner(&state)?;
    let l = db::list_personas(&state.db.lock().unwrap(), &o).map_err(e)?;
    Ok(l.into_iter().map(|p| persona_out(&state, p)).collect())
}

/// Creates the persona when `id` is empty. The picture changes only through its own commands.
#[tauri::command]
pub fn save_persona(state: State<'_, Shared>, persona: db::Persona) -> R<PersonaOut> {
    let name: String = persona.name.chars().filter(|c| !c.is_control()).take(60).collect::<String>().trim().to_string();
    if name.is_empty() {
        return Err("Give the persona a name.".into());
    }
    let o = owner(&state)?;
    let db = state.db.lock().unwrap();
    let existing = if persona.id.is_empty() { None } else { db::get_persona(&db, &persona.id, &o).map_err(e)? };
    if existing.is_none() && db::list_personas(&db, &o).map_err(e)?.len() >= 100 {
        return Err("That's a lot of personas. Delete some first.".into());
    }
    let saved = db::Persona {
        id: existing.as_ref().map(|p| p.id.clone()).unwrap_or_else(uid),
        name,
        description: clean_text(&persona.description, 20_000),
        style: clean_text(&persona.style, 20_000),
        avatar: existing.as_ref().and_then(|p| p.avatar.clone()),
        frame: existing.as_ref().and_then(|p| p.frame),
        created_at: existing.map(|p| p.created_at).unwrap_or_else(db::now),
    };
    db::save_persona(&db, &saved, &o).map_err(e)?;
    Ok(persona_out(&state, saved))
}

#[tauri::command]
pub fn delete_persona(state: State<'_, Shared>, id: String) -> R<()> {
    let o = owner(&state)?;
    let db = state.db.lock().unwrap();
    if let Some(p) = db::get_persona(&db, &id, &o).map_err(e)? {
        if let Some(a) = &p.avatar {
            let _ = std::fs::remove_file(state.data_dir.join(a));
        }
        let mut s = db::get_settings(&db, &o);
        if s.active_persona == id {
            s.active_persona.clear();
            db::save_settings(&db, &s, &o).map_err(e)?;
        }
    }
    db::delete_persona(&db, &id, &o).map_err(e)
}

/// Body: raw image bytes. Headers: `x-persona-id`, `x-file-name` (percent-encoded).
#[tauri::command]
pub fn set_persona_avatar(request: Request<'_>, state: State<'_, Shared>) -> R<PersonaOut> {
    let id = header(&request, "x-persona-id");
    let (bytes, rel) = avatar_file(&request, &format!("p-{id}"))?;
    let o = owner(&state)?;
    let db = state.db.lock().unwrap();
    let mut p = db::get_persona(&db, &id, &o).map_err(e)?.ok_or("Save the persona first")?;
    std::fs::write(state.data_dir.join(&rel), bytes).map_err(e)?;
    if let Some(old) = &p.avatar {
        let _ = std::fs::remove_file(state.data_dir.join(old));
    }
    p.avatar = Some(rel);
    p.frame = None;
    db::save_persona(&db, &p, &o).map_err(e)?;
    Ok(persona_out(&state, p))
}

#[tauri::command]
pub fn set_persona_frame(state: State<'_, Shared>, id: String, frame: Option<db::Frame>) -> R<PersonaOut> {
    let o = owner(&state)?;
    let db = state.db.lock().unwrap();
    let mut p = db::get_persona(&db, &id, &o).map_err(e)?.ok_or("Persona not found")?;
    p.frame = frame.and_then(|f| f.clean());
    db::save_persona(&db, &p, &o).map_err(e)?;
    Ok(persona_out(&state, p))
}

#[tauri::command]
pub fn clear_persona_avatar(state: State<'_, Shared>, id: String) -> R<PersonaOut> {
    let o = owner(&state)?;
    let db = state.db.lock().unwrap();
    let mut p = db::get_persona(&db, &id, &o).map_err(e)?.ok_or("Persona not found")?;
    if let Some(old) = p.avatar.take() {
        let _ = std::fs::remove_file(state.data_dir.join(old));
    }
    p.frame = None;
    db::save_persona(&db, &p, &o).map_err(e)?;
    Ok(persona_out(&state, p))
}

/// Who the player is in chats from now on. An empty id goes back to the plain name and description in Settings.
#[tauri::command]
pub fn set_active_persona(state: State<'_, Shared>, id: Option<String>) -> R<db::Settings> {
    let o = owner(&state)?;
    let db = state.db.lock().unwrap();
    let mut s = db::get_settings(&db, &o);
    s.active_persona = match id {
        Some(i) if !i.is_empty() => {
            db::get_persona(&db, &i, &o).map_err(e)?.ok_or("That persona doesn't exist any more.")?;
            i
        }
        _ => String::new(),
    };
    db::save_settings(&db, &s, &o).map_err(e)?;
    Ok(s)
}

/// The name and description the AI is given for the player: the active persona's, or the plain ones from Settings.
/// The persona's roleplay preferences ride along with its description, so the AI knows beforehand how the player
/// wants to play and what to remember.
pub fn apply_persona(db: &Connection, o: &db::Owner, s: &mut db::Settings) {
    if s.active_persona.is_empty() {
        return;
    }
    let Some(p) = db::get_persona(db, &s.active_persona, o).ok().flatten() else { return };
    s.user_name = p.name.clone();
    let mut d = p.description.trim().to_string();
    if !p.style.trim().is_empty() {
        if !d.is_empty() {
            d.push_str("\n\n");
        }
        d.push_str(&format!("How {} wants to roleplay, and what to remember:\n{}", p.name, p.style.trim()));
    }
    s.user_description = d;
}

// ----- profile picture (named profiles) -----

fn session_profile(st: &AppState) -> R<String> {
    let s = st.session.lock().unwrap();
    match (&s.profile, s.chosen) {
        (Some(p), true) => Ok(p.clone()),
        (None, true) => Err("The guest space has no profile picture. Make it a real profile first (Settings → Profile), or use a persona picture.".into()),
        _ => Err("Pick a profile first.".into()),
    }
}

/// Body: raw image bytes. Header: `x-file-name` (percent-encoded). Replaces the current picture and resets its framing.
#[tauri::command]
pub fn set_profile_avatar(request: Request<'_>, state: State<'_, Shared>) -> R<()> {
    let pid = session_profile(&state)?;
    let (bytes, rel) = avatar_file(&request, &format!("profile-{pid}"))?;
    let db = state.db.lock().unwrap();
    std::fs::write(state.data_dir.join(&rel), bytes).map_err(e)?;
    if let Some((old, _)) = db::get_profile_avatar(&db, &pid) {
        let _ = std::fs::remove_file(state.data_dir.join(old));
    }
    db::set_profile_avatar(&db, &pid, &rel, None).map_err(e)
}

#[tauri::command]
pub fn set_profile_avatar_frame(state: State<'_, Shared>, frame: Option<db::Frame>) -> R<()> {
    let pid = session_profile(&state)?;
    let db = state.db.lock().unwrap();
    let (file, _) = db::get_profile_avatar(&db, &pid).ok_or("There is no picture to frame.")?;
    db::set_profile_avatar(&db, &pid, &file, frame.and_then(|f| f.clean())).map_err(e)
}

#[tauri::command]
pub fn clear_profile_avatar(state: State<'_, Shared>) -> R<()> {
    let pid = session_profile(&state)?;
    let db = state.db.lock().unwrap();
    if let Some((old, _)) = db::get_profile_avatar(&db, &pid) {
        let _ = std::fs::remove_file(state.data_dir.join(old));
    }
    db::clear_profile_avatar(&db, &pid).map_err(e)
}
