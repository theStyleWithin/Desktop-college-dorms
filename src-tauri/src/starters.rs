//! Starter characters: three friendly built-in characters a new profile begins with, so the roster is not empty. They are added once per
//! profile (or the guest space), only to a profile with nothing in it yet, and are ordinary characters: delete one and it never comes back.

use std::path::Path;

use rusqlite::{params, Connection};
use serde_json::Value;

use crate::db::{self, Character, Media, Owner};
use dorms_core::card::CharacterData;

/// (card, picture) for each starter.
const STARTERS: [(&str, &[u8]); 3] = [
    (include_str!("starters/jeeves.json"), include_bytes!("starters/jeeves.png")),
    (include_str!("starters/scouter.json"), include_bytes!("starters/scouter.png")),
    (include_str!("starters/hal.json"), include_bytes!("starters/hal.png")),
];

fn card(json: &str) -> CharacterData {
    let v: Value = serde_json::from_str(json).expect("starter card is valid JSON");
    let s = |k: &str| v[k].as_str().unwrap_or("").to_string();
    CharacterData {
        name: s("name"),
        description: s("description"),
        personality: s("personality"),
        scenario: s("scenario"),
        first_mes: s("first_mes"),
        mes_example: s("mes_example"),
        system_prompt: s("system_prompt"),
        post_history_instructions: s("post_history_instructions"),
        creator: s("creator"),
        tags: v["tags"].as_array().map(|a| a.iter().filter_map(|t| t.as_str().map(String::from)).collect()).unwrap_or_default(),
        ..Default::default()
    }
}

fn flag_key(owner: &Owner) -> String {
    match owner {
        None => "starters".into(),
        Some(id) => format!("starters:{id}"),
    }
}

/// Adds the starters if this profile has never been offered them and has no characters or chats. Safe to call often.
pub fn ensure(c: &Connection, data_dir: &Path, owner: &Owner) {
    if std::env::var_os("DORMS_NO_STARTERS").is_some() {
        return;
    }
    let key = flag_key(owner);
    if c.query_row("SELECT 1 FROM settings WHERE key=?1", [&key], |_| Ok(())).is_ok() {
        return;
    }
    // Mark first, so a failure half-way never adds them twice.
    if c.execute("INSERT INTO settings(key,value) VALUES(?1,'1')", [&key]).is_err() {
        return;
    }
    let has_characters = db::list_characters(c, owner).map(|l| !l.is_empty()).unwrap_or(true);
    let has_chats = c.query_row("SELECT COUNT(*) FROM chats WHERE profile_id IS ?1", params![owner], |r| r.get::<_, i64>(0)).unwrap_or(1) > 0;
    if has_characters || has_chats {
        return;
    }
    let _ = std::fs::create_dir_all(data_dir.join("media"));
    let now = db::now();
    for (i, (json, png)) in STARTERS.iter().enumerate() {
        let id = crate::commands::uid();
        let rel = format!("media/{id}-{now}.png");
        let media = std::fs::write(data_dir.join(&rel), png).ok().map(|_| Media { kind: "image".into(), file: rel });
        let ch = Character {
            id,
            card: card(json),
            media,
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
            created_at: now + i as i64,
            updated_at: now + i as i64,
            last_used: 0,
            trusted: true,
        };
        let _ = db::save_character(c, &ch, owner);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh() -> (Connection, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("dorms-starters-{}", crate::commands::uid()));
        std::fs::create_dir_all(&dir).unwrap();
        (db::open(&dir.join("t.db")).unwrap(), dir)
    }

    #[test]
    fn the_cards_are_complete() {
        for (json, png) in STARTERS {
            let c = card(json);
            assert!(!c.name.is_empty() && !c.description.is_empty() && !c.first_mes.is_empty() && !png.is_empty());
            let text = [&c.description, &c.personality, &c.scenario, &c.first_mes, &c.mes_example, &c.system_prompt, &c.post_history_instructions].map(|t| t.as_str()).join(" ");
            let bare = text.replace("{{", "").replace("}}", "");
            assert!(!bare.contains('{') && !bare.contains('}'), "placeholders use double braces");
        }
    }

    #[test]
    fn the_scouter_is_kept_safe_for_work() {
        let c = card(STARTERS[1].0);
        assert!(c.system_prompt.contains("SAFE-FOR-WORK") && c.post_history_instructions.contains("safe for work"));
        assert!(!c.scenario.to_lowercase().contains("obscene"));
    }

    #[test]
    fn a_new_profile_gets_them_once_and_deleted_ones_stay_deleted() {
        let (c, dir) = fresh();
        let me: Owner = Some("p1".into());
        ensure(&c, &dir, &me);
        let list = db::list_characters(&c, &me).unwrap();
        assert_eq!(list.len(), 3);
        assert!(list.iter().all(|x| x.media.as_ref().map(|m| dir.join(&m.file).exists()).unwrap_or(false)));
        db::delete_character(&c, &list[0].id, &me).unwrap();
        ensure(&c, &dir, &me);
        assert_eq!(db::list_characters(&c, &me).unwrap().len(), 2, "never added again");
        assert!(db::list_characters(&c, &Some("p2".into())).unwrap().is_empty(), "other profiles are not touched until they are used");
    }

    #[test]
    fn someone_who_already_has_characters_is_left_alone() {
        let (c, dir) = fresh();
        let me: Owner = None;
        let mut ch = Character { id: "x".into(), card: card(STARTERS[0].0), media: None, outfits: vec![], gallery: vec![], gallery_mode: String::new(), outfit: None, frame: None, folder: None, order: None, lorebooks: vec![], playbook: String::new(), favorite: false, created_at: 1, updated_at: 1, last_used: 0, trusted: true };
        ch.card.name = "Mine".into();
        db::save_character(&c, &ch, &me).unwrap();
        ensure(&c, &dir, &me);
        assert_eq!(db::list_characters(&c, &me).unwrap().len(), 1);
    }
}
