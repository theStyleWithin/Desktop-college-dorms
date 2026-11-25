//! Tokenator: a small helper in the character editor. It asks the person's own model (built-in, cloud, Other API or network) to trim a field of a
//! card to a token budget or to draft a field from rough notes. It never saves anything: the editor shows the result and the person accepts it.

use tauri::State;
use tokio::sync::Notify;

use crate::commands::{e, owner, resolve_endpoint};
use crate::db;
use crate::Shared;
use dorms_core::prompt::ChatMsg;

type R<T> = Result<T, String>;

pub const MAX_TEXT: usize = 12_000;
pub const MAX_NOTES: usize = 4_000;

/// The card fields Tokenator can work on, with what each one is for.
pub fn field_guide(field: &str) -> Option<&'static str> {
    Some(match field {
        "description" => "the description: who the character is (looks, background, personality, how they behave), written as plain facts the model can use",
        "personality" => "the personality: a short list of traits, not a story",
        "scenario" => "the scenario: where and when the conversation happens and what the situation is",
        "first_mes" => "the first message: the character's opening message in their own voice, which sets how long and in what style they will reply",
        "mes_example" => "example dialogue between {{user}} and {{char}} that shows how the character speaks; separate examples with a line containing <START>",
        "system_prompt" => "the system prompt: instructions for how the model should play this character",
        "post_history_instructions" => "post-history instructions: a short reminder placed right before the model replies",
        _ => return None,
    })
}

/// About how many words a token budget allows (a token is a bit under a word).
pub fn words_for(tokens: usize) -> usize {
    (tokens as f64 * 0.75).round() as usize
}

pub fn system_for(mode: &str, field: &str, target: usize) -> R<String> {
    let guide = field_guide(field).ok_or("Tokenator can't work on that part of a card.")?;
    let words = words_for(target.max(20));
    match mode {
        "trim" => Ok(format!(
            "You are Tokenator, a careful editor of AI character cards. Rewrite the text you are given, which is {guide}, so that it uses about {target} tokens (about {words} words) or fewer. \
             Keep every fact, name, trait and way of speaking that matters. Cut repetition, filler, flowery wording and anything the model does not need. \
             Keep the same format: keep {{{{char}}}} and {{{{user}}}} as they are, keep *actions* and \"quotes\", keep <START> lines. Do not add anything new. \
             Reply with only the rewritten text: no introduction, no notes, no code block."
        )),
        "draft" => Ok(format!(
            "You are Tokenator, who helps people write AI character cards. From the person's notes, write {guide}. Use about {words} words (about {target} tokens) or fewer. \
             Use {{{{char}}}} for the character and {{{{user}}}} for the person talking to them. Use only what the notes and the card so far say; invent nothing important. \
             Reply with only the text for that field: no introduction, no notes, no code block."
        )),
        _ => Err("Tokenator doesn't know that job.".into()),
    }
}

/// What the model wrote, tidied: no code fence, no "Here is…" line, no quotes around the whole thing.
pub fn clean_reply(raw: &str) -> String {
    let mut t = raw.trim().to_string();
    if t.starts_with("```") {
        t = t.trim_start_matches("```").trim_start_matches(|c: char| c.is_alphanumeric()).trim_start_matches('\n').to_string();
        if let Some(i) = t.rfind("```") { t.truncate(i); }
        t = t.trim().to_string();
    }
    let first = t.lines().next().unwrap_or("").to_lowercase();
    if (first.starts_with("here is") || first.starts_with("here's") || first.starts_with("sure")) && first.trim_end().ends_with(':') {
        t = t.lines().skip(1).collect::<Vec<_>>().join("\n").trim().to_string();
    }
    if t.len() > 2 && t.starts_with('"') && t.ends_with('"') && t.matches('"').count() == 2 {
        t = t[1..t.len() - 1].trim().to_string();
    }
    t
}

pub fn clip(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

/// The message sent to the model for a card-field job: the text to trim, or the person's notes after what the card says so far.
pub fn user_for(mode: &str, text: &str, notes: &str, context: &str) -> R<String> {
    if mode == "trim" {
        let t = clip(text, MAX_TEXT);
        if t.trim().is_empty() { return Err("There is nothing there to shorten yet.".into()); }
        Ok(t)
    } else {
        let n = clip(notes, MAX_NOTES);
        if n.trim().is_empty() { return Err("Tell Tokenator a little about the character first.".into()); }
        let ctx = clip(context, 3000);
        Ok(format!("{}Notes from the person:\n{n}", if ctx.trim().is_empty() { String::new() } else { format!("The card so far:\n{ctx}\n\n") }))
    }
}

/// One ask to the person's own model (whatever they set up: built-in, cloud, Other API or network).
async fn ask_model(st: &Shared, o: &crate::db::Owner, system: String, user: String, temperature: f32, max_tokens: usize) -> R<String> {
    let settings = db::get_settings(&st.db.lock().unwrap(), o);
    let (ep, _) = resolve_endpoint(st, o, &settings).await?;
    let msgs = vec![ChatMsg { role: "system".into(), content: system }, ChatMsg { role: "user".into(), content: user }];
    let params = crate::llm::GenParams { temperature, top_p: 0.95, max_tokens: max_tokens.min(4096) };
    let out = crate::llm::stream_chat(&st.http, &ep, &msgs, &params, &Notify::new(), |_| {}).await.map_err(e)?;
    Ok(out)
}

/// Ask the model to trim (`mode` "trim", with the text) or draft (`mode` "draft", with the person's notes and what the card says so far).
#[tauri::command]
pub async fn tokenator_run(state: State<'_, Shared>, mode: String, field: String, text: String, notes: String, context: String, target_tokens: usize) -> R<String> {
    let st: Shared = state.inner().clone();
    let o = owner(&st)?;
    let target = target_tokens.clamp(20, 4000);
    let system = system_for(&mode, &field, target)?;
    let user = user_for(&mode, &text, &notes, &context)?;
    let out = ask_model(&st, &o, system, user, if mode == "trim" { 0.3 } else { 0.7 }, target * 2 + 64).await?;
    let out = clean_reply(&out);
    if out.is_empty() { return Err("The model sent back nothing. Try again, or pick a different model.".into()); }
    Ok(out)
}

// ----- other things Tokenator can write -----

pub const MAX_IDEA: usize = 2_000;

/// The instructions for each thing Tokenator can make (besides card fields).
pub fn make_system(kind: &str) -> R<&'static str> {
    match kind {
        "prompt" => Ok("You are Tokenator, who helps people write saved prompts for AI roleplay chats. A saved prompt is a short piece of text the person sends into a chat as their own message or instruction, for example a gentle redirect, a nudge for the scene, a reminder about style or length. \
             From the person's idea, write one. Make it clear and short, written so it can be sent as it is. Use {{char}} for the character and {{user}} for the person where it helps. \
             Reply in exactly this form and nothing else:\n\
             TITLE: a short title of under eight words\n\
             LABEL: one or two words, or leave this empty\n\
             TEXT:\n\
             the prompt itself"),
        "lorebook" => Ok("You are Tokenator, who helps people write lorebooks for AI roleplay. A lorebook is a set of short entries about a world: places, people, groups, rules, objects. Each entry has trigger keywords; when one of them appears in the chat, the entry's text is added to what the AI knows. \
             From the person's idea, write between 3 and 8 entries (or the number they ask for, at most 12). Each entry has a short name, 2 to 6 keywords someone would really type, and 1 to 4 sentences of plain facts. Do not repeat entries that already exist. \
             Reply in exactly this form, with a blank line between entries, and nothing else:\n\
             ENTRY: the name\n\
             KEYS: a keyword, another keyword\n\
             TEXT: the facts"),
        _ => Err("Tokenator can't write that yet.".into()),
    }
}

/// Reads the model's answer for a lorebook into entries (name, keys, text). Lenient about numbering and bullets; an entry with no text is dropped,
/// and one with no keys gets its name as the key. At most 12 entries, 8 keys each.
pub fn parse_lore_entries(raw: &str) -> R<Vec<(String, Vec<String>, String)>> {
    let t = clean_reply(raw);
    let mut out: Vec<(String, Vec<String>, String)> = vec![];
    let mut in_text = false;
    for line in t.lines() {
        let l = line.trim().trim_start_matches(|c: char| c.is_ascii_digit() || matches!(c, '.' | ')' | '-' | '*' | '#' | ' ')).trim_start();
        let low = l.to_lowercase();
        if low.starts_with("entry:") || (!in_text && low.starts_with("name:")) {
            let n = low.find(':').unwrap_or(0) + 1;
            out.push((l[n..].trim().trim_matches('"').trim().to_string(), vec![], String::new()));
            in_text = false;
        } else if low.starts_with("keys:") || low.starts_with("keywords:") {
            if let Some(e) = out.last_mut() {
                let n = low.find(':').unwrap_or(0) + 1;
                e.1 = l[n..].split(',').map(|k| k.trim().trim_matches('"').trim().to_string()).filter(|k| !k.is_empty()).take(8).collect();
            }
            in_text = false;
        } else if low.starts_with("text:") || low.starts_with("content:") {
            if let Some(e) = out.last_mut() {
                let n = low.find(':').unwrap_or(0) + 1;
                e.2 = l[n..].trim().to_string();
                in_text = true;
            }
        } else if in_text && !line.trim().is_empty() {
            if let Some(e) = out.last_mut() { e.2.push(' '); e.2.push_str(line.trim()); }
        } else if line.trim().is_empty() {
            in_text = false;
        }
    }
    let mut res: Vec<(String, Vec<String>, String)> = out.into_iter().filter(|e| !e.0.is_empty() && !e.2.trim().is_empty())
        .map(|(n, mut k, c)| { if k.is_empty() { k.push(n.clone()); } (clip(&n, 80), k, clip(c.trim(), 1500)) }).take(12).collect();
    res.dedup_by(|a, b| a.0.eq_ignore_ascii_case(&b.0));
    if res.is_empty() { return Err("The model didn't write usable entries. Try again, or say a little more about the world.".into()); }
    Ok(res)
}

/// Reads the model's answer for a prompt into (title, label, text). Lenient: if the markers are missing, everything that is not a TITLE or LABEL line is the text.
pub fn parse_prompt(raw: &str) -> R<(String, String, String)> {
    let t = clean_reply(raw);
    let (mut title, mut tag, mut body, mut in_body) = (String::new(), String::new(), Vec::<String>::new(), false);
    for line in t.lines() {
        if in_body { body.push(line.to_string()); continue; }
        let l = line.trim_start();
        let low = l.to_lowercase();
        let after = |n: usize| l[n..].trim().trim_matches('"').trim().to_string();
        if low.starts_with("title:") { title = after(6); }
        else if low.starts_with("label:") { tag = after(6); }
        else if low.starts_with("text:") { in_body = true; let r = after(5); if !r.is_empty() { body.push(r); } }
        else if low.starts_with("prompt:") { in_body = true; let r = after(7); if !r.is_empty() { body.push(r); } }
    }
    let mut text = body.join("\n").trim().to_string();
    if text.is_empty() {
        text = t.lines().filter(|l| { let low = l.trim_start().to_lowercase(); !low.starts_with("title:") && !low.starts_with("label:") }).collect::<Vec<_>>().join("\n").trim().to_string();
    }
    if text.is_empty() { return Err("The model didn't write a usable prompt. Try again, or say a little more about what you want.".into()); }
    if title.is_empty() { title = text.lines().next().unwrap_or("").chars().take(50).collect::<String>().trim().to_string(); }
    Ok((clip(&title, 100), clip(&tag, 30), text))
}

/// Write something new from a rough idea: `kind` says what ("prompt" for now). The answer is only shown to the person; nothing is saved until they accept it.
#[tauri::command]
pub async fn tokenator_make(state: State<'_, Shared>, kind: String, notes: String, context: String) -> R<serde_json::Value> {
    let st: Shared = state.inner().clone();
    let o = owner(&st)?;
    let system = make_system(&kind)?.to_string();
    let idea = clip(&notes, MAX_IDEA);
    if idea.trim().is_empty() { return Err("Tell Tokenator a little about what you want first.".into()); }
    let ctx = clip(&context, 2000);
    let user = if ctx.trim().is_empty() { format!("My idea:\n{idea}") } else { format!("{ctx}\n\nMy idea:\n{idea}") };
    let out = ask_model(&st, &o, system, user, 0.7, 900).await?;
    match kind.as_str() {
        "prompt" => { let (title, tag, body) = parse_prompt(&out)?; Ok(serde_json::json!({ "title": title, "tag": tag, "body": body })) }
        "lorebook" => {
            let entries = parse_lore_entries(&out)?;
            Ok(serde_json::json!({ "entries": entries.into_iter().map(|(name, keys, content)| serde_json::json!({ "name": name, "keys": keys, "content": content })).collect::<Vec<_>>() }))
        }
        _ => Err("Tokenator can't write that yet.".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_jobs_are_asked_for_properly() {
        let t = system_for("trim", "description", 400).unwrap();
        assert!(t.contains("about 400 tokens") && t.contains("300 words") && t.contains("{{char}}") && t.contains("Do not add anything new") && t.contains("only the rewritten text"));
        let d = system_for("draft", "mes_example", 200).unwrap();
        assert!(d.contains("<START>") && d.contains("150 words") && d.contains("{{user}}"));
        assert!(system_for("trim", "name", 100).is_err() && system_for("rewrite", "description", 100).is_err(), "only real fields and known jobs");
    }

    #[test]
    fn the_prompts_have_no_stray_backslashes_and_real_line_breaks() {
        for (mode, field) in [("trim", "description"), ("draft", "scenario")] {
            let sys = system_for(mode, field, 300).unwrap();
            assert!(!sys.contains('\\'), "{mode}: a stray backslash in the instructions: {sys}");
        }
        let u = user_for("draft", "", "shy and kind", "Description: a student").unwrap();
        assert!(u.contains('\n') && !u.contains("\\n"), "a real line break, not a typed backslash and n: {u:?}");
        assert!(u.starts_with("The card so far:\nDescription: a student\n\nNotes from the person:\nshy and kind"));
    }

    #[test]
    fn a_prompt_answer_is_read_into_its_parts() {
        let (t, l, b) = parse_prompt("TITLE: Soft redirect\nLABEL: Scene\nTEXT:\n(OOC: let's steer somewhere gentler.)\nThanks!").unwrap();
        assert_eq!((t.as_str(), l.as_str(), b.as_str()), ("Soft redirect", "Scene", "(OOC: let's steer somewhere gentler.)\nThanks!"));
        let (t, _, b) = parse_prompt("```\ntitle: \"Slow down\"\nlabel:\ntext: Take it slower, {{char}}.\n```").unwrap();
        assert_eq!((t.as_str(), b.as_str()), ("Slow down", "Take it slower, {{char}}."));
        let (t, l, b) = parse_prompt("Keep replies under three paragraphs.\nStay in character.").unwrap();
        assert_eq!((t.as_str(), l.as_str(), b.as_str()), ("Keep replies under three paragraphs.", "", "Keep replies under three paragraphs.\nStay in character."), "no markers: all of it is the text, the first line names it");
        assert!(parse_prompt("TITLE: Only a title").is_err(), "a title with no text is not a usable prompt");
        assert!(parse_prompt("   ").is_err());
        assert!(make_system("prompt").unwrap().contains("TEXT:") && make_system("ship").is_err());
    }

    #[test]
    fn a_lorebook_answer_is_read_into_entries() {
        let raw = "ENTRY: The Old Library\nKEYS: library, the old library, books\nTEXT: A crumbling hall of shelves.\nIt closes at dusk.\n\n2. Entry: Tea seller\nkeys: tea, seller\ntext: Knows everyone's order.\n\nENTRY: No text\nKEYS: nothing\n\nENTRY: Moon Gate\nTEXT: A round window high up.";
        let e = parse_lore_entries(raw).unwrap();
        assert_eq!(e.len(), 3, "an entry with no text is dropped");
        assert_eq!((e[0].0.as_str(), e[0].1.len(), e[0].2.as_str()), ("The Old Library", 3, "A crumbling hall of shelves. It closes at dusk."));
        assert_eq!((e[1].0.as_str(), e[1].1.clone(), e[1].2.as_str()), ("Tea seller", vec!["tea".to_string(), "seller".to_string()], "Knows everyone's order."), "numbering and capitals do not matter");
        assert_eq!(e[2].1, vec!["Moon Gate".to_string()], "no keys: the name is the key");
        let many: String = (0..20).map(|i| format!("ENTRY: E{i}\nKEYS: k\nTEXT: t\n\n")).collect();
        assert_eq!(parse_lore_entries(&many).unwrap().len(), 12, "at most twelve");
        assert!(parse_lore_entries("I could not do that.").is_err());
        assert!(make_system("lorebook").unwrap().contains("ENTRY:"));
    }

    #[test]
    fn the_models_reply_is_tidied() {
        assert_eq!(clean_reply("  Mira is shy.  "), "Mira is shy.");
        assert_eq!(clean_reply("```\nMira is shy.\n```"), "Mira is shy.");
        assert_eq!(clean_reply("```text\nMira is shy.\nShe reads.\n```"), "Mira is shy.\nShe reads.");
        assert_eq!(clean_reply("Here is the shortened text:\n\nMira is shy."), "Mira is shy.");
        assert_eq!(clean_reply("\"Mira is shy.\""), "Mira is shy.");
        assert_eq!(clean_reply("\"Hi,\" she says, \"hello.\""), "\"Hi,\" she says, \"hello.\"", "quotes inside are left alone");
        assert_eq!(clean_reply("   "), "");
    }
}
