//! SQLite storage. Characters are stored as JSON documents (so the card model
//! can evolve without migrations); chats and messages are relational.

use dorms_core::CharacterData;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

pub fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Media {
    /// image | gif | video | vrm
    pub kind: String,
    /// Path relative to the data dir.
    pub file: String,
}

/// An extra model file for a 3D character (the same character in different clothes): the wardrobe.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Outfit {
    pub id: String,
    pub name: String,
    /// Path relative to the data dir.
    pub file: String,
}

/// How an avatar picture is framed wherever it is shown: the point of the picture to keep in view (0..1 across and
/// down) and how far to zoom in on it.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
pub struct Frame {
    pub x: f64,
    pub y: f64,
    pub zoom: f64,
}

impl Frame {
    pub fn clean(self) -> Option<Frame> {
        let ok = |v: f64| if v.is_finite() { v } else { 0.5 };
        let f = Frame { x: ok(self.x).clamp(0.0, 1.0), y: ok(self.y).clamp(0.0, 1.0), zoom: if self.zoom.is_finite() { self.zoom.clamp(1.0, 5.0) } else { 1.0 } };
        // the default framing is stored as "no framing"
        if (f.x - 0.5).abs() < 1e-6 && (f.y - 0.5).abs() < 1e-6 && (f.zoom - 1.0).abs() < 1e-6 { None } else { Some(f) }
    }
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Character {
    #[serde(default)]
    pub id: String,
    pub card: CharacterData,
    #[serde(default)]
    pub media: Option<Media>,
    /// Extra outfits (VRM models) for a 3D character; `media` stays the original.
    #[serde(default)]
    pub outfits: Vec<Outfit>,
    /// The outfit being worn (an `outfits` id); `None` means the original model.
    #[serde(default)]
    pub outfit: Option<String>,
    /// How the picture is framed (position and zoom), so a face is never cut off.
    #[serde(default)]
    pub frame: Option<Frame>,
    /// The folder this character is filed in (an id from `folders`); `None` is the top level.
    #[serde(default)]
    pub folder: Option<String>,
    /// Shared lorebooks (ids from `lorebooks`) attached to this character, besides the book inside the card.
    #[serde(default)]
    pub lorebooks: Vec<String>,
    #[serde(default)]
    pub favorite: bool,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,
    #[serde(default)]
    pub last_used: i64,
    /// Whether this card's own system prompt / post-history instructions may take priority over
    /// the app's. Cards you write are trusted; imported ones are not until you say so.
    #[serde(default = "default_true")]
    pub trusted: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Dorm {
    pub id: i64,
    pub name: String,
    pub created_at: i64,
    /// The room this dorm is set in (its description and backdrop belong to every chat in the dorm).
    #[serde(default)]
    pub room_id: Option<i64>,
    /// Background music for this dorm (path inside the data folder), played on a loop in its chats. Overrides the room's.
    #[serde(default)]
    pub music: String,
    #[serde(default)]
    pub music_name: String,
}

/// A place: where a dorm happens. Made once, used by any number of dorms.
#[derive(Serialize, Deserialize, Clone)]
pub struct Room {
    pub id: i64,
    pub name: String,
    /// living_room | bedroom | kitchen | … | other
    pub kind: String,
    pub description: String,
    /// character | self
    pub owner_kind: String,
    pub character_id: Option<String>,
    /// "" | "preset:<key>" | "file:<name inside the data folder>"
    pub backdrop: String,
    pub created_at: i64,
    /// Background music (path inside the data folder) and the file's original name.
    #[serde(default)]
    pub music: String,
    #[serde(default)]
    pub music_name: String,
}

/// A lorebook in the library: keyword-triggered lore that can be attached to any number of characters.
#[derive(Serialize, Deserialize, Clone)]
pub struct Lorebook {
    pub id: String,
    pub name: String,
    /// The book itself, in the character-card book shape.
    pub book: serde_json::Value,
    pub created_at: i64,
    pub updated_at: i64,
}

/// A library folder: characters can be filed into it. It has a name and, if wanted, a picture of its own.
#[derive(Serialize, Deserialize, Clone)]
pub struct Folder {
    pub id: String,
    pub name: String,
    /// Path relative to the data dir, or None.
    pub cover: Option<String>,
    pub frame: Option<Frame>,
    pub created_at: i64,
}

/// A free-form note. No length limit beyond sanity (it is meant for long writing, like a card's creator notes).
#[derive(Serialize, Deserialize, Clone)]
pub struct Note {
    pub id: String,
    pub title: String,
    pub body: String,
    pub pinned: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

/// A mechanic pack in the library (the imported .bundle.json, verbatim).
#[derive(Serialize, Deserialize, Clone)]
pub struct MechanicRow {
    pub id: String,
    pub name: String,
    pub description: String,
    pub json: String,
    pub created_at: i64,
}

/// A pack's place in one chat: switched on or off, and the story state it keeps there.
#[derive(Serialize, Deserialize, Clone)]
pub struct ChatMechanic {
    pub mech_id: String,
    pub enabled: bool,
    pub state: serde_json::Map<String, serde_json::Value>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Chat {
    pub id: i64,
    pub dorm_id: Option<i64>,
    pub name: String,
    /// dm | group | channel
    pub kind: String,
    pub character_ids: Vec<String>,
    pub auto_chat: bool,
    pub auto_interval_s: i64,
    /// round_robin | random | mention
    pub turn_mode: String,
    pub max_auto_turns: i64,
    pub created_at: i64,
    pub updated_at: i64,
    /// chat | phone (the same conversation, shown and written as texting)
    #[serde(default = "default_style")]
    pub style: String,
}

fn default_style() -> String {
    "chat".into()
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Message {
    pub id: i64,
    pub chat_id: i64,
    /// user | character | system
    pub role: String,
    pub character_id: Option<String>,
    pub swipes: Vec<String>,
    pub swipe_index: i64,
    pub created_at: i64,
}

impl Message {
    pub fn content(&self) -> &str {
        self.swipes
            .get(self.swipe_index.max(0) as usize)
            .or_else(|| self.swipes.last())
            .map(String::as_str)
            .unwrap_or("")
    }
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct HeaderPair {
    pub name: String,
    pub value: String,
}

/// A user-defined model API ("Other API"): anything that speaks the OpenAI chat
/// completions format or Anthropic's messages format.
#[derive(Serialize, Deserialize, Clone)]
#[serde(default)]
pub struct ApiProfile {
    pub id: String,
    pub name: String,
    /// Wire format: `openai` | `anthropic`.
    pub format: String,
    pub base_url: String,
    pub model: String,
    /// Appended to `base_url` for chat requests (OpenAI format).
    pub chat_path: String,
    /// `bearer` | `x-api-key` | `header` | `none`
    pub auth: String,
    /// Header name when `auth` is `header`.
    pub auth_header: String,
    /// Extra static headers sent on every request.
    pub headers: Vec<HeaderPair>,
    /// JSON object merged into every request body (provider-specific options).
    pub extra_body: String,
}

impl Default for ApiProfile {
    fn default() -> Self {
        ApiProfile {
            id: String::new(),
            name: String::new(),
            format: "openai".into(),
            base_url: String::new(),
            model: String::new(),
            chat_path: "/chat/completions".into(),
            auth: "bearer".into(),
            auth_header: String::new(),
            headers: vec![],
            extra_body: String::new(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(default)]
pub struct Settings {
    /// local | openai | anthropic | custom:<profile id>
    pub provider: String,
    pub profiles: Vec<ApiProfile>,
    pub user_name: String,
    pub user_description: String,
    pub context_tokens: usize,
    pub max_tokens: usize,
    pub temperature: f32,
    pub top_p: f32,
    pub local_model: String,
    pub local_gpu: bool,
    pub openai_base_url: String,
    pub openai_model: String,
    pub anthropic_model: String,
    pub use_card_system_prompt: bool,
    pub default_system: String,
    pub theme: String,
    /// Voice input: any OpenAI-compatible `/audio/transcriptions` server (OpenAI, Groq, or a local Whisper server).
    pub stt_url: String,
    pub stt_model: String,
    /// Empty = let the server detect the language.
    pub stt_language: String,
    /// Send the message as soon as it has been transcribed.
    pub stt_auto_send: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            provider: "local".into(),
            profiles: vec![],
            user_name: "You".into(),
            user_description: String::new(),
            context_tokens: 4096,
            max_tokens: 512,
            temperature: 0.8,
            top_p: 0.95,
            local_model: String::new(),
            local_gpu: true,
            openai_base_url: "https://api.openai.com/v1".into(),
            openai_model: "gpt-4o-mini".into(),
            anthropic_model: "claude-haiku-5-5".into(),
            use_card_system_prompt: true,
            default_system: String::new(),
            theme: "dusk".into(),
            stt_url: "https://api.openai.com/v1".into(),
            stt_model: "whisper-1".into(),
            stt_language: String::new(),
            stt_auto_send: true,
        }
    }
}

type R<T> = rusqlite::Result<T>;

pub fn open(path: &std::path::Path) -> R<Connection> {
    let conn = Connection::open(path)?;
    conn.execute_batch(
        "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=NORMAL;
         CREATE TABLE IF NOT EXISTS characters(
            id TEXT PRIMARY KEY, json TEXT NOT NULL, name TEXT NOT NULL DEFAULT '',
            favorite INTEGER NOT NULL DEFAULT 0, last_used INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL DEFAULT 0);
         CREATE TABLE IF NOT EXISTS dorms(
            id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, created_at INTEGER NOT NULL);
         CREATE TABLE IF NOT EXISTS chats(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            dorm_id INTEGER REFERENCES dorms(id) ON DELETE CASCADE,
            name TEXT NOT NULL, kind TEXT NOT NULL,
            character_ids TEXT NOT NULL DEFAULT '[]',
            auto_chat INTEGER NOT NULL DEFAULT 0,
            auto_interval_s INTEGER NOT NULL DEFAULT 20,
            turn_mode TEXT NOT NULL DEFAULT 'round_robin',
            max_auto_turns INTEGER NOT NULL DEFAULT 12,
            created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
         CREATE TABLE IF NOT EXISTS messages(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
            role TEXT NOT NULL, character_id TEXT,
            swipes TEXT NOT NULL, swipe_index INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL);
         CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, id);
         CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS profiles(
            id TEXT PRIMARY KEY, handle TEXT NOT NULL UNIQUE COLLATE NOCASE, display_name TEXT NOT NULL,
            passcode_hash TEXT, created_at INTEGER NOT NULL, last_login INTEGER NOT NULL DEFAULT 0);
         CREATE TABLE IF NOT EXISTS rooms(
            id INTEGER PRIMARY KEY AUTOINCREMENT, profile_id TEXT, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'other',
            description TEXT NOT NULL DEFAULT '', owner_kind TEXT NOT NULL DEFAULT 'self', character_id TEXT,
            backdrop TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);
         CREATE TABLE IF NOT EXISTS lorebooks(
            id TEXT PRIMARY KEY, profile_id TEXT, name TEXT NOT NULL, json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
         CREATE TABLE IF NOT EXISTS folders(
            id TEXT PRIMARY KEY, profile_id TEXT, name TEXT NOT NULL, cover TEXT, frame TEXT, created_at INTEGER NOT NULL);
         CREATE TABLE IF NOT EXISTS notes(
            id TEXT PRIMARY KEY, profile_id TEXT, title TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '',
            pinned INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
         CREATE TABLE IF NOT EXISTS mechanics(
            id TEXT PRIMARY KEY, profile_id TEXT, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
            json TEXT NOT NULL, created_at INTEGER NOT NULL);
         CREATE TABLE IF NOT EXISTS chat_mechanics(
            chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE, mech_id TEXT NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 1, state TEXT NOT NULL DEFAULT '{}', PRIMARY KEY(chat_id, mech_id));",
    )?;
    ensure_column(&conn, "dorms", "room_id", "INTEGER")?;
    ensure_column(&conn, "dorms", "music", "TEXT NOT NULL DEFAULT ''")?;
    ensure_column(&conn, "dorms", "music_name", "TEXT NOT NULL DEFAULT ''")?;
    ensure_column(&conn, "rooms", "music", "TEXT NOT NULL DEFAULT ''")?;
    ensure_column(&conn, "rooms", "music_name", "TEXT NOT NULL DEFAULT ''")?;
    ensure_column(&conn, "chats", "style", "TEXT NOT NULL DEFAULT 'chat'")?;
    for t in ["rooms", "mechanics", "notes", "folders", "lorebooks"] {
        conn.execute_batch(&format!("CREATE INDEX IF NOT EXISTS idx_{t}_profile ON {t}(profile_id);"))?;
    }
    // Local profiles: everything a person owns carries their profile id. NULL is the guest space, which is
    // also where everything made before profiles existed lives, so upgrading loses nothing.
    for t in ["characters", "dorms", "chats"] {
        ensure_column(&conn, t, "profile_id", "TEXT")?;
        conn.execute_batch(&format!("CREATE INDEX IF NOT EXISTS idx_{t}_profile ON {t}(profile_id);"))?;
    }
    Ok(conn)
}

fn ensure_column(c: &Connection, table: &str, col: &str, decl: &str) -> R<()> {
    let has = {
        let mut s = c.prepare(&format!("PRAGMA table_info({table})"))?;
        let names: Vec<String> = s.query_map([], |r| r.get::<_, String>(1))?.filter_map(|x| x.ok()).collect();
        names.iter().any(|n| n == col)
    };
    if !has {
        c.execute(&format!("ALTER TABLE {table} ADD COLUMN {col} {decl}"), [])?;
    }
    Ok(())
}

/// `None` is the guest space.
pub type Owner = Option<String>;

// ----- characters -----

pub fn save_character(c: &Connection, ch: &Character, owner: &Owner) -> R<()> {
    let json = serde_json::to_string(ch).unwrap_or_default();
    c.execute(
        "INSERT INTO characters(id,json,name,favorite,last_used,updated_at,profile_id) VALUES(?1,?2,?3,?4,?5,?6,?7)
         ON CONFLICT(id) DO UPDATE SET json=?2,name=?3,favorite=?4,last_used=?5,updated_at=?6
         WHERE characters.profile_id IS ?7",
        params![ch.id, json, ch.card.name, ch.favorite as i64, ch.last_used, ch.updated_at, owner],
    )?;
    Ok(())
}

fn parse_character(json: String) -> Option<Character> {
    serde_json::from_str(&json).ok()
}

pub fn get_character(c: &Connection, id: &str, owner: &Owner) -> R<Option<Character>> {
    Ok(c.query_row("SELECT json FROM characters WHERE id=?1 AND profile_id IS ?2", params![id, owner], |r| r.get::<_, String>(0))
        .optional()?
        .and_then(parse_character))
}

pub fn list_characters(c: &Connection, owner: &Owner) -> R<Vec<Character>> {
    let mut s = c.prepare("SELECT json FROM characters WHERE profile_id IS ?1 ORDER BY name COLLATE NOCASE")?;
    let rows = s.query_map([owner], |r| r.get::<_, String>(0))?;
    Ok(rows.filter_map(|r| r.ok()).filter_map(parse_character).collect())
}

pub fn delete_character(c: &Connection, id: &str, owner: &Owner) -> R<()> {
    c.execute("DELETE FROM characters WHERE id=?1 AND profile_id IS ?2", params![id, owner])?;
    Ok(())
}

// ----- dorms -----

pub fn list_dorms(c: &Connection, owner: &Owner) -> R<Vec<Dorm>> {
    let mut s = c.prepare("SELECT id,name,created_at,room_id,music,music_name FROM dorms WHERE profile_id IS ?1 ORDER BY id")?;
    let rows = s.query_map([owner], |r| Ok(Dorm { id: r.get(0)?, name: r.get(1)?, created_at: r.get(2)?, room_id: r.get(3)?, music: r.get(4)?, music_name: r.get(5)? }))?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

pub fn create_dorm(c: &Connection, name: &str, room_id: Option<i64>, owner: &Owner) -> R<Dorm> {
    let t = now();
    // a dorm may only be set in a room of the same profile
    let room_id = match room_id {
        Some(r) if get_room(c, r, owner)?.is_some() => Some(r),
        _ => None,
    };
    c.execute("INSERT INTO dorms(name,created_at,profile_id,room_id) VALUES(?1,?2,?3,?4)", params![name, t, owner, room_id])?;
    Ok(Dorm { id: c.last_insert_rowid(), name: name.into(), created_at: t, room_id, music: String::new(), music_name: String::new() })
}

pub fn set_dorm_music(c: &Connection, id: i64, music: &str, name: &str, owner: &Owner) -> R<()> {
    c.execute("UPDATE dorms SET music=?2, music_name=?3 WHERE id=?1 AND profile_id IS ?4", params![id, music, name, owner])?;
    Ok(())
}

pub fn set_dorm_room(c: &Connection, id: i64, room_id: Option<i64>, owner: &Owner) -> R<()> {
    let room_id = match room_id {
        Some(r) if get_room(c, r, owner)?.is_some() => Some(r),
        _ => None,
    };
    c.execute("UPDATE dorms SET room_id=?2 WHERE id=?1 AND profile_id IS ?3", params![id, room_id, owner])?;
    Ok(())
}

pub fn get_dorm(c: &Connection, id: i64, owner: &Owner) -> R<Option<Dorm>> {
    c.query_row("SELECT id,name,created_at,room_id,music,music_name FROM dorms WHERE id=?1 AND profile_id IS ?2", params![id, owner], |r| {
        Ok(Dorm { id: r.get(0)?, name: r.get(1)?, created_at: r.get(2)?, room_id: r.get(3)?, music: r.get(4)?, music_name: r.get(5)? })
    })
    .optional()
}

// ----- rooms -----

fn row_room(r: &rusqlite::Row) -> R<Room> {
    Ok(Room { id: r.get(0)?, name: r.get(1)?, kind: r.get(2)?, description: r.get(3)?, owner_kind: r.get(4)?, character_id: r.get(5)?, backdrop: r.get(6)?, created_at: r.get(7)?, music: r.get(8)?, music_name: r.get(9)? })
}
const ROOM_COLS: &str = "id,name,kind,description,owner_kind,character_id,backdrop,created_at,music,music_name";

pub fn list_rooms(c: &Connection, owner: &Owner) -> R<Vec<Room>> {
    let mut s = c.prepare(&format!("SELECT {ROOM_COLS} FROM rooms WHERE profile_id IS ?1 ORDER BY id DESC"))?;
    let rows = s.query_map([owner], row_room)?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

pub fn get_room(c: &Connection, id: i64, owner: &Owner) -> R<Option<Room>> {
    c.query_row(&format!("SELECT {ROOM_COLS} FROM rooms WHERE id=?1 AND profile_id IS ?2"), params![id, owner], row_room).optional()
}

pub fn create_room(c: &Connection, r: &Room, owner: &Owner) -> R<Room> {
    c.execute(
        "INSERT INTO rooms(profile_id,name,kind,description,owner_kind,character_id,backdrop,created_at,music,music_name) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
        params![owner, r.name, r.kind, r.description, r.owner_kind, r.character_id, r.backdrop, now(), r.music, r.music_name],
    )?;
    Ok(get_room(c, c.last_insert_rowid(), owner)?.expect("just inserted"))
}

pub fn update_room(c: &Connection, r: &Room, owner: &Owner) -> R<()> {
    c.execute(
        "UPDATE rooms SET name=?2,kind=?3,description=?4,owner_kind=?5,character_id=?6,backdrop=?7,music=?9,music_name=?10 WHERE id=?1 AND profile_id IS ?8",
        params![r.id, r.name, r.kind, r.description, r.owner_kind, r.character_id, r.backdrop, owner, r.music, r.music_name],
    )?;
    Ok(())
}

pub fn delete_room(c: &Connection, id: i64, owner: &Owner) -> R<()> {
    c.execute("UPDATE dorms SET room_id=NULL WHERE room_id=?1 AND profile_id IS ?2", params![id, owner])?;
    c.execute("DELETE FROM rooms WHERE id=?1 AND profile_id IS ?2", params![id, owner])?;
    Ok(())
}

// ----- lorebooks -----

pub fn list_lorebooks(c: &Connection, owner: &Owner) -> R<Vec<Lorebook>> {
    let mut s = c.prepare("SELECT id,name,json,created_at,updated_at FROM lorebooks WHERE profile_id IS ?1 ORDER BY name COLLATE NOCASE")?;
    let rows = s.query_map([owner], |r| {
        let j: String = r.get(2)?;
        Ok(Lorebook { id: r.get(0)?, name: r.get(1)?, book: serde_json::from_str(&j).unwrap_or(serde_json::Value::Null), created_at: r.get(3)?, updated_at: r.get(4)? })
    })?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

pub fn save_lorebook(c: &Connection, b: &Lorebook, owner: &Owner) -> R<()> {
    c.execute(
        "INSERT INTO lorebooks(id,profile_id,name,json,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, json=excluded.json, updated_at=excluded.updated_at WHERE profile_id IS ?2",
        params![b.id, owner, b.name, serde_json::to_string(&b.book).unwrap_or_else(|_| "{}".into()), b.created_at, b.updated_at],
    )?;
    Ok(())
}

/// Delete a lorebook and take it off every character it was attached to.
pub fn delete_lorebook(c: &Connection, id: &str, owner: &Owner) -> R<()> {
    for mut ch in list_characters(c, owner)? {
        if ch.lorebooks.iter().any(|l| l == id) {
            ch.lorebooks.retain(|l| l != id);
            save_character(c, &ch, owner)?;
        }
    }
    c.execute("DELETE FROM lorebooks WHERE id=?1 AND profile_id IS ?2", params![id, owner])?;
    Ok(())
}

// ----- folders -----

fn row_folder(r: &rusqlite::Row) -> R<Folder> {
    let fr: Option<String> = r.get(3)?;
    Ok(Folder { id: r.get(0)?, name: r.get(1)?, cover: r.get(2)?, frame: fr.and_then(|j| serde_json::from_str(&j).ok()), created_at: r.get(4)? })
}

pub fn list_folders(c: &Connection, owner: &Owner) -> R<Vec<Folder>> {
    let mut s = c.prepare("SELECT id,name,cover,frame,created_at FROM folders WHERE profile_id IS ?1 ORDER BY name COLLATE NOCASE")?;
    let rows = s.query_map([owner], row_folder)?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

pub fn get_folder(c: &Connection, id: &str, owner: &Owner) -> R<Option<Folder>> {
    c.query_row("SELECT id,name,cover,frame,created_at FROM folders WHERE id=?1 AND profile_id IS ?2", params![id, owner], row_folder).optional()
}

pub fn save_folder(c: &Connection, f: &Folder, owner: &Owner) -> R<()> {
    let fr = f.frame.and_then(|x| serde_json::to_string(&x).ok());
    c.execute(
        "INSERT INTO folders(id,profile_id,name,cover,frame,created_at) VALUES(?1,?2,?3,?4,?5,?6)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, cover=excluded.cover, frame=excluded.frame WHERE profile_id IS ?2",
        params![f.id, owner, f.name, f.cover, fr, f.created_at],
    )?;
    Ok(())
}

/// Delete a folder; its characters go back to the top level (never deleted with it).
pub fn delete_folder(c: &Connection, id: &str, owner: &Owner) -> R<()> {
    if get_folder(c, id, owner)?.is_none() {
        return Ok(());
    }
    for mut ch in list_characters(c, owner)? {
        if ch.folder.as_deref() == Some(id) {
            ch.folder = None;
            save_character(c, &ch, owner)?;
        }
    }
    c.execute("DELETE FROM folders WHERE id=?1 AND profile_id IS ?2", params![id, owner])?;
    Ok(())
}

// ----- notes -----

pub fn list_notes(c: &Connection, owner: &Owner) -> R<Vec<Note>> {
    let mut s = c.prepare("SELECT id,title,body,pinned,created_at,updated_at FROM notes WHERE profile_id IS ?1 ORDER BY pinned DESC, updated_at DESC")?;
    let rows = s.query_map([owner], |r| Ok(Note { id: r.get(0)?, title: r.get(1)?, body: r.get(2)?, pinned: r.get::<_, i64>(3)? != 0, created_at: r.get(4)?, updated_at: r.get(5)? }))?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

/// Insert or update (only ever a note of this owner).
pub fn save_note(c: &Connection, n: &Note, owner: &Owner) -> R<()> {
    c.execute(
        "INSERT INTO notes(id,profile_id,title,body,pinned,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7)
         ON CONFLICT(id) DO UPDATE SET title=excluded.title, body=excluded.body, pinned=excluded.pinned, updated_at=excluded.updated_at WHERE profile_id IS ?2",
        params![n.id, owner, n.title, n.body, n.pinned as i64, n.created_at, n.updated_at],
    )?;
    Ok(())
}

pub fn delete_note(c: &Connection, id: &str, owner: &Owner) -> R<()> {
    c.execute("DELETE FROM notes WHERE id=?1 AND profile_id IS ?2", params![id, owner])?;
    Ok(())
}

// ----- mechanic packs -----

pub fn list_mechanics(c: &Connection, owner: &Owner) -> R<Vec<MechanicRow>> {
    let mut s = c.prepare("SELECT id,name,description,json,created_at FROM mechanics WHERE profile_id IS ?1 ORDER BY created_at, name")?;
    let rows = s.query_map([owner], |r| Ok(MechanicRow { id: r.get(0)?, name: r.get(1)?, description: r.get(2)?, json: r.get(3)?, created_at: r.get(4)? }))?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

pub fn get_mechanic(c: &Connection, id: &str, owner: &Owner) -> R<Option<MechanicRow>> {
    c.query_row("SELECT id,name,description,json,created_at FROM mechanics WHERE id=?1 AND profile_id IS ?2", params![id, owner], |r| {
        Ok(MechanicRow { id: r.get(0)?, name: r.get(1)?, description: r.get(2)?, json: r.get(3)?, created_at: r.get(4)? })
    })
    .optional()
}

pub fn save_mechanic(c: &Connection, m: &MechanicRow, owner: &Owner) -> R<()> {
    c.execute(
        "INSERT INTO mechanics(id,profile_id,name,description,json,created_at) VALUES(?1,?2,?3,?4,?5,?6)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, description=excluded.description, json=excluded.json WHERE profile_id IS ?2",
        params![m.id, owner, m.name, m.description, m.json, m.created_at],
    )?;
    Ok(())
}

pub fn delete_mechanic(c: &Connection, id: &str, owner: &Owner) -> R<()> {
    if get_mechanic(c, id, owner)?.is_some() {
        c.execute("DELETE FROM chat_mechanics WHERE mech_id=?1 AND chat_id IN (SELECT id FROM chats WHERE profile_id IS ?2)", params![id, owner])?;
        c.execute("DELETE FROM mechanics WHERE id=?1 AND profile_id IS ?2", params![id, owner])?;
    }
    Ok(())
}

pub fn list_chat_mechanics(c: &Connection, chat_id: i64) -> R<Vec<ChatMechanic>> {
    let mut s = c.prepare("SELECT mech_id,enabled,state FROM chat_mechanics WHERE chat_id=?1 ORDER BY rowid")?;
    let rows = s.query_map([chat_id], |r| {
        let st: String = r.get(2)?;
        Ok(ChatMechanic { mech_id: r.get(0)?, enabled: r.get::<_, i64>(1)? != 0, state: serde_json::from_str(&st).unwrap_or_default() })
    })?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

pub fn save_chat_mechanic(c: &Connection, chat_id: i64, m: &ChatMechanic) -> R<()> {
    c.execute(
        "INSERT INTO chat_mechanics(chat_id,mech_id,enabled,state) VALUES(?1,?2,?3,?4)
         ON CONFLICT(chat_id,mech_id) DO UPDATE SET enabled=excluded.enabled, state=excluded.state",
        params![chat_id, m.mech_id, m.enabled as i64, serde_json::to_string(&m.state).unwrap_or_else(|_| "{}".into())],
    )?;
    Ok(())
}


pub fn rename_dorm(c: &Connection, id: i64, name: &str, owner: &Owner) -> R<()> {
    c.execute("UPDATE dorms SET name=?2 WHERE id=?1 AND profile_id IS ?3", params![id, name, owner])?;
    Ok(())
}

pub fn delete_dorm(c: &Connection, id: i64, owner: &Owner) -> R<()> {
    c.execute("DELETE FROM dorms WHERE id=?1 AND profile_id IS ?2", params![id, owner])?;
    Ok(())
}

// ----- chats -----

fn row_chat(r: &rusqlite::Row) -> R<Chat> {
    let ids: String = r.get(4)?;
    Ok(Chat {
        id: r.get(0)?,
        dorm_id: r.get(1)?,
        name: r.get(2)?,
        kind: r.get(3)?,
        character_ids: serde_json::from_str(&ids).unwrap_or_default(),
        auto_chat: r.get::<_, i64>(5)? != 0,
        auto_interval_s: r.get(6)?,
        turn_mode: r.get(7)?,
        max_auto_turns: r.get(8)?,
        created_at: r.get(9)?,
        updated_at: r.get(10)?,
        style: r.get(11)?,
    })
}

const CHAT_COLS: &str = "id,dorm_id,name,kind,character_ids,auto_chat,auto_interval_s,turn_mode,max_auto_turns,created_at,updated_at,style";

pub fn list_chats(c: &Connection, owner: &Owner) -> R<Vec<Chat>> {
    let sql = format!("SELECT {CHAT_COLS} FROM chats WHERE profile_id IS ?1 ORDER BY updated_at DESC");
    let mut s = c.prepare(&sql)?;
    let rows = s.query_map([owner], row_chat)?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

pub fn get_chat(c: &Connection, id: i64, owner: &Owner) -> R<Option<Chat>> {
    let sql = format!("SELECT {CHAT_COLS} FROM chats WHERE id=?1 AND profile_id IS ?2");
    c.query_row(&sql, params![id, owner], row_chat).optional()
}

pub fn create_chat(c: &Connection, dorm_id: Option<i64>, name: &str, kind: &str, ids: &[String], owner: &Owner) -> R<Chat> {
    let t = now();
    // a chat may only live in a dorm of the same profile
    let dorm_id = match dorm_id {
        Some(d) if c.query_row("SELECT 1 FROM dorms WHERE id=?1 AND profile_id IS ?2", params![d, owner], |_| Ok(())).optional()?.is_some() => Some(d),
        _ => None,
    };
    c.execute(
        "INSERT INTO chats(dorm_id,name,kind,character_ids,created_at,updated_at,profile_id) VALUES(?1,?2,?3,?4,?5,?5,?6)",
        params![dorm_id, name, kind, serde_json::to_string(ids).unwrap_or_default(), t, owner],
    )?;
    Ok(get_chat(c, c.last_insert_rowid(), owner)?.expect("just inserted"))
}

pub fn update_chat(c: &Connection, ch: &Chat, owner: &Owner) -> R<()> {
    c.execute(
        "UPDATE chats SET dorm_id=?2,name=?3,kind=?4,character_ids=?5,auto_chat=?6,auto_interval_s=?7,
         turn_mode=?8,max_auto_turns=?9,updated_at=?10,style=?12 WHERE id=?1 AND profile_id IS ?11",
        params![
            ch.id, ch.dorm_id, ch.name, ch.kind,
            serde_json::to_string(&ch.character_ids).unwrap_or_default(),
            ch.auto_chat as i64, ch.auto_interval_s.max(5), ch.turn_mode, ch.max_auto_turns.max(1), now(), owner,
            if ch.style == "phone" { "phone" } else { "chat" }
        ],
    )?;
    Ok(())
}

pub fn set_auto_chat(c: &Connection, id: i64, on: bool) -> R<()> {
    c.execute("UPDATE chats SET auto_chat=?2 WHERE id=?1", params![id, on as i64])?;
    Ok(())
}

pub fn touch_chat(c: &Connection, id: i64) -> R<()> {
    c.execute("UPDATE chats SET updated_at=?2 WHERE id=?1", params![id, now()])?;
    Ok(())
}

pub fn delete_chat(c: &Connection, id: i64, owner: &Owner) -> R<()> {
    c.execute("DELETE FROM chats WHERE id=?1 AND profile_id IS ?2", params![id, owner])?;
    Ok(())
}

/// Does this message belong to a chat of this profile?
pub fn message_owned(c: &Connection, msg_id: i64, owner: &Owner) -> R<bool> {
    Ok(c.query_row(
        "SELECT 1 FROM messages m JOIN chats ch ON ch.id=m.chat_id WHERE m.id=?1 AND ch.profile_id IS ?2",
        params![msg_id, owner],
        |_| Ok(()),
    )
    .optional()?
    .is_some())
}

// ----- messages -----

fn row_msg(r: &rusqlite::Row) -> R<Message> {
    let swipes: String = r.get(4)?;
    Ok(Message {
        id: r.get(0)?,
        chat_id: r.get(1)?,
        role: r.get(2)?,
        character_id: r.get(3)?,
        swipes: serde_json::from_str(&swipes).unwrap_or_default(),
        swipe_index: r.get(5)?,
        created_at: r.get(6)?,
    })
}

pub fn list_messages(c: &Connection, chat_id: i64) -> R<Vec<Message>> {
    let mut s = c.prepare(
        "SELECT id,chat_id,role,character_id,swipes,swipe_index,created_at FROM messages WHERE chat_id=?1 ORDER BY id",
    )?;
    let rows = s.query_map([chat_id], row_msg)?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

pub fn get_message(c: &Connection, id: i64) -> R<Option<Message>> {
    c.query_row(
        "SELECT id,chat_id,role,character_id,swipes,swipe_index,created_at FROM messages WHERE id=?1",
        [id],
        row_msg,
    )
    .optional()
}

pub fn add_message(c: &Connection, chat_id: i64, role: &str, character_id: Option<&str>, swipes: &[String]) -> R<Message> {
    c.execute(
        "INSERT INTO messages(chat_id,role,character_id,swipes,swipe_index,created_at) VALUES(?1,?2,?3,?4,0,?5)",
        params![chat_id, role, character_id, serde_json::to_string(swipes).unwrap_or_default(), now()],
    )?;
    touch_chat(c, chat_id)?;
    Ok(get_message(c, c.last_insert_rowid())?.expect("just inserted"))
}

pub fn save_message_swipes(c: &Connection, id: i64, swipes: &[String], index: i64) -> R<()> {
    c.execute(
        "UPDATE messages SET swipes=?2,swipe_index=?3 WHERE id=?1",
        params![id, serde_json::to_string(swipes).unwrap_or_default(), index],
    )?;
    Ok(())
}

pub fn delete_message(c: &Connection, id: i64) -> R<()> {
    c.execute("DELETE FROM messages WHERE id=?1", [id])?;
    Ok(())
}

pub fn clear_messages(c: &Connection, chat_id: i64) -> R<()> {
    c.execute("DELETE FROM messages WHERE chat_id=?1", [chat_id])?;
    Ok(())
}

// ----- settings (one set per profile) -----

fn settings_key(owner: &Owner) -> String {
    match owner {
        None => "settings".into(), // the original key: guest space (and pre-profile installs)
        Some(id) => format!("settings:{id}"),
    }
}

pub fn get_settings(c: &Connection, owner: &Owner) -> Settings {
    c.query_row("SELECT value FROM settings WHERE key=?1", [settings_key(owner)], |r| r.get::<_, String>(0))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save_settings(c: &Connection, s: &Settings, owner: &Owner) -> R<()> {
    c.execute(
        "INSERT INTO settings(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=?2",
        params![settings_key(owner), serde_json::to_string(s).unwrap_or_default()],
    )?;
    Ok(())
}

// ----- device preferences (not tied to any profile) -----

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(default)]
pub struct DevicePrefs {
    /// Profile id last used, or "guest".
    pub last: Option<String>,
    /// Always show the profile picker at launch instead of reopening the last profile.
    pub ask_on_launch: bool,
}

pub fn get_device(c: &Connection) -> DevicePrefs {
    c.query_row("SELECT value FROM settings WHERE key='device'", [], |r| r.get::<_, String>(0))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save_device(c: &Connection, d: &DevicePrefs) -> R<()> {
    c.execute(
        "INSERT INTO settings(key,value) VALUES('device',?1) ON CONFLICT(key) DO UPDATE SET value=?1",
        [serde_json::to_string(d).unwrap_or_default()],
    )?;
    Ok(())
}

// ----- profiles -----

#[derive(Clone)]
pub struct Profile {
    pub id: String,
    pub handle: String,
    pub display_name: String,
    pub passcode_hash: Option<String>,
    pub created_at: i64,
    pub last_login: i64,
}

fn row_profile(r: &rusqlite::Row) -> R<Profile> {
    Ok(Profile {
        id: r.get(0)?,
        handle: r.get(1)?,
        display_name: r.get(2)?,
        passcode_hash: r.get(3)?,
        created_at: r.get(4)?,
        last_login: r.get(5)?,
    })
}

const PROFILE_COLS: &str = "id,handle,display_name,passcode_hash,created_at,last_login";

pub fn list_profiles(c: &Connection) -> R<Vec<Profile>> {
    let mut s = c.prepare(&format!("SELECT {PROFILE_COLS} FROM profiles ORDER BY last_login DESC, handle COLLATE NOCASE"))?;
    let rows = s.query_map([], row_profile)?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

pub fn get_profile(c: &Connection, id: &str) -> R<Option<Profile>> {
    c.query_row(&format!("SELECT {PROFILE_COLS} FROM profiles WHERE id=?1"), [id], row_profile).optional()
}

pub fn handle_taken(c: &Connection, handle: &str) -> R<bool> {
    Ok(c.query_row("SELECT 1 FROM profiles WHERE handle=?1", [handle], |_| Ok(())).optional()?.is_some())
}

pub fn insert_profile(c: &Connection, p: &Profile) -> R<()> {
    c.execute(
        "INSERT INTO profiles(id,handle,display_name,passcode_hash,created_at,last_login) VALUES(?1,?2,?3,?4,?5,?6)",
        params![p.id, p.handle, p.display_name, p.passcode_hash, p.created_at, p.last_login],
    )?;
    Ok(())
}

pub fn set_profile_name(c: &Connection, id: &str, display_name: &str) -> R<()> {
    c.execute("UPDATE profiles SET display_name=?2 WHERE id=?1", params![id, display_name])?;
    Ok(())
}

pub fn set_passcode_hash(c: &Connection, id: &str, hash: Option<&str>) -> R<()> {
    c.execute("UPDATE profiles SET passcode_hash=?2 WHERE id=?1", params![id, hash])?;
    Ok(())
}

pub fn touch_login(c: &Connection, id: &str) -> R<()> {
    c.execute("UPDATE profiles SET last_login=?2 WHERE id=?1", params![id, now()])?;
    Ok(())
}

/// Remove everything a profile owns (chats take their messages with them) and, for a named profile, the
/// profile itself. For the guest space this just empties it.
pub fn wipe_owner(c: &Connection, owner: &Owner) -> R<()> {
    c.execute("DELETE FROM rooms WHERE profile_id IS ?1", [owner])?;
    c.execute("DELETE FROM mechanics WHERE profile_id IS ?1", [owner])?;
    c.execute("DELETE FROM notes WHERE profile_id IS ?1", [owner])?;
    c.execute("DELETE FROM folders WHERE profile_id IS ?1", [owner])?;
    c.execute("DELETE FROM lorebooks WHERE profile_id IS ?1", [owner])?;
    c.execute("DELETE FROM chats WHERE profile_id IS ?1", [owner])?;
    c.execute("DELETE FROM dorms WHERE profile_id IS ?1", [owner])?;
    c.execute("DELETE FROM characters WHERE profile_id IS ?1", [owner])?;
    c.execute("DELETE FROM settings WHERE key=?1", [settings_key(owner)])?;
    if let Some(id) = owner {
        c.execute("DELETE FROM profiles WHERE id=?1", [id])?;
    }
    Ok(())
}

/// Turn the guest space into a named profile: its data moves over and the guest space starts fresh.
pub fn claim_guest(c: &Connection, new_id: &str) -> R<()> {
    for t in ["characters", "dorms", "chats", "rooms", "mechanics", "notes", "folders", "lorebooks"] {
        c.execute(&format!("UPDATE {t} SET profile_id=?1 WHERE profile_id IS NULL"), [new_id])?;
    }
    let guest = settings_key(&None);
    c.execute("UPDATE settings SET key=?1 WHERE key=?2", params![settings_key(&Some(new_id.into())), guest])?;
    Ok(())
}

pub fn count_rows(c: &Connection, table: &str, owner: &Owner) -> i64 {
    c.query_row(&format!("SELECT COUNT(*) FROM {table} WHERE profile_id IS ?1"), [owner], |r| r.get(0)).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use dorms_core::CharacterData;

    fn fresh() -> Connection {
        open(std::path::Path::new(":memory:")).unwrap()
    }
    fn me(id: &str) -> Owner {
        Some(id.to_string())
    }
    fn ch(id: &str, name: &str) -> Character {
        Character {
            id: id.into(),
            card: CharacterData { name: name.into(), ..Default::default() },
            media: None,
            outfits: vec![],
            outfit: None,
            frame: None,
            folder: None,
            lorebooks: vec![],
            favorite: false,
            created_at: 1,
            updated_at: 1,
            last_used: 0,
            trusted: true,
        }
    }

    #[test]
    fn rooms_and_packs_belong_to_their_owner_and_dorms_can_only_use_their_own_rooms() {
        let c = fresh();
        let (a, b) = (me("a"), me("b"));
        let room = |n: &str| Room { id: 0, name: n.into(), kind: "kitchen".into(), description: "d".into(), owner_kind: "self".into(), character_id: None, backdrop: "".into(), created_at: 0, music: String::new(), music_name: String::new() };
        let ra = create_room(&c, &room("A's kitchen"), &a).unwrap();
        let rb = create_room(&c, &room("B's kitchen"), &b).unwrap();
        assert_eq!(list_rooms(&c, &a).unwrap().len(), 1);
        assert!(get_room(&c, rb.id, &a).unwrap().is_none(), "A can't read B's room by id");
        let d = create_dorm(&c, "d", Some(rb.id), &a).unwrap();
        assert_eq!(d.room_id, None, "a dorm can't be set in someone else's room");
        let d = create_dorm(&c, "d2", Some(ra.id), &a).unwrap();
        assert_eq!(d.room_id, Some(ra.id));
        assert_eq!(list_dorms(&c, &a).unwrap()[1].room_id, Some(ra.id));
        delete_room(&c, ra.id, &b).unwrap();
        assert!(get_room(&c, ra.id, &a).unwrap().is_some(), "B can't delete A's room");
        delete_room(&c, ra.id, &a).unwrap();
        assert_eq!(list_dorms(&c, &a).unwrap()[1].room_id, None, "deleting a room frees its dorms");

        let m = MechanicRow { id: "m1".into(), name: "Aff".into(), description: "".into(), json: "{}".into(), created_at: 1 };
        save_mechanic(&c, &m, &a).unwrap();
        assert!(list_mechanics(&c, &b).unwrap().is_empty());
        assert!(get_mechanic(&c, "m1", &b).unwrap().is_none());
        let chat = create_chat(&c, None, "c", "dm", &[], &a).unwrap();
        save_chat_mechanic(&c, chat.id, &ChatMechanic { mech_id: "m1".into(), enabled: true, state: serde_json::Map::new() }).unwrap();
        delete_mechanic(&c, "m1", &b).unwrap();
        assert_eq!(list_chat_mechanics(&c, chat.id).unwrap().len(), 1, "B can't remove A's pack");
        delete_mechanic(&c, "m1", &a).unwrap();
        assert!(list_chat_mechanics(&c, chat.id).unwrap().is_empty());
        // a chat's texting style survives an update and rejects nonsense
        let mut ch = get_chat(&c, chat.id, &a).unwrap().unwrap();
        ch.style = "phone".into();
        update_chat(&c, &ch, &a).unwrap();
        assert_eq!(get_chat(&c, chat.id, &a).unwrap().unwrap().style, "phone");
        ch.style = "weird".into();
        update_chat(&c, &ch, &a).unwrap();
        assert_eq!(get_chat(&c, chat.id, &a).unwrap().unwrap().style, "chat");
    }

    #[test]
    fn folders_lorebooks_and_notes_are_private_and_cleaned_up() {
        let c = fresh();
        let (a, b) = (me("a"), me("b"));
        let f = Folder { id: "f1".into(), name: "Crew".into(), cover: None, frame: None, created_at: 1 };
        save_folder(&c, &f, &a).unwrap();
        assert!(list_folders(&c, &b).unwrap().is_empty() && get_folder(&c, "f1", &b).unwrap().is_none());
        // B can't take over A's folder by saving with the same id
        save_folder(&c, &Folder { name: "Stolen".into(), ..f.clone() }, &b).unwrap();
        assert_eq!(get_folder(&c, "f1", &a).unwrap().unwrap().name, "Crew");
        let mut x = ch("x", "X"); x.folder = Some("f1".into()); x.lorebooks = vec!["l1".into()];
        save_character(&c, &x, &a).unwrap();
        let lb = Lorebook { id: "l1".into(), name: "Lore".into(), book: serde_json::json!({"entries": []}), created_at: 1, updated_at: 1 };
        save_lorebook(&c, &lb, &a).unwrap();
        assert!(list_lorebooks(&c, &b).unwrap().is_empty());
        delete_folder(&c, "f1", &b).unwrap();
        assert!(get_folder(&c, "f1", &a).unwrap().is_some(), "B can't delete A's folder");
        delete_folder(&c, "f1", &a).unwrap();
        assert_eq!(get_character(&c, "x", &a).unwrap().unwrap().folder, None, "a deleted folder releases its characters");
        delete_lorebook(&c, "l1", &a).unwrap();
        assert!(get_character(&c, "x", &a).unwrap().unwrap().lorebooks.is_empty(), "a deleted lorebook detaches from characters");
        let n = Note { id: "n1".into(), title: "t".into(), body: "b".repeat(1_000_000), pinned: false, created_at: 1, updated_at: 1 };
        save_note(&c, &n, &a).unwrap();
        save_note(&c, &Note { body: "hijack".into(), ..n.clone() }, &b).unwrap();
        assert_eq!(list_notes(&c, &a).unwrap()[0].body.len(), 1_000_000, "a megabyte note round-trips; B can't overwrite it");
        assert!(list_notes(&c, &b).unwrap().is_empty());
        delete_note(&c, "n1", &b).unwrap();
        assert_eq!(list_notes(&c, &a).unwrap().len(), 1);
        wipe_owner(&c, &a).unwrap();
        assert!(list_notes(&c, &a).unwrap().is_empty() && list_folders(&c, &a).unwrap().is_empty() && list_lorebooks(&c, &a).unwrap().is_empty());
    }

    #[test]
    fn framing_is_kept_in_bounds_and_default_means_none() {
        assert_eq!(Frame { x: 0.5, y: 0.5, zoom: 1.0 }.clean(), None);
        assert_eq!(Frame { x: 7.0, y: -2.0, zoom: 99.0 }.clean(), Some(Frame { x: 1.0, y: 0.0, zoom: 5.0 }));
        assert_eq!(Frame { x: f64::NAN, y: 0.2, zoom: f64::INFINITY }.clean(), Some(Frame { x: 0.5, y: 0.2, zoom: 1.0 }));
        assert_eq!(Frame { x: 0.5, y: 0.5, zoom: 0.2 }.clean(), None, "zooming out is not possible");
    }

    #[test]
    fn every_kind_of_row_is_invisible_to_other_owners() {
        let c = fresh();
        let (a, b, guest) = (me("a"), me("b"), None);
        for o in [&a, &b, &guest] {
            save_character(&c, &ch(&format!("char-{}", o.clone().unwrap_or_else(|| "g".into())), "X"), o).unwrap();
            let d = create_dorm(&c, "dorm", None, o).unwrap();
            let chat = create_chat(&c, Some(d.id), "chat", "dm", &[], o).unwrap();
            add_message(&c, chat.id, "user", None, &["hi".into()]).unwrap();
        }
        for (o, mine) in [(&a, "char-a"), (&b, "char-b"), (&guest, "char-g")] {
            let chars = list_characters(&c, o).unwrap();
            assert_eq!(chars.len(), 1);
            assert_eq!(chars[0].id, mine);
            assert_eq!(list_dorms(&c, o).unwrap().len(), 1);
            assert_eq!(list_chats(&c, o).unwrap().len(), 1);
        }
        let b_chat = list_chats(&c, &b).unwrap()[0].clone();
        assert!(get_chat(&c, b_chat.id, &a).unwrap().is_none(), "A can't fetch B's chat by id");
        assert!(get_character(&c, "char-b", &a).unwrap().is_none());
        let b_msg = list_messages(&c, b_chat.id).unwrap()[0].id;
        assert!(!message_owned(&c, b_msg, &a).unwrap() && message_owned(&c, b_msg, &b).unwrap());
        // writes aimed at someone else's rows do nothing
        delete_character(&c, "char-b", &a).unwrap();
        delete_chat(&c, b_chat.id, &a).unwrap();
        rename_dorm(&c, list_dorms(&c, &b).unwrap()[0].id, "pwned", &a).unwrap();
        let mut hijack = b_chat.clone();
        hijack.name = "pwned".into();
        update_chat(&c, &hijack, &a).unwrap();
        save_character(&c, &ch("char-b", "pwned"), &a).unwrap();
        assert_eq!(list_characters(&c, &b).unwrap()[0].card.name, "X");
        assert_eq!(get_chat(&c, b_chat.id, &b).unwrap().unwrap().name, "chat");
        assert_eq!(list_dorms(&c, &b).unwrap()[0].name, "dorm");
    }

    #[test]
    fn a_chat_can_only_live_in_a_dorm_of_its_own_profile() {
        let c = fresh();
        let d = create_dorm(&c, "A's dorm", None, &me("a")).unwrap();
        let chat = create_chat(&c, Some(d.id), "x", "dm", &[], &me("b")).unwrap();
        assert_eq!(chat.dorm_id, None);
    }

    #[test]
    fn settings_and_keys_are_per_profile() {
        let c = fresh();
        let mut s = Settings::default();
        s.user_name = "Alex".into();
        save_settings(&c, &s, &me("a")).unwrap();
        assert_eq!(get_settings(&c, &me("a")).user_name, "Alex");
        assert_eq!(get_settings(&c, &me("b")).user_name, "You", "another profile gets defaults");
        assert_eq!(get_settings(&c, &None).user_name, "You");
    }

    #[test]
    fn wiping_a_profile_removes_only_its_rows() {
        let c = fresh();
        for id in ["a", "b"] {
            insert_profile(&c, &Profile { id: id.into(), handle: id.into(), display_name: id.into(), passcode_hash: None, created_at: 0, last_login: 0 }).unwrap();
            let o = me(id);
            save_character(&c, &ch(&format!("c-{id}"), "X"), &o).unwrap();
            let chat = create_chat(&c, None, "chat", "dm", &[], &o).unwrap();
            add_message(&c, chat.id, "user", None, &["m".into()]).unwrap();
            save_settings(&c, &Settings::default(), &o).unwrap();
        }
        wipe_owner(&c, &me("a")).unwrap();
        assert!(list_characters(&c, &me("a")).unwrap().is_empty() && list_chats(&c, &me("a")).unwrap().is_empty());
        assert!(get_profile(&c, "a").unwrap().is_none(), "the profile row goes too");
        let msgs: i64 = c.query_row("SELECT COUNT(*) FROM messages", [], |r| r.get(0)).unwrap();
        assert_eq!(msgs, 1, "its messages went with its chats, B's stayed");
        assert_eq!(list_characters(&c, &me("b")).unwrap().len(), 1);
        assert!(get_profile(&c, "b").unwrap().is_some());
    }

    #[test]
    fn claiming_the_guest_space_moves_everything_and_empties_it() {
        let c = fresh();
        save_character(&c, &ch("g1", "G"), &None).unwrap();
        create_chat(&c, None, "guest chat", "dm", &[], &None).unwrap();
        let mut gs = Settings::default();
        gs.user_name = "GuestName".into();
        save_settings(&c, &gs, &None).unwrap();
        insert_profile(&c, &Profile { id: "p".into(), handle: "p".into(), display_name: "P".into(), passcode_hash: None, created_at: 0, last_login: 0 }).unwrap();
        claim_guest(&c, "p").unwrap();
        assert_eq!(list_characters(&c, &me("p")).unwrap().len(), 1);
        assert_eq!(list_chats(&c, &me("p")).unwrap().len(), 1);
        assert_eq!(get_settings(&c, &me("p")).user_name, "GuestName");
        assert!(list_characters(&c, &None).unwrap().is_empty() && list_chats(&c, &None).unwrap().is_empty());
        assert_eq!(get_settings(&c, &None).user_name, "You");
    }

    #[test]
    fn profile_names_are_unique_ignoring_case() {
        let c = fresh();
        insert_profile(&c, &Profile { id: "1".into(), handle: "Alex".into(), display_name: "A".into(), passcode_hash: None, created_at: 0, last_login: 0 }).unwrap();
        assert!(handle_taken(&c, "alex").unwrap() && handle_taken(&c, "ALEX").unwrap() && !handle_taken(&c, "Alexa").unwrap());
        assert!(insert_profile(&c, &Profile { id: "2".into(), handle: "aLeX".into(), display_name: "B".into(), passcode_hash: None, created_at: 0, last_login: 0 }).is_err());
    }

    /// The upgrade path: a database made by v0.1.0 (no profile_id columns, no profiles table) must open
    /// without losing a thing, and everything in it must land in the guest space.
    #[test]
    fn a_v0_1_0_database_upgrades_into_the_guest_space() {
        let dir = std::env::temp_dir().join(format!("dorms-migrate-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("old.db");
        {
            let old = Connection::open(&path).unwrap();
            old.execute_batch(
                "CREATE TABLE characters(id TEXT PRIMARY KEY, json TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', favorite INTEGER NOT NULL DEFAULT 0, last_used INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0);
                 CREATE TABLE dorms(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, created_at INTEGER NOT NULL);
                 CREATE TABLE chats(id INTEGER PRIMARY KEY AUTOINCREMENT, dorm_id INTEGER REFERENCES dorms(id) ON DELETE CASCADE, name TEXT NOT NULL, kind TEXT NOT NULL, character_ids TEXT NOT NULL DEFAULT '[]', auto_chat INTEGER NOT NULL DEFAULT 0, auto_interval_s INTEGER NOT NULL DEFAULT 20, turn_mode TEXT NOT NULL DEFAULT 'round_robin', max_auto_turns INTEGER NOT NULL DEFAULT 12, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
                 CREATE TABLE messages(id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE, role TEXT NOT NULL, character_id TEXT, swipes TEXT NOT NULL, swipe_index INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
                 CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
                 INSERT INTO characters(id,json,name) VALUES('old1', '{\"id\":\"old1\",\"card\":{\"name\":\"Old Friend\"},\"created_at\":1,\"updated_at\":1}', 'Old Friend');
                 INSERT INTO dorms(name,created_at) VALUES('Old dorm', 1);
                 INSERT INTO chats(dorm_id,name,kind,created_at,updated_at) VALUES(1,'Old chat','dm',1,1);
                 INSERT INTO messages(chat_id,role,swipes,created_at) VALUES(1,'user','[\"remember me\"]',1);
                 INSERT INTO settings(key,value) VALUES('settings','{\"user_name\":\"OldMe\",\"provider\":\"anthropic\"}');",
            )
            .unwrap();
        }
        let c = open(&path).unwrap();
        let chars = list_characters(&c, &None).unwrap();
        assert_eq!(chars.len(), 1);
        assert_eq!(chars[0].card.name, "Old Friend");
        assert!(chars[0].trusted, "cards from before the trust setting stay trusted");
        assert_eq!(list_dorms(&c, &None).unwrap().len(), 1);
        let chats = list_chats(&c, &None).unwrap();
        assert_eq!(chats.len(), 1);
        assert_eq!(list_messages(&c, chats[0].id).unwrap()[0].swipes[0], "remember me");
        let s = get_settings(&c, &None);
        assert_eq!((s.user_name.as_str(), s.provider.as_str()), ("OldMe", "anthropic"));
        assert!(list_profiles(&c).unwrap().is_empty());
        drop(c);
        let again = open(&path).unwrap(); // opening twice must not fail or duplicate anything
        assert_eq!(list_characters(&again, &None).unwrap().len(), 1);
        let _ = std::fs::remove_dir_all(dir);
    }
}
