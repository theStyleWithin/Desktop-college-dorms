use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use dorms_core::prompt::{build_prompt, clean_reply, join_continuation, substitute, HistoryItem, PromptInput, PromptSettings};
use dorms_core::{CardError, CardSpec};
use serde::Serialize;
use serde_json::json;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{Emitter, State};
use tokio::sync::Notify;

use crate::db::{self, ApiProfile, Character, Chat, Dorm, Media, Message, Settings};
use crate::llm::{self, Auth, Endpoint, Extras, GenParams};
use crate::{llama, secrets, AppState, Shared};

type R<T> = Result<T, String>;

/// Largest card file we will parse (cards are normally well under 5 MB).
const MAX_CARD_BYTES: usize = 64 * 1024 * 1024;

fn e<E: std::fmt::Display>(err: E) -> String {
    err.to_string()
}

/// Whose data this session may touch. `None` is the guest space. Chosen by signing in, never by the web view.
fn owner(st: &AppState) -> R<db::Owner> {
    let s = st.session.lock().unwrap();
    if s.chosen { Ok(s.profile.clone()) } else { Err("Pick a profile first.".into()) }
}

/// Secrets (API keys) are kept per profile so people sharing a computer never share keys.
fn skey(o: &db::Owner, name: &str) -> String {
    match o {
        None => name.to_string(),
        Some(id) => format!("{name}@{id}"),
    }
}

fn uid() -> String {
    uuid::Uuid::new_v4().to_string()
}

fn emit(st: &AppState, event: &str, payload: serde_json::Value) {
    let _ = st.app.emit(event, payload);
}

// ---------------------------------------------------------------------------
// App info
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct AppInfo {
    version: &'static str,
    data_dir: String,
    portable: bool,
    platform: &'static str,
    local_engine: bool,
}

#[tauri::command]
pub fn app_info(state: State<'_, Shared>) -> AppInfo {
    AppInfo {
        version: env!("CARGO_PKG_VERSION"),
        data_dir: state.data_dir.to_string_lossy().to_string(),
        portable: cfg!(feature = "portable"),
        platform: std::env::consts::OS,
        local_engine: llama::engine_supported(),
    }
}

// ---------------------------------------------------------------------------
// Characters
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct CharacterOut {
    #[serde(flatten)]
    c: Character,
    media_path: Option<String>,
}

fn out(st: &AppState, c: Character) -> CharacterOut {
    let media_path = c.media.as_ref().map(|m| st.data_dir.join(&m.file).to_string_lossy().to_string());
    CharacterOut { c, media_path }
}

fn raw_body<'a>(req: &'a Request<'_>) -> R<&'a [u8]> {
    match req.body() {
        InvokeBody::Raw(b) => Ok(b.as_slice()),
        _ => Err("Expected a binary payload".into()),
    }
}

fn header(req: &Request<'_>, name: &str) -> String {
    let raw = req.headers().get(name).and_then(|v| v.to_str().ok()).unwrap_or("");
    // header values are percent-encoded by the frontend (file names may be non-ASCII)
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

fn media_kind(file_name: &str) -> R<(&'static str, String)> {
    let ext = std::path::Path::new(file_name)
        .extension()
        .and_then(|x| x.to_str())
        .unwrap_or("")
        .to_lowercase();
    let kind = match ext.as_str() {
        "png" | "jpg" | "jpeg" | "webp" | "avif" | "bmp" => "image",
        "gif" => "gif",
        "mp4" | "webm" | "mov" | "m4v" | "ogv" => "video",
        "vrm" => "vrm",
        _ => return Err("Unsupported file type. Use JPG, PNG, WebP, GIF, MP4/WebM video, or a VRM model.".into()),
    };
    Ok((kind, ext))
}

fn write_media(st: &AppState, char_id: &str, file_name: &str, bytes: &[u8]) -> R<Media> {
    let (kind, ext) = media_kind(file_name)?;
    let rel = format!("media/{char_id}-{}.{ext}", db::now());
    std::fs::write(st.data_dir.join(&rel), bytes).map_err(e)?;
    Ok(Media { kind: kind.into(), file: rel })
}

fn remove_media_file(st: &AppState, m: &Option<Media>) {
    if let Some(m) = m {
        let _ = std::fs::remove_file(st.data_dir.join(&m.file));
    }
}

#[tauri::command]
pub fn list_characters(state: State<'_, Shared>) -> R<Vec<CharacterOut>> {
    let list = db::list_characters(&state.db.lock().unwrap(), &owner(&state)?).map_err(e)?;
    Ok(list.into_iter().map(|c| out(&state, c)).collect())
}

#[tauri::command]
pub fn get_character(state: State<'_, Shared>, id: String) -> R<Option<CharacterOut>> {
    let c = db::get_character(&state.db.lock().unwrap(), &id, &owner(&state)?).map_err(e)?;
    Ok(c.map(|c| out(&state, c)))
}

#[tauri::command]
pub fn save_character(state: State<'_, Shared>, mut character: Character) -> R<CharacterOut> {
    let o = owner(&state)?;
    let db = state.db.lock().unwrap();
    let now = db::now();
    // an id that isn't one of this profile's characters is treated as a new character
    let known = !character.id.is_empty() && db::get_character(&db, &character.id, &o).map_err(e)?.is_some();
    if !known {
        character.id = uid();
        character.created_at = now;
    }
    // media is owned by the backend; never trust the frontend copy
    if let Some(existing) = db::get_character(&db, &character.id, &o).map_err(e)? {
        character.media = existing.media;
        if character.created_at == 0 {
            character.created_at = existing.created_at;
        }
    }
    character.updated_at = now;
    db::save_character(&db, &character, &o).map_err(e)?;
    Ok(out(&state, character))
}

#[tauri::command]
pub fn delete_character(state: State<'_, Shared>, id: String) -> R<()> {
    let o = owner(&state)?;
    let db = state.db.lock().unwrap();
    if let Some(c) = db::get_character(&db, &id, &o).map_err(e)? {
        remove_media_file(&state, &c.media);
    }
    db::delete_character(&db, &id, &o).map_err(e)
}

#[tauri::command]
pub fn set_favorite(state: State<'_, Shared>, id: String, favorite: bool) -> R<()> {
    let o = owner(&state)?;
    let db = state.db.lock().unwrap();
    if let Some(mut c) = db::get_character(&db, &id, &o).map_err(e)? {
        c.favorite = favorite;
        db::save_character(&db, &c, &o).map_err(e)?;
    }
    Ok(())
}

/// Body: raw file bytes. Headers: `x-char-id`, `x-file-name` (percent-encoded).
#[tauri::command]
pub fn set_media(request: Request<'_>, state: State<'_, Shared>) -> R<CharacterOut> {
    let id = header(&request, "x-char-id");
    let name = header(&request, "x-file-name");
    let bytes = raw_body(&request)?;
    let o = owner(&state)?;
    let db = state.db.lock().unwrap();
    let mut c = db::get_character(&db, &id, &o).map_err(e)?.ok_or("Save the character first")?;
    let media = write_media(&state, &id, &name, bytes)?;
    remove_media_file(&state, &c.media);
    c.media = Some(media);
    c.updated_at = db::now();
    db::save_character(&db, &c, &o).map_err(e)?;
    Ok(out(&state, c))
}

#[tauri::command]
pub fn clear_media(state: State<'_, Shared>, id: String) -> R<CharacterOut> {
    let o = owner(&state)?;
    let db = state.db.lock().unwrap();
    let mut c = db::get_character(&db, &id, &o).map_err(e)?.ok_or("Character not found")?;
    remove_media_file(&state, &c.media);
    c.media = None;
    c.updated_at = db::now();
    db::save_character(&db, &c, &o).map_err(e)?;
    Ok(out(&state, c))
}

#[derive(Serialize)]
pub struct ImportOut {
    character: CharacterOut,
    warnings: Vec<String>,
    spec: String,
}

/// Import a character card (.json or .png). Body: file bytes; header `x-file-name`.
/// Error `NO_CARD` means a PNG without card data (the UI offers it as an avatar).
#[tauri::command]
pub fn import_card(request: Request<'_>, state: State<'_, Shared>) -> R<ImportOut> {
    let bytes = raw_body(&request)?;
    let name = header(&request, "x-file-name");
    let is_png = dorms_core::png::is_png(bytes);
    if bytes.len() > MAX_CARD_BYTES {
        return Err(format!("That file is too large to be a character card (over {} MB).", MAX_CARD_BYTES / 1_048_576));
    }
    let parsed = if is_png { dorms_core::import_png(bytes) } else { dorms_core::import_json(bytes) }
        .map_err(|err| match err {
            CardError::NoCardInPng => "NO_CARD".to_string(),
            other => other.to_string(),
        })?;

    let spec = format!("{:?}", parsed.spec);
    let now = db::now();
    let mut ch = Character {
        id: uid(),
        card: parsed.data,
        media: None,
        favorite: false,
        created_at: now,
        updated_at: now,
        last_used: 0,
        trusted: true,
    };
    // Downloaded cards may carry prompt-injection style instructions. Their own system prompt
    // and post-history instructions are used only as lower-priority notes until the user trusts the card.
    let mut warnings = parsed.warnings;
    if !ch.card.system_prompt.trim().is_empty() || !ch.card.post_history_instructions.trim().is_empty() {
        ch.trusted = false;
        warnings.push("This card has its own system prompt or post-history instructions. They are used only as lower-priority notes until you choose to trust the card (Edit → Advanced).".into());
    }
    if ch.card.name.trim().is_empty() {
        let stem = std::path::Path::new(&name).file_stem().and_then(|s| s.to_str()).unwrap_or("Imported character");
        ch.card.name = stem.to_string();
    }
    if is_png {
        ch.media = write_media(&state, &ch.id, "card.png", bytes).ok();
    }
    db::save_character(&state.db.lock().unwrap(), &ch, &owner(&state)?).map_err(e)?;
    Ok(ImportOut { character: out(&state, ch), warnings, spec })
}

/// format: `png` | `json_v2` | `json_v3`
#[tauri::command]
pub fn export_card(state: State<'_, Shared>, id: String, format: String) -> R<Response> {
    let c = db::get_character(&state.db.lock().unwrap(), &id, &owner(&state)?).map_err(e)?.ok_or("Character not found")?;
    let bytes = match format.as_str() {
        "png" => {
            let base = c
                .media
                .as_ref()
                .filter(|m| m.kind == "image" || m.kind == "gif")
                .and_then(|m| std::fs::read(state.data_dir.join(&m.file)).ok());
            dorms_core::export_png(&c.card, base.as_deref()).map_err(e)?
        }
        "json_v3" => dorms_core::export_json(&c.card, CardSpec::V3),
        _ => dorms_core::export_json(&c.card, CardSpec::V2),
    };
    Ok(Response::new(bytes))
}

// ---------------------------------------------------------------------------
// Dorms, chats, messages
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn list_dorms(state: State<'_, Shared>) -> R<Vec<Dorm>> {
    db::list_dorms(&state.db.lock().unwrap(), &owner(&state)?).map_err(e)
}

#[tauri::command]
pub fn create_dorm(state: State<'_, Shared>, name: String) -> R<Dorm> {
    db::create_dorm(&state.db.lock().unwrap(), name.trim(), &owner(&state)?).map_err(e)
}

#[tauri::command]
pub fn rename_dorm(state: State<'_, Shared>, id: i64, name: String) -> R<()> {
    db::rename_dorm(&state.db.lock().unwrap(), id, name.trim(), &owner(&state)?).map_err(e)
}

#[tauri::command]
pub fn delete_dorm(state: State<'_, Shared>, id: i64) -> R<()> {
    db::delete_dorm(&state.db.lock().unwrap(), id, &owner(&state)?).map_err(e)
}

#[tauri::command]
pub fn list_chats(state: State<'_, Shared>) -> R<Vec<Chat>> {
    db::list_chats(&state.db.lock().unwrap(), &owner(&state)?).map_err(e)
}

#[tauri::command]
pub fn create_chat(
    state: State<'_, Shared>,
    dorm_id: Option<i64>,
    name: String,
    kind: String,
    character_ids: Vec<String>,
) -> R<Chat> {
    let o = owner(&state)?;
    let db = state.db.lock().unwrap();
    let kind = if ["dm", "group", "channel"].contains(&kind.as_str()) { kind } else { "dm".into() };
    let chat = db::create_chat(&db, dorm_id, name.trim(), &kind, &character_ids, &o).map_err(e)?;
    // Seed greetings: DMs get the character's, groups get each one's. Channels start empty.
    if kind != "channel" {
        let user = db::get_settings(&db, &o).user_name;
        for id in character_ids.iter().take(if kind == "dm" { 1 } else { usize::MAX }) {
            if let Some(c) = db::get_character(&db, id, &o).map_err(e)? {
                let mut greetings: Vec<String> = vec![];
                if !c.card.first_mes.trim().is_empty() {
                    greetings.push(c.card.first_mes.clone());
                }
                greetings.extend(c.card.alternate_greetings.iter().cloned());
                if kind != "dm" {
                    greetings.truncate(1);
                }
                if greetings.is_empty() {
                    continue;
                }
                let swipes: Vec<String> = greetings.iter().map(|g| substitute(g, &c.card.name, &user, "")).collect();
                db::add_message(&db, chat.id, "character", Some(id), &swipes).map_err(e)?;
            }
        }
    }
    Ok(chat)
}

#[tauri::command]
pub fn update_chat(state: State<'_, Shared>, chat: Chat) -> R<()> {
    db::update_chat(&state.db.lock().unwrap(), &chat, &owner(&state)?).map_err(e)
}

#[tauri::command]
pub fn delete_chat(state: State<'_, Shared>, id: i64) -> R<()> {
    let o = owner(&state)?;
    stop_auto(&state, id);
    db::delete_chat(&state.db.lock().unwrap(), id, &o).map_err(e)
}

#[tauri::command]
pub fn list_messages(state: State<'_, Shared>, chat_id: i64) -> R<Vec<Message>> {
    let o = owner(&state)?;
    let db = state.db.lock().unwrap();
    db::get_chat(&db, chat_id, &o).map_err(e)?.ok_or("Chat not found")?;
    db::list_messages(&db, chat_id).map_err(e)
}

#[tauri::command]
pub fn add_user_message(state: State<'_, Shared>, chat_id: i64, text: String) -> R<Message> {
    let o = owner(&state)?;
    let db = state.db.lock().unwrap();
    db::get_chat(&db, chat_id, &o).map_err(e)?.ok_or("Chat not found")?;
    db::add_message(&db, chat_id, "user", None, &[text]).map_err(e)
}

#[tauri::command]
pub fn edit_message(state: State<'_, Shared>, id: i64, text: String) -> R<Message> {
    let o = owner(&state)?;
    let db = state.db.lock().unwrap();
    if !db::message_owned(&db, id, &o).map_err(e)? {
        return Err("Message not found".into());
    }
    let mut m = db::get_message(&db, id).map_err(e)?.ok_or("Message not found")?;
    let idx = (m.swipe_index.max(0) as usize).min(m.swipes.len().saturating_sub(1));
    if m.swipes.is_empty() {
        m.swipes.push(text);
    } else {
        m.swipes[idx] = text;
    }
    db::save_message_swipes(&db, id, &m.swipes, idx as i64).map_err(e)?;
    Ok(db::get_message(&db, id).map_err(e)?.ok_or("Message not found")?)
}

#[tauri::command]
pub fn delete_message(state: State<'_, Shared>, id: i64) -> R<()> {
    let o = owner(&state)?;
    let db = state.db.lock().unwrap();
    if !db::message_owned(&db, id, &o).map_err(e)? {
        return Err("Message not found".into());
    }
    db::delete_message(&db, id).map_err(e)
}

#[tauri::command]
pub fn set_swipe(state: State<'_, Shared>, id: i64, index: i64) -> R<Message> {
    let o = owner(&state)?;
    let db = state.db.lock().unwrap();
    if !db::message_owned(&db, id, &o).map_err(e)? {
        return Err("Message not found".into());
    }
    let m = db::get_message(&db, id).map_err(e)?.ok_or("Message not found")?;
    let idx = index.clamp(0, m.swipes.len().saturating_sub(1) as i64);
    db::save_message_swipes(&db, id, &m.swipes, idx).map_err(e)?;
    Ok(db::get_message(&db, id).map_err(e)?.ok_or("Message not found")?)
}

#[tauri::command]
pub fn clear_chat(state: State<'_, Shared>, chat_id: i64) -> R<()> {
    let o = owner(&state)?;
    let db = state.db.lock().unwrap();
    db::get_chat(&db, chat_id, &o).map_err(e)?.ok_or("Chat not found")?;
    db::clear_messages(&db, chat_id).map_err(e)
}

// ---------------------------------------------------------------------------
// Settings & keys
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn get_settings(state: State<'_, Shared>) -> R<Settings> {
    Ok(db::get_settings(&state.db.lock().unwrap(), &owner(&state)?))
}

#[tauri::command]
pub fn save_settings(state: State<'_, Shared>, mut settings: Settings) -> R<Settings> {
    settings.context_tokens = settings.context_tokens.clamp(512, 131_072);
    settings.max_tokens = settings.max_tokens.clamp(16, 8192);
    settings.temperature = settings.temperature.clamp(0.0, 2.0);
    settings.top_p = settings.top_p.clamp(0.0, 1.0);
    for p in settings.profiles.iter_mut() {
        p.id = p.id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').collect();
        if p.id.is_empty() {
            p.id = uid();
        }
    }
    db::save_settings(&state.db.lock().unwrap(), &settings, &owner(&state)?).map_err(e)?;
    Ok(settings)
}

#[derive(Serialize)]
pub struct KeyStatus {
    present: bool,
}

/// Secret names: the two built-in providers, or `custom-<profile id>`.
fn check_provider(p: &str) -> R<()> {
    let custom_ok = p.strip_prefix("custom-").map(|id| !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')).unwrap_or(false);
    if p == "openai" || p == "anthropic" || custom_ok { Ok(()) } else { Err("Unknown provider".into()) }
}

#[tauri::command]
pub fn set_api_key(state: State<'_, Shared>, provider: String, key: String) -> R<String> {
    check_provider(&provider)?;
    let o = owner(&state)?;
    if key.trim().is_empty() {
        secrets::delete(&state.data_dir, &skey(&o, &provider));
        return Ok("none".into());
    }
    secrets::set(&state.data_dir, &skey(&o, &provider), key.trim()).map(String::from)
}

#[tauri::command]
pub fn has_api_key(state: State<'_, Shared>, provider: String) -> R<KeyStatus> {
    check_provider(&provider)?;
    let o = owner(&state)?;
    Ok(KeyStatus { present: secrets::get(&state.data_dir, &skey(&o, &provider)).is_some() })
}

// ---------------------------------------------------------------------------
// Local models
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn hardware_info() -> llama::Hardware {
    llama::hardware()
}

#[tauri::command]
pub fn list_models(state: State<'_, Shared>) -> Vec<llama::ModelFile> {
    llama::list_models(&state.data_dir)
}

#[tauri::command]
pub fn delete_model(state: State<'_, Shared>, file: String) -> R<()> {
    llama::delete_model(&state.data_dir, &file)
}

#[tauri::command]
pub async fn download_model(state: State<'_, Shared>, url: String, file: String) -> R<()> {
    let st: Shared = state.inner().clone();
    let cancel = Arc::new(Notify::new());
    let key = format!("dl:{file}");
    st.cancels.lock().unwrap().insert(key.clone(), cancel.clone());
    let res = llama::download_model(&st, &url, &file, &cancel).await;
    st.cancels.lock().unwrap().remove(&key);
    if let Err(err) = &res {
        emit(&st, "dorms://model-progress", json!({ "file": file, "downloaded": 0, "total": 0, "done": true, "error": err }));
    }
    res
}

#[tauri::command]
pub fn cancel_download(state: State<'_, Shared>, file: String) {
    if let Some(n) = state.cancels.lock().unwrap().get(&format!("dl:{file}")) {
        n.notify_one();
    }
}

#[tauri::command]
pub async fn local_engine_status(state: State<'_, Shared>) -> R<llama::Status> {
    Ok(llama::status(&state).await)
}

#[tauri::command]
pub async fn stop_local_engine(state: State<'_, Shared>) -> R<()> {
    llama::stop(&state).await;
    Ok(())
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

/// Turn a user-defined API profile (plus its stored key) into an endpoint.
fn profile_endpoint(st: &AppState, o: &db::Owner, p: &ApiProfile) -> R<Endpoint> {
    if p.base_url.trim().is_empty() {
        return Err(format!("\"{}\" has no address yet. Fill in its base URL in Settings.", p.name));
    }
    if p.model.trim().is_empty() {
        return Err(format!("\"{}\" has no model name yet. Enter one in Settings.", p.name));
    }
    let body = if p.extra_body.trim().is_empty() {
        None
    } else {
        match serde_json::from_str::<serde_json::Value>(&p.extra_body) {
            Ok(v) if v.is_object() => Some(v),
            _ => return Err(format!("The extra JSON body for \"{}\" must be a JSON object, like {{\"key\": \"value\"}}.", p.name)),
        }
    };
    let extras = Extras { headers: p.headers.iter().map(|h| (h.name.clone(), h.value.clone())).collect(), body };
    let key = secrets::get(&st.data_dir, &skey(o, &format!("custom-{}", p.id)));
    let base = p.base_url.trim().to_string();
    if p.format == "anthropic" {
        let key = key.ok_or_else(|| format!("Add the API key for \"{}\" in Settings.", p.name))?;
        return Ok(Endpoint::Anthropic { base, key, model: p.model.trim().to_string(), extras });
    }
    let auth = match p.auth.as_str() {
        "x-api-key" => Auth::XApiKey,
        "header" => Auth::Header(p.auth_header.clone()),
        "none" => Auth::None,
        _ => Auth::Bearer,
    };
    let path = if p.chat_path.trim().is_empty() { "/chat/completions".to_string() } else { p.chat_path.trim().to_string() };
    Ok(Endpoint::OpenAi { base, path, key, auth, model: p.model.trim().to_string(), extras })
}

/// The endpoint to talk to, plus the context window we must stay inside.
async fn resolve_endpoint(st: &Shared, o: &db::Owner, s: &Settings) -> R<(Endpoint, usize)> {
    match s.provider.as_str() {
        "anthropic" => {
            let key = secrets::get(&st.data_dir, &skey(o, "anthropic")).ok_or("Add your Anthropic API key in Settings.")?;
            Ok((Endpoint::Anthropic { base: "https://api.anthropic.com".into(), key, model: s.anthropic_model.clone(), extras: Extras::default() }, s.context_tokens))
        }
        "openai" => {
            let key = secrets::get(&st.data_dir, &skey(o, "openai"));
            Ok((Endpoint::openai(s.openai_base_url.clone(), key, s.openai_model.clone()), s.context_tokens))
        }
        p if p.starts_with("custom:") => {
            let id = &p["custom:".len()..];
            let prof = s.profiles.iter().find(|x| x.id == id).ok_or("The selected Other API no longer exists. Pick another in Settings.")?;
            Ok((profile_endpoint(st, o, prof)?, s.context_tokens))
        }
        _ => {
            let (base, n_ctx) = llama::ensure_running(st, &s.local_model, s.context_tokens, s.local_gpu).await?;
            Ok((Endpoint::openai(base, None, "local".into()), s.context_tokens.min(n_ctx)))
        }
    }
}

fn pick_speaker(chat: &Chat, history: &[&Message], chars: &HashMap<String, Character>) -> String {
    let ids: Vec<&String> = chat.character_ids.iter().filter(|i| chars.contains_key(*i)).collect();
    let last = history.iter().rev().find_map(|m| m.character_id.as_ref());
    let round_robin = || match last.and_then(|l| ids.iter().position(|i| *i == l)) {
        Some(p) => ids[(p + 1) % ids.len()].clone(),
        None => ids[0].clone(),
    };
    match chat.turn_mode.as_str() {
        "random" if ids.len() > 1 => {
            let pool: Vec<&&String> = ids.iter().filter(|i| Some(**i) != last).collect();
            let n = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.subsec_nanos() as usize)
                .unwrap_or(0);
            (*pool[n % pool.len()]).clone()
        }
        "mention" => {
            if let Some(m) = history.last() {
                let text = m.content().to_lowercase();
                for id in &ids {
                    if Some(*id) == last {
                        continue;
                    }
                    let name = chars[*id].card.name.to_lowercase();
                    if !name.is_empty() && text.contains(&name) {
                        return (*id).clone();
                    }
                }
            }
            round_robin()
        }
        _ => round_robin(),
    }
}

struct BusyGuard {
    st: Shared,
    chat_id: i64,
    rid: String,
}

impl Drop for BusyGuard {
    fn drop(&mut self) {
        self.st.busy.lock().unwrap().remove(&self.chat_id);
        self.st.cancels.lock().unwrap().remove(&self.rid);
    }
}

async fn run_generation(
    st: &Shared,
    o: &db::Owner,
    rid: &str,
    chat_id: i64,
    speaker: Option<String>,
    regen: Option<i64>,
    cont: Option<i64>,
    cancel: &Notify,
) -> R<Message> {
    let (settings, chat, chars, msgs) = {
        let db = st.db.lock().unwrap();
        let settings = db::get_settings(&db, o);
        let chat = db::get_chat(&db, chat_id, o).map_err(e)?.ok_or("Chat not found")?;
        let mut chars = HashMap::new();
        for id in &chat.character_ids {
            if let Some(c) = db::get_character(&db, id, o).map_err(e)? {
                chars.insert(id.clone(), c);
            }
        }
        let msgs = db::list_messages(&db, chat_id).map_err(e)?;
        (settings, chat, chars, msgs)
    };
    if chars.is_empty() {
        return Err("This chat has no characters yet. Add one first.".into());
    }

    let (history, target): (Vec<&Message>, Option<&Message>) = match (regen, cont) {
        (Some(mid), _) => {
            let pos = msgs.iter().position(|m| m.id == mid).ok_or("Message not found")?;
            (msgs[..pos].iter().collect(), Some(&msgs[pos]))
        }
        // continuing: the whole chat is history, including the message being extended
        (None, Some(cid)) => {
            let last = msgs.last().ok_or("Message not found")?;
            if last.id != cid {
                return Err("Only the newest message can be continued.".into());
            }
            if last.role != "character" || last.character_id.is_none() {
                return Err("Only a character's message can be continued.".into());
            }
            (msgs.iter().collect(), Some(last))
        }
        (None, None) => (msgs.iter().collect(), None),
    };
    let continuing = cont.is_some() && regen.is_none();

    let speaker_id = match (target, speaker) {
        (Some(m), _) => m.character_id.clone().ok_or("Only character messages can be regenerated or continued")?,
        (None, Some(s)) => s,
        (None, None) => pick_speaker(&chat, &history, &chars),
    };
    let speaker_char = chars.get(&speaker_id).ok_or("That character isn't in this chat")?;

    let items: Vec<HistoryItem> = history
        .iter()
        .filter(|m| m.role != "system")
        .map(|m| {
            let is_user = m.role == "user";
            let name = if is_user {
                settings.user_name.clone()
            } else {
                m.character_id.as_ref().and_then(|i| chars.get(i)).map(|c| c.card.name.clone()).unwrap_or_else(|| "?".into())
            };
            HistoryItem {
                speaker_id: if is_user { None } else { m.character_id.clone() },
                name,
                text: m.content().to_string(),
            }
        })
        .collect();
    let others: Vec<(String, dorms_core::CharacterData)> = chat
        .character_ids
        .iter()
        .filter(|i| **i != speaker_id)
        .filter_map(|i| chars.get(i).map(|c| (i.clone(), c.card.clone())))
        .collect();
    emit(st, "dorms://gen", json!({ "request_id": rid, "chat_id": chat_id, "character_id": speaker_id, "kind": "loading", "continue_of": cont }));
    let (endpoint, context_tokens) = resolve_endpoint(st, o, &settings).await?;
    let ps = PromptSettings {
        user_name: settings.user_name.clone(),
        user_description: settings.user_description.clone(),
        context_tokens,
        max_response_tokens: settings.max_tokens.min(context_tokens / 2),
        use_card_system_prompt: settings.use_card_system_prompt,
        default_system: Some(settings.default_system.clone()).filter(|s| !s.trim().is_empty()),
        default_scan_depth: 4,
        continue_last: continuing,
    };
    let prompt = build_prompt(&PromptInput {
        speaker_id: &speaker_id,
        speaker: &speaker_char.card,
        others: &others,
        history: &items,
        settings: &ps,
        group: chat.kind != "dm",
        trusted: speaker_char.trusted,
    });
    emit(st, "dorms://gen", json!({ "request_id": rid, "chat_id": chat_id, "character_id": speaker_id, "kind": "start", "continue_of": cont }));

    let params = GenParams { temperature: settings.temperature, top_p: settings.top_p, max_tokens: ps.max_response_tokens };
    let full = llm::stream_chat(&st.http, &endpoint, &prompt, &params, cancel, |t| {
        emit(st, "dorms://gen", json!({ "request_id": rid, "chat_id": chat_id, "character_id": speaker_id, "kind": "token", "text": t, "continue_of": cont }));
    })
    .await?;

    // A continuation keeps its leading spacing (it may start a new paragraph); only a stray "Name:" is removed.
    let text = if continuing {
        let prefix = format!("{}:", speaker_char.card.name);
        let t = full.trim_start();
        if t.starts_with(&prefix) { t[prefix.len()..].trim_start().to_string() } else { full.clone() }
    } else {
        clean_reply(&full, &speaker_char.card.name)
    };
    if text.trim().is_empty() {
        return Err("The model returned an empty reply. Try again, or raise the max length in Settings.".into());
    }

    let msg = {
        let db = st.db.lock().unwrap();
        let m = match target {
            // extend the version being shown, in place
            Some(t) if continuing => {
                let mut swipes = t.swipes.clone();
                let idx = (t.swipe_index.max(0) as usize).min(swipes.len().saturating_sub(1));
                let joined = join_continuation(swipes.get(idx).map(String::as_str).unwrap_or(""), &text);
                if swipes.is_empty() {
                    swipes.push(joined);
                } else {
                    swipes[idx] = joined;
                }
                db::save_message_swipes(&db, t.id, &swipes, idx as i64).map_err(e)?;
                db::get_message(&db, t.id).map_err(e)?.ok_or("Message vanished")?
            }
            Some(t) => {
                let mut swipes = t.swipes.clone();
                swipes.push(text);
                let idx = swipes.len() as i64 - 1;
                db::save_message_swipes(&db, t.id, &swipes, idx).map_err(e)?;
                db::get_message(&db, t.id).map_err(e)?.ok_or("Message vanished")?
            }
            None => db::add_message(&db, chat_id, "character", Some(&speaker_id), &[text]).map_err(e)?,
        };
        if let Some(mut c) = db::get_character(&db, &speaker_id, o).map_err(e)? {
            c.last_used = db::now();
            let _ = db::save_character(&db, &c, o);
        }
        m
    };
    emit(st, "dorms://gen", json!({ "request_id": rid, "chat_id": chat_id, "character_id": speaker_id, "kind": "done", "message": msg, "continue_of": cont }));
    Ok(msg)
}

/// One full reply, with busy/cancel bookkeeping and error events.
async fn generate_once(st: &Shared, o: &db::Owner, chat_id: i64, speaker: Option<String>, regen: Option<i64>, cont: Option<i64>, rid: String) -> R<Message> {
    if !st.busy.lock().unwrap().insert(chat_id) {
        let err = "This chat is already generating a reply.".to_string();
        emit(st, "dorms://gen", json!({ "request_id": rid, "chat_id": chat_id, "kind": "error", "error": err }));
        return Err(err);
    }
    let cancel = Arc::new(Notify::new());
    st.cancels.lock().unwrap().insert(rid.clone(), cancel.clone());
    let _guard = BusyGuard { st: st.clone(), chat_id, rid: rid.clone() };
    let res = run_generation(st, o, &rid, chat_id, speaker, regen, cont, &cancel).await;
    if let Err(err) = &res {
        emit(st, "dorms://gen", json!({ "request_id": rid, "chat_id": chat_id, "kind": "error", "error": err }));
    }
    res
}

/// Starts a reply in the background; progress arrives as `dorms://gen` events.
#[tauri::command]
pub fn generate(state: State<'_, Shared>, chat_id: i64, character_id: Option<String>, regenerate_message_id: Option<i64>, continue_message_id: Option<i64>) -> R<String> {
    let o = owner(&state)?;
    let rid = uid();
    let st: Shared = state.inner().clone();
    let r = rid.clone();
    tauri::async_runtime::spawn(async move {
        let _ = generate_once(&st, &o, chat_id, character_id, regenerate_message_id, continue_message_id, r).await;
    });
    Ok(rid)
}

#[tauri::command]
pub fn cancel_generation(state: State<'_, Shared>, request_id: String) {
    if let Some(n) = state.cancels.lock().unwrap().get(&request_id) {
        n.notify_one();
    }
}

#[tauri::command]
pub async fn test_provider(state: State<'_, Shared>) -> R<String> {
    let st: Shared = state.inner().clone();
    let o = owner(&st)?;
    let settings = db::get_settings(&st.db.lock().unwrap(), &o);
    let (ep, _) = resolve_endpoint(&st, &o, &settings).await?;
    let msgs = vec![
        dorms_core::prompt::ChatMsg { role: "system".into(), content: "Reply with one short friendly sentence.".into() },
        dorms_core::prompt::ChatMsg { role: "user".into(), content: "Say hello.".into() },
    ];
    let params = GenParams { temperature: 0.7, top_p: 0.95, max_tokens: 40 };
    let cancel = Notify::new();
    let text = llm::stream_chat(&st.http, &ep, &msgs, &params, &cancel, |_| {}).await?;
    Ok(text.trim().to_string())
}

/// Try a (possibly unsaved) Other API profile with a tiny request.
#[tauri::command]
pub async fn test_profile(state: State<'_, Shared>, profile: ApiProfile) -> R<String> {
    let st: Shared = state.inner().clone();
    let o = owner(&st)?;
    let ep = profile_endpoint(&st, &o, &profile)?;
    let msgs = vec![
        dorms_core::prompt::ChatMsg { role: "system".into(), content: "Reply with one short friendly sentence.".into() },
        dorms_core::prompt::ChatMsg { role: "user".into(), content: "Say hello.".into() },
    ];
    let params = GenParams { temperature: 0.7, top_p: 0.95, max_tokens: 40 };
    let text = llm::stream_chat(&st.http, &ep, &msgs, &params, &Notify::new(), |_| {}).await?;
    Ok(text.trim().to_string())
}

/// Ask an Other API which models it offers, so the user can pick instead of typing.
#[tauri::command]
pub async fn list_remote_models(state: State<'_, Shared>, profile: ApiProfile) -> R<Vec<String>> {
    let st: Shared = state.inner().clone();
    let mut p = profile;
    if p.model.trim().is_empty() {
        p.model = "model".into(); // not needed for listing
    }
    let o = owner(&st)?;
    let ep = profile_endpoint(&st, &o, &p)?;
    llm::list_remote_models(&st.http, &ep).await
}

// ---------------------------------------------------------------------------
// 3D crash guard
// ---------------------------------------------------------------------------

/// WebGL can hard-crash the web view on unsupported graphics setups, which JavaScript can't catch.
/// Before the first 3D attempt we drop a marker file; once a frame has rendered it is removed. If the
/// window dies in between, the next launch finds the marker and skips live 3D instead of crashing again.
/// Returns `false` when a previous attempt never finished.
#[tauri::command]
pub fn vrm_guard_begin(state: State<'_, Shared>) -> bool {
    let p = state.data_dir.join("vrm-guard");
    if p.exists() {
        return false;
    }
    let _ = std::fs::write(&p, b"1");
    true
}

/// `reset` is the user pressing "Try again"; otherwise the first frame rendered fine.
#[tauri::command]
pub fn vrm_guard_end(state: State<'_, Shared>) {
    let _ = std::fs::remove_file(state.data_dir.join("vrm-guard"));
}

// ---------------------------------------------------------------------------
// Auto chat (bots talking to each other)
// ---------------------------------------------------------------------------

fn stop_auto(st: &AppState, chat_id: i64) {
    if let Some(h) = st.autos.lock().unwrap().remove(&chat_id) {
        h.abort();
    }
}

async fn auto_loop(st: Shared, o: db::Owner, chat_id: i64) {
    loop {
        let chat = db::get_chat(&st.db.lock().unwrap(), chat_id, &o).ok().flatten();
        let Some(chat) = chat else { break };
        if !chat.auto_chat {
            break;
        }
        tokio::time::sleep(Duration::from_secs(chat.auto_interval_s.max(5) as u64)).await;

        // Stop after N bot-only turns in a row so an unattended channel can't
        // run (and burn power or API credit) forever.
        let trailing = {
            let db = st.db.lock().unwrap();
            let msgs = db::list_messages(&db, chat_id).unwrap_or_default();
            msgs.iter().rev().take_while(|m| m.role == "character").count() as i64
        };
        if trailing >= chat.max_auto_turns {
            let _ = db::set_auto_chat(&st.db.lock().unwrap(), chat_id, false);
            emit(&st, "dorms://auto-stopped", json!({ "chat_id": chat_id, "reason": "turn_limit" }));
            break;
        }
        if st.busy.lock().unwrap().contains(&chat_id) {
            continue;
        }
        if generate_once(&st, &o, chat_id, None, None, None, uid()).await.is_err() {
            let _ = db::set_auto_chat(&st.db.lock().unwrap(), chat_id, false);
            emit(&st, "dorms://auto-stopped", json!({ "chat_id": chat_id, "reason": "error" }));
            break;
        }
    }
    st.autos.lock().unwrap().remove(&chat_id);
}

#[tauri::command]
pub fn set_auto_chat(state: State<'_, Shared>, chat_id: i64, on: bool) -> R<()> {
    let o = owner(&state)?;
    let st: Shared = state.inner().clone();
    db::get_chat(&st.db.lock().unwrap(), chat_id, &o).map_err(e)?.ok_or("Chat not found")?;
    db::set_auto_chat(&st.db.lock().unwrap(), chat_id, on).map_err(e)?;
    stop_auto(&st, chat_id);
    if on {
        let s2 = st.clone();
        let h = tauri::async_runtime::spawn(auto_loop(s2, o, chat_id));
        st.autos.lock().unwrap().insert(chat_id, h);
    }
    Ok(())
}
