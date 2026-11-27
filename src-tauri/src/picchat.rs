//! Talking to a character about the picture or video you are looking at in the Gallery. The character is told what you are looking at (its title, and for a
//! video where you are in it) and, for a picture, can really see it when the model can: the app sends a smaller copy of it with your latest message.
//! A video's frames are never sent, only its title and the time, and the character is told so. Nothing is saved by the app here, and nothing is sent
//! anywhere except to the model you already chose.

use base64::Engine as _;
use image::ImageEncoder;
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use tauri::State;
use tokio::sync::Notify;

use crate::commands::{e, owner, resolve_endpoint};
use crate::tokenator::{build_messages, ChatIn};
use crate::{db, Shared};

type R<T> = Result<T, String>;

/// The longest side of the picture copy that is shown to the model.
const SEE_SIDE: u32 = 1024;

/// What the person is looking at.
#[derive(Deserialize, Clone, Debug)]
pub struct PicRef {
    /// The picture's key in the Gallery: `char:<id>:profile`, `char:<id>:<item>` or `disk:<path>`.
    pub key: String,
    pub title: String,
    #[serde(default)]
    pub note: String,
    /// `image`, `gif` or `video`.
    pub kind: String,
    /// For a video, how far in (seconds) and how long it is.
    #[serde(default)]
    pub at: Option<f64>,
    #[serde(default)]
    pub length: Option<f64>,
}

fn clip(s: &str, n: usize) -> String { let t: String = s.chars().take(n).collect(); t }

fn secs(s: f64) -> String { let s = s.max(0.0) as u64; format!("{}:{:02}", s / 60, s % 60) }

/// What the character is told: who they are (from their card), what is being looked at and whether they can see it.
pub fn system(c: &dorms_core::CharacterData, user: &str, pic: &PicRef, sees: bool) -> String {
    let fill = |t: &str| t.replace("{{char}}", &c.name).replace("{{user}}", user).replace("{{Char}}", &c.name).replace("{{User}}", user);
    let mut s = format!("You are {}, a character in a roleplay app. Stay fully in character and speak the way {} would.\n", c.name, c.name);
    for (label, text) in [("About you", &c.description), ("Your personality", &c.personality), ("The scene", &c.scenario), ("How you always behave", &c.system_prompt)] {
        let t = fill(text.trim());
        if !t.is_empty() { s.push_str(&format!("\n{label}: {}\n", clip(&t, 3000))); }
    }
    let what = match pic.kind.as_str() { "video" => "a video", "gif" => "an animated GIF", _ => "a picture" };
    s.push_str(&format!("\n{user} has the Gallery open and is looking at {what} called \"{}\"", clip(pic.title.trim(), 120)));
    if !pic.note.trim().is_empty() { s.push_str(&format!(" (from \"{}\")", clip(pic.note.trim(), 120))); }
    s.push('.');
    if pic.kind == "video" {
        if let Some(at) = pic.at { s.push_str(&format!(" They are {} into it{}.", secs(at), pic.length.filter(|l| *l > 0.0).map(|l| format!(" (it is {} long)", secs(l))).unwrap_or_default())); }
    }
    s.push_str(" They want to chat with you about it.\n");
    if sees {
        s.push_str("\nThe picture is attached to their latest message, so you can see it. Talk about what is really in it, in your own voice.");
    } else if pic.kind == "video" {
        s.push_str("\nYou cannot see the video itself, only what is written above and what they tell you. Ask them to describe what is happening, and never make up what is on screen.");
    } else {
        s.push_str("\nYou cannot see the picture, only what is written above and what they tell you. Ask them to describe it, and never make up what is in it.");
    }
    s.push_str("\n\nReply in character, like a real conversation: usually one to four sentences unless they ask for more. Never write the other person's lines.");
    s
}

/// Where the picture's file is, if it is one this person's Gallery holds. Pictures from a folder on the computer must be inside a folder on the list.
fn pic_file(st: &crate::AppState, o: &db::Owner, key: &str) -> R<PathBuf> {
    let db = st.db.lock().unwrap();
    if let Some(p) = key.strip_prefix("disk:") {
        let real = Path::new(p).canonicalize().map_err(|_| "That picture isn't there any more.".to_string())?;
        let folders = db::list_view_folders(&db, o).map_err(e)?;
        if folders.iter().any(|f| Path::new(&f.path).canonicalize().map(|r| real.starts_with(r)).unwrap_or(false)) { return Ok(real); }
        return Err("That picture isn't in a Gallery folder.".into());
    }
    let rest = key.strip_prefix("char:").ok_or("That isn't a Gallery picture.")?;
    let (id, item) = rest.split_once(':').ok_or("That isn't a Gallery picture.")?;
    let c = db::get_character(&db, id, o).map_err(e)?.ok_or("That character isn't here any more.")?;
    if item != "profile" {
        if let Some(g) = c.gallery.iter().find(|g| g.id == item).filter(|g| !g.link.is_empty()) { return Ok(PathBuf::from(&g.link)); }   // a file linked in place
    }
    let rel = if item == "profile" { c.media.as_ref().map(|m| m.file.clone()) } else { c.gallery.iter().find(|g| g.id == item).map(|g| g.file.clone()) };
    Ok(st.data_dir.join(rel.ok_or("That picture isn't here any more.")?))
}

/// A smaller copy of a picture (a GIF's first frame) as a JPEG, ready to hand to a model that can see.
pub fn jpeg_data_url(path: &Path) -> R<String> {
    let mut reader = image::ImageReader::open(path).map_err(|x| x.to_string())?.with_guessed_format().map_err(|x| x.to_string())?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(16_384);
    limits.max_image_height = Some(16_384);
    limits.max_alloc = Some(512 * 1024 * 1024);
    reader.limits(limits);
    let img = reader.decode().map_err(|x| format!("That picture can't be read ({x})."))?;
    let rgb = img.thumbnail(SEE_SIDE, SEE_SIDE).to_rgb8();
    let mut out = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 80).write_image(rgb.as_raw(), rgb.width(), rgb.height(), image::ExtendedColorType::Rgb8).map_err(|x| x.to_string())?;
    Ok(format!("data:image/jpeg;base64,{}", base64::engine::general_purpose::STANDARD.encode(out)))
}

/// One turn of a chat with a character about what is on screen. `show` asks to let them see it (a picture, not a video). Returns the reply and whether they really saw it.
#[tauri::command]
pub async fn gallery_chat(state: State<'_, Shared>, character_id: String, messages: Vec<ChatIn>, pic: PicRef, show: bool) -> R<Value> {
    let st: Shared = state.inner().clone();
    let o = owner(&st)?;
    if messages.iter().all(|m| m.role == "assistant") { return Err("Say something first.".into()); }
    let (card, settings) = {
        let db = st.db.lock().unwrap();
        let c = db::get_character(&db, &character_id, &o).map_err(e)?.ok_or("That character isn't here any more.")?;
        (c.card, db::get_settings(&db, &o))
    };
    // a picture copy for the model (not for a video: its frames are never sent)
    let image = if show && pic.kind != "video" {
        let (st2, o2, key) = (st.clone(), o.clone(), pic.key.clone());
        tauri::async_runtime::spawn_blocking(move || pic_file(&st2, &o2, &key).and_then(|p| jpeg_data_url(&p))).await.map_err(|x| x.to_string())?.ok()
    } else { None };
    let user = if settings.user_name.trim().is_empty() { "the person".to_string() } else { settings.user_name.trim().to_string() };
    let (ep, _) = resolve_endpoint(&st, &o, &settings).await?;
    let params = crate::llm::GenParams { temperature: 0.8, top_p: 0.95, max_tokens: 400 };
    let make = |with_image: Option<&String>| -> Vec<Value> {
        let mut history = messages.clone();
        if let (Some(img), Some(last)) = (with_image, history.iter_mut().rev().find(|m| m.role != "assistant")) { last.images = vec![img.clone()]; }
        build_messages(system(&card, &user, &pic, with_image.is_some()), &history)
    };
    let (out, saw) = match &image {
        Some(img) => match crate::llm::stream_chat_values(&st.http, &ep, &make(Some(img)), &params, &Notify::new(), |_| {}).await {
            Ok(t) => (t, true),
            // the model may not be able to see pictures: talk without it rather than fail
            Err(_) => (crate::llm::stream_chat_values(&st.http, &ep, &make(None), &params, &Notify::new(), |_| {}).await.map_err(e)?, false),
        },
        None => (crate::llm::stream_chat_values(&st.http, &ep, &make(None), &params, &Notify::new(), |_| {}).await.map_err(e)?, false),
    };
    let reply = out.trim().to_string();
    if reply.is_empty() { return Err("The model sent back nothing. Try again, or pick a different model.".into()); }
    Ok(json!({ "reply": reply, "saw": saw }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn card() -> dorms_core::CharacterData {
        let mut c = dorms_core::CharacterData::default();
        c.name = "Mira".into(); c.description = "{{char}} is a shy art student who draws {{user}} often.".into(); c.personality = "kind, curious".into();
        c
    }

    #[test]
    fn the_character_is_told_who_they_are_and_what_is_on_screen() {
        let pic = PicRef { key: "disk:/x/a.png".into(), title: "sunset".into(), note: "Trip".into(), kind: "image".into(), at: None, length: None };
        let s = system(&card(), "Sam", &pic, true);
        assert!(s.contains("You are Mira") && s.contains("Mira is a shy art student who draws Sam often.") && s.contains("a picture called \"sunset\"") && s.contains("from \"Trip\""));
        assert!(s.contains("you can see it") && !s.contains("cannot see"));
        assert!(system(&card(), "Sam", &pic, false).contains("You cannot see the picture"));
    }

    #[test]
    fn a_video_is_never_claimed_to_be_seen_and_its_time_is_told() {
        let pic = PicRef { key: "disk:/x/v.mp4".into(), title: "clip".into(), note: String::new(), kind: "video".into(), at: Some(83.4), length: Some(250.0) };
        let s = system(&card(), "Sam", &pic, false);
        assert!(s.contains("a video called \"clip\"") && s.contains("1:23 into it (it is 4:10 long)") && s.contains("cannot see the video"));
    }

    #[test]
    fn a_picture_copy_is_a_small_jpeg_and_a_bad_file_is_refused() {
        let dir = std::env::temp_dir().join(format!("dorms-pc-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("big.png");
        image::RgbImage::from_pixel(3000, 2000, image::Rgb([10, 120, 200])).save(&p).unwrap();
        let url = jpeg_data_url(&p).unwrap();
        assert!(url.starts_with("data:image/jpeg;base64,"));
        let bytes = base64::engine::general_purpose::STANDARD.decode(&url["data:image/jpeg;base64,".len()..]).unwrap();
        let img = image::load_from_memory(&bytes).unwrap();
        assert!(img.width() <= SEE_SIDE && img.height() <= SEE_SIDE && img.width() > 500);
        let bad = dir.join("bad.png");
        std::fs::write(&bad, b"not a picture").unwrap();
        assert!(jpeg_data_url(&bad).is_err());
    }
}
