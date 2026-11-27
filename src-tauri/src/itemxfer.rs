//! Single items moved between two devices over the home Wi-Fi (the "Send to phone" button): a character, a persona, a lorebook, a note or a saved prompt.
//! They travel over the same encrypted channel as a whole profile (see `transfer`). What arrives is looked at first and only added when the person says so,
//! always as a new item (it never replaces one that is already there). A persona's picture is not sent, only its words.

use crate::db;
use serde::{Deserialize, Serialize};

type R<T> = Result<T, String>;

/// The kinds of item that can be sent, besides `profile`.
pub const KINDS: [&str; 5] = ["character", "persona", "lorebook", "note", "prompt"];
const MAX_ITEM: usize = 64 * 1024 * 1024;

pub fn is_item(kind: &str) -> bool { KINDS.contains(&kind) }

/// Packs one item into bytes. Returns its kind, its name and the bytes.
pub fn pack(st: &crate::AppState, kind: &str, id: &str) -> R<(String, String, Vec<u8>)> {
    let o = crate::accounts::owner_now(st)?;
    let c = st.db.lock().unwrap();
    let json = |v: serde_json::Result<Vec<u8>>| v.map_err(|e| e.to_string());
    match kind {
        "character" => {
            let ch = db::get_character(&c, id, &o).map_err(|e| e.to_string())?.ok_or("That character isn't here any more.")?;
            let base = ch.media.as_ref().filter(|m| m.kind == "image" || m.kind == "gif").and_then(|m| std::fs::read(st.data_dir.join(&m.file)).ok());
            let bytes = match dorms_core::export_png(&ch.card, base.as_deref()) {
                Ok(b) => b,
                Err(_) => dorms_core::export_json(&ch.card, dorms_core::CardSpec::V3),
            };
            Ok((kind.into(), ch.card.name.clone(), bytes))
        }
        "persona" => { let p = db::get_persona(&c, id, &o).map_err(|e| e.to_string())?.ok_or("That persona isn't here any more.")?; Ok((kind.into(), p.name.clone(), json(serde_json::to_vec(&p))?)) }
        "lorebook" => { let b = db::list_lorebooks(&c, &o).map_err(|e| e.to_string())?.into_iter().find(|b| b.id == id).ok_or("That lorebook isn't here any more.")?; Ok((kind.into(), b.name.clone(), json(serde_json::to_vec(&b))?)) }
        "note" => { let n = db::list_notes(&c, &o).map_err(|e| e.to_string())?.into_iter().find(|n| n.id == id).ok_or("That note isn't here any more.")?; Ok((kind.into(), n.title.clone(), json(serde_json::to_vec(&n))?)) }
        "prompt" => { let p = db::list_prompts(&c, &o).map_err(|e| e.to_string())?.into_iter().find(|p| p.id == id).ok_or("That prompt isn't here any more.")?; Ok((kind.into(), p.title.clone(), json(serde_json::to_vec(&p))?)) }
        _ => Err("That kind of item can't be sent.".into()),
    }
}

/// What an arrived item is, for the "Add it?" question.
#[derive(Serialize, Debug, PartialEq)]
pub struct ItemInfo { pub kind: String, pub name: String, pub detail: String }

fn clip(s: &str, n: usize) -> String { let t: String = s.chars().take(n).collect(); if s.chars().count() > n { format!("{t}…") } else { t } }

/// Reads what arrived without adding anything.
pub fn describe(kind: &str, bytes: &[u8]) -> R<ItemInfo> {
    if !is_item(kind) { return Err("That isn't a kind of item this version knows.".into()); }
    if bytes.len() > MAX_ITEM { return Err("That is too big to be a single item.".into()); }
    let bad = |_| "What arrived isn't a readable item.".to_string();
    let (name, detail) = match kind {
        "character" => {
            let parsed = if dorms_core::png::is_png(bytes) { dorms_core::import_png(bytes) } else { dorms_core::import_json(bytes) }.map_err(|e| e.to_string())?;
            let c = parsed.data;
            (c.name.clone(), clip(&c.description, 160))
        }
        "persona" => { let p: db::Persona = serde_json::from_slice(bytes).map_err(bad)?; (p.name, clip(&p.description, 160)) }
        "lorebook" => { let b: db::Lorebook = serde_json::from_slice(bytes).map_err(bad)?; let n = b.book.get("entries").and_then(|e| e.as_array()).map(|a| a.len()).unwrap_or(0); (b.name, format!("{n} {}", if n == 1 { "entry" } else { "entries" })) }
        "note" => { let n: db::Note = serde_json::from_slice(bytes).map_err(bad)?; (n.title, clip(&n.body, 160)) }
        _ => { let p: db::SavedPrompt = serde_json::from_slice(bytes).map_err(bad)?; (p.title, clip(&p.body, 160)) }
    };
    Ok(ItemInfo { kind: kind.into(), name, detail })
}

/// Adds what arrived to the open profile as a new item.
pub fn add(st: &crate::AppState, kind: &str, bytes: &[u8]) -> R<ItemInfo> {
    let info = describe(kind, bytes)?;
    let o = crate::accounts::owner_now(st)?;
    let now = db::now();
    let new_id = || uuid::Uuid::new_v4().to_string();
    let bad = |_| "What arrived isn't a readable item.".to_string();
    match kind {
        "character" => { crate::commands::import_bytes(st, bytes, if dorms_core::png::is_png(bytes) { "card.png" } else { "card.json" })?; }
        "persona" => { let mut p: db::Persona = serde_json::from_slice(bytes).map_err(bad)?; p.id = new_id(); p.avatar = None; p.frame = None; p.created_at = now; db::save_persona(&st.db.lock().unwrap(), &p, &o).map_err(|e| e.to_string())?; }
        "lorebook" => { let mut b: db::Lorebook = serde_json::from_slice(bytes).map_err(bad)?; b.id = new_id(); b.created_at = now; b.updated_at = now; db::save_lorebook(&st.db.lock().unwrap(), &b, &o).map_err(|e| e.to_string())?; }
        "note" => { let mut n: db::Note = serde_json::from_slice(bytes).map_err(bad)?; n.id = new_id(); n.pinned = false; n.created_at = now; n.updated_at = now; db::save_note(&st.db.lock().unwrap(), &n, &o).map_err(|e| e.to_string())?; }
        _ => { let mut p: db::SavedPrompt = serde_json::from_slice(bytes).map_err(bad)?; p.id = new_id(); p.created_at = now; p.updated_at = now; db::save_prompt(&st.db.lock().unwrap(), &p, &o).map_err(|e| e.to_string())?; }
    }
    Ok(info)
}

/// Looks inside the item that arrived (the staging place holds its bytes).
#[tauri::command]
pub fn inspect_staged_item(state: tauri::State<'_, crate::Shared>, token: String, kind: String) -> R<ItemInfo> {
    let bytes = crate::accounts::staged_bytes(&state, &token)?;
    describe(&kind, &bytes)
}

/// Adds the item that arrived, as a new item, and clears the staging place.
#[tauri::command]
pub fn add_staged_item(state: tauri::State<'_, crate::Shared>, token: String, kind: String) -> R<ItemInfo> {
    let bytes = crate::accounts::staged_bytes(&state, &token)?;
    let info = add(&state, &kind, &bytes)?;
    *state.staged.lock().unwrap() = None;
    crate::transfer::clear_receive(&state);
    Ok(info)
}

#[derive(Deserialize)]
pub struct ItemRef { pub kind: String, pub id: String }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn what_arrived_is_described_and_bad_data_is_refused() {
        let n = db::Note { id: "x".into(), title: "Trip".into(), body: "Pack the tent.".into(), pinned: true, created_at: 1, updated_at: 1 };
        let i = describe("note", &serde_json::to_vec(&n).unwrap()).unwrap();
        assert_eq!(i, ItemInfo { kind: "note".into(), name: "Trip".into(), detail: "Pack the tent.".into() });
        let b = db::Lorebook { id: "l".into(), name: "Lore".into(), book: serde_json::json!({"entries": [{}, {}]}), created_at: 1, updated_at: 1 };
        assert_eq!(describe("lorebook", &serde_json::to_vec(&b).unwrap()).unwrap().detail, "2 entries");
        assert!(describe("note", b"not json").is_err());
        assert!(describe("profile", b"{}").is_err());
        assert!(describe("persona", &vec![0u8; MAX_ITEM + 1]).is_err());
    }
}
