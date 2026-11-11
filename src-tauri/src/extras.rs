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
}

fn room_out(st: &AppState, room: Room) -> RoomOut {
    let backdrop_path = room.backdrop.strip_prefix("file:").map(|f| st.data_dir.join(f).to_string_lossy().to_string());
    RoomOut { room, backdrop_path }
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
