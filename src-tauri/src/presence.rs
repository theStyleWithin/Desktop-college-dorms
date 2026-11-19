//! The characters list: whether the model behind the characters is up (the light beside each name), and the short
//! status each character shows (what is on their mind), written by the model in the character's voice or by the user.

use serde::Serialize;
use tauri::State;
use tokio::sync::Notify;

use crate::commands::{e, owner, remote_endpoint};
use crate::db::{self, CharStatus};
use crate::llm::{self, GenParams, Health};
use crate::{llama, Shared};

type R<T> = Result<T, String>;

#[derive(Serialize)]
pub struct HealthOut {
    /// `local` (always green) | `ok` | `warn` | `down` | `none` (not set up)
    pub state: String,
    pub detail: String,
    /// the model's name, for the label
    pub model: String,
    pub checked_at: i64,
}

fn health(state: &str, detail: impl Into<String>, model: impl Into<String>) -> HealthOut {
    HealthOut { state: state.into(), detail: detail.into(), model: model.into(), checked_at: db::now() }
}

/// Is the model that answers for the characters working? A local model is always shown as online;
/// a cloud or network model gets a quick `GET .../models`.
#[tauri::command]
pub async fn provider_health(state: State<'_, Shared>) -> R<HealthOut> {
    let st: Shared = state.inner().clone();
    let o = owner(&st)?;
    let settings = db::get_settings(&st.db.lock().unwrap(), &o);
    let label = match settings.provider.as_str() {
        "openai" => settings.openai_model.clone(),
        "anthropic" => settings.anthropic_model.clone(),
        p if p.starts_with("custom:") => settings.profiles.iter().find(|x| format!("custom:{}", x.id) == p).map(|x| x.model.clone()).unwrap_or_default(),
        _ => String::new(),
    };
    let Some(ep) = remote_endpoint(&st, &o, &settings) else {
        return Ok(health("local", "Local model", ""));
    };
    let ep = match ep {
        Ok(ep) => ep,
        Err(m) => return Ok(health("none", m, label)),
    };
    Ok(match llm::probe(&st.http, &ep).await {
        Health::Ok => health("ok", "", label),
        Health::Warn(m) => health("warn", m, label),
        Health::Down(m) => health("down", m, label),
    })
}

#[tauri::command]
pub fn list_statuses(state: State<'_, Shared>) -> R<Vec<CharStatus>> {
    let o = owner(&state)?;
    db::list_statuses(&state.db.lock().unwrap(), &o).map_err(e)
}

/// One short line: no line breaks or quotes around it, not too long, and not the model refusing or explaining itself.
pub fn clean_status(raw: &str) -> Option<String> {
    let line = raw.lines().map(str::trim).find(|l| !l.is_empty())?;
    let wrap = |c: char| c == '"' || c == '“' || c == '”' || c == '\'' || c == '`' || c == '*';
    let line = line.trim_matches(wrap).trim();
    let line = line.strip_prefix("Status:").or_else(|| line.strip_prefix("status:")).unwrap_or(line).trim();
    let line = line.trim_matches(wrap).trim();
    let line: String = line.chars().filter(|c| !c.is_control()).collect::<String>().split_whitespace().collect::<Vec<_>>().join(" ");
    let low = line.to_lowercase();
    if line.is_empty() || low.contains("as an ai") || low.contains("i cannot") || low.contains("i can't") || low.contains("i'm sorry") || low.contains("language model") {
        return None;
    }
    let out: String = line.chars().take(80).collect();
    Some(out.trim_end().to_string())
}

/// Set (or, with empty text, clear) a character's status by hand.
#[tauri::command]
pub fn set_status(state: State<'_, Shared>, character_id: String, text: String) -> R<Option<CharStatus>> {
    let o = owner(&state)?;
    let db = state.db.lock().unwrap();
    db::get_character(&db, &character_id, &o).map_err(e)?.ok_or("That character doesn't exist any more.")?;
    let t: String = text.chars().filter(|c| !c.is_control()).collect::<String>().trim().chars().take(80).collect();
    if t.is_empty() {
        db::delete_status(&db, &character_id, &o).map_err(e)?;
        return Ok(None);
    }
    let st = CharStatus { character_id, text: t, source: "user".into(), updated_at: db::now() };
    db::save_status(&db, &st, &o).map_err(e)?;
    Ok(Some(st))
}

fn part_of_day() -> &'static str {
    let h = (db::now() / 1000 / 3600 % 24) as u32; // UTC: only a rough hint for the mood
    match h { 5..=11 => "morning", 12..=16 => "afternoon", 17..=21 => "evening", _ => "late at night" }
}

/// Ask the model for what is on this character's mind right now, in their own voice, and keep it as their status.
/// A local model is only used if it is already running (a status is not worth loading a model for).
#[tauri::command]
pub async fn generate_status(state: State<'_, Shared>, character_id: String) -> R<CharStatus> {
    let st: Shared = state.inner().clone();
    let o = owner(&st)?;
    let (ch, settings) = {
        let db = st.db.lock().unwrap();
        (db::get_character(&db, &character_id, &o).map_err(e)?.ok_or("That character doesn't exist any more.")?, db::get_settings(&db, &o))
    };
    let ep = match remote_endpoint(&st, &o, &settings) {
        Some(r) => r?,
        None => {
            let s = llama::status(&st).await;
            if !s.running {
                return Err("The local model isn't running right now. Open a chat to start it, or use a cloud model.".into());
            }
            let port = st.llama.lock().await.port;
            llm::Endpoint::openai(format!("http://127.0.0.1:{port}/v1"), None, "local".into())
        }
    };
    let c = &ch.card;
    let cut = |t: &str, n: usize| t.chars().take(n).collect::<String>();
    let msgs = vec![
        dorms_core::prompt::ChatMsg {
            role: "system".into(),
            content: format!(
                "You write a chat-app custom status for a fictional character. Reply with ONE short line, at most 70 characters: what {name} would put as their status right now, a passing thought or mood in their own voice. No quotation marks, no hashtags, no explanation, nothing explicit or graphic, and never say you are an AI.",
                name = c.name
            ),
        },
        dorms_core::prompt::ChatMsg {
            role: "user".into(),
            content: format!("Character: {}\nAbout them: {}\nPersonality: {}\nIt is {} for them.\nTheir status:", c.name, cut(&c.description, 600), cut(&c.personality, 300), part_of_day()),
        },
    ];
    let params = GenParams { temperature: 0.95, top_p: 0.95, max_tokens: 40 };
    let raw = llm::stream_chat(&st.http, &ep, &msgs, &params, &Notify::new(), |_| {}).await?;
    let text = clean_status(&raw).ok_or("The model didn't give a usable status. Try again.")?;
    let status = CharStatus { character_id, text, source: "ai".into(), updated_at: db::now() };
    let db = st.db.lock().unwrap();
    // the character may have been deleted while the model was thinking
    if db::get_character(&db, &status.character_id, &o).map_err(e)?.is_none() {
        return Err("That character doesn't exist any more.".into());
    }
    db::save_status(&db, &status, &o).map_err(e)?;
    Ok(status)
}

#[cfg(test)]
mod tests {
    use super::clean_status;
    use crate::llm::{probe, Endpoint, Health};
    use std::io::{Read, Write};

    #[test]
    fn a_status_is_one_short_clean_line() {
        assert_eq!(clean_status("\"brewing tea and waiting\"\nextra line").as_deref(), Some("brewing tea and waiting"));
        assert_eq!(clean_status("  Status: *napping*  ").as_deref(), Some("napping"));
        assert_eq!(clean_status("a   b\t c").as_deref(), Some("a b c"));
        assert_eq!(clean_status(&"x".repeat(200)).unwrap().chars().count(), 80);
        assert!(clean_status("").is_none() && clean_status("\n\n").is_none());
        assert!(clean_status("As an AI, I can't have a status").is_none());
        assert!(clean_status("I'm sorry, but I cannot do that").is_none());
    }

    /// A tiny server that answers every request with the given status line.
    fn serve(status: &'static str) -> String {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for s in l.incoming().flatten() {
                let mut s = s;
                let mut buf = [0u8; 2048];
                let _ = s.read(&mut buf);
                let _ = write!(s, "HTTP/1.1 {status}\r\nContent-Length: 2\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{{}}");
            }
        });
        format!("http://127.0.0.1:{port}/v1")
    }

    #[test]
    fn the_light_is_green_amber_or_red_by_what_the_server_says() {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let http = reqwest::Client::new();
        let check = |base: String| rt.block_on(probe(&http, &Endpoint::openai(base, Some("k".into()), "m".into())));
        assert_eq!(check(serve("200 OK")), Health::Ok);
        assert_eq!(check(serve("404 Not Found")), Health::Ok, "a server with no model list is still up");
        assert!(matches!(check(serve("401 Unauthorized")), Health::Warn(_)));
        assert!(matches!(check(serve("429 Too Many Requests")), Health::Warn(_)));
        assert!(matches!(check(serve("503 Service Unavailable")), Health::Down(_)));
        assert!(matches!(check("http://127.0.0.1:1/v1".into()), Health::Down(_)), "nothing there at all");
    }
}
