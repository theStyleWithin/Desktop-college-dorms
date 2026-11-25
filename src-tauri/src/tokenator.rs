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
        "playbook" => Ok("You are Tokenator, who helps people write playbooks for AI roleplay. A playbook keeps track of things in a story, such as trust or mood, and changes them when certain words are said. The characters are told the current values, so the story can grow and change. \
             From the person's idea, write a small playbook: 2 to 4 values and 2 to 6 rules. A value is a number (with a range, like 0-10), a choice from a list, or yes/no. A rule says: when the player says any of some words, change values (add or subtract a number, or set a value). \
             Reply in exactly this form and nothing else:\n\
             NAME: a short name\n\
             WHAT: one sentence about what this playbook tracks\n\
             HOW: one or two sentences telling the player how to use it\n\
             VALUE: trust | number | 0-10 | starts 2 | how much they trust the player | 0=a wary stranger, 3=a cautious acquaintance, 6=a friend\n\
             VALUE: mood | choice | calm, cheerful, tense | starts calm | how they feel right now\n\
             RULE: Kind words | player says: thank you, please, sorry | trust +1; mood = cheerful\n\
             RULE: Rude words | player says: shut up, idiot | trust -2; mood = tense\n\
             Use only the value names you wrote in VALUE lines inside RULE lines."),
        "room" => Ok("You are Tokenator, who helps people describe rooms for AI roleplay. A room is a place where a chat happens; the characters only notice what its description says. \
             From the person's idea, write one room. Pick the kind from this list: living_room, bedroom, kitchen, bathroom, dining_room, games_room, office, garage, garden, balcony, basement, rooftop, other. The description is 2 to 5 plain sentences about what is there: furniture, light, sounds, smells, mood. \
             Reply in exactly this form and nothing else:\n\
             NAME: the room's name\n\
             KIND: one word from the list\n\
             TEXT: the description"),
        "world" => Ok("You are Tokenator, who helps people build worlds for AI roleplay. A world is a set of connected rooms (places) with some background. \
             From the person's idea, write: a name; ABOUT, one to three sentences that the characters are told in every chat; LORE, a few short paragraphs of background written to be read (history, feel, people); then 4 to 8 rooms; then LINK lines saying which rooms connect. Each room links to at most three others, and every room connects to at least one other. Do not repeat rooms that already exist. \
             A room's kind is one of: living_room, bedroom, kitchen, bathroom, dining_room, games_room, office, garage, garden, balcony, basement, rooftop, other. \
             Reply in exactly this form and nothing else:\n\
             NAME: the world's name\n\
             ABOUT: one to three sentences\n\
             LORE: the background, in a few paragraphs\n\
             ROOM: room name | kind | one or two sentences about it\n\
             ROOM: another room | kind | one or two sentences\n\
             LINK: room name -> another room\n\
             LINK: another room -> a third room"),
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

// ----- playbooks, rooms and worlds -----

use crate::playbook::{clean_playbook, Act, Band, Cond, Playbook, Rule, Var};
use serde_json::{json, Value};

const ROOM_KINDS: [&str; 13] = ["living_room", "bedroom", "kitchen", "bathroom", "dining_room", "games_room", "office", "garage", "garden", "balcony", "basement", "rooftop", "other"];

/// A name the playbook rules can use: lower case letters, digits and underscores, starting with a letter.
fn slug(s: &str) -> String {
    let mut out = String::new();
    for c in s.trim().to_lowercase().chars() {
        if c.is_ascii_alphanumeric() { out.push(c); } else if !out.is_empty() && !out.ends_with('_') { out.push('_'); }
    }
    let out = out.trim_matches('_').to_string();
    match out.chars().next() {
        None => String::new(),
        Some(c) if c.is_ascii_alphabetic() => out.chars().take(24).collect(),
        Some(_) => format!("v_{out}").chars().take(24).collect(),
    }
}

/// Splits an answer into `KEY: text` sections. A section goes on over the lines that follow, until the next line that starts with one of `keys`.
fn sections(raw: &str, keys: &[&str]) -> Vec<(String, String)> {
    let t = clean_reply(raw);
    let mut out: Vec<(String, String)> = vec![];
    for line in t.lines() {
        let m = line.trim().trim_start_matches(|c: char| c.is_ascii_digit() || matches!(c, '.' | ')' | '-' | '*' | '#' | ' ')).trim_start();
        if let Some((k, v)) = m.split_once(':') {
            let k = k.trim().to_lowercase();
            if keys.contains(&k.as_str()) { out.push((k, v.trim().to_string())); continue; }
        }
        if let Some(last) = out.last_mut() { last.1.push('\n'); last.1.push_str(line.trim_end()); }
    }
    for o in out.iter_mut() { o.1 = o.1.trim().to_string(); }
    out
}

fn parse_range(s: &str) -> Option<(f64, f64)> {
    let t = s.to_lowercase().replace(" to ", "-").replace("..", "-").replace(' ', "");
    let i = t.char_indices().skip(1).find(|(_, c)| *c == '-')?.0;
    let (a, b): (f64, f64) = (t[..i].parse().ok()?, t[i + 1..].parse().ok()?);
    Some(if a <= b { (a, b) } else { (b, a) })
}

fn after_word<'a>(s: &'a str, words: &[&str]) -> &'a str {
    let t = s.trim();
    let low = t.to_lowercase();
    for w in words {
        if low.starts_with(w) { return t[w.len()..].trim().trim_start_matches(|c: char| c == ':' || c == '=').trim(); }
    }
    t
}

fn unquote(s: &str) -> String {
    s.trim().trim_matches('"').trim().to_string()
}

/// `trust | number | 0-10 | starts 2 | what it is | 0=a wary stranger, 3=a friend` into a playbook value.
fn parse_value_line(s: &str) -> Option<Var> {
    let p: Vec<&str> = s.split('|').map(|x| x.trim()).collect();
    let label = unquote(p.first()?);
    let id = slug(&label);
    if id.is_empty() { return None; }
    let kind_txt = p.get(1).map(|k| k.to_lowercase()).unwrap_or_default();
    let kind = if kind_txt.contains("choice") || kind_txt.contains("list") || kind_txt.contains("option") { "choice" }
        else if kind_txt.contains("yes") || kind_txt.contains("bool") { "bool" }
        else if kind_txt.contains("text") { "text" }
        else { "number" };
    let third = p.get(2).copied().unwrap_or("");
    let starts = after_word(p.get(3).copied().unwrap_or(""), &["starts as", "starts", "start"]).to_string();
    let mut v = Var { id, label: label.chars().take(40).collect(), kind: kind.into(), note: clip(p.get(4).copied().unwrap_or(""), 300), ..Var::default() };
    match kind {
        "number" => {
            let (lo, hi) = parse_range(third).unwrap_or((0.0, 10.0));
            v.min = Some(lo);
            v.max = Some(hi);
            v.default = json!(starts.parse::<f64>().unwrap_or(lo).clamp(lo, hi));
            for m in p.get(5).copied().unwrap_or("").split(',') {
                if let Some((a, b)) = m.split_once('=') {
                    if let Ok(from) = a.trim().parse::<f64>() { if !unquote(b).is_empty() { v.bands.push(Band { from, text: unquote(b) }); } }
                }
            }
        }
        "choice" => {
            v.options = third.split(',').map(unquote).filter(|o| !o.is_empty()).take(12).collect();
            if v.options.is_empty() { return None; }
            let d = v.options.iter().find(|o| o.eq_ignore_ascii_case(starts.trim())).cloned().unwrap_or_else(|| v.options[0].clone());
            v.default = json!(d);
        }
        "bool" => v.default = json!(matches!(starts.to_lowercase().as_str(), "yes" | "true" | "on")),
        _ => v.default = json!(clip(&starts, 100)),
    }
    Some(v)
}

/// Reads the model's playbook answer into a playbook and checks it with the same rules as a saved one. Rules that name an unknown value are dropped.
pub fn parse_playbook(raw: &str) -> R<Playbook> {
    let (mut name, mut what, mut how) = (String::new(), String::new(), String::new());
    let mut vars: Vec<Var> = vec![];
    let mut rule_lines: Vec<(String, String, String)> = vec![];
    for (k, v) in sections(raw, &["name", "what", "description", "how", "how to use", "instructions", "value", "rule"]) {
        match k.as_str() {
            "name" => name = v,
            "what" | "description" => what = v,
            "how" | "how to use" | "instructions" => how = v,
            "value" => { if let Some(var) = parse_value_line(v.lines().next().unwrap_or("")) { if !vars.iter().any(|x| x.id == var.id) { vars.push(var); } } }
            _ => {
                let p: Vec<String> = v.lines().next().unwrap_or("").split('|').map(|x| x.trim().to_string()).collect();
                if p.len() >= 3 { rule_lines.push((p[0].clone(), p[1].clone(), p[2].clone())); }
            }
        }
    }
    vars.truncate(10);
    if vars.is_empty() { return Err("The model didn't write any values for the playbook. Try again, or say a little more about what you want to track.".into()); }
    let mut rules: Vec<Rule> = vec![];
    for (n, (rname, trig, eff)) in rule_lines.iter().enumerate() {
        let src = trig.split_once(':').map(|x| x.1).unwrap_or(trig.as_str());
        let words: Vec<String> = src.split(',').map(unquote).filter(|w| !w.is_empty()).take(10).collect();
        let mut acts: Vec<Act> = vec![];
        for e in eff.split(';') {
            let e = e.trim();
            let Some(pos) = e.find(|c: char| matches!(c, '+' | '-' | '=')) else { continue };
            let id = slug(&e[..pos]);
            let Some(var) = vars.iter().find(|v| v.id == id) else { continue };
            let rest = &e[pos..];
            let num = |t: &str| t.trim_start_matches(|c: char| matches!(c, '+' | '-' | '=' | ' ')).trim().parse::<f64>().ok();
            if rest.starts_with('+') { if let Some(x) = num(rest) { acts.push(Act { var: id, op: "add".into(), value: json!(x.abs()) }); } }
            else if rest.starts_with('-') { if let Some(x) = num(rest) { acts.push(Act { var: id, op: "subtract".into(), value: json!(x.abs()) }); } }
            else {
                let val = unquote(rest.trim_start_matches('=').trim());
                let value = match var.kind.as_str() {
                    "number" => match val.parse::<f64>() { Ok(x) => json!(x), Err(_) => continue },
                    "bool" => json!(matches!(val.to_lowercase().as_str(), "yes" | "true" | "on")),
                    _ => json!(val),
                };
                acts.push(Act { var: id, op: "set".into(), value });
            }
        }
        if words.is_empty() || acts.is_empty() { continue; }
        let id = { let s = slug(rname); if s.is_empty() { format!("rule_{}", n + 1) } else { s } };
        rules.push(Rule { id, name: rname.chars().take(60).collect(), phase: "before".into(), when: vec![Cond::UserSays { words }], then: acts, ..Rule::default() });
    }
    rules.truncate(15);
    let pb = Playbook {
        name: if name.trim().is_empty() { "My playbook".into() } else { clip(name.trim(), 60) },
        description: clip(what.trim(), 600), instructions: clip(how.trim(), 2000), variables: vars, rules, ..Playbook::default()
    };
    clean_playbook(pb, &[]).map_err(|m| format!("The model's draft wasn't a usable playbook ({m}) Try again, or say a little more about what you want to track."))
}

/// A room kind the app knows, from whatever the model wrote ("Living room", "kitchen"); anything else is "other".
fn room_kind(s: &str) -> String {
    let t = s.trim().to_lowercase().replace([' ', '-'], "_");
    if ROOM_KINDS.contains(&t.as_str()) { return t; }
    let spaced = s.trim().to_lowercase();
    ROOM_KINDS.iter().find(|k| **k != "other" && spaced.contains(&k.replace('_', " "))).map(|k| k.to_string()).unwrap_or_else(|| "other".into())
}

/// Reads the model's room answer into (name, kind, description).
pub fn parse_room(raw: &str) -> R<(String, String, String)> {
    let (mut name, mut kind, mut text) = (String::new(), String::new(), String::new());
    for (k, v) in sections(raw, &["name", "kind", "text", "description"]) {
        match k.as_str() { "name" => name = unquote(v.lines().next().unwrap_or("")), "kind" => kind = v, _ => text = v }
    }
    if name.is_empty() || text.trim().is_empty() { return Err("The model didn't write a usable room. Try again, or say a little more about the place.".into()); }
    Ok((clip(&name, 80), room_kind(&kind), clip(text.trim(), 4000)))
}

/// What the model wrote for a world: its name, what the characters are told, the lore to read, rooms (name, kind, description) and which rooms connect.
pub struct WorldDraft { pub name: String, pub about: String, pub lore: String, pub rooms: Vec<(String, String, String)>, pub links: Vec<(String, String)> }

pub fn parse_world(raw: &str) -> R<WorldDraft> {
    let mut w = WorldDraft { name: String::new(), about: String::new(), lore: String::new(), rooms: vec![], links: vec![] };
    let mut link_lines: Vec<String> = vec![];
    for (k, v) in sections(raw, &["name", "about", "lore", "room", "link"]) {
        match k.as_str() {
            "name" => w.name = unquote(v.lines().next().unwrap_or("")),
            "about" => w.about = v,
            "lore" => w.lore = v,
            "room" => {
                let p: Vec<String> = v.lines().next().unwrap_or("").split('|').map(|x| x.trim().to_string()).collect();
                let name = unquote(&p[0]);
                if name.is_empty() || w.rooms.iter().any(|r| r.0.eq_ignore_ascii_case(&name)) || w.rooms.len() >= 8 { continue; }
                let (kind, desc) = match p.len() { 1 => ("other".to_string(), String::new()), 2 => ("other".to_string(), p[1].clone()), _ => (room_kind(&p[1]), p[2].clone()) };
                w.rooms.push((clip(&name, 80), kind, clip(desc.trim(), 600)));
            }
            _ => link_lines.push(v.lines().next().unwrap_or("").to_string()),
        }
    }
    let mut degree: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for l in link_lines {
        let l = l.replace("<->", "->").replace('→', "->").replace('—', "->");
        let Some((a, b)) = l.split_once("->") else { continue };
        let find = |x: &str| w.rooms.iter().find(|r| r.0.eq_ignore_ascii_case(unquote(x).as_str())).map(|r| r.0.clone());
        let (Some(a), Some(b)) = (find(a), find(b)) else { continue };
        if a == b || w.links.iter().any(|(x, y)| (x == &a && y == &b) || (x == &b && y == &a)) { continue; }
        if degree.get(&a).copied().unwrap_or(0) >= 3 || degree.get(&b).copied().unwrap_or(0) >= 3 { continue; }
        *degree.entry(a.clone()).or_insert(0) += 1;
        *degree.entry(b.clone()).or_insert(0) += 1;
        w.links.push((a, b));
    }
    w.about = clip(w.about.trim(), 600);
    w.lore = clip(w.lore.trim(), 6000);
    if w.rooms.is_empty() && w.lore.is_empty() && w.about.is_empty() { return Err("The model didn't write a usable world. Try again, or say a little more about it.".into()); }
    Ok(w)
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
    let budget = match kind.as_str() { "world" => 2200, "playbook" => 1400, "room" => 700, _ => 900 };
    let out = ask_model(&st, &o, system, user, 0.7, budget).await?;
    match kind.as_str() {
        "prompt" => { let (title, tag, body) = parse_prompt(&out)?; Ok(serde_json::json!({ "title": title, "tag": tag, "body": body })) }
        "lorebook" => {
            let entries = parse_lore_entries(&out)?;
            Ok(serde_json::json!({ "entries": entries.into_iter().map(|(name, keys, content)| serde_json::json!({ "name": name, "keys": keys, "content": content })).collect::<Vec<_>>() }))
        }
        "playbook" => { let pb = parse_playbook(&out)?; serde_json::to_value(pb).map_err(|x| x.to_string()) }
        "room" => { let (name, kind, description) = parse_room(&out)?; Ok(json!({ "name": name, "kind": kind, "description": description })) }
        "world" => {
            let w = parse_world(&out)?;
            Ok(json!({ "name": w.name, "description": w.about, "lore": w.lore,
                "rooms": w.rooms.iter().map(|(n, k, d)| json!({ "name": n, "kind": k, "description": d })).collect::<Vec<Value>>(),
                "links": w.links.iter().map(|(a, b)| json!([a, b])).collect::<Vec<Value>>() }))
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
    fn a_playbook_answer_becomes_a_valid_playbook() {
        let raw = "NAME: Slow burn\nWHAT: Trust that grows with kindness.\nHOW: Be kind.\nVALUE: Trust | number | 0-10 | starts 2 | how much they trust you | 0=a wary stranger, 3=a cautious acquaintance, 6=a friend\nVALUE: Mood | choice | calm, cheerful, tense | starts calm | how they feel\nVALUE: Met before | yes/no | | starts no | have they met\nRULE: Kind words | player says: thank you, please | trust +1; mood = cheerful\nRULE: Rude | player says: shut up, idiot | trust -2; mood = tense; ghost +5\nRULE: Nothing useful | player says: hello | nobody +1\nRULE: No words | player says: | trust +1";
        let pb = parse_playbook(raw).unwrap();
        assert_eq!(pb.name, "Slow burn");
        assert_eq!(pb.variables.iter().map(|v| v.id.as_str()).collect::<Vec<_>>(), vec!["trust", "mood", "met_before"]);
        assert_eq!((pb.variables[0].min, pb.variables[0].max, pb.variables[0].bands.len()), (Some(0.0), Some(10.0), 3));
        assert_eq!(pb.variables[1].options, vec!["calm", "cheerful", "tense"]);
        assert_eq!(pb.rules.len(), 2, "a rule with no known value, and one with no words, are dropped");
        assert_eq!(pb.rules[1].then.len(), 2, "the unknown value inside a rule is dropped, the rest stays");
        assert_eq!((pb.rules[0].then[0].op.as_str(), pb.rules[1].then[0].op.as_str()), ("add", "subtract"));
        assert!(parse_playbook("NAME: Empty").is_err(), "no values is not a playbook");
        assert!(parse_playbook("whatever the model felt like writing").is_err());
        assert!(make_system("playbook").unwrap().contains("VALUE:") && make_system("room").unwrap().contains("KIND:") && make_system("world").unwrap().contains("LINK:"));
    }

    #[test]
    fn a_room_answer_is_read_into_name_kind_and_text() {
        let (n, k, t) = parse_room("NAME: Mina's Kitchen\nKIND: Kitchen\nTEXT: Yellow tiles and a humming fridge.\nA kettle on the stove.").unwrap();
        assert_eq!((n.as_str(), k.as_str(), t.as_str()), ("Mina's Kitchen", "kitchen", "Yellow tiles and a humming fridge.\nA kettle on the stove."));
        assert_eq!(parse_room("NAME: Cave\nKIND: a damp cave\nTEXT: Dripping.").unwrap().1, "other");
        assert_eq!(parse_room("name: X\nkind: living room\ntext: Sofa.").unwrap().1, "living_room");
        assert!(parse_room("NAME: Only a name").is_err());
    }

    #[test]
    fn a_world_answer_is_read_into_rooms_and_links() {
        let raw = "NAME: Lantern Quarter\nABOUT: A neon-lit district.\nLORE: Built along an old canal.\n\nThe Quarter never sleeps.\nROOM: Tea house | kitchen | Steam and gossip.\nROOM: Rooftop | rooftop | Lanterns everywhere.\nROOM: Library | office | Closes at dusk.\nROOM: Library | office | a duplicate\nROOM: Attic | other | Round window.\nLINK: Tea house -> Rooftop\nLINK: rooftop -> tea house\nLINK: Tea house -> Library\nLINK: Tea house -> Attic\nLINK: Library -> Nowhere\nLINK: Attic -> Attic";
        let w = parse_world(raw).unwrap();
        assert_eq!(w.name, "Lantern Quarter");
        assert_eq!(w.rooms.len(), 4, "a duplicate room is dropped");
        assert_eq!(w.rooms[0].1, "kitchen");
        assert!(w.lore.contains("canal") && w.lore.contains("never sleeps"), "lore keeps its paragraphs: {}", w.lore);
        assert_eq!(w.links.len(), 3, "a link back the other way, one to a room that does not exist, and one to itself are dropped");
        assert!(parse_world("nothing here").is_err());
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
