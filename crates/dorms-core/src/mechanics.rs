//! Mechanic packs: optional story layers (variables that move with the chat, lore entries, reactions) that a
//! person can switch on per chat. Packs are imported from `.bundle.json` files. This module is pure logic: parse a
//! bundle, keep a per-chat state, react to events, read the model's hidden `[variable: op value]` directives, and
//! write the block of instructions that goes into the prompt.

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

#[derive(Deserialize, Serialize, Clone, Default, Debug)]
#[serde(default)]
pub struct Bundle {
    pub name: String,
    pub description: String,
    pub tags: Vec<String>,
    pub entries: Vec<Entry>,
    pub variables: Vec<Var>,
    pub reactions: Vec<Reaction>,
    #[serde(rename = "rootComponent")]
    pub root_component: Option<Value>,
}

#[derive(Deserialize, Serialize, Clone, Default, Debug)]
#[serde(default)]
pub struct Entry {
    pub id: String,
    pub name: String,
    pub content: String,
    pub enabled: Option<bool>,
    pub keywords: Vec<String>,
    #[serde(rename = "alwaysSend")]
    pub always_send: bool,
}

#[derive(Deserialize, Serialize, Clone, Default, Debug)]
#[serde(default)]
pub struct Var {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub description: String,
    pub min: Option<f64>,
    pub max: Option<f64>,
    #[serde(rename = "deltaUp")]
    pub delta_up: Option<f64>,
    #[serde(rename = "deltaDown")]
    pub delta_down: Option<f64>,
    pub precise: bool,
    #[serde(rename = "defaultValue")]
    pub default_value: Value,
    #[serde(rename = "behaviorRules")]
    pub behavior_rules: String,
}

#[derive(Deserialize, Serialize, Clone, Default, Debug)]
#[serde(default)]
pub struct Reaction {
    pub id: String,
    pub name: String,
    pub enabled: Option<bool>,
    pub when: When,
    pub then: Vec<Action>,
    #[serde(rename = "maxFireCount")]
    pub max_fire_count: Option<u64>,
}

#[derive(Deserialize, Serialize, Clone, Default, Debug)]
#[serde(default)]
pub struct When {
    #[serde(rename = "eventType")]
    pub event_type: String,
    #[serde(rename = "match")]
    pub matcher: Map<String, Value>,
}

#[derive(Deserialize, Serialize, Clone, Default, Debug)]
#[serde(default)]
pub struct Action {
    pub path: String,
    pub value: Value,
    pub operation: String,
}

pub type State = Map<String, Value>;

/// Parse a `.bundle.json`. Anything that isn't a mechanic pack is rejected with a plain message.
pub fn parse_bundle(text: &str) -> Result<Bundle, String> {
    let v: Value = serde_json::from_str(text.trim_start_matches('\u{feff}')).map_err(|_| "That file isn't valid JSON.".to_string())?;
    if !v.is_object() || (v.get("variables").is_none() && v.get("entries").is_none() && v.get("reactions").is_none()) {
        return Err("That doesn't look like a mechanic pack (no variables, entries or reactions in it).".into());
    }
    let b: Bundle = serde_json::from_value(v).map_err(|e| format!("Couldn't read that pack: {e}"))?;
    if b.name.trim().is_empty() {
        return Err("The pack has no name.".into());
    }
    if b.variables.iter().any(|x| x.id.trim().is_empty()) {
        return Err("A variable in that pack has no id.".into());
    }
    Ok(b)
}

pub fn init_state(b: &Bundle) -> State {
    let mut s = State::new();
    for v in &b.variables {
        s.insert(v.id.clone(), if v.default_value.is_null() { default_for(&v.kind) } else { v.default_value.clone() });
    }
    s
}

fn default_for(kind: &str) -> Value {
    match kind {
        "number" => json!(0),
        "boolean" => json!(false),
        "json" => json!({}),
        _ => json!(""),
    }
}

// ---------- paths ----------

fn get_path<'a>(root: &'a Value, path: &[&str]) -> Option<&'a Value> {
    let mut cur = root;
    for p in path {
        cur = match cur {
            Value::Object(m) => m.get(*p)?,
            Value::Array(a) => a.get(p.parse::<usize>().ok()?)?,
            _ => return None,
        };
    }
    Some(cur)
}

fn slot<'a>(root: &'a mut Value, path: &[&str]) -> &'a mut Value {
    let mut cur = root;
    for p in path {
        if !cur.is_object() && !cur.is_array() {
            *cur = json!({});
        }
        cur = match cur {
            Value::Array(a) => {
                let i = p.parse::<usize>().unwrap_or(0);
                while a.len() <= i {
                    a.push(Value::Null);
                }
                &mut a[i]
            }
            Value::Object(m) => m.entry((*p).to_string()).or_insert(Value::Null),
            _ => unreachable!(),
        };
    }
    cur
}

pub struct Change {
    pub path: String,
    pub before: Value,
    pub after: Value,
}

/// Apply one operation to the state. Numbers on a declared variable are clamped to its min/max and to the largest
/// step it allows per change. Returns None when nothing changed (or the operation made no sense).
pub fn apply_op(state: &mut State, b: &Bundle, path: &str, op: &str, value: &Value) -> Option<Change> {
    let parts: Vec<&str> = path.split('.').filter(|p| !p.is_empty()).collect();
    let (root, rest) = parts.split_first()?;
    let var = b.variables.iter().find(|v| v.id == *root)?;
    let mut holder = Value::Object(std::mem::take(state));
    let before = get_path(&holder, &parts).cloned().unwrap_or(Value::Null);
    let num = |v: &Value| v.as_f64().or_else(|| v.as_str().and_then(|s| s.trim().parse::<f64>().ok()));
    let after: Option<Value> = match op {
        "set" => Some(value.clone()),
        "add" | "subtract" | "sub" => {
            let sign = if op == "add" { 1.0 } else { -1.0 };
            match (num(&before).or(Some(0.0)), num(value)) {
                (Some(cur), Some(d)) => {
                    let mut delta = sign * d;
                    if rest.is_empty() {
                        if delta > 0.0 { if let Some(m) = var.delta_up { delta = delta.min(m.abs()); } }
                        if delta < 0.0 { if let Some(m) = var.delta_down { delta = delta.max(-m.abs()); } }
                    }
                    Some(json!(cur + delta))
                }
                _ => None,
            }
        }
        "push" | "append" => {
            let mut arr = match &before { Value::Array(a) => a.clone(), _ => vec![] };
            arr.push(value.clone());
            Some(Value::Array(arr))
        }
        "remove" | "delete" | "unset" => {
            if rest.is_empty() { None } else {
                let (last, parent) = rest.split_last().unwrap();
                let mut pp = vec![*root];
                pp.extend(parent.iter().copied());
                let p = slot(&mut holder, &pp);
                match p {
                    Value::Object(m) => { m.remove(*last); }
                    Value::Array(a) => { if let Ok(i) = last.parse::<usize>() { if i < a.len() { a.remove(i); } } }
                    _ => {}
                }
                *state = match holder { Value::Object(m) => m, _ => State::new() };
                let changed = get_path(&Value::Object(state.clone()), &parts).is_none() && !before.is_null();
                return changed.then(|| Change { path: path.into(), before, after: Value::Null });
            }
        }
        _ => None,
    };
    let Some(mut after) = after else {
        *state = match holder { Value::Object(m) => m, _ => State::new() };
        return None;
    };
    // number discipline
    if rest.is_empty() && var.kind == "number" {
        if let Some(mut n) = num(&after) {
            if let Some(lo) = var.min { n = n.max(lo); }
            if let Some(hi) = var.max { n = n.min(hi); }
            if !var.precise { n = n.round(); }
            after = if n.fract() == 0.0 { json!(n as i64) } else { json!((n * 100.0).round() / 100.0) };
        }
    }
    *slot(&mut holder, &parts) = after.clone();
    *state = match holder { Value::Object(m) => m, _ => State::new() };
    (before != after).then(|| Change { path: path.into(), before, after })
}

// ---------- reading the model's hidden directives ----------

pub struct Directive { pub path: String, pub op: String, pub value: Value }

/// Turns `{name: "x", n: 2}` (bare keys, single quotes) into JSON. Strict JSON passes through untouched.
fn relaxed(s: &str) -> Option<Value> {
    if let Ok(v) = serde_json::from_str::<Value>(s) { return Some(v); }
    let re = Regex::new(r#"([\{,]\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*:)"#).ok()?;
    let fixed = re.replace_all(s, r#"$1"$2"$3"#).replace('\'', "\"");
    serde_json::from_str::<Value>(&fixed).ok()
}

fn parse_value(s: &str) -> Value {
    let t = s.trim();
    if t.is_empty() { return Value::Null; }
    if let Some(v) = relaxed(t) { return v; }
    let un = t.trim_matches(|c| c == '"' || c == '\'' || c == '“' || c == '”');
    if let Ok(n) = un.parse::<f64>() { return json!(n); }
    json!(un)
}

/// Finds `[path: op value]` groups whose path starts with one of `known` variable ids, removes them from the text and
/// returns them in order. Brackets that aren't directives (ordinary prose, links) stay where they are.
pub fn extract_directives(text: &str, known: &[String]) -> (String, Vec<Directive>) {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::new();
    let mut found = vec![];
    let mut i = 0;
    while i < chars.len() {
        if chars[i] != '[' { out.push(chars[i]); i += 1; continue; }
        // matching close, skipping strings and nested brackets
        let (mut depth, mut j, mut in_str, mut q) = (0i32, i, false, ' ');
        let mut end = None;
        while j < chars.len() {
            let c = chars[j];
            if in_str { if c == '\\' { j += 1; } else if c == q { in_str = false; } }
            else if c == '"' { in_str = true; q = c; }
            else if c == '[' || c == '{' { depth += 1; }
            else if c == ']' || c == '}' { depth -= 1; if depth == 0 { end = Some(j); break; } }
            j += 1;
        }
        let Some(end) = end else { out.push(chars[i]); i += 1; continue };
        let inner: String = chars[i + 1..end].iter().collect();
        let mut taken = false;
        if let Some(colon) = inner.find(':') {
            let path = inner[..colon].trim();
            let rest = inner[colon + 1..].trim();
            let root = path.split('.').next().unwrap_or("");
            let valid_path = !path.is_empty() && path.chars().all(|c| c.is_alphanumeric() || "_.-".contains(c));
            if valid_path && known.iter().any(|k| k == root) {
                let (op, val) = match rest.split_once(char::is_whitespace) { Some((o, v)) => (o, v), None => (rest, "") };
                let op = op.to_lowercase();
                if ["set", "add", "subtract", "sub", "push", "append", "remove", "delete", "unset"].contains(&op.as_str()) {
                    found.push(Directive { path: path.into(), op, value: parse_value(val) });
                    taken = true;
                }
            }
        }
        if taken { i = end + 1; } else { out.push('['); i += 1; }
    }
    // tidy the gaps the removed directives left behind
    let tidy = Regex::new(r"[ \t]+\n").unwrap().replace_all(&out, "\n").to_string();
    let tidy = Regex::new(r"\n{3,}").unwrap().replace_all(&tidy, "\n\n").to_string();
    (tidy.trim_end().to_string(), found)
}

// ---------- events and reactions ----------

pub enum Event<'a> {
    UserMessage(&'a str),
    CharacterMessage(&'a str),
    TurnComplete(u64),
}

fn word_match(op: &str, hay: &str, want: &Value) -> bool {
    let h = hay.to_lowercase();
    let w = want.as_str().map(str::to_string).unwrap_or_else(|| want.to_string()).to_lowercase();
    let terms: Vec<&str> = w.split(',').map(str::trim).filter(|t| !t.is_empty()).collect();
    match op {
        "contains" | "includes" | "contains_any" => terms.iter().any(|t| h.contains(t)),
        "not_contains" => !terms.iter().any(|t| h.contains(t)),
        "eq" | "equals" => h.trim() == w.trim(),
        _ => false,
    }
}

fn num_match(op: &str, n: u64, want: &Value) -> bool {
    let w = want.as_f64().unwrap_or(0.0).max(0.0) as u64;
    match op {
        "every" => w > 0 && n > 0 && n % w == 0,
        "eq" => n == w,
        "gte" | "ge" => n >= w,
        "gt" => n > w,
        _ => false,
    }
}

fn spec<'a>(m: &'a Map<String, Value>, key: &str) -> Option<(&'a str, &'a Value)> {
    let o = m.get(key)?.as_object()?;
    Some((o.get("operator").and_then(Value::as_str).unwrap_or("eq"), o.get("value")?))
}

fn numeric_vars(b: &Bundle, s: &State) -> Vec<(String, f64)> {
    b.variables.iter().filter(|v| v.kind == "number").filter_map(|v| s.get(&v.id).and_then(Value::as_f64).map(|n| (v.id.clone(), n))).collect()
}

fn fired(s: &State, rid: &str) -> u64 {
    s.get("_fired").and_then(|f| f.get(rid)).and_then(Value::as_u64).unwrap_or(0)
}

/// Run every reaction that matches `event`, then any "crossed a line" reactions the changes caused.
pub fn react(state: &mut State, b: &Bundle, ev: &Event) -> Vec<Change> {
    let mut changes = vec![];
    let before = numeric_vars(b, state);
    run_reactions(state, b, ev, None, &mut changes);
    // threshold crossings (bounded: a crossing reaction may itself move a variable)
    let mut prev = before;
    for _ in 0..3 {
        let now = numeric_vars(b, state);
        let mut crossed = vec![];
        for (id, n) in &now {
            let p = prev.iter().find(|(i, _)| i == id).map(|(_, v)| *v).unwrap_or(*n);
            crossed.push((id.clone(), p, *n));
        }
        let count_before = changes.len();
        for c in crossed.iter().filter(|(_, p, n)| p != n) { run_reactions(state, b, ev, Some(c), &mut changes); }
        prev = now;
        if changes.len() == count_before { break; }
    }
    changes
}

fn run_reactions(state: &mut State, b: &Bundle, ev: &Event, crossing: Option<&(String, f64, f64)>, out: &mut Vec<Change>) {
    for r in &b.reactions {
        if r.enabled == Some(false) { continue; }
        if let Some(max) = r.max_fire_count { if fired(state, &r.id) >= max { continue; } }
        let m = &r.when.matcher;
        let hit = match (r.when.event_type.as_str(), ev, crossing) {
            ("message:user", Event::UserMessage(t), None) => spec(m, "content").map(|(o, v)| word_match(o, t, v)).unwrap_or(true),
            ("message:character" | "message:assistant" | "message:ai", Event::CharacterMessage(t), None) => spec(m, "content").map(|(o, v)| word_match(o, t, v)).unwrap_or(true),
            ("turn:complete", Event::TurnComplete(n), None) => spec(m, "turnCount").map(|(o, v)| num_match(o, *n, v)).unwrap_or(true),
            ("state:crossed", _, Some((id, p, n))) => {
                let want_id = spec(m, "variableId").and_then(|(_, v)| v.as_str());
                let th = spec(m, "threshold").and_then(|(_, v)| v.as_f64());
                let dir = spec(m, "direction").and_then(|(_, v)| v.as_str()).unwrap_or("above");
                match (want_id, th) {
                    (Some(w), Some(t)) if w == id => if dir == "below" { *p >= t && *n < t } else { *p < t && *n >= t },
                    _ => false,
                }
            }
            _ => false,
        };
        if !hit { continue; }
        for a in &r.then {
            if let Some(id) = a.path.strip_prefix("@prompt.directive.") {
                let c = a.value.get("content").and_then(Value::as_str).unwrap_or("").to_string();
                if c.is_empty() { continue; }
                let dur = a.value.get("duration").and_then(Value::as_u64).unwrap_or(1).max(1);
                let persistent = a.value.get("persistent").and_then(Value::as_bool).unwrap_or(false);
                let list = state.entry("_directives").or_insert_with(|| json!([]));
                if let Value::Array(l) = list {
                    l.retain(|d| d.get("id").and_then(Value::as_str) != Some(id));
                    l.push(json!({"id": id, "content": c, "left": dur, "persistent": persistent}));
                }
                continue;
            }
            if let Some(c) = apply_op(state, b, &a.path, &a.operation, &a.value) { out.push(c); }
        }
        let f = state.entry("_fired").or_insert_with(|| json!({}));
        if let Value::Object(fm) = f { let n = fm.get(&r.id).and_then(Value::as_u64).unwrap_or(0) + 1; fm.insert(r.id.clone(), json!(n)); }
    }
}

/// Count down one-shot directives after the character has spoken.
pub fn end_turn(state: &mut State) {
    if let Some(Value::Array(l)) = state.get_mut("_directives") {
        for d in l.iter_mut() {
            if d.get("persistent").and_then(Value::as_bool) == Some(true) { continue; }
            let left = d.get("left").and_then(Value::as_u64).unwrap_or(1).saturating_sub(1);
            d["left"] = json!(left);
        }
        l.retain(|d| d.get("persistent").and_then(Value::as_bool) == Some(true) || d.get("left").and_then(Value::as_u64).unwrap_or(0) > 0);
    }
}

// ---------- the prompt block ----------

const PROTOCOL: &str = "To change one of these story variables, write a hidden line anywhere in your reply in the form [variable: operation value], for example [affection: add 3], [mood: set \"shy\"], [log: push {\"text\": \"…\"}] or [cards.aria.note: set \"…\"]. Operations: set, add, subtract, push, remove. A dotted path reaches inside a json variable. The app removes these lines before the person reads your reply, so never mention them and never show the numbers in prose. Only change a variable when the story gives a real reason.";

fn short(v: &Value) -> String {
    let s = v.to_string();
    if s.chars().count() > 600 { format!("{}…", s.chars().take(600).collect::<String>()) } else { s }
}

/// What the model is told for one switched-on pack: its lore, its variables with their current values and rules, and
/// any one-shot directives its reactions queued.
pub fn prompt_block(b: &Bundle, state: &State, recent: &str) -> String {
    let mut parts: Vec<String> = vec![];
    let low = recent.to_lowercase();
    for e in &b.entries {
        if e.enabled == Some(false) || e.content.trim().is_empty() { continue; }
        let hit = e.always_send || e.keywords.iter().any(|k| !k.trim().is_empty() && low.contains(&k.to_lowercase()));
        if hit { parts.push(e.content.trim().to_string()); }
    }
    if !b.variables.is_empty() {
        let mut v = String::from("Story variables (current values):\n");
        for var in &b.variables {
            let cur = state.get(&var.id).cloned().unwrap_or(Value::Null);
            let range = match (var.min, var.max) { (Some(a), Some(z)) if var.kind == "number" => format!(" (range {a}–{z})"), _ => String::new() };
            v.push_str(&format!("- {} [{}]{}: {}\n", var.name, var.id, range, short(&cur)));
            if !var.behavior_rules.trim().is_empty() { v.push_str(&format!("  Rules: {}\n", var.behavior_rules.trim())); }
        }
        v.push_str(PROTOCOL);
        parts.push(v);
    }
    if let Some(Value::Array(l)) = state.get("_directives") {
        for d in l { if let Some(c) = d.get("content").and_then(Value::as_str) { parts.push(c.to_string()); } }
    }
    if parts.is_empty() { return String::new(); }
    format!("[{}]\n{}", b.name, parts.join("\n\n"))
}

/// What kind of built-in panel a pack gets in the app (the pack's own interface code is not run).
pub fn app_kind(b: &Bundle) -> &'static str {
    let ids: Vec<&str> = b.variables.iter().map(|v| v.id.as_str()).collect();
    if ids.contains(&"app_relations") { "relations" }
    else if ids.contains(&"app_status") { "status" }
    else if ids.contains(&"phone_contacts") { "phone" }
    else { "vars" }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pack() -> Bundle {
        parse_bundle(r#"{"name":"Affection","entries":[{"id":"e","name":"Stages","content":"Stages text","alwaysSend":true},{"id":"k","name":"Secret","content":"Secret lore","keywords":["locket"]}],
        "variables":[{"id":"aff","name":"Affection","type":"number","min":0,"max":100,"deltaUp":15,"deltaDown":15,"precise":true,"defaultValue":20,"behaviorRules":"how she feels"},
                     {"id":"trust","name":"Trust","type":"number","min":0,"max":100,"defaultValue":10},
                     {"id":"cards","name":"Cards","type":"json","defaultValue":{"chars":{}}},
                     {"id":"log","name":"Log","type":"json","defaultValue":[]}],
        "reactions":[
          {"id":"warm","when":{"eventType":"message:user","match":{"content":{"value":"thank you,thanks,sorry","operator":"contains"}}},"then":[{"path":"aff","type":"set","value":3,"operation":"add"}]},
          {"id":"cold","when":{"eventType":"message:user","match":{"content":{"value":"whatever,shut up","operator":"contains"}}},"then":[{"path":"aff","type":"set","value":2,"operation":"subtract"}]},
          {"id":"time","when":{"eventType":"turn:complete","match":{"turnCount":{"value":10,"operator":"every"}}},"then":[{"path":"trust","type":"set","value":1,"operation":"add"}]},
          {"id":"line","maxFireCount":1,"when":{"eventType":"state:crossed","match":{"direction":{"value":"above","operator":"eq"},"threshold":{"value":60,"operator":"eq"},"variableId":{"value":"aff","operator":"eq"}}},
           "then":[{"path":"@prompt.directive.line","type":"set","operation":"set","value":{"content":"She says one new thing.","duration":1,"persistent":false}}]}]}"#).unwrap()
    }

    #[test]
    fn rejects_things_that_are_not_packs() {
        assert!(parse_bundle("nope").is_err());
        assert!(parse_bundle(r#"{"hello":1}"#).is_err());
        assert!(parse_bundle(r#"{"name":"x","variables":[{"id":""}]}"#).is_err());
    }

    #[test]
    fn defaults_become_the_starting_state() {
        let s = init_state(&pack());
        assert_eq!(s["aff"], json!(20));
        assert_eq!(s["cards"], json!({"chars": {}}));
    }

    #[test]
    fn keyword_reactions_move_numbers_both_ways() {
        let b = pack();
        let mut s = init_state(&b);
        react(&mut s, &b, &Event::UserMessage("Thank you, that helped"));
        assert_eq!(s["aff"], json!(23));
        react(&mut s, &b, &Event::UserMessage("whatever"));
        assert_eq!(s["aff"], json!(21));
        react(&mut s, &b, &Event::UserMessage("nothing special"));
        assert_eq!(s["aff"], json!(21));
    }

    #[test]
    fn every_n_turns_and_crossing_fire_as_described() {
        let b = pack();
        let mut s = init_state(&b);
        for n in 1..=9 { react(&mut s, &b, &Event::TurnComplete(n)); }
        assert_eq!(s["trust"], json!(10));
        react(&mut s, &b, &Event::TurnComplete(10));
        assert_eq!(s["trust"], json!(11));
        s.insert("aff".into(), json!(58));
        let ch = react(&mut s, &b, &Event::UserMessage("thanks"));
        assert!(!ch.is_empty());
        assert_eq!(s["aff"], json!(61));
        assert!(prompt_block(&b, &s, "").contains("She says one new thing."));
        end_turn(&mut s);
        assert!(!prompt_block(&b, &s, "").contains("She says one new thing."), "one-shot directive expires");
        // maxFireCount 1: crossing again does nothing
        s.insert("aff".into(), json!(50));
        react(&mut s, &b, &Event::UserMessage("thanks sorry"));
        s.insert("aff".into(), json!(59));
        react(&mut s, &b, &Event::UserMessage("thanks"));
        assert!(!prompt_block(&b, &s, "").contains("She says one new thing."));
    }

    #[test]
    fn numbers_are_clamped_and_steps_limited() {
        let b = pack();
        let mut s = init_state(&b);
        apply_op(&mut s, &b, "aff", "add", &json!(500));
        assert_eq!(s["aff"], json!(35), "one change can raise it by at most deltaUp (15)");
        apply_op(&mut s, &b, "aff", "set", &json!(500));
        assert_eq!(s["aff"], json!(100));
        apply_op(&mut s, &b, "aff", "set", &json!(-4));
        assert_eq!(s["aff"], json!(0));
        assert!(apply_op(&mut s, &b, "nope", "set", &json!(1)).is_none(), "unknown variables are ignored");
    }

    #[test]
    fn nested_paths_push_and_remove() {
        let b = pack();
        let mut s = init_state(&b);
        apply_op(&mut s, &b, "cards.chars.aria", "set", &json!({"name": "Aria", "affection": 40}));
        apply_op(&mut s, &b, "cards.chars.aria.affection", "add", &json!(3));
        assert_eq!(s["cards"]["chars"]["aria"]["affection"], json!(43.0));
        apply_op(&mut s, &b, "log", "push", &json!({"text": "hi"}));
        apply_op(&mut s, &b, "log", "push", &json!({"text": "again"}));
        assert_eq!(s["log"].as_array().unwrap().len(), 2);
        apply_op(&mut s, &b, "cards.chars.aria", "remove", &Value::Null);
        assert!(s["cards"]["chars"].get("aria").is_none());
    }

    #[test]
    fn hidden_directives_are_read_and_removed() {
        let known: Vec<String> = ["aff", "cards", "log"].iter().map(|s| s.to_string()).collect();
        let text = "She smiles. [aff: add 3]\n\nShe whispers a secret. [log: push {text: \"met at night\", n: 2}] [cards.chars.aria: set {'name':'Aria'}]\n[see the link](http://x) [not a var: add 1]";
        let (clean, d) = extract_directives(text, &known);
        assert_eq!(d.len(), 3);
        assert_eq!(d[0].path, "aff"); assert_eq!(d[0].op, "add"); assert_eq!(d[0].value, json!(3));
        assert_eq!(d[1].value, json!({"text": "met at night", "n": 2}));
        assert_eq!(d[2].value, json!({"name": "Aria"}));
        assert!(!clean.contains("[aff") && !clean.contains("[log") && !clean.contains("[cards"));
        assert!(clean.contains("[see the link](http://x)") && clean.contains("[not a var: add 1]"), "ordinary brackets stay");
        assert!(clean.starts_with("She smiles."));
    }

    #[test]
    fn prompt_block_has_lore_values_and_rules_and_only_matching_keywords() {
        let b = pack();
        let s = init_state(&b);
        let p = prompt_block(&b, &s, "we talked");
        assert!(p.contains("Stages text") && p.contains("Affection [aff] (range 0–100): 20") && p.contains("how she feels"));
        assert!(!p.contains("Secret lore"));
        assert!(prompt_block(&b, &s, "she kept a LOCKET").contains("Secret lore"));
        assert!(p.contains("[variable: operation value]"));
    }

    #[test]
    fn app_kinds() {
        let rel = parse_bundle(r#"{"name":"r","variables":[{"id":"app_relations","type":"json"}]}"#).unwrap();
        assert_eq!(app_kind(&rel), "relations");
        assert_eq!(app_kind(&pack()), "vars");
    }

    /// Real packs people share: run with DORMS_PACK_DIR=<folder of .bundle.json files> cargo test -p dorms-core real_packs -- --ignored --nocapture
    #[test]
    #[ignore]
    fn real_packs_parse_and_work() {
        let Ok(dir) = std::env::var("DORMS_PACK_DIR") else { return };
        for f in std::fs::read_dir(dir).unwrap().filter_map(|e| e.ok()).filter(|e| e.path().to_string_lossy().ends_with(".json")) {
            let text = std::fs::read_to_string(f.path()).unwrap();
            let b = parse_bundle(&text).unwrap_or_else(|e| panic!("{:?}: {e}", f.path()));
            let mut s = init_state(&b);
            let known: Vec<String> = b.variables.iter().map(|v| v.id.clone()).collect();
            react(&mut s, &b, &Event::UserMessage("thank you, I understand. please stay"));
            react(&mut s, &b, &Event::TurnComplete(10));
            let block = prompt_block(&b, &s, "hello");
            println!("{} -> app={} vars={:?} reactions={} state={} block_chars={}", b.name, app_kind(&b), known, b.reactions.len(), serde_json::to_string(&s).unwrap().chars().take(160).collect::<String>(), block.chars().count());
            assert!(!block.is_empty());
        }
    }
}
