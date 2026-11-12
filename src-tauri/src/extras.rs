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
}

fn room_out(st: &AppState, room: Room) -> RoomOut {
    let backdrop_path = room.backdrop.strip_prefix("file:").map(|f| st.data_dir.join(f).to_string_lossy().to_string());
    let music_path = Some(room.music.as_str()).filter(|m| !m.is_empty()).map(|m| st.data_dir.join(m).to_string_lossy().to_string());
    RoomOut { room, backdrop_path, music_path }
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
