//! Profile decorations: a nameplate behind a row in the characters list, an animated profile background and an avatar wreath,
//! for the user and for each character. A character's can be chosen by the user, or (when the user allows it) by the model, to suit who
//! the character is. The ids, names and blurbs live in `src/lib/decoData.json` (the page draws the art; see `src/lib/decoCore.js`).

use std::sync::OnceLock;

use serde::Deserialize;
use tauri::State;
use tokio::sync::Notify;

use crate::commands::{e, owner};
use crate::db::{self, CharDeco, UserDeco};
use crate::llm::{self, GenParams};
use crate::presence::quick_endpoint;
use crate::Shared;

type R<T> = Result<T, String>;

#[derive(Deserialize)]
struct Item {
    id: String,
    name: String,
    blurb: String,
}
#[derive(Deserialize)]
struct Banner {
    id: String,
}
#[derive(Deserialize)]
struct Data {
    plates: Vec<Item>,
    backgrounds: Vec<Item>,
    wreaths: Vec<Item>,
    #[serde(rename = "tagColors")]
    tag_colors: Vec<(String, String)>,
    #[serde(rename = "tagGlyphs")]
    tag_glyphs: Vec<(String, String)>,
    banners: Vec<Banner>,
}

fn data() -> &'static Data {
    static D: OnceLock<Data> = OnceLock::new();
    D.get_or_init(|| serde_json::from_str(include_str!("../../src/lib/decoData.json")).expect("decoData.json is valid"))
}

fn has(list: &[Item], id: &str) -> bool {
    list.iter().any(|x| x.id == id)
}

/// A nameplate, background and wreath that are all known ones (anything else becomes "none"/empty).
pub fn clean_look(plate: &str, bg: &str, wreath: &str) -> (String, String, String) {
    let d = data();
    (
        if plate != "none" && has(&d.plates, plate) { plate.into() } else { "none".into() },
        if bg != "none" && has(&d.backgrounds, bg) { bg.into() } else { String::new() },
        if wreath != "none" && has(&d.wreaths, wreath) { wreath.into() } else { String::new() },
    )
}

/// A tag is 2 to 4 letters or numbers, in capitals.
pub fn clean_tag(t: &str) -> String {
    let t: String = t.chars().filter(|c| c.is_ascii_alphanumeric()).take(4).collect::<String>().to_uppercase();
    if t.len() >= 2 { t } else { String::new() }
}

/// The user's own decorations, made safe: only known ids, a clean tag, one of the listed colours and symbols.
pub fn clean_user(mut u: UserDeco) -> UserDeco {
    let d = data();
    let (p, b, w) = clean_look(&u.plate, &u.bg, &u.wreath);
    u.plate = p;
    u.bg = b;
    u.wreath = w;
    u.tag = clean_tag(&u.tag);
    if !d.tag_colors.iter().any(|(c, _)| *c == u.tag_color) {
        u.tag_color = d.tag_colors[0].0.clone();
    }
    if !d.tag_glyphs.iter().any(|(g, _)| *g == u.tag_glyph) {
        u.tag_glyph.clear();
    }
    if !d.banners.iter().any(|b| b.id == u.banner) {
        u.banner.clear();
    }
    u
}

/// A room's decorations and tag, made safe the same way a profile's are.
pub fn clean_room_deco(r: db::RoomDeco) -> db::RoomDeco {
    let u = clean_user(UserDeco { plate: r.plate, bg: r.bg, wreath: r.wreath, tag: r.tag, tag_color: r.tag_color, tag_glyph: r.tag_glyph, ..UserDeco::default() });
    db::RoomDeco { plate: u.plate, bg: u.bg, wreath: u.wreath, tag: u.tag, tag_color: u.tag_color, tag_glyph: u.tag_glyph }
}

#[tauri::command]
pub fn list_char_deco(state: State<'_, Shared>) -> R<Vec<CharDeco>> {
    db::list_char_deco(&state.db.lock().unwrap(), &owner(&state)?).map_err(e)
}

/// Dress a character by hand. Choosing nothing at all takes the decorations off.
#[tauri::command]
pub fn set_char_deco(state: State<'_, Shared>, character_id: String, plate: String, bg: String, wreath: String) -> R<Option<CharDeco>> {
    let o = owner(&state)?;
    let db = state.db.lock().unwrap();
    if db::get_character(&db, &character_id, &o).map_err(e)?.is_none() {
        return Err("That character doesn't exist any more.".into());
    }
    let (plate, bg, wreath) = clean_look(&plate, &bg, &wreath);
    if plate == "none" && bg.is_empty() && wreath.is_empty() {
        db::delete_char_deco(&db, &character_id, &o).map_err(e)?;
        return Ok(None);
    }
    let d = CharDeco { character_id, plate, bg, wreath, source: "user".into(), updated_at: db::now() };
    db::save_char_deco(&db, &d, &o).map_err(e)?;
    Ok(Some(d))
}

#[tauri::command]
pub fn clear_char_deco(state: State<'_, Shared>, character_id: String) -> R<()> {
    db::delete_char_deco(&state.db.lock().unwrap(), &character_id, &owner(&state)?).map_err(e)
}

fn options(list: &[Item]) -> String {
    list.iter().map(|i| format!("{} ({}: {})", i.id, i.name, i.blurb)).collect::<Vec<_>>().join("\n")
}

/// What the model said, reduced to a known nameplate, background and wreath. The model may wrap its answer in words or a code fence;
/// only a JSON object is looked for. `None` if there is nothing usable in it.
pub fn parse_choice(raw: &str) -> Option<(String, String, String)> {
    let start = raw.find('{')?;
    let end = raw.rfind('}')?;
    if end <= start {
        return None;
    }
    let v: serde_json::Value = serde_json::from_str(&raw[start..=end]).ok()?;
    let get = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").trim().to_lowercase();
    let (plate, bg, wreath) = clean_look(&get("plate"), &get("bg"), &get("wreath"));
    if plate == "none" && bg.is_empty() && wreath.is_empty() {
        return None;
    }
    Some((plate, bg, wreath))
}

/// Takes out any part of a choice that is in a holiday set that is closed today (the model was not offered them, but may name one anyway).
pub fn without_locked((plate, bg, wreath): (String, String, String), locked: &[String]) -> (String, String, String) {
    let l = |id: &str| locked.iter().any(|x| x == id);
    (if l(&plate) { "none".into() } else { plate }, if l(&bg) { String::new() } else { bg }, if l(&wreath) { String::new() } else { wreath })
}

/// Ask the model to choose decorations that suit this character, and keep them as theirs. Whatever the user chose by hand is only
/// replaced when they ask for a new pick themselves.
#[tauri::command]
pub async fn generate_char_deco(state: State<'_, Shared>, character_id: String, locked: Option<Vec<String>>) -> R<CharDeco> {
    let locked = locked.unwrap_or_default();
    let st: Shared = state.inner().clone();
    let o = owner(&st)?;
    let (ch, settings) = {
        let db = st.db.lock().unwrap();
        (db::get_character(&db, &character_id, &o).map_err(e)?.ok_or("That character doesn't exist any more.")?, db::get_settings(&db, &o))
    };
    let ep = quick_endpoint(&st, &o, &settings).await?;
    let c = &ch.card;
    let cut = |t: &str, n: usize| t.chars().take(n).collect::<String>();
    let d = data();
    // holiday sets that are closed today are not on offer (the page works out which, from the calendar)
    let open = |list: &[Item]| list.iter().filter(|i| !locked.contains(&i.id)).map(|i| format!("{} ({}: {})", i.id, i.name, i.blurb)).collect::<Vec<_>>().join("\n");
    let msgs = vec![
        dorms_core::prompt::ChatMsg {
            role: "system".into(),
            content: format!(
                "You dress a fictional character's profile in a chat app. Choose ONE nameplate, ONE profile background and ONE avatar wreath that suit {name}'s personality, \
                 style and world. Pick from these lists only, and pick \"none\" for a kind where nothing fits. Prefer a matching look over a random one.\n\n\
                 Nameplates:\n{plates}\n\nBackgrounds:\n{bgs}\n\nWreaths:\n{wreaths}\n\n\
                 Reply with only a JSON object like {{\"plate\":\"<id>\",\"bg\":\"<id>\",\"wreath\":\"<id>\"}} and nothing else.",
                name = c.name,
                plates = open(&d.plates),
                bgs = open(&d.backgrounds),
                wreaths = open(&d.wreaths)
            ),
        },
        dorms_core::prompt::ChatMsg {
            role: "user".into(),
            content: format!(
                "Character: {}\nAbout them: {}\nPersonality: {}\nTags: {}\nTheir decorations:",
                c.name,
                cut(&c.description, 600),
                cut(&c.personality, 300),
                c.tags.join(", ")
            ),
        },
    ];
    let params = GenParams { temperature: 0.7, top_p: 0.95, max_tokens: 90 };
    let raw = llm::stream_chat(&st.http, &ep, &msgs, &params, &Notify::new(), |_| {}).await?;
    let (plate, bg, wreath) = parse_choice(&raw).map(|c| without_locked(c, &locked)).ok_or("The model didn't choose anything usable. Try again.")?;
    if plate == "none" && bg.is_empty() && wreath.is_empty() {
        return Err("The model didn't choose anything usable. Try again.".into());
    }
    let deco = CharDeco { character_id, plate, bg, wreath, source: "ai".into(), updated_at: db::now() };
    let db = st.db.lock().unwrap();
    // the character may have been deleted while the model was thinking
    if db::get_character(&db, &deco.character_id, &o).map_err(e)?.is_none() {
        return Err("That character doesn't exist any more.".into());
    }
    db::save_char_deco(&db, &deco, &o).map_err(e)?;
    Ok(deco)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_known_decorations_are_kept() {
        assert_eq!(clean_look("embers", "boba", "bobacup"), ("embers".into(), "boba".into(), "bobacup".into()));
        assert_eq!(clean_look("nope", "also-nope", "../../etc"), ("none".into(), String::new(), String::new()));
        assert_eq!(clean_look("none", "none", "none"), ("none".into(), String::new(), String::new()));
    }

    #[test]
    fn a_tag_is_two_to_four_clean_capitals() {
        assert_eq!(clean_tag("koi"), "KOI");
        assert_eq!(clean_tag(" a!b?c#d$e "), "ABCD");
        assert_eq!(clean_tag("x"), "");
        assert_eq!(clean_tag("<b>"), "", "one letter is too short");
    }

    #[test]
    fn the_users_own_decorations_are_made_safe() {
        let u = clean_user(UserDeco { plate: "evil".into(), bg: "boba".into(), wreath: "x".into(), tag: "zen!".into(), tag_color: "red".into(), tag_glyph: "💥".into(), banner: "nowhere".into(), ..UserDeco::default() });
        assert_eq!((u.plate.as_str(), u.bg.as_str(), u.wreath.as_str()), ("none", "boba", ""));
        assert_eq!(u.tag, "ZEN");
        assert_eq!(u.tag_color, "#5865f2", "an unknown colour becomes the first one");
        assert_eq!(u.tag_glyph, "");
        assert_eq!(u.banner, "");
        assert!(clean_user(UserDeco { tag_color: "#23a55a".into(), tag_glyph: "★".into(), banner: "dusk".into(), ..UserDeco::default() }).banner == "dusk");
    }

    #[test]
    fn a_rooms_decorations_and_tag_are_made_safe_too() {
        let r = clean_room_deco(db::RoomDeco { plate: "evil".into(), bg: "boba".into(), wreath: "lotus".into(), tag: "inn!".into(), tag_color: "x".into(), tag_glyph: "★".into() });
        assert_eq!((r.plate.as_str(), r.bg.as_str(), r.wreath.as_str(), r.tag.as_str(), r.tag_color.as_str(), r.tag_glyph.as_str()), ("none", "boba", "lotus", "INN", "#5865f2", "★"));
        assert_eq!(clean_room_deco(db::RoomDeco::default()), db::RoomDeco::default(), "an undecorated room stays undecorated");
    }

    #[test]
    fn a_models_choice_is_read_out_of_whatever_it_wrote() {
        assert_eq!(parse_choice(r#"{"plate":"bubbletea","bg":"boba","wreath":"catphones"}"#), Some(("bubbletea".into(), "boba".into(), "catphones".into())));
        assert_eq!(parse_choice("Sure! ```json\n{\"plate\": \"Embers\", \"bg\": \"none\", \"wreath\": \"lotus\"}\n``` hope that helps"), Some(("embers".into(), String::new(), "lotus".into())));
        assert_eq!(parse_choice(r#"{"plate":"made-up","bg":"nope","wreath":"also-made-up"}"#), None, "nothing known means nothing usable");
        assert_eq!(parse_choice(r#"{"plate":"made-up","wreath":"lotus"}"#), Some(("none".into(), String::new(), "lotus".into())), "unknown kinds are dropped, known ones kept");
        assert_eq!(parse_choice("I would choose Embers"), None);
        assert_eq!(parse_choice("}{"), None);
    }

    #[test]
    fn a_closed_holiday_set_is_never_kept_from_the_model() {
        let c = ("hk3".to_string(), "pumpkinsunset".to_string(), "bobacup".to_string());
        let locked = vec!["hk3".to_string(), "pumpkinsunset".to_string()];
        assert_eq!(without_locked(c.clone(), &locked), ("none".to_string(), String::new(), "bobacup".to_string()));
        assert_eq!(without_locked(c.clone(), &[]), c);
        assert!(data().plates.iter().any(|p| p.id == "hk3") && data().backgrounds.iter().any(|p| p.id == "pumpkinsunset"), "the new sets are in the list");
    }

    /// The Rust side reads the ids from decoData.json and the page draws them from decoCore.js: they have to name the same things.
    #[test]
    fn the_data_file_and_the_art_code_agree() {
        let core = include_str!("../../src/lib/decoCore.js");
        let d = data();
        for list in [&d.plates, &d.backgrounds, &d.wreaths] {
            for i in list.iter() {
                assert!(core.contains(&format!("id: '{}'", i.id)), "decoCore.js has no entry {}", i.id);
                assert!(!i.name.is_empty() && !i.blurb.is_empty());
            }
        }
        // every picture that is drawn has an entry in the list, and every entry that is not "none" has a picture
        // the eight Hanukkah nights are drawn in one loop (`wreath['hk' + n] = svg(`), the rest one by one
        let hk = |id: &str, kind: &str| id.len() == 3 && id.starts_with("hk") && core.contains(&format!("{kind}['hk' + n] = svg("));
        for i in d.wreaths.iter().filter(|i| i.id != "none") {
            assert!(hk(&i.id, "wreath") || core.contains(&format!("wreath.{} = svg(", i.id)) || core.contains(&format!("wreath['{}'] = svg(", i.id)), "no art for the wreath {}", i.id);
        }
        for i in d.backgrounds.iter().filter(|i| i.id != "none") {
            assert!(hk(&i.id, "bg") || core.contains(&format!("bg.{} = svg(", i.id)) || core.contains(&format!("bg['{}'] = svg(", i.id)), "no art for the background {}", i.id);
        }
        for i in d.plates.iter().filter(|i| i.id != "none" && !CSS_PLATES.contains(&i.id.as_str())) {
            assert!(hk(&i.id, "plate") || core.contains(&format!("plate.{} = svg(", i.id)) || core.contains(&format!("plate['{}'] = svg(", i.id)), "no art for the nameplate {}", i.id);
        }
    }

    /// The first ten nameplates are drawn by style sheet rules rather than by pictures.
    const CSS_PLATES: [&str; 10] = ["embers", "aurora", "tide", "sakura", "circuit", "starfield", "parchment", "neon", "slime", "prism"];
}
