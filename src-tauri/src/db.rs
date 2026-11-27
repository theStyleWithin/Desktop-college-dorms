//! SQLite storage. Characters are stored as JSON documents (so the card model
//! can evolve without migrations); chats and messages are relational.

use dorms_core::CharacterData;
use std::collections::HashMap;
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

/// One picture (or GIF or short video) in a character's gallery, with the moods it fits (for the mood-matching display).
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct GalleryItem {
    pub id: String,
    /// Path relative to the data dir.
    pub file: String,
    /// image | gif | video
    pub kind: String,
    /// Moods from `GALLERY_MOODS` this picture shows (empty: it fits no particular mood).
    #[serde(default)]
    pub moods: Vec<String>,
    /// For a file the person linked instead of copying (a big video, say): where it is on their computer (then `file` is empty). "" for a copy kept by the app.
    #[serde(default)]
    pub link: String,
}

/// The moods a gallery picture can be tagged with (and the mood detector can pick).
pub const GALLERY_MOODS: [&str; 12] = ["neutral", "happy", "laughing", "loving", "embarrassed", "smug", "surprised", "scared", "sad", "angry", "thinking", "sleepy"];

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
    /// More pictures of the character; what shows in a chat depends on `gallery_mode`.
    #[serde(default)]
    pub gallery: Vec<GalleryItem>,
    /// `fixed` (the main picture, always), `random` (a new picture from the gallery after each reply) or `mood` (the picture that
    /// fits the mood of the reply). Empty means fixed.
    #[serde(default)]
    pub gallery_mode: String,
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
    /// Where this card sits when the library is in "my order" (lower comes first); `None` = not placed yet, goes last.
    #[serde(default)]
    pub order: Option<i64>,
    /// Shared lorebooks (ids from `lorebooks`) attached to this character, besides the book inside the card.
    #[serde(default)]
    pub lorebooks: Vec<String>,
    /// The playbook this character comes with (an id from `playbooks`); a chat can override it. Empty = none.
    #[serde(default)]
    pub playbook: String,
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
    /// An imported 3D scene (a .glb, .gltf or .fbx inside the data folder) that replaces the built-in 3D room, and its original file name.
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub model_name: String,
    /// How the model is set in the room: size multiplier, turn (degrees), height shift (metres).
    #[serde(default = "one")]
    pub model_scale: f64,
    #[serde(default)]
    pub model_rot: f64,
    #[serde(default)]
    pub model_y: f64,
    /// The owner marked this model as allowed to be shared. Only then does it go into an exported profile.
    #[serde(default)]
    pub model_share: bool,
    /// The room this one is part of (the kitchen of "our house"). Rooms without one are top-level places.
    #[serde(default)]
    pub parent_id: Option<i64>,
    /// Pictures of the room: its look, as a gallery (up to `MAX_ROOM_PICS`).
    #[serde(default)]
    pub gallery: Vec<RoomPic>,
    /// The world this room is in (a folder of connected rooms); `None` = not in one.
    #[serde(default)]
    pub world_id: Option<i64>,
    /// How the room is dressed, if the user wants: the same nameplate, background and wreath a profile can wear, and a tag beside its name.
    #[serde(default)]
    pub deco: RoomDeco,
    /// Its exits: rooms it leads to by a one-way pathway (at most 3), besides its parent and sub-rooms.
    #[serde(default)]
    pub links: Vec<i64>,
}

fn one() -> f64 { 1.0 }

/// A world: a folder of connected rooms, kept apart from the other worlds. Lorebooks can be attached to it, and then apply to every
/// chat in any of its rooms. Rooms, "part of" links and exits never cross from one world into another.
#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct World {
    pub id: i64,
    pub name: String,
    /// What this world is like, told to the characters in every chat in it.
    #[serde(default)]
    pub description: String,
    /// The world's background lore, written to be read (the codex): its history, places and people. Shown on the world's overview page; not sent to the model
    /// (the description and the attached lorebooks are what shape the roleplay).
    #[serde(default)]
    pub lore: String,
    /// Ids of the lorebooks attached to it.
    #[serde(default)]
    pub lorebooks: Vec<String>,
    /// A persona (its id) that stands in for the person's own while a chat is in this world. "" for none.
    #[serde(default)]
    pub persona: String,
    /// A playbook (its id) the chats here use when neither the chat nor its characters choose one. "" for none.
    #[serde(default)]
    pub playbook: String,
    /// Standing instructions for every chat in this world, placed after the characters' own instructions (which win if they disagree).
    #[serde(default)]
    pub instructions: String,
    /// Saved prompts (their ids) that sit first in the Prompts menu while the person is in a chat in this world.
    #[serde(default)]
    pub prompts: Vec<String>,
    /// The world's cover picture (a path inside the data folder, `media/world-*`), or "" for none.
    #[serde(default)]
    pub cover: String,
    #[serde(default)]
    pub created_at: i64,
}

/// A picture in a room's gallery: part of how the place looks, with an optional caption (which the characters are told too).
#[derive(Serialize, Deserialize, Clone, PartialEq, Debug, Default)]
#[serde(default)]
pub struct RoomPic {
    pub id: String,
    /// Path inside the data folder (`media/roompic-*`).
    pub file: String,
    pub caption: String,
}

/// A room dressed like a server: optional decorations and a short tag (all empty by default).
#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(default)]
pub struct RoomDeco {
    pub plate: String,
    pub bg: String,
    pub wreath: String,
    pub tag: String,
    pub tag_color: String,
    pub tag_glyph: String,
}

impl Default for RoomDeco {
    fn default() -> Self {
        RoomDeco { plate: "none".into(), bg: String::new(), wreath: String::new(), tag: String::new(), tag_color: "#5865f2".into(), tag_glyph: String::new() }
    }
}

/// A decoration (a 3D prop such as furniture, a plant or food) in the profile's library, kept as a .glb inside the data folder.
#[derive(Serialize, Deserialize, Clone)]
pub struct DecorItem {
    pub id: String,
    pub name: String,
    /// Path inside the data folder (`media/decor-*.glb`).
    pub file: String,
    #[serde(default)]
    pub bytes: i64,
    /// The owner marked it as allowed to be shared: only then does it go into an exported profile.
    #[serde(default)]
    pub share: bool,
    #[serde(default)]
    pub created_at: i64,
}

/// Someone the player can be: a name, who they are, and how they like to roleplay. The active one is described to the AI
/// before the chat begins (it replaces the plain name and "about you" text).
#[derive(Serialize, Deserialize, Clone)]
pub struct Persona {
    pub id: String,
    pub name: String,
    /// Who this persona is (appearance, background, personality).
    pub description: String,
    /// How the player wants to roleplay and what the AI should remember.
    pub style: String,
    /// Picture (path inside the data folder) and its framing.
    pub avatar: Option<String>,
    pub frame: Option<Frame>,
    pub created_at: i64,
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
    /// The folder this one sits inside (None = the top level). Folders nest, a few levels deep at most.
    #[serde(default)]
    pub parent: Option<String>,
    /// A character (id) whose picture stands in for the folder's own picture, when it has none.
    #[serde(default)]
    pub cover_char: Option<String>,
}

/// How many folders may sit inside one another.
pub const MAX_FOLDER_DEPTH: usize = 12;

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

/// A saved prompt: a piece of text kept to drop into a roleplay as a message (a mid-chat instruction, a style reminder...).
#[derive(Serialize, Deserialize, Clone)]
pub struct SavedPrompt {
    pub id: String,
    pub title: String,
    pub body: String,
    /// A short label shown beside the title ("Advanced Prompt", "Style"...), or empty.
    #[serde(default)]
    pub tag: String,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,
}

/// How a character is dressed: a nameplate behind their row in the characters list, an animated profile background and an avatar wreath.
/// Chosen by the user or, when the user allows it, by the model to suit the character. (Ids come from `src/lib/decoData.json`.)
#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct CharDeco {
    /// The character's id.
    pub character_id: String,
    /// A nameplate id, or `none`.
    pub plate: String,
    /// A profile background id, or empty.
    pub bg: String,
    /// An avatar wreath id, or empty.
    pub wreath: String,
    /// `ai` or `user`.
    pub source: String,
    pub updated_at: i64,
}

/// The user's own profile decorations (nameplate, background, wreath), their name tag and banner, and whether the model may dress the characters.
#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(default)]
pub struct UserDeco {
    pub plate: String,
    pub bg: String,
    pub wreath: String,
    /// Things move a little (also switched off by the device's reduced-motion setting).
    pub animate: bool,
    /// A 2 to 4 letter tag shown beside the name, its colour (one of the listed ones) and a symbol.
    pub tag: String,
    pub tag_color: String,
    pub tag_glyph: String,
    /// A built-in banner id for the profile card, or empty.
    pub banner: String,
    /// Let the model choose decorations for characters that have none, to suit who they are.
    pub ai_pick: bool,
}

impl Default for UserDeco {
    fn default() -> Self {
        UserDeco { plate: "none".into(), bg: String::new(), wreath: String::new(), animate: true, tag: String::new(), tag_color: "#5865f2".into(), tag_glyph: String::new(), banner: String::new(), ai_pick: false }
    }
}

/// A custom emoji (a small picture used inline as `:name:`) or sticker (a bigger picture sent as a whole message as `[sticker: name]`).
/// It works everywhere, or only in one room (`room_id`), like a server's own emoji.
#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct EmojiItem {
    pub id: String,
    /// `emoji` or `sticker`.
    pub kind: String,
    pub name: String,
    /// What it means or when to use it: told to the characters so they can use it too.
    #[serde(default)]
    pub meaning: String,
    /// Path inside the data folder (`media/emoji-*`).
    pub file: String,
    /// The room it belongs to, or `None` for everywhere.
    #[serde(default)]
    pub room_id: Option<i64>,
    #[serde(default)]
    pub created_at: i64,
}

/// What is on a character's mind (a short line shown in the characters list), written by the model in their voice or by the user.
#[derive(Serialize, Deserialize, Clone)]
pub struct CharStatus {
    /// The character's id.
    pub character_id: String,
    pub text: String,
    /// `ai` or `user`.
    pub source: String,
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
    /// The room the story has moved into (a pathway taken). Without one, the chat is in its dorm's room.
    #[serde(default)]
    pub room_id: Option<i64>,
    /// True when the person chose, for this chat only, to play as their own persona even though its world brings one.
    #[serde(default)]
    pub world_persona_off: bool,
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
    /// The persona being played (an id from `personas`); empty means the plain name and description above.
    pub active_persona: String,
    /// The order the person put the Gallery's folders in: `char:<id>` and `disk:<id>` keys (what is not listed follows in the usual order).
    pub gallery_order: Vec<String>,
    /// True to show characters' folders and folders from the computer together in one place; false (the default) keeps them in separate sections.
    pub gallery_merge: bool,
    /// The user's own profile decorations.
    pub deco: UserDeco,
    /// Novel writing: how many requests a day the model's plan allows (0 = no limit set), and how many of them are kept for chatting.
    pub novel_daily_limit: usize,
    pub novel_reserve: usize,
    /// Desktop only: keep the app running in the system tray when the window is minimized, and/or when it is closed.
    pub tray_minimize: bool,
    pub tray_close: bool,
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
            active_persona: String::new(),
            gallery_order: vec![],
            gallery_merge: false,
            deco: UserDeco::default(),
            novel_daily_limit: 0,
            novel_reserve: 5,
            tray_minimize: false,
            tray_close: false,
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
         CREATE TABLE IF NOT EXISTS personas(
            id TEXT PRIMARY KEY, profile_id TEXT, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', style TEXT NOT NULL DEFAULT '',
            avatar TEXT, frame TEXT, created_at INTEGER NOT NULL);
         CREATE TABLE IF NOT EXISTS profile_avatars(profile_id TEXT PRIMARY KEY, file TEXT NOT NULL, frame TEXT);
         CREATE TABLE IF NOT EXISTS decor(
            id TEXT PRIMARY KEY, profile_id TEXT, name TEXT NOT NULL, file TEXT NOT NULL,
            bytes INTEGER NOT NULL DEFAULT 0, share INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
         CREATE TABLE IF NOT EXISTS prompts(
            id TEXT PRIMARY KEY, profile_id TEXT, title TEXT NOT NULL, body TEXT NOT NULL, tag TEXT NOT NULL DEFAULT '',
            created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
         CREATE TABLE IF NOT EXISTS char_status(
            id TEXT PRIMARY KEY, profile_id TEXT, text TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'ai', updated_at INTEGER NOT NULL);
         CREATE TABLE IF NOT EXISTS playbooks(
            id TEXT PRIMARY KEY, profile_id TEXT, name TEXT NOT NULL, json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
         CREATE TABLE IF NOT EXISTS chat_playbook(
            chat_id INTEGER PRIMARY KEY, mode TEXT NOT NULL DEFAULT 'inherit', playbook_id TEXT, state TEXT NOT NULL DEFAULT '{}', turn INTEGER NOT NULL DEFAULT 0,
            llm INTEGER NOT NULL DEFAULT 1, start_state TEXT NOT NULL DEFAULT '{}', pending_state TEXT, pending_turn INTEGER);
         CREATE TABLE IF NOT EXISTS playbook_snap(
            message_id INTEGER PRIMARY KEY, chat_id INTEGER NOT NULL, before_state TEXT NOT NULL, after_state TEXT NOT NULL, turn INTEGER NOT NULL DEFAULT 0);
         CREATE TABLE IF NOT EXISTS emoji_items(
            id TEXT PRIMARY KEY, profile_id TEXT, kind TEXT NOT NULL, name TEXT NOT NULL, meaning TEXT NOT NULL DEFAULT '', file TEXT NOT NULL,
            room_id INTEGER, created_at INTEGER NOT NULL);
         CREATE TABLE IF NOT EXISTS char_deco(
            id TEXT PRIMARY KEY, profile_id TEXT, plate TEXT NOT NULL DEFAULT 'none', bg TEXT NOT NULL DEFAULT '', wreath TEXT NOT NULL DEFAULT '',
            source TEXT NOT NULL DEFAULT 'ai', updated_at INTEGER NOT NULL);
         CREATE TABLE IF NOT EXISTS deco_custom(
            did TEXT NOT NULL, profile_id TEXT, data TEXT NOT NULL, created_at INTEGER NOT NULL);
         CREATE INDEX IF NOT EXISTS deco_custom_owner ON deco_custom(profile_id);
         CREATE TABLE IF NOT EXISTS gallery_comments(
            id TEXT PRIMARY KEY, profile_id TEXT, pic_key TEXT NOT NULL, parent_id TEXT, author TEXT NOT NULL DEFAULT '',
            body TEXT NOT NULL, created_at INTEGER NOT NULL, edited_at INTEGER);
         CREATE INDEX IF NOT EXISTS gallery_comments_pic ON gallery_comments(profile_id, pic_key);
         CREATE TABLE IF NOT EXISTS view_folders(
            id TEXT PRIMARY KEY, profile_id TEXT, path TEXT NOT NULL, added_at INTEGER NOT NULL);
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
    crate::novel::init(&conn)?;
    crate::shelf::init(&conn)?;
    ensure_column(&conn, "profiles", "hidden", "INTEGER NOT NULL DEFAULT 0")?;
    ensure_column(&conn, "view_folders", "name", "TEXT NOT NULL DEFAULT ''")?;
    ensure_column(&conn, "view_folders", "own", "INTEGER NOT NULL DEFAULT 0")?;
    ensure_column(&conn, "folders", "parent", "TEXT")?;
    ensure_column(&conn, "folders", "cover_char", "TEXT")?;
    ensure_column(&conn, "dorms", "room_id", "INTEGER")?;
    ensure_column(&conn, "dorms", "music", "TEXT NOT NULL DEFAULT ''")?;
    ensure_column(&conn, "dorms", "music_name", "TEXT NOT NULL DEFAULT ''")?;
    ensure_column(&conn, "rooms", "music", "TEXT NOT NULL DEFAULT ''")?;
    ensure_column(&conn, "rooms", "music_name", "TEXT NOT NULL DEFAULT ''")?;
    ensure_column(&conn, "rooms", "model", "TEXT NOT NULL DEFAULT ''")?;
    ensure_column(&conn, "rooms", "model_name", "TEXT NOT NULL DEFAULT ''")?;
    ensure_column(&conn, "rooms", "model_scale", "REAL NOT NULL DEFAULT 1")?;
    ensure_column(&conn, "rooms", "model_rot", "REAL NOT NULL DEFAULT 0")?;
    ensure_column(&conn, "rooms", "model_y", "REAL NOT NULL DEFAULT 0")?;
    ensure_column(&conn, "rooms", "model_share", "INTEGER NOT NULL DEFAULT 0")?;
    ensure_column(&conn, "chats", "style", "TEXT NOT NULL DEFAULT 'chat'")?;
    // pathways: rooms inside rooms, rooms joined to each other, and the room a chat has moved into
    ensure_column(&conn, "rooms", "parent_id", "INTEGER")?;
    ensure_column(&conn, "rooms", "world_id", "INTEGER")?;
    ensure_column(&conn, "rooms", "gallery", "TEXT NOT NULL DEFAULT '[]'")?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS worlds(id INTEGER PRIMARY KEY AUTOINCREMENT, profile_id TEXT, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);
         CREATE TABLE IF NOT EXISTS world_lorebooks(world_id INTEGER NOT NULL, book_id TEXT NOT NULL, PRIMARY KEY(world_id, book_id));",
    )?;
    for col in ["persona", "playbook", "instructions"] { ensure_column(&conn, "worlds", col, "TEXT NOT NULL DEFAULT ''")?; }
    ensure_column(&conn, "worlds", "prompts", "TEXT NOT NULL DEFAULT '[]'")?;
    ensure_column(&conn, "worlds", "cover", "TEXT NOT NULL DEFAULT ''")?;
    ensure_column(&conn, "worlds", "lore", "TEXT NOT NULL DEFAULT ''")?; // after the table exists (worlds made before this had no lore)
    ensure_column(&conn, "rooms", "deco_plate", "TEXT NOT NULL DEFAULT 'none'")?;
    ensure_column(&conn, "rooms", "deco_bg", "TEXT NOT NULL DEFAULT ''")?;
    ensure_column(&conn, "rooms", "deco_wreath", "TEXT NOT NULL DEFAULT ''")?;
    ensure_column(&conn, "rooms", "deco_tag", "TEXT NOT NULL DEFAULT ''")?;
    ensure_column(&conn, "rooms", "deco_tag_color", "TEXT NOT NULL DEFAULT '#5865f2'")?;
    ensure_column(&conn, "rooms", "deco_tag_glyph", "TEXT NOT NULL DEFAULT ''")?;
    ensure_column(&conn, "chats", "room_id", "INTEGER")?;
    ensure_column(&conn, "chats", "world_persona_off", "INTEGER NOT NULL DEFAULT 0")?;
    conn.execute_batch("CREATE TABLE IF NOT EXISTS room_links(a INTEGER NOT NULL, b INTEGER NOT NULL, PRIMARY KEY(a,b));")?;
    for t in ["rooms", "mechanics", "notes", "folders", "lorebooks", "personas"] {
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
    let _ = delete_gallery_comments_under(c, owner, &format!("char:{id}:"));
    c.execute("DELETE FROM characters WHERE id=?1 AND profile_id IS ?2", params![id, owner])?;
    c.execute("DELETE FROM char_status WHERE id=?1 AND profile_id IS ?2", params![id, owner])?;
    c.execute("DELETE FROM char_deco WHERE id=?1 AND profile_id IS ?2", params![id, owner])?;
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
    Ok(Room { id: r.get(0)?, name: r.get(1)?, kind: r.get(2)?, description: r.get(3)?, owner_kind: r.get(4)?, character_id: r.get(5)?, backdrop: r.get(6)?, created_at: r.get(7)?, music: r.get(8)?, music_name: r.get(9)?, model: r.get(10)?, model_name: r.get(11)?, model_scale: r.get(12)?, model_rot: r.get(13)?, model_y: r.get(14)?, model_share: r.get::<_, i64>(15)? != 0, parent_id: r.get(16)?, links: vec![], deco: RoomDeco { plate: r.get(17)?, bg: r.get(18)?, wreath: r.get(19)?, tag: r.get(20)?, tag_color: r.get(21)?, tag_glyph: r.get(22)? }, world_id: r.get(23)?, gallery: serde_json::from_str(&r.get::<_, String>(24)?).unwrap_or_default() })
}
const ROOM_COLS: &str = "id,name,kind,description,owner_kind,character_id,backdrop,created_at,music,music_name,model,model_name,model_scale,model_rot,model_y,model_share,parent_id,deco_plate,deco_bg,deco_wreath,deco_tag,deco_tag_color,deco_tag_glyph,world_id,gallery";

pub fn list_rooms(c: &Connection, owner: &Owner) -> R<Vec<Room>> {
    let mut s = c.prepare(&format!("SELECT {ROOM_COLS} FROM rooms WHERE profile_id IS ?1 ORDER BY id DESC"))?;
    let rows = s.query_map([owner], row_room)?;
    let mut rooms: Vec<Room> = rows.filter_map(|r| r.ok()).collect();
    let ids: std::collections::HashSet<i64> = rooms.iter().map(|r| r.id).collect();
    let mut links: HashMap<i64, Vec<i64>> = HashMap::new();
    let mut l = c.prepare("SELECT a,b FROM room_links ORDER BY b")?;
    for (x, y) in l.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)))?.filter_map(|r| r.ok()) {
        if ids.contains(&x) && ids.contains(&y) { links.entry(x).or_default().push(y); }
    }
    for r in rooms.iter_mut() { r.links = links.remove(&r.id).unwrap_or_default(); }
    Ok(rooms)
}

pub fn get_room(c: &Connection, id: i64, owner: &Owner) -> R<Option<Room>> {
    let room = c.query_row(&format!("SELECT {ROOM_COLS} FROM rooms WHERE id=?1 AND profile_id IS ?2"), params![id, owner], row_room).optional()?;
    Ok(room.map(|mut r| {
        r.links = c.prepare("SELECT b FROM room_links WHERE a=?1 ORDER BY b").and_then(|mut s| s.query_map([id], |x| x.get(0)).map(|rows| rows.filter_map(|x| x.ok()).collect())).unwrap_or_default();
        r
    }))
}

/// Whether `parent` can be the room `id` is part of: one of the owner's rooms, and not the room itself or anything inside it.
pub fn valid_parent(c: &Connection, id: i64, parent: Option<i64>, owner: &Owner) -> Option<i64> {
    let mut cur = parent?;
    let wanted = get_room(c, cur, owner).ok().flatten()?;
    // a room can only be part of a room in its own world
    if get_room(c, id, owner).ok().flatten().map(|r| r.world_id) != Some(wanted.world_id) { return None; }
    // walk up from the wanted parent: if we meet `id`, the room would end up inside itself
    for _ in 0..200 {
        if cur == id { return None; }
        match c.query_row("SELECT parent_id FROM rooms WHERE id=?1 AND profile_id IS ?2", params![cur, owner], |r| r.get::<_, Option<i64>>(0)) {
            Ok(Some(p)) => cur = p,
            _ => return parent,
        }
    }
    None
}

/// The most exits (one-way pathways out) a room may have.
pub const MAX_EXITS: usize = 3;

/// Gives `id` exactly these exits: one-way pathways to the owner's own other rooms (never to itself). Whether there
/// are too many is for the caller to refuse (a backup may carry more than the limit and must keep them).
pub fn set_room_links(c: &Connection, id: i64, links: &[i64], owner: &Owner) -> R<()> {
    if get_room(c, id, owner)?.is_none() { return Ok(()); }
    c.execute("DELETE FROM room_links WHERE a=?1", [id])?;
    let world = get_room(c, id, owner)?.map(|r| r.world_id);
    for &o in links {
        // exits only lead to rooms in the same world
        if o != id && get_room(c, o, owner)?.map(|r| r.world_id) == world {
            c.execute("INSERT OR IGNORE INTO room_links(a,b) VALUES(?1,?2)", params![id, o])?;
        }
    }
    Ok(())
}

pub fn set_room_parent(c: &Connection, id: i64, parent: Option<i64>, owner: &Owner) -> R<()> {
    let parent = valid_parent(c, id, parent, owner);
    c.execute("UPDATE rooms SET parent_id=?2 WHERE id=?1 AND profile_id IS ?3", params![id, parent, owner])?;
    Ok(())
}

// ----- worlds -----

/// A world of this owner, or `None`.
pub fn valid_world(c: &Connection, world: Option<i64>, owner: &Owner) -> Option<i64> {
    let w = world?;
    c.query_row("SELECT 1 FROM worlds WHERE id=?1 AND profile_id IS ?2", params![w, owner], |_| Ok(())).optional().ok().flatten().map(|_| w)
}

fn world_books(c: &Connection, id: i64) -> Vec<String> {
    c.prepare("SELECT book_id FROM world_lorebooks WHERE world_id=?1 ORDER BY book_id").and_then(|mut s| s.query_map([id], |r| r.get(0)).map(|rows| rows.filter_map(|x| x.ok()).collect())).unwrap_or_default()
}

pub fn list_worlds(c: &Connection, owner: &Owner) -> R<Vec<World>> {
    let mut s = c.prepare("SELECT id,name,description,lore,created_at,persona,playbook,instructions,prompts,cover FROM worlds WHERE profile_id IS ?1 ORDER BY id")?;
    let rows: Vec<(i64, String, String, String, i64, String, String, String, String, String)> = s.query_map([owner], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?, r.get(9)?)))?.filter_map(|r| r.ok()).collect();
    Ok(rows.into_iter().map(|(id, name, description, lore, created_at, persona, playbook, instructions, prompts, cover)| World { id, name, description, lore, lorebooks: world_books(c, id), persona, playbook, instructions, prompts: serde_json::from_str(&prompts).unwrap_or_default(), cover, created_at }).collect())
}

pub fn get_world(c: &Connection, id: i64, owner: &Owner) -> R<Option<World>> {
    Ok(list_worlds(c, owner)?.into_iter().find(|w| w.id == id))
}

pub fn create_world(c: &Connection, name: &str, description: &str, owner: &Owner) -> R<World> {
    c.execute("INSERT INTO worlds(profile_id,name,description,created_at) VALUES(?1,?2,?3,?4)", params![owner, name, description, now()])?;
    Ok(get_world(c, c.last_insert_rowid(), owner)?.expect("just inserted"))
}

/// Rename it, describe it, and set exactly which of the owner's lorebooks are attached.
pub fn update_world(c: &Connection, id: i64, name: &str, description: &str, lore: &str, lorebooks: &[String], owner: &Owner) -> R<()> {
    if get_world(c, id, owner)?.is_none() { return Ok(()); }
    c.execute("UPDATE worlds SET name=?2, description=?3, lore=?5 WHERE id=?1 AND profile_id IS ?4", params![id, name, description, owner, lore])?;
    c.execute("DELETE FROM world_lorebooks WHERE world_id=?1", [id])?;
    let mine: Vec<String> = list_lorebooks(c, owner)?.into_iter().map(|b| b.id).collect();
    for b in lorebooks.iter().filter(|b| mine.contains(b)) {
        c.execute("INSERT OR IGNORE INTO world_lorebooks(world_id,book_id) VALUES(?1,?2)", params![id, b])?;
    }
    Ok(())
}

/// Sets what a world brings along: a persona and a playbook (ids; the caller has checked they are the owner's) and standing instructions.
pub fn set_world_setup(c: &Connection, id: i64, persona: &str, playbook: &str, instructions: &str, prompts: &[String], owner: &Owner) -> R<()> {
    let mine: Vec<String> = list_prompts(c, owner)?.into_iter().map(|p| p.id).collect();
    let mut keep: Vec<&String> = Vec::new();
    for p in prompts.iter().filter(|p| mine.contains(p)) { if !keep.contains(&p) && keep.len() < 30 { keep.push(p); } }
    c.execute("UPDATE worlds SET persona=?2, playbook=?3, instructions=?4, prompts=?6 WHERE id=?1 AND profile_id IS ?5", params![id, persona, playbook, instructions, owner, serde_json::to_string(&keep).unwrap_or_else(|_| "[]".into())])?;
    Ok(())
}

/// Sets (or, with "", clears) a world's cover picture. The caller has written the file.
pub fn set_world_cover(c: &Connection, id: i64, cover: &str, owner: &Owner) -> R<()> {
    c.execute("UPDATE worlds SET cover=?2 WHERE id=?1 AND profile_id IS ?3", params![id, cover, owner])?;
    Ok(())
}

/// Delete a world. Its rooms are not deleted: they are simply not in a world any more.
pub fn delete_world(c: &Connection, id: i64, owner: &Owner) -> R<()> {
    if get_world(c, id, owner)?.is_none() { return Ok(()); }
    c.execute("UPDATE rooms SET world_id=NULL WHERE world_id=?1 AND profile_id IS ?2", params![id, owner])?;
    c.execute("DELETE FROM world_lorebooks WHERE world_id=?1", [id])?;
    c.execute("DELETE FROM worlds WHERE id=?1 AND profile_id IS ?2", params![id, owner])?;
    Ok(())
}

/// Put these rooms in a world (or in none). Rooms, "part of" links and exits never cross between worlds, so any link between a room that
/// moved and one that did not (and is now in a different world) is dropped.
pub fn move_rooms_to_world(c: &Connection, ids: &[i64], world: Option<i64>, owner: &Owner) -> R<()> {
    let world = valid_world(c, world, owner);
    for id in ids {
        c.execute("UPDATE rooms SET world_id=?2 WHERE id=?1 AND profile_id IS ?3", params![id, world, owner])?;
    }
    c.execute("UPDATE rooms SET parent_id=NULL WHERE profile_id IS ?1 AND parent_id IS NOT NULL AND (SELECT p.world_id FROM rooms p WHERE p.id=rooms.parent_id) IS NOT rooms.world_id", [owner])?;
    c.execute("DELETE FROM room_links WHERE (SELECT world_id FROM rooms WHERE id=room_links.a) IS NOT (SELECT world_id FROM rooms WHERE id=room_links.b)", [])?;
    Ok(())
}

/// The world a chat is in: the world of the room it is in now.
pub fn chat_world(c: &Connection, chat: &Chat, owner: &Owner) -> R<Option<World>> {
    match chat_room(c, chat, owner)?.and_then(|r| r.world_id) { Some(w) => get_world(c, w, owner), None => Ok(None) }
}

/// The most pictures one room's gallery holds.
pub const MAX_ROOM_PICS: usize = 24;

/// Replaces a room's gallery (the pictures themselves are files the caller has already put in place).
pub fn set_room_gallery(c: &Connection, id: i64, gallery: &[RoomPic], owner: &Owner) -> R<()> {
    c.execute("UPDATE rooms SET gallery=?2 WHERE id=?1 AND profile_id IS ?3", params![id, serde_json::to_string(gallery).unwrap_or_else(|_| "[]".into()), owner])?;
    Ok(())
}

pub fn create_room(c: &Connection, r: &Room, owner: &Owner) -> R<Room> {
    c.execute(
        "INSERT INTO rooms(profile_id,name,kind,description,owner_kind,character_id,backdrop,created_at,music,music_name,model,model_name,model_scale,model_rot,model_y,model_share,deco_plate,deco_bg,deco_wreath,deco_tag,deco_tag_color,deco_tag_glyph,world_id) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23)",
        params![owner, r.name, r.kind, r.description, r.owner_kind, r.character_id, r.backdrop, now(), r.music, r.music_name, r.model, r.model_name, r.model_scale, r.model_rot, r.model_y, r.model_share as i64, r.deco.plate, r.deco.bg, r.deco.wreath, r.deco.tag, r.deco.tag_color, r.deco.tag_glyph, valid_world(c, r.world_id, owner)],
    )?;
    Ok(get_room(c, c.last_insert_rowid(), owner)?.expect("just inserted"))
}

pub fn update_room(c: &Connection, r: &Room, owner: &Owner) -> R<()> {
    c.execute(
        "UPDATE rooms SET name=?2,kind=?3,description=?4,owner_kind=?5,character_id=?6,backdrop=?7,music=?9,music_name=?10,model=?11,model_name=?12,model_scale=?13,model_rot=?14,model_y=?15,model_share=?16,deco_plate=?17,deco_bg=?18,deco_wreath=?19,deco_tag=?20,deco_tag_color=?21,deco_tag_glyph=?22 WHERE id=?1 AND profile_id IS ?8",
        params![r.id, r.name, r.kind, r.description, r.owner_kind, r.character_id, r.backdrop, owner, r.music, r.music_name, r.model, r.model_name, r.model_scale, r.model_rot, r.model_y, r.model_share as i64, r.deco.plate, r.deco.bg, r.deco.wreath, r.deco.tag, r.deco.tag_color, r.deco.tag_glyph],
    )?;
    set_room_parent(c, r.id, r.parent_id, owner)?;
    Ok(())
}

pub fn delete_room(c: &Connection, id: i64, owner: &Owner) -> R<()> {
    c.execute("UPDATE dorms SET room_id=NULL WHERE room_id=?1 AND profile_id IS ?2", params![id, owner])?;
    c.execute("UPDATE chats SET room_id=NULL WHERE room_id=?1 AND profile_id IS ?2", params![id, owner])?;
    // what was tied to the room works everywhere from now on (nothing is lost)
    c.execute("UPDATE emoji_items SET room_id=NULL WHERE room_id=?1 AND profile_id IS ?2", params![id, owner])?;
    // what was inside it moves up a level, so nothing is lost
    let up: Option<i64> = c.query_row("SELECT parent_id FROM rooms WHERE id=?1 AND profile_id IS ?2", params![id, owner], |r| r.get(0)).optional()?.flatten();
    c.execute("UPDATE rooms SET parent_id=?3 WHERE parent_id=?1 AND profile_id IS ?2", params![id, owner, up])?;
    c.execute("DELETE FROM room_links WHERE a=?1 OR b=?1", [id])?;
    c.execute("DELETE FROM rooms WHERE id=?1 AND profile_id IS ?2", params![id, owner])?;
    Ok(())
}

// ----- decorations -----

fn row_decor(r: &rusqlite::Row) -> R<DecorItem> {
    Ok(DecorItem { id: r.get(0)?, name: r.get(1)?, file: r.get(2)?, bytes: r.get(3)?, share: r.get::<_, i64>(4)? != 0, created_at: r.get(5)? })
}
const DECOR_COLS: &str = "id,name,file,bytes,share,created_at";

pub fn list_decor(c: &Connection, owner: &Owner) -> R<Vec<DecorItem>> {
    let mut s = c.prepare(&format!("SELECT {DECOR_COLS} FROM decor WHERE profile_id IS ?1 ORDER BY name COLLATE NOCASE, created_at"))?;
    let rows = s.query_map([owner], row_decor)?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

pub fn get_decor(c: &Connection, id: &str, owner: &Owner) -> R<Option<DecorItem>> {
    c.query_row(&format!("SELECT {DECOR_COLS} FROM decor WHERE id=?1 AND profile_id IS ?2"), params![id, owner], row_decor).optional()
}

pub fn save_decor(c: &Connection, d: &DecorItem, owner: &Owner) -> R<()> {
    c.execute(
        "INSERT INTO decor(id,profile_id,name,file,bytes,share,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, share=excluded.share WHERE decor.profile_id IS ?2",
        params![d.id, owner, d.name, d.file, d.bytes, d.share as i64, d.created_at],
    )?;
    Ok(())
}

pub fn delete_decor(c: &Connection, id: &str, owner: &Owner) -> R<()> {
    c.execute("DELETE FROM decor WHERE id=?1 AND profile_id IS ?2", params![id, owner])?;
    Ok(())
}

// ----- personas and profile pictures -----

fn row_persona(r: &rusqlite::Row) -> R<Persona> {
    let fr: Option<String> = r.get(5)?;
    Ok(Persona { id: r.get(0)?, name: r.get(1)?, description: r.get(2)?, style: r.get(3)?, avatar: r.get(4)?, frame: fr.and_then(|j| serde_json::from_str(&j).ok()), created_at: r.get(6)? })
}
const PERSONA_COLS: &str = "id,name,description,style,avatar,frame,created_at";

pub fn list_personas(c: &Connection, owner: &Owner) -> R<Vec<Persona>> {
    let mut s = c.prepare(&format!("SELECT {PERSONA_COLS} FROM personas WHERE profile_id IS ?1 ORDER BY created_at, name COLLATE NOCASE"))?;
    let rows = s.query_map([owner], row_persona)?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

pub fn get_persona(c: &Connection, id: &str, owner: &Owner) -> R<Option<Persona>> {
    c.query_row(&format!("SELECT {PERSONA_COLS} FROM personas WHERE id=?1 AND profile_id IS ?2"), params![id, owner], row_persona).optional()
}

pub fn save_persona(c: &Connection, p: &Persona, owner: &Owner) -> R<()> {
    let fr = p.frame.and_then(|x| serde_json::to_string(&x).ok());
    c.execute(
        "INSERT INTO personas(id,profile_id,name,description,style,avatar,frame,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, description=excluded.description, style=excluded.style, avatar=excluded.avatar, frame=excluded.frame WHERE profile_id IS ?2",
        params![p.id, owner, p.name, p.description, p.style, p.avatar, fr, p.created_at],
    )?;
    Ok(())
}

pub fn delete_persona(c: &Connection, id: &str, owner: &Owner) -> R<()> {
    c.execute("DELETE FROM personas WHERE id=?1 AND profile_id IS ?2", params![id, owner])?;
    Ok(())
}

pub fn get_profile_avatar(c: &Connection, pid: &str) -> Option<(String, Option<Frame>)> {
    c.query_row("SELECT file,frame FROM profile_avatars WHERE profile_id=?1", [pid], |r| {
        let fr: Option<String> = r.get(1)?;
        Ok((r.get::<_, String>(0)?, fr.and_then(|j| serde_json::from_str(&j).ok())))
    })
    .ok()
}

pub fn set_profile_avatar(c: &Connection, pid: &str, file: &str, frame: Option<Frame>) -> R<()> {
    let fr = frame.and_then(|x| serde_json::to_string(&x).ok());
    c.execute(
        "INSERT INTO profile_avatars(profile_id,file,frame) VALUES(?1,?2,?3) ON CONFLICT(profile_id) DO UPDATE SET file=excluded.file, frame=excluded.frame",
        params![pid, file, fr],
    )?;
    Ok(())
}

pub fn clear_profile_avatar(c: &Connection, pid: &str) -> R<()> {
    c.execute("DELETE FROM profile_avatars WHERE profile_id=?1", [pid])?;
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
    c.execute("DELETE FROM world_lorebooks WHERE book_id=?1 AND world_id IN (SELECT id FROM worlds WHERE profile_id IS ?2)", params![id, owner])?;
    c.execute("DELETE FROM lorebooks WHERE id=?1 AND profile_id IS ?2", params![id, owner])?;
    Ok(())
}

// ----- folders -----

fn row_folder(r: &rusqlite::Row) -> R<Folder> {
    let fr: Option<String> = r.get(3)?;
    Ok(Folder { id: r.get(0)?, name: r.get(1)?, cover: r.get(2)?, frame: fr.and_then(|j| serde_json::from_str(&j).ok()), created_at: r.get(4)?, parent: r.get(5)?, cover_char: r.get(6)? })
}

pub fn list_folders(c: &Connection, owner: &Owner) -> R<Vec<Folder>> {
    let mut s = c.prepare("SELECT id,name,cover,frame,created_at,parent,cover_char FROM folders WHERE profile_id IS ?1 ORDER BY name COLLATE NOCASE")?;
    let rows = s.query_map([owner], row_folder)?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

pub fn get_folder(c: &Connection, id: &str, owner: &Owner) -> R<Option<Folder>> {
    c.query_row("SELECT id,name,cover,frame,created_at,parent,cover_char FROM folders WHERE id=?1 AND profile_id IS ?2", params![id, owner], row_folder).optional()
}

pub fn save_folder(c: &Connection, f: &Folder, owner: &Owner) -> R<()> {
    let fr = f.frame.and_then(|x| serde_json::to_string(&x).ok());
    c.execute(
        "INSERT INTO folders(id,profile_id,name,cover,frame,created_at,parent,cover_char) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, cover=excluded.cover, frame=excluded.frame, parent=excluded.parent, cover_char=excluded.cover_char WHERE profile_id IS ?2",
        params![f.id, owner, f.name, f.cover, fr, f.created_at, f.parent, f.cover_char],
    )?;
    Ok(())
}

/// The chain of folders from `id` up to the top: `[id, its parent, its grandparent, …]` (stops if the data loops).
pub fn folder_chain(all: &[Folder], id: &str) -> Vec<String> {
    let mut out = vec![];
    let mut cur = Some(id.to_string());
    while let Some(c) = cur {
        if out.contains(&c) || out.len() > 64 { break; }
        let next = all.iter().find(|f| f.id == c).and_then(|f| f.parent.clone());
        out.push(c);
        cur = next;
    }
    out
}

/// How many levels deep the subtree under `id` goes (a folder with no subfolders is 1).
pub fn folder_height(all: &[Folder], id: &str, guard: usize) -> usize {
    if guard > 64 { return 1; }
    1 + all.iter().filter(|f| f.parent.as_deref() == Some(id)).map(|f| folder_height(all, &f.id, guard + 1)).max().unwrap_or(0)
}

/// Can folder `id` be put inside `parent` (None = the top level)? Not into itself or something inside it, and not too deep.
pub fn can_nest(all: &[Folder], id: &str, parent: Option<&str>) -> Result<(), &'static str> {
    let Some(p) = parent else { return Ok(()) };
    if p == id || folder_chain(all, p).iter().any(|a| a == id) {
        return Err("A folder can't go inside itself or one of its own subfolders.");
    }
    if folder_chain(all, p).len() + folder_height(all, id, 0) > MAX_FOLDER_DEPTH {
        return Err("Folders can only be nested a few levels deep.");
    }
    Ok(())
}

/// Delete a folder. Nothing inside is deleted: its characters and subfolders move up into the folder it sat in.
pub fn delete_folder(c: &Connection, id: &str, owner: &Owner) -> R<()> {
    let Some(gone) = get_folder(c, id, owner)? else { return Ok(()) };
    for mut ch in list_characters(c, owner)? {
        if ch.folder.as_deref() == Some(id) {
            ch.folder = gone.parent.clone();
            save_character(c, &ch, owner)?;
        }
    }
    for mut f in list_folders(c, owner)? {
        if f.parent.as_deref() == Some(id) {
            f.parent = gone.parent.clone();
            save_folder(c, &f, owner)?;
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

// ----- saved prompts -----

pub fn list_prompts(c: &Connection, owner: &Owner) -> R<Vec<SavedPrompt>> {
    let mut s = c.prepare("SELECT id,title,body,tag,created_at,updated_at FROM prompts WHERE profile_id IS ?1 ORDER BY title COLLATE NOCASE, created_at")?;
    let rows = s.query_map([owner], |r| Ok(SavedPrompt { id: r.get(0)?, title: r.get(1)?, body: r.get(2)?, tag: r.get(3)?, created_at: r.get(4)?, updated_at: r.get(5)? }))?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

/// Insert or update (only ever a prompt of this owner).
pub fn save_prompt(c: &Connection, p: &SavedPrompt, owner: &Owner) -> R<()> {
    c.execute(
        "INSERT INTO prompts(id,profile_id,title,body,tag,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7)
         ON CONFLICT(id) DO UPDATE SET title=excluded.title, body=excluded.body, tag=excluded.tag, updated_at=excluded.updated_at WHERE prompts.profile_id IS ?2",
        params![p.id, owner, p.title, p.body, p.tag, p.created_at, p.updated_at],
    )?;
    Ok(())
}

pub fn delete_prompt(c: &Connection, id: &str, owner: &Owner) -> R<()> {
    c.execute("DELETE FROM prompts WHERE id=?1 AND profile_id IS ?2", params![id, owner])?;
    Ok(())
}

// ----- character statuses -----

pub fn list_statuses(c: &Connection, owner: &Owner) -> R<Vec<CharStatus>> {
    let mut s = c.prepare("SELECT id,text,source,updated_at FROM char_status WHERE profile_id IS ?1")?;
    let rows = s.query_map([owner], |r| Ok(CharStatus { character_id: r.get(0)?, text: r.get(1)?, source: r.get(2)?, updated_at: r.get(3)? }))?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

/// Insert or replace (only ever a status of this owner).
pub fn save_status(c: &Connection, st: &CharStatus, owner: &Owner) -> R<()> {
    c.execute(
        "INSERT INTO char_status(id,profile_id,text,source,updated_at) VALUES(?1,?2,?3,?4,?5)
         ON CONFLICT(id) DO UPDATE SET text=excluded.text, source=excluded.source, updated_at=excluded.updated_at WHERE char_status.profile_id IS ?2",
        params![st.character_id, owner, st.text, st.source, st.updated_at],
    )?;
    Ok(())
}

pub fn delete_status(c: &Connection, id: &str, owner: &Owner) -> R<()> {
    c.execute("DELETE FROM char_status WHERE id=?1 AND profile_id IS ?2", params![id, owner])?;
    Ok(())
}

// ----- custom emoji and stickers -----

pub const MAX_EMOJI: usize = 50;
pub const MAX_STICKERS: usize = 30;

fn row_emoji(r: &rusqlite::Row) -> R<EmojiItem> {
    Ok(EmojiItem { id: r.get(0)?, kind: r.get(1)?, name: r.get(2)?, meaning: r.get(3)?, file: r.get(4)?, room_id: r.get(5)?, created_at: r.get(6)? })
}

pub fn list_emoji(c: &Connection, owner: &Owner) -> R<Vec<EmojiItem>> {
    let mut s = c.prepare("SELECT id,kind,name,meaning,file,room_id,created_at FROM emoji_items WHERE profile_id IS ?1 ORDER BY kind, name, created_at")?;
    let rows = s.query_map([owner], row_emoji)?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

pub fn get_emoji(c: &Connection, id: &str, owner: &Owner) -> R<Option<EmojiItem>> {
    c.query_row("SELECT id,kind,name,meaning,file,room_id,created_at FROM emoji_items WHERE id=?1 AND profile_id IS ?2", params![id, owner], row_emoji).optional()
}

/// Is there already one of this kind with this name, with the same reach (everywhere, or the same room)? (`except` is the one being renamed.)
pub fn emoji_name_taken(c: &Connection, kind: &str, name: &str, room_id: Option<i64>, except: &str, owner: &Owner) -> R<bool> {
    Ok(c.query_row(
        "SELECT 1 FROM emoji_items WHERE profile_id IS ?1 AND kind=?2 AND name=?3 AND room_id IS ?4 AND id<>?5",
        params![owner, kind, name, room_id, except],
        |_| Ok(()),
    )
    .optional()?
    .is_some())
}

pub fn save_emoji(c: &Connection, e: &EmojiItem, owner: &Owner) -> R<()> {
    c.execute(
        "INSERT INTO emoji_items(id,profile_id,kind,name,meaning,file,room_id,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, meaning=excluded.meaning, room_id=excluded.room_id WHERE emoji_items.profile_id IS ?2",
        params![e.id, owner, e.kind, e.name, e.meaning, e.file, e.room_id, e.created_at],
    )?;
    Ok(())
}

pub fn delete_emoji(c: &Connection, id: &str, owner: &Owner) -> R<()> {
    c.execute("DELETE FROM emoji_items WHERE id=?1 AND profile_id IS ?2", params![id, owner])?;
    Ok(())
}

/// The emoji and stickers a chat in `room` can use: the ones that work everywhere and the ones tied to that room. Where both have the same
/// name, the room's own wins.
pub fn emoji_available(items: &[EmojiItem], room: Option<i64>) -> Vec<&EmojiItem> {
    let mut out: Vec<&EmojiItem> = vec![];
    for it in items.iter().filter(|i| i.room_id.is_none() || (room.is_some() && i.room_id == room)) {
        match out.iter().position(|o| o.kind == it.kind && o.name == it.name) {
            Some(k) => { if it.room_id.is_some() { out[k] = it; } }
            None => out.push(it),
        }
    }
    out
}

// ----- character decorations -----

pub fn list_char_deco(c: &Connection, owner: &Owner) -> R<Vec<CharDeco>> {
    let mut s = c.prepare("SELECT id,plate,bg,wreath,source,updated_at FROM char_deco WHERE profile_id IS ?1")?;
    let rows = s.query_map([owner], |r| Ok(CharDeco { character_id: r.get(0)?, plate: r.get(1)?, bg: r.get(2)?, wreath: r.get(3)?, source: r.get(4)?, updated_at: r.get(5)? }))?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

/// Insert or replace (only ever a record of this owner).
pub fn save_char_deco(c: &Connection, d: &CharDeco, owner: &Owner) -> R<()> {
    c.execute(
        "INSERT INTO char_deco(id,profile_id,plate,bg,wreath,source,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7)
         ON CONFLICT(id) DO UPDATE SET plate=excluded.plate, bg=excluded.bg, wreath=excluded.wreath, source=excluded.source, updated_at=excluded.updated_at WHERE char_deco.profile_id IS ?2",
        params![d.character_id, owner, d.plate, d.bg, d.wreath, d.source, d.updated_at],
    )?;
    Ok(())
}

/// The most decorations of one's own a profile can keep.
pub const MAX_CUSTOM_DECO: usize = 120;

/// A decoration the person brought in from a file (a nameplate, profile banner or avatar decoration). The page has already rebuilt the art from
/// an allow-list; `deco.rs` checks the shape and the sizes again before anything is stored. Kept as JSON, newest last.
#[derive(Serialize, Deserialize, Clone, PartialEq, Debug, Default)]
#[serde(default)]
pub struct CustomDeco {
    /// `cp_`, `cb_` or `cw_` and ten hex digits: made from the art, so the same art is the same decoration everywhere.
    pub did: String,
    /// plate | banner | wreath
    pub dkind: String,
    /// svg | image | sprite (a video turned into a strip of frames)
    pub mode: String,
    pub name: String,
    pub blurb: String,
    /// The picture: SVG text, or a `data:image/...` URL.
    pub art: String,
    /// The same picture standing still (for when "Animate decorations" is off), if it moves.
    pub still: String,
    pub moves: bool,
    pub author: String,
    pub license: String,
    pub pack: String,
    pub cols: i64,
    pub rows: i64,
    pub frames: i64,
    pub dur: f64,
    /// The video, for a sprite, so it can be exported again.
    pub src: String,
}

pub fn list_custom_deco(c: &Connection, owner: &Owner) -> R<Vec<CustomDeco>> {
    let mut s = c.prepare("SELECT data FROM deco_custom WHERE profile_id IS ?1 ORDER BY created_at, rowid")?;
    let rows: Vec<String> = s.query_map([owner], |r| r.get(0))?.filter_map(|r| r.ok()).collect();
    Ok(rows.into_iter().filter_map(|j| serde_json::from_str(&j).ok()).collect())
}

pub fn save_custom_deco(c: &Connection, d: &CustomDeco, owner: &Owner) -> R<()> {
    c.execute("DELETE FROM deco_custom WHERE did=?1 AND profile_id IS ?2", params![d.did, owner])?;
    c.execute("INSERT INTO deco_custom(did,profile_id,data,created_at) VALUES(?1,?2,?3,?4)", params![d.did, owner, serde_json::to_string(d).unwrap_or_default(), now()])?;
    Ok(())
}

pub fn delete_custom_deco(c: &Connection, did: &str, owner: &Owner) -> R<()> {
    c.execute("DELETE FROM deco_custom WHERE did=?1 AND profile_id IS ?2", params![did, owner])?;
    Ok(())
}

/// A comment the person wrote under a picture in the Gallery, kept only on this device. Comments can answer other comments (a thread, like a
/// forum): `parent_id` is the comment being answered. A picture is named by its `pic_key`: `char:<character id>:profile` or
/// `char:<character id>:<gallery item id>` for a character's pictures, `disk:<full path>` for a picture from a folder on the computer.
#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct GalleryComment {
    pub id: String,
    pub pic_key: String,
    pub parent_id: Option<String>,
    pub author: String,
    pub body: String,
    pub created_at: i64,
    pub edited_at: Option<i64>,
}

/// The longest one comment can be. There is no limit on how many comments a picture can have.
pub const MAX_COMMENT_CHARS: usize = 20_000;

fn row_comment(r: &rusqlite::Row) -> rusqlite::Result<GalleryComment> {
    Ok(GalleryComment { id: r.get(0)?, pic_key: r.get(1)?, parent_id: r.get(2)?, author: r.get(3)?, body: r.get(4)?, created_at: r.get(5)?, edited_at: r.get(6)? })
}
const COMMENT_COLS: &str = "id,pic_key,parent_id,author,body,created_at,edited_at";

/// Every comment under one picture, oldest first.
pub fn list_gallery_comments(c: &Connection, owner: &Owner, pic_key: &str) -> R<Vec<GalleryComment>> {
    let mut s = c.prepare(&format!("SELECT {COMMENT_COLS} FROM gallery_comments WHERE profile_id IS ?1 AND pic_key=?2 ORDER BY created_at, rowid"))?;
    let rows = s.query_map(params![owner, pic_key], row_comment)?.filter_map(|r| r.ok()).collect();
    Ok(rows)
}

/// All of a profile's comments (for a backup).
pub fn all_gallery_comments(c: &Connection, owner: &Owner) -> R<Vec<GalleryComment>> {
    let mut s = c.prepare(&format!("SELECT {COMMENT_COLS} FROM gallery_comments WHERE profile_id IS ?1 ORDER BY created_at, rowid"))?;
    let rows = s.query_map([owner], row_comment)?.filter_map(|r| r.ok()).collect();
    Ok(rows)
}

/// How many comments each picture has (replies included), for the little count on a picture.
pub fn gallery_comment_counts(c: &Connection, owner: &Owner) -> R<HashMap<String, i64>> {
    let mut s = c.prepare("SELECT pic_key, COUNT(*) FROM gallery_comments WHERE profile_id IS ?1 GROUP BY pic_key")?;
    let rows = s.query_map([owner], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?.filter_map(|r| r.ok()).collect();
    Ok(rows)
}

pub fn get_gallery_comment(c: &Connection, owner: &Owner, id: &str) -> R<Option<GalleryComment>> {
    Ok(c.query_row(&format!("SELECT {COMMENT_COLS} FROM gallery_comments WHERE id=?1 AND profile_id IS ?2"), params![id, owner], row_comment).optional()?)
}

pub fn insert_gallery_comment(c: &Connection, owner: &Owner, g: &GalleryComment) -> R<()> {
    c.execute("INSERT INTO gallery_comments(id,profile_id,pic_key,parent_id,author,body,created_at,edited_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
        params![g.id, owner, g.pic_key, g.parent_id, g.author, g.body, g.created_at, g.edited_at])?;
    Ok(())
}

pub fn edit_gallery_comment(c: &Connection, owner: &Owner, id: &str, body: &str) -> R<()> {
    c.execute("UPDATE gallery_comments SET body=?3, edited_at=?4 WHERE id=?1 AND profile_id IS ?2", params![id, owner, body, now()])?;
    Ok(())
}

/// Deletes a comment and every reply under it (and replies to those). Returns how many went.
pub fn delete_gallery_comment(c: &Connection, owner: &Owner, id: &str) -> R<usize> {
    let mut gone = vec![id.to_string()];
    let mut i = 0;
    while i < gone.len() {
        let mut s = c.prepare("SELECT id FROM gallery_comments WHERE profile_id IS ?1 AND parent_id=?2")?;
        let kids: Vec<String> = s.query_map(params![owner, gone[i]], |r| r.get(0))?.filter_map(|r| r.ok()).collect();
        gone.extend(kids);
        i += 1;
    }
    let mut n = 0;
    for g in &gone { n += c.execute("DELETE FROM gallery_comments WHERE id=?1 AND profile_id IS ?2", params![g, owner])?; }
    Ok(n)
}

/// Drops every comment under pictures whose key starts with this (a deleted character's pictures, or one removed picture).
pub fn delete_gallery_comments_under(c: &Connection, owner: &Owner, key_prefix: &str) -> R<()> {
    let like = format!("{}%", key_prefix.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"));
    c.execute("DELETE FROM gallery_comments WHERE profile_id IS ?1 AND pic_key LIKE ?2 ESCAPE '\\'", params![owner, like])?;
    Ok(())
}

/// A folder on the computer that the person added to the Gallery, only to look at (nothing in it is ever copied, changed or deleted).
#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct ViewFolder {
    pub id: String,
    pub path: String,
    pub added_at: i64,
    /// The name of a folder made inside the app (its `own` ones); empty for a folder from the computer, which is named after its folder.
    #[serde(default)]
    pub name: String,
    /// True for a gallery folder made in the app, whose pictures live in the app's own data folder (as opposed to a folder from the computer).
    #[serde(default)]
    pub own: bool,
}

/// The most folders one profile can add.
pub const MAX_VIEW_FOLDERS: usize = 40;

pub fn list_view_folders(c: &Connection, owner: &Owner) -> R<Vec<ViewFolder>> {
    let mut s = c.prepare("SELECT id,path,added_at,name,own FROM view_folders WHERE profile_id IS ?1 ORDER BY added_at, rowid")?;
    let rows = s.query_map([owner], |r| Ok(ViewFolder { id: r.get(0)?, path: r.get(1)?, added_at: r.get(2)?, name: r.get(3)?, own: r.get::<_, i64>(4)? != 0 }))?.filter_map(|r| r.ok()).collect();
    Ok(rows)
}

pub fn add_view_folder(c: &Connection, id: &str, path: &str, owner: &Owner) -> R<()> {
    c.execute("INSERT INTO view_folders(id,profile_id,path,added_at) VALUES(?1,?2,?3,?4)", params![id, owner, path, now()])?;
    Ok(())
}

/// Points a folder on the list at a new place (the person moved it).
pub fn set_view_folder_path(c: &Connection, id: &str, path: &str, owner: &Owner) -> R<()> {
    c.execute("UPDATE view_folders SET path=?3 WHERE id=?1 AND profile_id IS ?2", params![id, owner, path])?;
    Ok(())
}

/// After a folder is moved, the comments on its pictures follow them: `disk:<from><sep>x` becomes `disk:<to><sep>x`. Returns how many.
pub fn remap_gallery_comment_keys(c: &Connection, owner: &Owner, from: &str, to: &str) -> R<usize> {
    let sep = std::path::MAIN_SEPARATOR;
    let from_p = format!("disk:{from}{sep}");
    let like = format!("{}%", from_p.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"));
    let n = c.execute(
        "UPDATE gallery_comments SET pic_key = ?3 || substr(pic_key, ?4) WHERE profile_id IS ?1 AND pic_key LIKE ?2 ESCAPE '\\'",
        params![owner, like, format!("disk:{to}{sep}"), from_p.chars().count() as i64 + 1],
    )?;
    Ok(n)
}

/// Adds a gallery folder made in the app: its pictures are kept in `path`, inside the app's own data folder.
pub fn add_own_folder(c: &Connection, id: &str, path: &str, name: &str, owner: &Owner) -> R<()> {
    c.execute("INSERT INTO view_folders(id,profile_id,path,added_at,name,own) VALUES(?1,?2,?3,?4,?5,1)", params![id, owner, path, now(), name])?;
    Ok(())
}

pub fn remove_view_folder(c: &Connection, id: &str, owner: &Owner) -> R<Option<String>> {
    let path: Option<String> = c.query_row("SELECT path FROM view_folders WHERE id=?1 AND profile_id IS ?2", params![id, owner], |r| r.get(0)).optional()?;
    c.execute("DELETE FROM view_folders WHERE id=?1 AND profile_id IS ?2", params![id, owner])?;
    Ok(path)
}

pub fn delete_char_deco(c: &Connection, id: &str, owner: &Owner) -> R<()> {
    c.execute("DELETE FROM char_deco WHERE id=?1 AND profile_id IS ?2", params![id, owner])?;
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
        room_id: r.get(12)?,
        world_persona_off: r.get::<_, i64>(13)? != 0,
    })
}

const CHAT_COLS: &str = "id,dorm_id,name,kind,character_ids,auto_chat,auto_interval_s,turn_mode,max_auto_turns,created_at,updated_at,style,room_id,world_persona_off";

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

/// The room a chat is in now: the one the story moved to, else its dorm's.
pub fn chat_room(c: &Connection, chat: &Chat, owner: &Owner) -> R<Option<Room>> {
    if let Some(r) = chat.room_id { if let Some(room) = get_room(c, r, owner)? { return Ok(Some(room)); } }
    let Some(d) = chat.dorm_id else { return Ok(None) };
    let Some(dorm) = get_dorm(c, d, owner)? else { return Ok(None) };
    match dorm.room_id { Some(r) => get_room(c, r, owner), None => Ok(None) }
}

pub fn set_chat_room(c: &Connection, id: i64, room_id: Option<i64>, owner: &Owner) -> R<()> {
    let room_id = match room_id { Some(r) if get_room(c, r, owner)?.is_some() => Some(r), _ => None };
    c.execute("UPDATE chats SET room_id=?2, updated_at=?4 WHERE id=?1 AND profile_id IS ?3", params![id, room_id, owner, now()])?;
    Ok(())
}

pub fn update_chat(c: &Connection, ch: &Chat, owner: &Owner) -> R<()> {
    c.execute(
        "UPDATE chats SET dorm_id=?2,name=?3,kind=?4,character_ids=?5,auto_chat=?6,auto_interval_s=?7,
         turn_mode=?8,max_auto_turns=?9,updated_at=?10,style=?12,world_persona_off=?13 WHERE id=?1 AND profile_id IS ?11",
        params![
            ch.id, ch.dorm_id, ch.name, ch.kind,
            serde_json::to_string(&ch.character_ids).unwrap_or_default(),
            ch.auto_chat as i64, ch.auto_interval_s.max(5), ch.turn_mode, ch.max_auto_turns.max(1), now(), owner,
            if ch.style == "phone" { "phone" } else { "chat" },
            ch.world_persona_off as i64
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

/// How many messages each character has written across all of this profile's chats (most first): their "most used" ranking.
pub fn character_usage(c: &Connection, owner: &Owner) -> R<Vec<(String, i64)>> {
    let mut s = c.prepare(
        "SELECT m.character_id, COUNT(*) FROM messages m JOIN chats ch ON ch.id = m.chat_id
         WHERE ch.profile_id IS ?1 AND m.role = 'character' AND m.character_id IS NOT NULL
         GROUP BY m.character_id ORDER BY 2 DESC, 1",
    )?;
    let rows = s.query_map([owner], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
    Ok(rows.filter_map(|r| r.ok()).collect())
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

/// There is one kind of persona. What used to be a separate "default persona" (the plain name and "About you" text in the settings) becomes a
/// real persona the first time it is found, so nothing anyone wrote is lost and there are never two of the same person.
pub fn migrate_default_persona(c: &Connection, owner: &Owner) {
    let mut s = get_settings(c, owner);
    let about = s.user_description.trim().to_string();
    if about.is_empty() {
        return;
    }
    let name: String = Some(s.user_name.trim()).filter(|n| !n.is_empty()).unwrap_or("Me").chars().take(60).collect();
    let p = Persona { id: crate::commands::uid(), name, description: about.chars().take(20_000).collect(), style: String::new(), avatar: None, frame: None, created_at: now() };
    if save_persona(c, &p, owner).is_err() {
        return;
    }
    if s.active_persona.is_empty() {
        s.active_persona = p.id;
    }
    s.user_description.clear();
    let _ = save_settings(c, &s, owner);
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
    /// Left out of the list of accounts on the start screen (shown again from Settings).
    pub hidden: bool,
}

fn row_profile(r: &rusqlite::Row) -> R<Profile> {
    Ok(Profile {
        id: r.get(0)?,
        handle: r.get(1)?,
        display_name: r.get(2)?,
        passcode_hash: r.get(3)?,
        created_at: r.get(4)?,
        last_login: r.get(5)?,
        hidden: r.get::<_, i64>(6)? != 0,
    })
}

const PROFILE_COLS: &str = "id,handle,display_name,passcode_hash,created_at,last_login,hidden";

pub fn set_profile_hidden(c: &Connection, id: &str, hidden: bool) -> R<()> {
    c.execute("UPDATE profiles SET hidden=?2 WHERE id=?1", params![id, hidden as i64])?;
    Ok(())
}

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
    c.execute("DELETE FROM room_links WHERE a IN (SELECT id FROM rooms WHERE profile_id IS ?1) OR b IN (SELECT id FROM rooms WHERE profile_id IS ?1)", [owner])?;
    c.execute("DELETE FROM world_lorebooks WHERE world_id IN (SELECT id FROM worlds WHERE profile_id IS ?1)", [owner])?;
    c.execute("DELETE FROM worlds WHERE profile_id IS ?1", [owner])?;
    c.execute("DELETE FROM rooms WHERE profile_id IS ?1", [owner])?;
    c.execute("DELETE FROM decor WHERE profile_id IS ?1", [owner])?;
    c.execute("DELETE FROM prompts WHERE profile_id IS ?1", [owner])?;
    c.execute("DELETE FROM char_status WHERE profile_id IS ?1", [owner])?;
    c.execute("DELETE FROM char_deco WHERE profile_id IS ?1", [owner])?;
    c.execute("DELETE FROM view_folders WHERE profile_id IS ?1", [owner])?;
    c.execute("DELETE FROM gallery_comments WHERE profile_id IS ?1", [owner])?;
    c.execute("DELETE FROM deco_custom WHERE profile_id IS ?1", [owner])?;
    c.execute("DELETE FROM emoji_items WHERE profile_id IS ?1", [owner])?;
    c.execute("DELETE FROM playbooks WHERE profile_id IS ?1", [owner])?;
    c.execute("DELETE FROM shelf_folders WHERE profile_id IS ?1", [owner])?;
    c.execute("DELETE FROM shelf_items WHERE profile_id IS ?1", [owner])?;
    c.execute("DELETE FROM mechanics WHERE profile_id IS ?1", [owner])?;
    c.execute("DELETE FROM notes WHERE profile_id IS ?1", [owner])?;
    c.execute("DELETE FROM folders WHERE profile_id IS ?1", [owner])?;
    c.execute("DELETE FROM lorebooks WHERE profile_id IS ?1", [owner])?;
    c.execute("DELETE FROM personas WHERE profile_id IS ?1", [owner])?;
    c.execute("DELETE FROM chats WHERE profile_id IS ?1", [owner])?;
    c.execute("DELETE FROM dorms WHERE profile_id IS ?1", [owner])?;
    c.execute("DELETE FROM characters WHERE profile_id IS ?1", [owner])?;
    c.execute("DELETE FROM settings WHERE key=?1", [settings_key(owner)])?;
    if let Some(id) = owner {
        c.execute("DELETE FROM profile_avatars WHERE profile_id=?1", [id])?;
        c.execute("DELETE FROM profiles WHERE id=?1", [id])?;
    }
    Ok(())
}

/// Turn the guest space into a named profile: its data moves over and the guest space starts fresh.
pub fn claim_guest(c: &Connection, new_id: &str) -> R<()> {
    for t in ["characters", "dorms", "chats", "rooms", "mechanics", "notes", "folders", "lorebooks", "personas", "decor", "prompts", "char_status", "char_deco", "view_folders", "gallery_comments", "deco_custom", "emoji_items", "worlds", "playbooks", "shelf_folders", "shelf_items"] {
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
    #[test]
    fn comments_follow_a_folder_that_was_moved() {
        let c = fresh();
        let sep = std::path::MAIN_SEPARATOR;
        let key = |root: &str, f: &str| format!("disk:{root}{sep}{f}");
        for (k, who) in [(key("/old/art", "a.png"), "ann"), (key("/old/art", "sub/b.png"), "ann"), (key("/old/artsy", "c.png"), "ann"), (key("/old/art", "a.png"), "bob")] {
            insert_gallery_comment(&c, &me(who), &GalleryComment { id: uid_test(&k, who), pic_key: k, parent_id: None, author: who.into(), body: "hi".into(), created_at: 1, edited_at: None }).unwrap();
        }
        assert_eq!(remap_gallery_comment_keys(&c, &me("ann"), "/old/art", "/new/art").unwrap(), 2, "the folder's own pictures, including those in its subfolders, and nothing else");
        assert_eq!(list_gallery_comments(&c, &me("ann"), &key("/new/art", "a.png")).unwrap().len(), 1);
        assert_eq!(list_gallery_comments(&c, &me("ann"), &key("/new/art", "sub/b.png")).unwrap().len(), 1);
        assert!(list_gallery_comments(&c, &me("ann"), &key("/old/art", "a.png")).unwrap().is_empty());
        assert_eq!(list_gallery_comments(&c, &me("ann"), &key("/old/artsy", "c.png")).unwrap().len(), 1, "a folder with a similar name is untouched");
        assert_eq!(list_gallery_comments(&c, &me("bob"), &key("/old/art", "a.png")).unwrap().len(), 1, "another profile's comments are untouched");
    }
    fn uid_test(k: &str, who: &str) -> String { format!("{who}:{k}") }
    fn ch(id: &str, name: &str) -> Character {
        Character {
            id: id.into(),
            card: CharacterData { name: name.into(), ..Default::default() },
            media: None,
            outfits: vec![],
            gallery: vec![],
            gallery_mode: String::new(),
            outfit: None,
            frame: None,
            folder: None,
            order: None,
            lorebooks: vec![],
            playbook: String::new(),
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
        let room = |n: &str| Room { id: 0, name: n.into(), kind: "kitchen".into(), description: "d".into(), owner_kind: "self".into(), character_id: None, backdrop: "".into(), created_at: 0, music: String::new(), music_name: String::new(), model: String::new(), model_name: String::new(), model_scale: 1.0, model_rot: 0.0, model_y: 0.0, model_share: false, parent_id: None, links: vec![], deco: RoomDeco::default(), world_id: None, gallery: vec![] };
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
        let f = Folder { id: "f1".into(), name: "Crew".into(), cover: None, frame: None, created_at: 1, parent: None, cover_char: None };
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
    fn personas_and_profile_pictures_are_private() {
        let c = fresh();
        let (a, b) = (me("a"), me("b"));
        let p = Persona { id: "p1".into(), name: "Kai".into(), description: "d".into(), style: "s".into(), avatar: Some("media/x.png".into()), frame: Some(Frame { x: 0.2, y: 0.3, zoom: 2.0 }), created_at: 1 };
        save_persona(&c, &p, &a).unwrap();
        assert!(list_personas(&c, &b).unwrap().is_empty() && get_persona(&c, "p1", &b).unwrap().is_none());
        save_persona(&c, &Persona { name: "Stolen".into(), ..p.clone() }, &b).unwrap();
        assert_eq!(get_persona(&c, "p1", &a).unwrap().unwrap().name, "Kai", "B can't overwrite A's persona by reusing the id");
        assert_eq!(get_persona(&c, "p1", &a).unwrap().unwrap().frame, p.frame);
        delete_persona(&c, "p1", &b).unwrap();
        assert!(get_persona(&c, "p1", &a).unwrap().is_some());
        set_profile_avatar(&c, "a", "media/a.gif", Some(Frame { x: 0.1, y: 0.1, zoom: 1.5 })).unwrap();
        assert_eq!(get_profile_avatar(&c, "a").unwrap().0, "media/a.gif");
        assert!(get_profile_avatar(&c, "b").is_none());
        wipe_owner(&c, &a).unwrap();
        assert!(list_personas(&c, &a).unwrap().is_empty() && get_profile_avatar(&c, "a").is_none(), "wiping a profile removes its personas and picture");
    }

    #[test]
    fn decorations_are_private_and_keep_their_sharing_mark() {
        let c = fresh();
        let (a, b) = (me("a"), me("b"));
        let d = DecorItem { id: "d1".into(), name: "Lamp".into(), file: "media/decor-1.glb".into(), bytes: 10, share: false, created_at: 1 };
        save_decor(&c, &d, &a).unwrap();
        assert!(list_decor(&c, &b).unwrap().is_empty() && get_decor(&c, "d1", &b).unwrap().is_none());
        // B can't take over or change A's item by saving with the same id
        save_decor(&c, &DecorItem { name: "Stolen".into(), share: true, ..d.clone() }, &b).unwrap();
        let got = get_decor(&c, "d1", &a).unwrap().unwrap();
        assert_eq!((got.name.as_str(), got.share), ("Lamp", false));
        save_decor(&c, &DecorItem { name: "Desk lamp".into(), share: true, ..d.clone() }, &a).unwrap();
        let got = get_decor(&c, "d1", &a).unwrap().unwrap();
        assert_eq!((got.name.as_str(), got.share, got.file.as_str()), ("Desk lamp", true, "media/decor-1.glb"));
        delete_decor(&c, "d1", &b).unwrap();
        assert!(get_decor(&c, "d1", &a).unwrap().is_some(), "B can't delete A's item");
        wipe_owner(&c, &a).unwrap();
        assert!(list_decor(&c, &a).unwrap().is_empty());
    }

    #[test]
    fn saved_prompts_are_private_to_their_profile() {
        let c = fresh();
        let (a, b) = (me("a"), me("b"));
        let p = SavedPrompt { id: "p1".into(), title: "Soft redirect".into(), body: "[OOC: keep it gentle]".into(), tag: "Style".into(), created_at: 1, updated_at: 1 };
        save_prompt(&c, &p, &a).unwrap();
        assert!(list_prompts(&c, &b).unwrap().is_empty());
        // B can't overwrite or delete A's prompt by using its id
        save_prompt(&c, &SavedPrompt { title: "Stolen".into(), ..p.clone() }, &b).unwrap();
        delete_prompt(&c, "p1", &b).unwrap();
        let got = list_prompts(&c, &a).unwrap();
        assert_eq!((got.len(), got[0].title.as_str(), got[0].body.as_str()), (1, "Soft redirect", "[OOC: keep it gentle]"));
        wipe_owner(&c, &a).unwrap();
        assert!(list_prompts(&c, &a).unwrap().is_empty());
    }

    #[test]
    fn character_statuses_are_private_and_follow_their_character() {
        let c = fresh();
        let (a, b) = (me("a"), me("b"));
        save_character(&c, &ch("x", "X"), &a).unwrap();
        let st = CharStatus { character_id: "x".into(), text: "brewing tea".into(), source: "ai".into(), updated_at: 1 };
        save_status(&c, &st, &a).unwrap();
        assert!(list_statuses(&c, &b).unwrap().is_empty());
        save_status(&c, &CharStatus { text: "stolen".into(), ..st.clone() }, &b).unwrap();
        delete_status(&c, "x", &b).unwrap();
        assert_eq!(list_statuses(&c, &a).unwrap()[0].text, "brewing tea", "B can't change or remove A's status");
        save_status(&c, &CharStatus { text: "napping".into(), source: "user".into(), updated_at: 2, ..st }, &a).unwrap();
        let got = list_statuses(&c, &a).unwrap();
        assert_eq!((got.len(), got[0].text.as_str(), got[0].source.as_str()), (1, "napping", "user"));
        delete_character(&c, "x", &a).unwrap();
        assert!(list_statuses(&c, &a).unwrap().is_empty(), "deleting the character removes the status");
    }

    #[test]
    fn a_gallery_survives_a_save_and_older_characters_still_load() {
        let c = fresh();
        let a = me("a");
        let mut x = ch("x", "X");
        x.gallery = vec![GalleryItem { id: "g1".into(), file: "media/x-gal-1.png".into(), kind: "image".into(), moods: vec!["happy".into(), "laughing".into()], link: String::new() }];
        x.gallery_mode = "mood".into();
        save_character(&c, &x, &a).unwrap();
        let got = get_character(&c, "x", &a).unwrap().unwrap();
        assert_eq!((got.gallery.len(), got.gallery[0].moods.clone(), got.gallery_mode.as_str()), (1, vec!["happy".to_string(), "laughing".to_string()], "mood"));
        // a character saved before galleries existed has neither field
        let old: Character = serde_json::from_str(&serde_json::to_string(&ch("y", "Y")).unwrap().replace(",\"gallery\":[]", "").replace(",\"gallery_mode\":\"\"", "")).unwrap();
        assert!(old.gallery.is_empty() && old.gallery_mode.is_empty());
        assert!(GALLERY_MOODS.contains(&"embarrassed") && GALLERY_MOODS.len() == 12);
    }

    #[test]
    fn character_usage_counts_their_messages_per_profile() {
        let c = fresh();
        let (a, b) = (me("a"), me("b"));
        for id in ["x", "y"] { save_character(&c, &ch(id, id), &a).unwrap(); }
        let chat = create_chat(&c, None, "t", "dm", &["x".to_string()], &a).unwrap();
        for _ in 0..3 { add_message(&c, chat.id, "character", Some("x"), &["hi".to_string()]).unwrap(); }
        add_message(&c, chat.id, "character", Some("y"), &["yo".to_string()]).unwrap();
        add_message(&c, chat.id, "user", None, &["me".to_string()]).unwrap();
        assert_eq!(character_usage(&c, &a).unwrap(), vec![("x".to_string(), 3), ("y".to_string(), 1)], "the user's own messages are not counted");
        assert!(character_usage(&c, &b).unwrap().is_empty(), "another profile sees nothing");
    }

    #[test]
    fn card_order_and_folder_picture_character_survive_a_save() {
        let c = fresh();
        let a = me("a");
        let mut x = ch("x", "X"); x.order = Some(2); save_character(&c, &x, &a).unwrap();
        let mut y = ch("y", "Y"); y.order = Some(0); save_character(&c, &y, &a).unwrap();
        let got = list_characters(&c, &a).unwrap();
        assert_eq!(got.iter().find(|c| c.id == "x").unwrap().order, Some(2));
        assert_eq!(got.iter().find(|c| c.id == "y").unwrap().order, Some(0));
        let f = Folder { id: "f".into(), name: "F".into(), cover: None, frame: None, created_at: 1, parent: None, cover_char: Some("x".into()) };
        save_folder(&c, &f, &a).unwrap();
        assert_eq!(get_folder(&c, "f", &a).unwrap().unwrap().cover_char.as_deref(), Some("x"));
    }

    #[test]
    fn folders_nest_without_loops_and_deleting_moves_things_up() {
        let c = fresh();
        let a = me("a");
        let mk = |id: &str, parent: Option<&str>| Folder { id: id.into(), name: id.into(), cover: None, frame: None, created_at: 1, parent: parent.map(String::from), cover_char: None };
        for f in [mk("canon", None), mk("series", Some("canon")), mk("sub", Some("series"))] { save_folder(&c, &f, &a).unwrap(); }
        let all = list_folders(&c, &a).unwrap();
        assert_eq!(folder_chain(&all, "sub"), vec!["sub", "series", "canon"]);
        assert_eq!(folder_height(&all, "canon", 0), 3);
        assert!(can_nest(&all, "series", None).is_ok());
        assert!(can_nest(&all, "canon", Some("sub")).is_err(), "a folder can't go inside its own subfolder");
        assert!(can_nest(&all, "canon", Some("canon")).is_err(), "or inside itself");
        assert!(can_nest(&all, "sub", Some("canon")).is_ok());
        // depth limit
        let mut deep = vec![mk("d0", None)];
        for i in 1..MAX_FOLDER_DEPTH { deep.push(mk(&format!("d{i}"), Some(&format!("d{}", i - 1)))); }
        deep.push(mk("loose", None));
        assert!(can_nest(&deep, "loose", Some(&format!("d{}", MAX_FOLDER_DEPTH - 1))).is_err(), "too deep");
        assert!(can_nest(&deep, "loose", Some("d0")).is_ok());
        // a looping file can't hang the helpers
        let looped = vec![mk("x", Some("y")), mk("y", Some("x"))];
        assert!(folder_chain(&looped, "x").len() <= 2 && folder_height(&looped, "x", 0) < 100);
        // characters in a deleted folder, and its subfolders, move up one level (not out of everything)
        let mut x = ch("x", "X"); x.folder = Some("series".into()); save_character(&c, &x, &a).unwrap();
        delete_folder(&c, "series", &a).unwrap();
        assert_eq!(get_character(&c, "x", &a).unwrap().unwrap().folder.as_deref(), Some("canon"));
        assert_eq!(get_folder(&c, "sub", &a).unwrap().unwrap().parent.as_deref(), Some("canon"));
        delete_folder(&c, "canon", &a).unwrap();
        assert_eq!(get_character(&c, "x", &a).unwrap().unwrap().folder, None);
        assert_eq!(get_folder(&c, "sub", &a).unwrap().unwrap().parent, None);
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
            insert_profile(&c, &Profile { id: id.into(), handle: id.into(), display_name: id.into(), passcode_hash: None, created_at: 0, last_login: 0, hidden: false }).unwrap();
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
        insert_profile(&c, &Profile { id: "p".into(), handle: "p".into(), display_name: "P".into(), passcode_hash: None, created_at: 0, last_login: 0, hidden: false }).unwrap();
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
        insert_profile(&c, &Profile { id: "1".into(), handle: "Alex".into(), display_name: "A".into(), passcode_hash: None, created_at: 0, last_login: 0, hidden: false }).unwrap();
        assert!(handle_taken(&c, "alex").unwrap() && handle_taken(&c, "ALEX").unwrap() && !handle_taken(&c, "Alexa").unwrap());
        assert!(insert_profile(&c, &Profile { id: "2".into(), handle: "aLeX".into(), display_name: "B".into(), passcode_hash: None, created_at: 0, last_login: 0, hidden: false }).is_err());
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

    #[test]
    fn pathways_nest_rooms_link_them_and_move_a_chat() {
        let c = fresh();
        let (a, b) = (me("a"), me("b"));
        let room = |n: &str| Room { id: 0, name: n.into(), kind: "other".into(), description: "d".into(), owner_kind: "self".into(), character_id: None, backdrop: "".into(), created_at: 0, music: String::new(), music_name: String::new(), model: String::new(), model_name: String::new(), model_scale: 1.0, model_rot: 0.0, model_y: 0.0, model_share: false, parent_id: None, links: vec![], deco: RoomDeco::default(), world_id: None, gallery: vec![] };
        let house = create_room(&c, &room("House"), &a).unwrap();
        let kitchen = create_room(&c, &room("Kitchen"), &a).unwrap();
        let attic = create_room(&c, &room("Attic"), &a).unwrap();
        let theirs = create_room(&c, &room("Theirs"), &b).unwrap();
        set_room_parent(&c, kitchen.id, Some(house.id), &a).unwrap();
        assert_eq!(get_room(&c, kitchen.id, &a).unwrap().unwrap().parent_id, Some(house.id));
        set_room_parent(&c, house.id, Some(kitchen.id), &a).unwrap();
        assert_eq!(get_room(&c, house.id, &a).unwrap().unwrap().parent_id, None, "a room can't end up inside its own sub-room");
        set_room_parent(&c, house.id, Some(house.id), &a).unwrap();
        assert_eq!(get_room(&c, house.id, &a).unwrap().unwrap().parent_id, None, "nor inside itself");
        set_room_parent(&c, attic.id, Some(theirs.id), &a).unwrap();
        assert_eq!(get_room(&c, attic.id, &a).unwrap().unwrap().parent_id, None, "nor inside someone else's room");
        set_room_links(&c, kitchen.id, &[attic.id, theirs.id, kitchen.id], &a).unwrap();
        assert_eq!(get_room(&c, kitchen.id, &a).unwrap().unwrap().links, vec![attic.id], "exits lead to the owner's own other rooms only");
        assert!(get_room(&c, attic.id, &a).unwrap().unwrap().links.is_empty(), "an exit is one-way: the attic has none back");
        set_room_links(&c, attic.id, &[kitchen.id], &a).unwrap();
        assert_eq!(get_room(&c, attic.id, &a).unwrap().unwrap().links, vec![kitchen.id]);
        assert_eq!(get_room(&c, kitchen.id, &a).unwrap().unwrap().links, vec![attic.id], "giving the attic its exits leaves the kitchen's alone");
        let d = create_dorm(&c, "d", Some(house.id), &a).unwrap();
        let ch = create_chat(&c, Some(d.id), "x", "dm", &[], &a).unwrap();
        assert_eq!(chat_room(&c, &ch, &a).unwrap().unwrap().id, house.id, "before any move the chat is in its dorm's room");
        set_chat_room(&c, ch.id, Some(kitchen.id), &a).unwrap();
        let ch = get_chat(&c, ch.id, &a).unwrap().unwrap();
        assert_eq!(chat_room(&c, &ch, &a).unwrap().unwrap().id, kitchen.id);
        set_chat_room(&c, ch.id, Some(theirs.id), &a).unwrap();
        assert_eq!(get_chat(&c, ch.id, &a).unwrap().unwrap().room_id, None, "a chat can't move into someone else's room");
        set_chat_room(&c, ch.id, Some(kitchen.id), &a).unwrap();
        delete_room(&c, house.id, &a).unwrap();
        assert_eq!(get_room(&c, kitchen.id, &a).unwrap().unwrap().parent_id, None, "deleting a house frees its rooms");
        delete_room(&c, kitchen.id, &a).unwrap();
        assert_eq!(get_chat(&c, ch.id, &a).unwrap().unwrap().room_id, None, "deleting the room a chat is in puts it back in its dorm's");
        assert!(get_room(&c, attic.id, &a).unwrap().unwrap().links.is_empty(), "and the exits leading to it go with it");
    }

    #[test]
    fn character_decorations_belong_to_their_owner_and_go_with_the_character() {
        let c = fresh();
        let (a, b) = (me("a"), me("b"));
        let d = CharDeco { character_id: "x".into(), plate: "embers".into(), bg: "boba".into(), wreath: "bobacup".into(), source: "ai".into(), updated_at: 1 };
        save_char_deco(&c, &d, &a).unwrap();
        assert_eq!(list_char_deco(&c, &a).unwrap(), vec![d.clone()]);
        assert!(list_char_deco(&c, &b).unwrap().is_empty(), "another profile sees none of them");
        save_char_deco(&c, &CharDeco { plate: "stolen".into(), ..d.clone() }, &b).unwrap();
        assert_eq!(list_char_deco(&c, &a).unwrap()[0].plate, "embers", "another profile can't overwrite them");
        save_char_deco(&c, &CharDeco { plate: "tide".into(), source: "user".into(), updated_at: 2, ..d.clone() }, &a).unwrap();
        assert_eq!((list_char_deco(&c, &a).unwrap()[0].plate.as_str(), list_char_deco(&c, &a).unwrap()[0].source.as_str()), ("tide", "user"));
        delete_char_deco(&c, "x", &b).unwrap();
        assert_eq!(list_char_deco(&c, &a).unwrap().len(), 1, "another profile can't remove them");
        delete_char_deco(&c, "x", &a).unwrap();
        assert!(list_char_deco(&c, &a).unwrap().is_empty());
    }

    #[test]
    fn the_users_decorations_are_saved_with_their_settings_and_old_settings_still_load() {
        let c = fresh();
        let a = me("a");
        let mut s = get_settings(&c, &a);
        assert_eq!((s.deco.plate.as_str(), s.deco.animate, s.deco.ai_pick), ("none", true, false));
        s.deco.wreath = "lotus".into(); s.deco.ai_pick = true;
        save_settings(&c, &s, &a).unwrap();
        assert_eq!((get_settings(&c, &a).deco.wreath, get_settings(&c, &a).deco.ai_pick), ("lotus".to_string(), true));
        // settings saved before decorations existed have no such field: they get the defaults
        let old: Settings = serde_json::from_str(r#"{"provider":"local","user_name":"Old"}"#).unwrap();
        assert_eq!(old.deco, UserDeco::default());
    }

    #[test]
    fn emoji_and_stickers_work_everywhere_or_in_one_room() {
        let c = fresh();
        let (a, b) = (me("a"), me("b"));
        let it = |id: &str, kind: &str, name: &str, room: Option<i64>| EmojiItem { id: id.into(), kind: kind.into(), name: name.into(), meaning: "m".into(), file: format!("media/emoji-{id}.png"), room_id: room, created_at: 1 };
        let (glob, kit, kit2, stk) = (it("1", "emoji", "party", None), it("2", "emoji", "party", Some(7)), it("3", "emoji", "stove", Some(7)), it("4", "sticker", "shrug", None));
        for x in [&glob, &kit, &kit2, &stk] { save_emoji(&c, x, &a).unwrap(); }
        assert_eq!(list_emoji(&c, &a).unwrap().len(), 4);
        assert!(list_emoji(&c, &b).unwrap().is_empty(), "another profile sees none of them");
        let all = list_emoji(&c, &a).unwrap();
        let names = |room: Option<i64>| { let mut v: Vec<String> = emoji_available(&all, room).iter().map(|i| format!("{}:{}:{}", i.kind, i.name, i.id)).collect(); v.sort(); v };
        assert_eq!(names(None), vec!["emoji:party:1", "sticker:shrug:4"], "outside any room only the ones that work everywhere");
        assert_eq!(names(Some(9)), vec!["emoji:party:1", "sticker:shrug:4"], "another room doesn't get this room's");
        assert_eq!(names(Some(7)), vec!["emoji:party:2", "emoji:stove:3", "sticker:shrug:4"], "in the room: the room's own, and its own :party: wins");
        assert!(emoji_name_taken(&c, "emoji", "party", None, "other", &a).unwrap());
        assert!(!emoji_name_taken(&c, "emoji", "party", None, "1", &a).unwrap(), "renaming it to itself is fine");
        assert!(!emoji_name_taken(&c, "sticker", "party", None, "x", &a).unwrap(), "emoji and stickers have separate names");
        assert!(!emoji_name_taken(&c, "emoji", "party", Some(9), "x", &a).unwrap(), "the same name in another room is fine");
        save_emoji(&c, &EmojiItem { name: "stolen".into(), ..glob.clone() }, &b).unwrap();
        assert_eq!(get_emoji(&c, "1", &a).unwrap().unwrap().name, "party", "another profile can't change them");
        delete_emoji(&c, "1", &b).unwrap();
        assert!(get_emoji(&c, "1", &a).unwrap().is_some(), "or remove them");
        // deleting the room frees what was tied to it
        let r = create_room(&c, &Room { id: 0, name: "R".into(), kind: "other".into(), description: String::new(), owner_kind: "self".into(), character_id: None, backdrop: String::new(), created_at: 0, music: String::new(), music_name: String::new(), model: String::new(), model_name: String::new(), model_scale: 1.0, model_rot: 0.0, model_y: 0.0, model_share: false, parent_id: None, links: vec![], deco: RoomDeco::default(), world_id: None, gallery: vec![] }, &a).unwrap();
        save_emoji(&c, &it("5", "emoji", "tied", Some(r.id)), &a).unwrap();
        delete_room(&c, r.id, &a).unwrap();
        assert_eq!(get_emoji(&c, "5", &a).unwrap().unwrap().room_id, None, "what was tied to a deleted room works everywhere from then on");
    }

    #[test]
    fn a_room_keeps_its_gallery_for_its_owner_only() {
        let c = fresh();
        let (a, b) = (me("a"), me("b"));
        let r = create_room(&c, &Room { id: 0, name: "Attic".into(), kind: "other".into(), description: String::new(), owner_kind: "self".into(), character_id: None, backdrop: String::new(), created_at: 0, music: String::new(), music_name: String::new(), model: String::new(), model_name: String::new(), model_scale: 1.0, model_rot: 0.0, model_y: 0.0, model_share: false, parent_id: None, links: vec![], deco: RoomDeco::default(), world_id: None, gallery: vec![] }, &a).unwrap();
        let pics = vec![RoomPic { id: "p1".into(), file: "media/roompic-1.png".into(), caption: "a cracked blue teapot".into() }];
        set_room_gallery(&c, r.id, &pics, &b).unwrap();
        assert!(get_room(&c, r.id, &a).unwrap().unwrap().gallery.is_empty(), "another profile can't change it");
        set_room_gallery(&c, r.id, &pics, &a).unwrap();
        let g = get_room(&c, r.id, &a).unwrap().unwrap().gallery;
        assert_eq!((g.len(), g[0].caption.as_str()), (1, "a cracked blue teapot"));
    }

    #[test]
    fn the_old_default_persona_becomes_a_real_one_once() {
        let c = fresh();
        let (a, b) = (me("a"), me("b"));
        migrate_default_persona(&c, &a);
        assert!(list_personas(&c, &a).unwrap().is_empty(), "nothing written, nothing made");
        let mut s = get_settings(&c, &a);
        s.user_name = "Sam".into();
        s.user_description = "  Tall and shy.  ".into();
        save_settings(&c, &s, &a).unwrap();
        migrate_default_persona(&c, &a);
        migrate_default_persona(&c, &a);
        let l = list_personas(&c, &a).unwrap();
        assert_eq!((l.len(), l[0].name.as_str(), l[0].description.as_str()), (1, "Sam", "Tall and shy."), "made once, with what was written");
        let after = get_settings(&c, &a);
        assert!(after.user_description.is_empty() && after.active_persona == l[0].id, "it is the one in use, and the old text is not kept twice");
        assert!(list_personas(&c, &b).unwrap().is_empty(), "another profile is untouched");
        // one already chosen stays chosen
        let mut s = get_settings(&c, &b);
        s.user_description = "Quiet.".into();
        s.active_persona = "someone".into();
        save_settings(&c, &s, &b).unwrap();
        migrate_default_persona(&c, &b);
        assert_eq!(get_settings(&c, &b).active_persona, "someone");
    }

    #[test]
    fn worlds_keep_their_rooms_apart_and_carry_lorebooks() {
        let c = fresh();
        let (a, b) = (me("a"), me("b"));
        let mk = |n: &str, w: Option<i64>, o: &Owner| create_room(&c, &Room { id: 0, name: n.into(), kind: "other".into(), description: String::new(), owner_kind: "self".into(), character_id: None, backdrop: String::new(), created_at: 0, music: String::new(), music_name: String::new(), model: String::new(), model_name: String::new(), model_scale: 1.0, model_rot: 0.0, model_y: 0.0, model_share: false, parent_id: None, links: vec![], deco: RoomDeco::default(), world_id: w, gallery: vec![] }, o).unwrap();
        let (w1, w2, wb) = (create_world(&c, "Tevyat", "A big wide world.", &a).unwrap(), create_world(&c, "Earth", "", &a).unwrap(), create_world(&c, "Theirs", "", &b).unwrap());
        assert_eq!(list_worlds(&c, &a).unwrap().len(), 2);
        assert_eq!(list_worlds(&c, &b).unwrap().len(), 1, "another profile's worlds are its own");
        let (r1, r2, r3, r4) = (mk("Mondstadt", Some(w1.id), &a), mk("Cave", Some(w1.id), &a), mk("Home", Some(w2.id), &a), mk("Loose", None, &a));
        assert_eq!(mk("Sneaky", Some(wb.id), &a).world_id, None, "a room can't be put in someone else's world");
        let get = |id: i64| get_room(&c, id, &a).unwrap().unwrap();
        // "part of" and exits never cross between worlds
        set_room_parent(&c, r2.id, Some(r1.id), &a).unwrap();
        set_room_parent(&c, r3.id, Some(r1.id), &a).unwrap();
        set_room_parent(&c, r4.id, Some(r1.id), &a).unwrap();
        assert_eq!((get(r2.id).parent_id, get(r3.id).parent_id, get(r4.id).parent_id), (Some(r1.id), None, None));
        set_room_links(&c, r1.id, &[r2.id, r3.id, r4.id], &a).unwrap();
        assert_eq!(get(r1.id).links, vec![r2.id], "an exit only leads to a room in the same world");
        // moving a room to another world drops the links it can't keep
        move_rooms_to_world(&c, &[r2.id], Some(w2.id), &a).unwrap();
        assert_eq!((get(r2.id).world_id, get(r2.id).parent_id, get(r1.id).links.len()), (Some(w2.id), None, 0));
        // a whole connected set moves together and stays connected
        let (x, y) = (mk("X", Some(w1.id), &a), mk("Y", Some(w1.id), &a));
        set_room_parent(&c, y.id, Some(x.id), &a).unwrap();
        set_room_links(&c, x.id, &[y.id], &a).unwrap();
        move_rooms_to_world(&c, &[x.id, y.id], Some(w2.id), &a).unwrap();
        assert_eq!((get(y.id).world_id, get(y.id).parent_id, get(x.id).links.clone()), (Some(w2.id), Some(x.id), vec![y.id]));
        assert_eq!(move_rooms_to_world(&c, &[x.id], Some(wb.id), &a).map(|_| get(x.id).world_id).unwrap(), None, "someone else's world means no world");
        // lorebooks attached to a world; only the owner's own books count
        let book = Lorebook { id: "book1".into(), name: "Lore".into(), book: serde_json::json!({"entries": []}), created_at: 1, updated_at: 1 };
        save_lorebook(&c, &book, &a).unwrap();
        update_world(&c, w1.id, "Tevyat", "A big wide world.", "Long ago, seven nations rose.", &["book1".into(), "nope".into()], &a).unwrap();
        assert_eq!(get_world(&c, w1.id, &a).unwrap().unwrap().lore, "Long ago, seven nations rose.");
        assert_eq!(get_world(&c, w1.id, &a).unwrap().unwrap().lorebooks, vec!["book1".to_string()]);
        update_world(&c, w1.id, "Hijack", "", "stolen", &[], &b).unwrap();
        assert_eq!(get_world(&c, w1.id, &a).unwrap().unwrap().name, "Tevyat", "another profile can't change it");
        // a chat is in the world of the room it is in
        let d = create_dorm(&c, "d", Some(r1.id), &a).unwrap();
        let ch = create_chat(&c, Some(d.id), "x", "dm", &[], &a).unwrap();
        assert_eq!(chat_world(&c, &ch, &a).unwrap().unwrap().id, w1.id);
        set_chat_room(&c, ch.id, Some(r3.id), &a).unwrap();
        let ch = get_chat(&c, ch.id, &a).unwrap().unwrap();
        assert_eq!(chat_world(&c, &ch, &a).unwrap().unwrap().id, w2.id, "walking into a room in another world changes the world");
        delete_lorebook(&c, "book1", &a).unwrap();
        assert!(get_world(&c, w1.id, &a).unwrap().unwrap().lorebooks.is_empty(), "a deleted lorebook leaves its world");
        // deleting a world keeps its rooms
        delete_world(&c, w1.id, &b).unwrap();
        assert!(get_world(&c, w1.id, &a).unwrap().is_some(), "another profile can't delete it");
        delete_world(&c, w1.id, &a).unwrap();
        assert!(get_world(&c, w1.id, &a).unwrap().is_none() && get(r1.id).world_id.is_none() && get_room(&c, r1.id, &a).unwrap().is_some(), "its rooms are not deleted, only no longer in a world");
    }
}
