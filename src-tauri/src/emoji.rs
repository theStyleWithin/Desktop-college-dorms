//! Custom emoji and stickers. An emoji is a small picture used inline as `:name:`; a sticker is a bigger picture sent as a whole message as
//! `[sticker: name]`. Each works everywhere or only in one room, like a server's own, and each has a short meaning so that the characters
//! know when to use it (they are told which ones the current room has, and may use them in their replies). The pictures are copies kept in
//! the app's data folder, never links to where they came from.

use serde::Serialize;
use tauri::{ipc::Request, State};

use crate::commands::{e, header, media_kind, owner, raw_body, uid};
use crate::db::{self, EmojiItem, MAX_EMOJI, MAX_STICKERS};
use crate::Shared;

type R<T> = Result<T, String>;

const MAX_EMOJI_BYTES: usize = 512 * 1024;
const MAX_STICKER_BYTES: usize = 3 * 1024 * 1024;

#[derive(Serialize)]
pub struct EmojiOut {
    #[serde(flatten)]
    pub item: EmojiItem,
    /// Where the picture is (the page turns it into something it can show).
    pub path: String,
}

fn out(st: &Shared, item: EmojiItem) -> EmojiOut {
    let path = st.data_dir.join(&item.file).to_string_lossy().into_owned();
    EmojiOut { item, path }
}

/// A name is lowercase letters, numbers and underscores, 2 to 24 of them (spaces and dashes become underscores).
pub fn clean_name(raw: &str) -> Option<String> {
    let n: String = raw.trim().to_lowercase().chars().map(|c| if c == ' ' || c == '-' { '_' } else { c }).filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == '_').collect();
    let n = n.trim_matches('_').chars().take(24).collect::<String>();
    if n.len() >= 2 { Some(n) } else { None }
}

fn clean_meaning(raw: &str) -> String {
    raw.chars().filter(|c| !c.is_control()).collect::<String>().split_whitespace().collect::<Vec<_>>().join(" ").chars().take(80).collect()
}

fn check_room(db: &rusqlite::Connection, room_id: Option<i64>, o: &db::Owner) -> R<Option<i64>> {
    match room_id {
        None => Ok(None),
        Some(r) => if db::get_room(db, r, o).map_err(e)?.is_some() { Ok(Some(r)) } else { Err("That room doesn't exist any more.".into()) },
    }
}

#[tauri::command]
pub fn list_emoji(state: State<'_, Shared>) -> R<Vec<EmojiOut>> {
    let o = owner(&state)?;
    let items = db::list_emoji(&state.db.lock().unwrap(), &o).map_err(e)?;
    Ok(items.into_iter().map(|i| out(&state, i)).collect())
}

/// Add one: the picture comes as the body, the rest in headers (`x-kind`, `x-name`, `x-meaning`, `x-room-id`, `x-file-name`).
#[tauri::command]
pub fn add_emoji(request: Request<'_>, state: State<'_, Shared>) -> R<EmojiOut> {
    let kind = header(&request, "x-kind");
    let file_name = header(&request, "x-file-name");
    let room_raw = header(&request, "x-room-id");
    let bytes = raw_body(&request)?;
    let o = owner(&state)?;
    if kind != "emoji" && kind != "sticker" {
        return Err("Choose emoji or sticker.".into());
    }
    let (mk, ext) = media_kind(&file_name)?;
    if mk != "image" && mk != "gif" {
        return Err("Emoji and stickers are pictures: PNG, JPG, WebP or GIF.".into());
    }
    let (limit, max_bytes, what) = if kind == "emoji" { (MAX_EMOJI, MAX_EMOJI_BYTES, "emoji") } else { (MAX_STICKERS, MAX_STICKER_BYTES, "stickers") };
    if bytes.is_empty() || bytes.len() > max_bytes {
        return Err(format!("That picture is too big for {what} ({} KB at most).", max_bytes / 1024));
    }
    let stem = std::path::Path::new(&file_name).file_stem().and_then(|x| x.to_str()).unwrap_or("").to_string();
    let wanted = { let n = header(&request, "x-name"); if n.trim().is_empty() { stem } else { n } };
    let name = clean_name(&wanted).ok_or("Give it a name of 2 to 24 letters or numbers.")?;
    let room_id = if room_raw.trim().is_empty() { None } else { Some(room_raw.trim().parse::<i64>().map_err(|_| "That room doesn't exist any more.")?) };
    let db = state.db.lock().unwrap();
    let room_id = check_room(&db, room_id, &o)?;
    if db::list_emoji(&db, &o).map_err(e)?.iter().filter(|i| i.kind == kind).count() >= limit {
        return Err(format!("That's the limit: {limit} {what}. Remove one first."));
    }
    if db::emoji_name_taken(&db, &kind, &name, room_id, "", &o).map_err(e)? {
        return Err(format!("There is already {} called \"{name}\" {}.", if kind == "emoji" { "an emoji" } else { "a sticker" }, if room_id.is_some() { "in that room" } else { "that works everywhere" }));
    }
    let id = uid();
    let rel = format!("media/emoji-{id}.{ext}");
    std::fs::write(state.data_dir.join(&rel), bytes).map_err(e)?;
    let item = EmojiItem { id, kind, name, meaning: clean_meaning(&header(&request, "x-meaning")), file: rel, room_id, created_at: db::now() };
    db::save_emoji(&db, &item, &o).map_err(e)?;
    Ok(out(&state, item))
}

/// Rename it, change what it means, or change where it works (`room_id` empty = everywhere).
#[tauri::command]
pub fn update_emoji(state: State<'_, Shared>, id: String, name: String, meaning: String, room_id: Option<i64>) -> R<EmojiOut> {
    let o = owner(&state)?;
    let db = state.db.lock().unwrap();
    let mut it = db::get_emoji(&db, &id, &o).map_err(e)?.ok_or("That one doesn't exist any more.")?;
    let name = clean_name(&name).ok_or("Give it a name of 2 to 24 letters or numbers.")?;
    let room_id = check_room(&db, room_id, &o)?;
    if db::emoji_name_taken(&db, &it.kind, &name, room_id, &it.id, &o).map_err(e)? {
        return Err(format!("There is already one called \"{name}\" {}.", if room_id.is_some() { "in that room" } else { "that works everywhere" }));
    }
    it.name = name;
    it.meaning = clean_meaning(&meaning);
    it.room_id = room_id;
    db::save_emoji(&db, &it, &o).map_err(e)?;
    Ok(out(&state, it))
}

#[tauri::command]
pub fn delete_emoji(state: State<'_, Shared>, id: String) -> R<()> {
    let o = owner(&state)?;
    let db = state.db.lock().unwrap();
    if let Some(it) = db::get_emoji(&db, &id, &o).map_err(e)? {
        let _ = std::fs::remove_file(state.data_dir.join(&it.file));
        db::delete_emoji(&db, &id, &o).map_err(e)?;
    }
    Ok(())
}

/// What the characters are told about the emoji and stickers they have in this room.
pub fn prompt_block(items: &[EmojiItem], room: Option<i64>) -> String {
    let avail = db::emoji_available(items, room);
    let line = |i: &&EmojiItem, fmt: String| if i.meaning.is_empty() { fmt } else { format!("{fmt} ({})", i.meaning) };
    let emoji: Vec<String> = avail.iter().filter(|i| i.kind == "emoji").map(|i| line(i, format!(":{}:", i.name))).collect();
    let stickers: Vec<String> = avail.iter().filter(|i| i.kind == "sticker").map(|i| line(i, format!("[sticker: {}]", i.name))).collect();
    if emoji.is_empty() && stickers.is_empty() {
        return String::new();
    }
    let mut s = String::from("Custom emoji and stickers are available in this chat. Use them now and then, only when one truly fits the moment, the way a person would; never use one that is not listed.");
    if !emoji.is_empty() {
        s.push_str(&format!("\nEmoji (write the name between colons inside your sentence): {}", emoji.join(", ")));
    }
    if !stickers.is_empty() {
        s.push_str(&format!("\nStickers (to send one, write it on a line of its own, like [sticker: name]): {}", stickers.join(", ")));
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_name_is_small_clean_and_safe() {
        assert_eq!(clean_name("Party Time").as_deref(), Some("party_time"));
        assert_eq!(clean_name("  Wave-2!  ").as_deref(), Some("wave_2"));
        assert_eq!(clean_name("../../etc").as_deref(), Some("etc"));
        assert_eq!(clean_name("a"), None);
        assert_eq!(clean_name("___"), None);
        assert_eq!(clean_name(&"x".repeat(60)).unwrap().len(), 24);
        assert_eq!(clean_name("Ünïcode").as_deref(), Some("ncode"));
    }

    #[test]
    fn what_a_character_is_told_lists_only_what_the_room_has() {
        let it = |kind: &str, name: &str, meaning: &str, room: Option<i64>| EmojiItem { id: name.into(), kind: kind.into(), name: name.into(), meaning: meaning.into(), file: "f.png".into(), room_id: room, created_at: 0 };
        let items = vec![it("emoji", "party", "celebration", None), it("emoji", "stove", "cooking", Some(7)), it("sticker", "shrug", "I don't know", None), it("sticker", "bow", "", Some(7))];
        let none = prompt_block(&items, None);
        assert!(none.contains(":party: (celebration)") && none.contains("[sticker: shrug] (I don't know)"));
        assert!(!none.contains("stove") && !none.contains("bow"), "what is tied to a room is not offered outside it");
        let kitchen = prompt_block(&items, Some(7));
        assert!(kitchen.contains(":stove: (cooking)") && kitchen.contains("[sticker: bow]") && !kitchen.contains("bow ("), "no meaning, no brackets");
        assert_eq!(prompt_block(&[], Some(7)), "");
        assert_eq!(prompt_block(&[it("emoji", "stove", "", Some(7))], None), "", "nothing available means nothing is said");
    }
}
