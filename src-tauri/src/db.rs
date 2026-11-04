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

#[derive(Serialize, Deserialize, Clone)]
pub struct Character {
    #[serde(default)]
    pub id: String,
    pub card: CharacterData,
    #[serde(default)]
    pub media: Option<Media>,
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
         CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);",
    )?;
    Ok(conn)
}

// ----- characters -----

pub fn save_character(c: &Connection, ch: &Character) -> R<()> {
    let json = serde_json::to_string(ch).unwrap_or_default();
    c.execute(
        "INSERT INTO characters(id,json,name,favorite,last_used,updated_at) VALUES(?1,?2,?3,?4,?5,?6)
         ON CONFLICT(id) DO UPDATE SET json=?2,name=?3,favorite=?4,last_used=?5,updated_at=?6",
        params![ch.id, json, ch.card.name, ch.favorite as i64, ch.last_used, ch.updated_at],
    )?;
    Ok(())
}

fn parse_character(json: String) -> Option<Character> {
    serde_json::from_str(&json).ok()
}

pub fn get_character(c: &Connection, id: &str) -> R<Option<Character>> {
    Ok(c.query_row("SELECT json FROM characters WHERE id=?1", [id], |r| r.get::<_, String>(0))
        .optional()?
        .and_then(parse_character))
}

pub fn list_characters(c: &Connection) -> R<Vec<Character>> {
    let mut s = c.prepare("SELECT json FROM characters ORDER BY name COLLATE NOCASE")?;
    let rows = s.query_map([], |r| r.get::<_, String>(0))?;
    Ok(rows.filter_map(|r| r.ok()).filter_map(parse_character).collect())
}

pub fn delete_character(c: &Connection, id: &str) -> R<()> {
    c.execute("DELETE FROM characters WHERE id=?1", [id])?;
    Ok(())
}

// ----- dorms -----

pub fn list_dorms(c: &Connection) -> R<Vec<Dorm>> {
    let mut s = c.prepare("SELECT id,name,created_at FROM dorms ORDER BY id")?;
    let rows = s.query_map([], |r| Ok(Dorm { id: r.get(0)?, name: r.get(1)?, created_at: r.get(2)? }))?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

pub fn create_dorm(c: &Connection, name: &str) -> R<Dorm> {
    let t = now();
    c.execute("INSERT INTO dorms(name,created_at) VALUES(?1,?2)", params![name, t])?;
    Ok(Dorm { id: c.last_insert_rowid(), name: name.into(), created_at: t })
}

pub fn rename_dorm(c: &Connection, id: i64, name: &str) -> R<()> {
    c.execute("UPDATE dorms SET name=?2 WHERE id=?1", params![id, name])?;
    Ok(())
}

pub fn delete_dorm(c: &Connection, id: i64) -> R<()> {
    c.execute("DELETE FROM dorms WHERE id=?1", [id])?;
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
    })
}

const CHAT_COLS: &str = "id,dorm_id,name,kind,character_ids,auto_chat,auto_interval_s,turn_mode,max_auto_turns,created_at,updated_at";

pub fn list_chats(c: &Connection) -> R<Vec<Chat>> {
    let sql = format!("SELECT {CHAT_COLS} FROM chats ORDER BY updated_at DESC");
    let mut s = c.prepare(&sql)?;
    let rows = s.query_map([], row_chat)?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

pub fn get_chat(c: &Connection, id: i64) -> R<Option<Chat>> {
    let sql = format!("SELECT {CHAT_COLS} FROM chats WHERE id=?1");
    c.query_row(&sql, [id], row_chat).optional()
}

pub fn create_chat(c: &Connection, dorm_id: Option<i64>, name: &str, kind: &str, ids: &[String]) -> R<Chat> {
    let t = now();
    c.execute(
        "INSERT INTO chats(dorm_id,name,kind,character_ids,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?5)",
        params![dorm_id, name, kind, serde_json::to_string(ids).unwrap_or_default(), t],
    )?;
    Ok(get_chat(c, c.last_insert_rowid())?.expect("just inserted"))
}

pub fn update_chat(c: &Connection, ch: &Chat) -> R<()> {
    c.execute(
        "UPDATE chats SET dorm_id=?2,name=?3,kind=?4,character_ids=?5,auto_chat=?6,auto_interval_s=?7,
         turn_mode=?8,max_auto_turns=?9,updated_at=?10 WHERE id=?1",
        params![
            ch.id, ch.dorm_id, ch.name, ch.kind,
            serde_json::to_string(&ch.character_ids).unwrap_or_default(),
            ch.auto_chat as i64, ch.auto_interval_s.max(5), ch.turn_mode, ch.max_auto_turns.max(1), now()
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

pub fn delete_chat(c: &Connection, id: i64) -> R<()> {
    c.execute("DELETE FROM chats WHERE id=?1", [id])?;
    Ok(())
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

// ----- settings -----

pub fn get_settings(c: &Connection) -> Settings {
    c.query_row("SELECT value FROM settings WHERE key='settings'", [], |r| r.get::<_, String>(0))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save_settings(c: &Connection, s: &Settings) -> R<()> {
    c.execute(
        "INSERT INTO settings(key,value) VALUES('settings',?1) ON CONFLICT(key) DO UPDATE SET value=?1",
        [serde_json::to_string(s).unwrap_or_default()],
    )?;
    Ok(())
}
