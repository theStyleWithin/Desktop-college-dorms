//! Playbooks: the events system for characters. A playbook keeps a saved set of values for each chat (the story's state), rules that change
//! those values before and after each reply, and, if you like, which lorebook entries are available depending on the state. The characters
//! are told the current state when they reply. A playbook can be used with no lorebooks at all.
//!
//! One playbook is active in a chat at a time (a character can come with one; a chat can use another, or none). Regenerating a reply
//! reruns the rules from the state before that reply; continuing a reply does not advance anything; editing text reruns nothing.

use std::collections::{BTreeMap, HashSet};
use std::future::Future;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::State;

use crate::commands::{e, owner, uid};
use crate::db::{self, Owner};
use crate::Shared;

type R<T> = Result<T, String>;

pub const MAX_VARS: usize = 10;
pub const MAX_RULES: usize = 15;
pub const MAX_ASK: usize = 3;
pub const MAX_BOOKS: usize = 4;
pub const MAX_SCENARIOS: usize = 8;
/// How many values one chat keeps (the ones of other playbooks it used before stay for a while, so they can come back).
pub const MAX_STATE: usize = 50;

// ----- the definition -----

/// What a number means at and above a point ("wary acquaintance" from 1, "trusted partner" from 9).
#[derive(Serialize, Deserialize, Clone, PartialEq, Debug, Default)]
#[serde(default)]
pub struct Band {
    pub from: f64,
    pub text: String,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(default)]
pub struct Var {
    pub id: String,
    pub label: String,
    /// `number` | `bool` | `text` | `choice`
    pub kind: String,
    pub default: Value,
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub options: Vec<String>,
    /// Told to the characters: what this value is.
    pub note: String,
    /// Told to the characters: what a number means at each point.
    pub bands: Vec<Band>,
}

impl Default for Var {
    fn default() -> Self {
        Var { id: String::new(), label: String::new(), kind: "number".into(), default: json!(0), min: None, max: None, options: vec![], note: String::new(), bands: vec![] }
    }
}

/// A check on the story. All the checks of a rule have to hold.
#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Cond {
    /// A value, compared: `==` `!=` `>` `>=` `<` `<=` `contains`.
    Var { var: String, op: String, value: Value },
    /// The player's message has one of these words or phrases in it.
    UserSays { words: Vec<String> },
    /// The reply that was just written has one of these in it (only after a reply).
    ReplySays { words: Vec<String> },
    /// Every this many turns.
    EveryN { n: u32 },
    /// A chance, in percent, each turn.
    Chance { percent: u32 },
}

/// A change to a value: `set`, `add`, `subtract`, `toggle` (yes/no), `append` (text) or `clear` (back to the default).
#[derive(Serialize, Deserialize, Clone, PartialEq, Debug, Default)]
#[serde(default)]
pub struct Act {
    pub var: String,
    pub op: String,
    pub value: Value,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(default)]
pub struct Rule {
    pub id: String,
    pub name: String,
    /// `before` (the reply reads the result) or `after` (it can look at what was just written).
    pub phase: String,
    /// All of these must hold.
    pub when: Vec<Cond>,
    /// If there are any, at least one of these must hold as well.
    pub when_any: Vec<Cond>,
    /// A question for the model to judge (for what plain checks can't tell: "did the player earn her trust?"). Runs only if the checks above hold.
    pub ask: String,
    /// What to check instead when the model's judgment is switched off for the chat (nothing = the rule does not run).
    pub fallback: Vec<Cond>,
    pub then: Vec<Act>,
}

impl Default for Rule {
    fn default() -> Self {
        Rule { id: String::new(), name: String::new(), phase: "before".into(), when: vec![], when_any: vec![], ask: String::new(), fallback: vec![], then: vec![] }
    }
}

/// Which entries of an attached lorebook are available, by the state. An entry named here is available only while its checks hold; the rest
/// of the book follows `default_on`. (An entry is named by its name, or `#3` for the third.)
#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(default)]
pub struct Gate {
    pub entry: String,
    pub when: Vec<Cond>,
}
impl Default for Gate {
    fn default() -> Self {
        Gate { entry: String::new(), when: vec![] }
    }
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(default)]
pub struct LoreGate {
    pub book: String,
    pub default_on: bool,
    pub gates: Vec<Gate>,
}
impl Default for LoreGate {
    fn default() -> Self {
        LoreGate { book: String::new(), default_on: true, gates: vec![] }
    }
}

/// A different starting state ("Strangers", "Old friends").
#[derive(Serialize, Deserialize, Clone, PartialEq, Debug, Default)]
#[serde(default)]
pub struct Scenario {
    pub name: String,
    pub description: String,
    pub values: BTreeMap<String, Value>,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug, Default)]
#[serde(default)]
pub struct Playbook {
    pub id: String,
    pub name: String,
    pub description: String,
    /// How to use it, shown to the player in the chat.
    pub instructions: String,
    pub variables: Vec<Var>,
    pub rules: Vec<Rule>,
    /// Ids of the lorebooks attached (up to four, the owner's own).
    pub lorebooks: Vec<String>,
    pub lore: Vec<LoreGate>,
    pub scenarios: Vec<Scenario>,
    pub created_at: i64,
    pub updated_at: i64,
}

// ----- values -----

/// A name for a variable or rule: lowercase letters, numbers and underscores, starting with a letter, 24 at most.
pub fn clean_id(s: &str) -> Option<String> {
    let t: String = s.trim().to_lowercase().chars().map(|c| if c == ' ' || c == '-' { '_' } else { c }).filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == '_').collect();
    let t: String = t.trim_matches('_').chars().take(24).collect();
    if t.chars().next().is_some_and(|c| c.is_ascii_lowercase()) { Some(t) } else { None }
}

fn number_value(n: f64) -> Value {
    if n.fract() == 0.0 && n.abs() < 1e12 { json!(n as i64) } else { json!((n * 100.0).round() / 100.0) }
}

fn text_of(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

/// A value made to fit its variable: a number inside its range, a yes/no, one of the choices, or short text.
pub fn coerce(v: &Var, val: &Value) -> Value {
    match v.kind.as_str() {
        "number" => {
            let n = val.as_f64().or_else(|| val.as_str().and_then(|s| s.trim().parse().ok())).unwrap_or_else(|| v.default.as_f64().unwrap_or(0.0));
            let n = n.clamp(v.min.unwrap_or(-1.0e9), v.max.unwrap_or(1.0e9));
            number_value(n)
        }
        "bool" => Value::Bool(match val {
            Value::Bool(b) => *b,
            Value::String(s) => matches!(s.trim().to_lowercase().as_str(), "true" | "yes" | "1" | "on"),
            Value::Number(n) => n.as_f64().unwrap_or(0.0) != 0.0,
            _ => v.default.as_bool().unwrap_or(false),
        }),
        "choice" => {
            let s = text_of(val);
            match v.options.iter().find(|o| o.eq_ignore_ascii_case(s.trim())) {
                Some(o) => Value::String(o.clone()),
                None => Value::String(text_of(&v.default)),
            }
        }
        _ => Value::String(text_of(val).chars().filter(|c| !c.is_control() || *c == '\n').take(200).collect::<String>().trim().to_string()),
    }
}

// ----- the state of a chat -----

#[derive(Serialize, Deserialize, Clone, Default, PartialEq, Debug)]
#[serde(default)]
pub struct PState {
    pub vars: BTreeMap<String, Value>,
    /// The turn each value was last changed (so the oldest unused ones can be let go when there are too many).
    pub touched: BTreeMap<String, i64>,
}

impl PState {
    pub fn get(&self, v: &Var) -> Value {
        coerce(v, self.vars.get(&v.id).unwrap_or(&v.default))
    }
    pub fn set(&mut self, id: &str, val: Value, turn: i64) {
        self.vars.insert(id.to_string(), val);
        self.touched.insert(id.to_string(), turn);
    }
    /// Keeps at most `MAX_STATE` values: the active playbook's always stay, the oldest of the others go first.
    pub fn trim(&mut self, keep: &HashSet<String>) {
        while self.vars.len() > MAX_STATE {
            let Some(oldest) = self.vars.keys().filter(|k| !keep.contains(*k)).min_by_key(|k| (self.touched.get(*k).copied().unwrap_or(0), (*k).clone())).cloned() else { break };
            self.vars.remove(&oldest);
            self.touched.remove(&oldest);
        }
        self.touched.retain(|k, _| self.vars.contains_key(k));
    }
}

/// The values of this playbook's variables right now (defaults where nothing is stored).
pub fn values(pb: &Playbook, st: &PState) -> BTreeMap<String, Value> {
    pb.variables.iter().map(|v| (v.id.clone(), st.get(v))).collect()
}

/// The state a playbook starts a chat in: its defaults, with a scenario's values on top.
pub fn starting_state(pb: &Playbook, scenario: Option<&str>) -> PState {
    let mut st = PState::default();
    let sc = scenario.and_then(|n| pb.scenarios.iter().find(|s| s.name.eq_ignore_ascii_case(n.trim())));
    for v in &pb.variables {
        let val = sc.and_then(|s| s.values.get(&v.id)).map(|x| coerce(v, x)).unwrap_or_else(|| coerce(v, &v.default));
        st.set(&v.id, val, 0);
    }
    st
}

// ----- checks and changes -----

/// What the checks can look at.
pub struct Ctx {
    pub user: String,
    pub reply: String,
    pub turn: i64,
    /// Makes this turn's chances (a different number each time, so a regenerated reply can turn out differently).
    pub seed: u64,
}

fn mix(mut x: u64) -> u64 {
    x ^= x >> 33;
    x = x.wrapping_mul(0xff51afd7ed558ccd);
    x ^= x >> 33;
    x = x.wrapping_mul(0xc4ceb9fe1a85ec53);
    x ^ (x >> 33)
}

fn any_word(text: &str, words: &[String]) -> bool {
    let t = text.to_lowercase();
    words.iter().any(|w| !w.trim().is_empty() && t.contains(&w.trim().to_lowercase()))
}

pub fn eval(c: &Cond, vals: &BTreeMap<String, Value>, ctx: &Ctx, salt: u64) -> bool {
    match c {
        Cond::Var { var, op, value } => {
            let Some(cur) = vals.get(var) else { return false };
            if let (Some(a), Some(b)) = (cur.as_f64(), value.as_f64().or_else(|| value.as_str().and_then(|s| s.trim().parse().ok()))) {
                return match op.as_str() { "==" => a == b, "!=" => a != b, ">" => a > b, ">=" => a >= b, "<" => a < b, "<=" => a <= b, _ => false };
            }
            if let (Some(a), Some(b)) = (cur.as_bool(), value.as_bool()) {
                return match op.as_str() { "==" => a == b, "!=" => a != b, _ => false };
            }
            let (a, b) = (text_of(cur).to_lowercase(), text_of(value).to_lowercase());
            match op.as_str() { "==" => a == b, "!=" => a != b, "contains" => a.contains(&b), _ => false }
        }
        Cond::UserSays { words } => any_word(&ctx.user, words),
        Cond::ReplySays { words } => !ctx.reply.is_empty() && any_word(&ctx.reply, words),
        Cond::EveryN { n } => *n > 0 && ctx.turn > 0 && ctx.turn % i64::from(*n) == 0,
        Cond::Chance { percent } => (mix(ctx.seed ^ salt.wrapping_mul(0x9e3779b97f4a7c15)) % 100) < u64::from((*percent).min(100)),
    }
}

fn all_hold(list: &[Cond], vals: &BTreeMap<String, Value>, ctx: &Ctx, salt: u64) -> bool {
    list.iter().enumerate().all(|(k, c)| eval(c, vals, ctx, salt.wrapping_add(k as u64 + 1)))
}

/// Applies one change. Anything that doesn't fit the variable is ignored (a number can't be appended to).
pub fn apply(pb: &Playbook, st: &mut PState, act: &Act, turn: i64) {
    let Some(v) = pb.variables.iter().find(|v| v.id == act.var) else { return };
    let cur = st.get(v);
    let new = match (act.op.as_str(), v.kind.as_str()) {
        ("set", _) => Some(coerce(v, &act.value)),
        ("add", "number") | ("subtract", "number") => {
            let by = act.value.as_f64().or_else(|| act.value.as_str().and_then(|s| s.trim().parse().ok())).unwrap_or(0.0);
            let n = cur.as_f64().unwrap_or(0.0) + if act.op == "add" { by } else { -by };
            Some(coerce(v, &json!(n)))
        }
        ("toggle", "bool") => Some(Value::Bool(!cur.as_bool().unwrap_or(false))),
        ("append", "text") => {
            let (a, b) = (text_of(&cur), text_of(&act.value));
            if b.trim().is_empty() { None } else { Some(coerce(v, &Value::String(if a.is_empty() { b } else { format!("{a}, {b}") }))) }
        }
        ("clear", _) => Some(coerce(v, &v.default)),
        _ => None,
    };
    if let Some(n) = new {
        st.set(&v.id, n, turn);
    }
}

/// Runs the rules of one phase, in order. `ask` is how the model is asked a rule's question (`true` = yes); `llm_on` says whether it may be.
/// Returns the names of the rules that ran.
pub async fn run_phase<F, Fut>(pb: &Playbook, phase: &str, st: &mut PState, ctx: &Ctx, llm_on: bool, mut ask: F) -> Vec<String>
where
    F: FnMut(String, BTreeMap<String, Value>) -> Fut,
    Fut: Future<Output = bool>,
{
    let mut ran = vec![];
    for (i, rule) in pb.rules.iter().enumerate().filter(|(_, r)| r.phase == phase) {
        let vals = values(pb, st);
        let salt = (i as u64 + 1) * 1000;
        let basic = all_hold(&rule.when, &vals, ctx, salt) && (rule.when_any.is_empty() || rule.when_any.iter().enumerate().any(|(k, c)| eval(c, &vals, ctx, salt + 500 + k as u64)));
        if !basic {
            continue;
        }
        let fire = if rule.ask.trim().is_empty() {
            true
        } else if llm_on {
            ask(rule.ask.clone(), vals.clone()).await
        } else {
            !rule.fallback.is_empty() && all_hold(&rule.fallback, &vals, ctx, salt + 700)
        };
        if fire {
            for act in &rule.then {
                apply(pb, st, act, ctx.turn);
            }
            ran.push(if rule.name.is_empty() { rule.id.clone() } else { rule.name.clone() });
        }
    }
    ran
}

// ----- what the characters are told -----

fn describe(v: &Var, val: &Value) -> String {
    let shown = match val {
        Value::Bool(b) => if *b { "yes".to_string() } else { "no".to_string() },
        other => text_of(other),
    };
    let mut s = format!("- {}: {}", if v.label.is_empty() { &v.id } else { &v.label }, if shown.is_empty() { "(nothing yet)".into() } else { shown });
    if v.kind == "number" {
        if let (Some(lo), Some(hi)) = (v.min, v.max) {
            s.push_str(&format!(" (from {} to {})", number_value(lo), number_value(hi)));
        }
        if let Some(n) = val.as_f64() {
            if let Some(b) = v.bands.iter().filter(|b| b.from <= n).max_by(|a, b| a.from.total_cmp(&b.from)) {
                s.push_str(&format!(", meaning: {}", b.text));
            }
        }
    }
    if !v.note.trim().is_empty() {
        s.push_str(&format!(". {}", v.note.trim()));
    }
    s
}

/// The state, as the characters are told it.
pub fn prompt_block(pb: &Playbook, st: &PState) -> String {
    if pb.variables.is_empty() {
        return String::new();
    }
    let lines: Vec<String> = pb.variables.iter().map(|v| describe(v, &st.get(v))).collect();
    format!(
        "The story so far is tracked by these values. Let them shape the scene and how everyone behaves, and keep your reply consistent with them; \
         never mention that they are numbers or variables.\n{}",
        lines.join("\n")
    )
}

fn entry_matches(key: &str, index: usize, entry: &dorms_core::BookEntry) -> bool {
    let k = key.trim().to_lowercase();
    k == format!("#{}", index + 1) || (!entry.name.trim().is_empty() && entry.name.trim().to_lowercase() == k)
}

/// The entries of the attached lorebooks that are available now (the lorebook engine then picks what is relevant and fits).
pub fn lore_entries(pb: &Playbook, books: &[db::Lorebook], st: &PState) -> Vec<dorms_core::BookEntry> {
    let vals = values(pb, st);
    let ctx = Ctx { user: String::new(), reply: String::new(), turn: 0, seed: 0 };
    let mut out = vec![];
    for id in pb.lorebooks.iter().take(MAX_BOOKS) {
        let Some(b) = books.iter().find(|b| &b.id == id) else { continue };
        let mut w = vec![];
        let book = dorms_core::CharacterBook::from_value(&b.book, &mut w);
        let cfg = pb.lore.iter().find(|g| &g.book == id);
        for (i, entry) in book.entries.into_iter().enumerate() {
            let gate = cfg.and_then(|c| c.gates.iter().find(|g| entry_matches(&g.entry, i, &entry)));
            let available = match gate {
                Some(g) => all_hold(&g.when, &vals, &ctx, 0),
                None => cfg.map_or(true, |c| c.default_on),
            };
            if available {
                out.push(entry);
            }
        }
    }
    out
}

// ----- checking a definition -----

fn check_conds(list: &mut Vec<Cond>, vars: &HashSet<String>, what: &str) -> R<()> {
    for c in list.iter_mut() {
        match c {
            Cond::Var { var, op, .. } => {
                if !vars.contains(var.as_str()) {
                    return Err(format!("{what} checks a value called \"{var}\", which this playbook doesn't have."));
                }
                if !["==", "!=", ">", ">=", "<", "<=", "contains"].contains(&op.as_str()) {
                    return Err(format!("{what} uses a comparison that isn't known: \"{op}\"."));
                }
            }
            Cond::UserSays { words } | Cond::ReplySays { words } => {
                words.retain(|w| !w.trim().is_empty());
                for w in words.iter_mut() { *w = w.trim().chars().take(60).collect(); }
                words.truncate(20);
            }
            Cond::EveryN { n } => *n = (*n).clamp(1, 1000),
            Cond::Chance { percent } => *percent = (*percent).min(100),
        }
    }
    Ok(())
}

/// A definition made safe and within the limits. `my_books` are the lorebooks that belong to the owner.
pub fn clean_playbook(mut pb: Playbook, my_books: &[String]) -> R<Playbook> {
    pb.name = pb.name.chars().filter(|c| !c.is_control()).collect::<String>().trim().chars().take(60).collect();
    if pb.name.is_empty() {
        return Err("Give the playbook a name.".into());
    }
    pb.description = pb.description.trim().chars().take(600).collect();
    pb.instructions = pb.instructions.trim().chars().take(2000).collect();
    if pb.variables.len() > MAX_VARS {
        return Err(format!("A playbook can have up to {MAX_VARS} variables."));
    }
    if pb.rules.len() > MAX_RULES {
        return Err(format!("A playbook can have up to {MAX_RULES} rules."));
    }
    if pb.rules.iter().filter(|r| !r.ask.trim().is_empty()).count() > MAX_ASK {
        return Err(format!("At most {MAX_ASK} rules can ask the model to judge."));
    }
    if pb.lorebooks.len() > MAX_BOOKS {
        return Err(format!("A playbook can have up to {MAX_BOOKS} lorebooks."));
    }
    if pb.scenarios.len() > MAX_SCENARIOS {
        return Err(format!("A playbook can have up to {MAX_SCENARIOS} starting scenarios."));
    }
    let mut seen = HashSet::new();
    for v in pb.variables.iter_mut() {
        v.id = clean_id(&v.id).ok_or("Every variable needs a name of letters, numbers and underscores, starting with a letter.")?;
        if !seen.insert(v.id.clone()) {
            return Err(format!("Two variables are called \"{}\".", v.id));
        }
        v.label = v.label.trim().chars().take(40).collect();
        v.note = v.note.trim().chars().take(300).collect();
        if !["number", "bool", "text", "choice"].contains(&v.kind.as_str()) {
            v.kind = "text".into();
        }
        v.options = v.options.iter().map(|o| o.trim().chars().take(40).collect::<String>()).filter(|o| !o.is_empty()).take(12).collect();
        if v.kind == "choice" && v.options.is_empty() {
            return Err(format!("\"{}\" is a choice, so it needs at least one option.", v.id));
        }
        if let (Some(lo), Some(hi)) = (v.min, v.max) {
            if lo > hi { std::mem::swap(&mut v.min, &mut v.max); }
        }
        v.bands.retain(|b| !b.text.trim().is_empty());
        for b in v.bands.iter_mut() { b.text = b.text.trim().chars().take(120).collect(); }
        v.bands.truncate(8);
        let d = v.default.clone();
        v.default = coerce(v, &d);
    }
    let vars: HashSet<String> = pb.variables.iter().map(|v| v.id.clone()).collect();
    let mut rule_ids = HashSet::new();
    for (i, r) in pb.rules.iter_mut().enumerate() {
        r.id = clean_id(&r.id).unwrap_or_else(|| format!("rule_{}", i + 1));
        while !rule_ids.insert(r.id.clone()) { r.id = format!("{}_{}", r.id, i + 1); }
        r.name = r.name.trim().chars().take(60).collect();
        if r.phase != "before" && r.phase != "after" { r.phase = "before".into(); }
        r.ask = r.ask.trim().chars().take(400).collect();
        let what = format!("The rule \"{}\"", if r.name.is_empty() { &r.id } else { &r.name });
        check_conds(&mut r.when, &vars, &what)?;
        check_conds(&mut r.when_any, &vars, &what)?;
        check_conds(&mut r.fallback, &vars, &what)?;
        for a in &r.then {
            if !vars.contains(&a.var) {
                return Err(format!("{what} changes a value called \"{}\", which this playbook doesn't have.", a.var));
            }
            if !["set", "add", "subtract", "toggle", "append", "clear"].contains(&a.op.as_str()) {
                return Err(format!("{what} uses a change that isn't known: \"{}\".", a.op));
            }
        }
        if r.then.is_empty() {
            return Err(format!("{what} doesn't change anything yet."));
        }
        if r.phase == "before" {
            // a rule that runs before the reply can't look at a reply that doesn't exist yet
            r.when.retain(|c| !matches!(c, Cond::ReplySays { .. }));
        }
    }
    let mut books: Vec<String> = vec![];
    for b in pb.lorebooks.iter() {
        if my_books.contains(b) && !books.contains(b) { books.push(b.clone()); }
    }
    pb.lorebooks = books;
    pb.lore.retain(|g| pb.lorebooks.contains(&g.book));
    for g in pb.lore.iter_mut() {
        g.gates.retain(|x| !x.entry.trim().is_empty());
        for x in g.gates.iter_mut() { check_conds(&mut x.when, &vars, "A lorebook entry's availability")?; }
    }
    for s in pb.scenarios.iter_mut() {
        s.name = s.name.trim().chars().take(40).collect();
        if s.name.is_empty() {
            return Err("Every starting scenario needs a name.".into());
        }
        s.description = s.description.trim().chars().take(200).collect();
        let vals = std::mem::take(&mut s.values);
        s.values = vals.into_iter().filter_map(|(k, val)| pb.variables.iter().find(|v| v.id == k).map(|v| (k, coerce(v, &val)))).collect();
    }
    Ok(pb)
}

// ----- keeping them -----

pub fn list(c: &Connection, o: &Owner) -> R<Vec<Playbook>> {
    let mut s = c.prepare("SELECT id,json,created_at,updated_at FROM playbooks WHERE profile_id IS ?1 ORDER BY name COLLATE NOCASE").map_err(e)?;
    let rows = s.query_map([o], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?, r.get::<_, i64>(3)?))).map_err(e)?;
    Ok(rows.filter_map(|r| r.ok()).filter_map(|(id, j, c, u)| serde_json::from_str::<Playbook>(&j).ok().map(|mut p| { p.id = id; p.created_at = c; p.updated_at = u; p })).collect())
}

pub fn get(c: &Connection, id: &str, o: &Owner) -> Option<Playbook> {
    if id.is_empty() { return None; }
    list(c, o).ok()?.into_iter().find(|p| p.id == id)
}

pub fn save(c: &Connection, pb: &Playbook, o: &Owner) -> R<()> {
    let j = serde_json::to_string(pb).map_err(e)?;
    c.execute(
        "INSERT INTO playbooks(id,profile_id,name,json,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?5)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, json=excluded.json, updated_at=excluded.updated_at WHERE playbooks.profile_id IS ?2",
        params![pb.id, o, pb.name, j, db::now()],
    )
    .map_err(e)?;
    Ok(())
}

// ----- one chat's story -----

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ChatRow {
    /// `inherit` (the character's own), `none`, or `set` (`playbook_id`).
    pub mode: String,
    pub playbook_id: Option<String>,
    pub state: PState,
    pub turn: i64,
    /// Whether the model may be asked to judge (rules that ask).
    pub llm: bool,
    /// What the story started as, for rewinding to the beginning.
    pub start: PState,
    /// The state before a reply that is still being written (put back if it fails).
    pub pending: Option<(PState, i64)>,
}

impl Default for ChatRow {
    fn default() -> Self {
        ChatRow { mode: "inherit".into(), playbook_id: None, state: PState::default(), turn: 0, llm: true, start: PState::default(), pending: None }
    }
}

pub fn chat_row(c: &Connection, chat_id: i64) -> ChatRow {
    c.query_row("SELECT mode,playbook_id,state,turn,llm,start_state,pending_state,pending_turn FROM chat_playbook WHERE chat_id=?1", [chat_id], |r| {
        let st = |s: String| serde_json::from_str::<PState>(&s).unwrap_or_default();
        let pending: Option<String> = r.get(6)?;
        Ok(ChatRow {
            mode: r.get(0)?,
            playbook_id: r.get(1)?,
            state: st(r.get(2)?),
            turn: r.get(3)?,
            llm: r.get::<_, i64>(4)? != 0,
            start: st(r.get(5)?),
            pending: pending.map(|p| (st(p), r.get::<_, Option<i64>>(7).ok().flatten().unwrap_or(0))),
        })
    })
    .optional()
    .ok()
    .flatten()
    .unwrap_or_default()
}

pub fn save_row(c: &Connection, chat_id: i64, row: &ChatRow) -> R<()> {
    let js = |s: &PState| serde_json::to_string(s).unwrap_or_else(|_| "{}".into());
    c.execute(
        "INSERT INTO chat_playbook(chat_id,mode,playbook_id,state,turn,llm,start_state,pending_state,pending_turn) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)
         ON CONFLICT(chat_id) DO UPDATE SET mode=excluded.mode, playbook_id=excluded.playbook_id, state=excluded.state, turn=excluded.turn, llm=excluded.llm,
            start_state=excluded.start_state, pending_state=excluded.pending_state, pending_turn=excluded.pending_turn",
        params![chat_id, row.mode, row.playbook_id, js(&row.state), row.turn, row.llm as i64, js(&row.start), row.pending.as_ref().map(|p| js(&p.0)), row.pending.as_ref().map(|p| p.1)],
    )
    .map_err(e)?;
    Ok(())
}

/// The playbook a chat is using: the one chosen for it, or none, or else the first of its characters that comes with one.
pub fn effective(c: &Connection, chat: &db::Chat, o: &Owner) -> Option<(Playbook, ChatRow)> {
    let row = chat_row(c, chat.id);
    let id = match row.mode.as_str() {
        "none" => return None,
        "set" => row.playbook_id.clone()?,
        _ => chat.character_ids.iter().filter_map(|i| db::get_character(c, i, o).ok().flatten()).map(|ch| ch.playbook).find(|p| !p.is_empty())
            .or_else(|| db::chat_world(c, chat, o).ok().flatten().map(|w| w.playbook).filter(|p| !p.is_empty()))?,
    };
    get(c, &id, o).map(|pb| (pb, row))
}

pub fn save_snapshot(c: &Connection, message_id: i64, chat_id: i64, before: &PState, after: &PState, turn: i64) -> R<()> {
    let js = |s: &PState| serde_json::to_string(s).unwrap_or_else(|_| "{}".into());
    c.execute(
        "INSERT INTO playbook_snap(message_id,chat_id,before_state,after_state,turn) VALUES(?1,?2,?3,?4,?5)
         ON CONFLICT(message_id) DO UPDATE SET before_state=excluded.before_state, after_state=excluded.after_state, turn=excluded.turn",
        params![message_id, chat_id, js(before), js(after), turn],
    )
    .map_err(e)?;
    Ok(())
}

pub fn snapshot(c: &Connection, message_id: i64) -> Option<(PState, PState, i64)> {
    c.query_row("SELECT before_state,after_state,turn FROM playbook_snap WHERE message_id=?1", [message_id], |r| {
        let st = |s: String| serde_json::from_str::<PState>(&s).unwrap_or_default();
        Ok((st(r.get(0)?), st(r.get(1)?), r.get::<_, i64>(2)?))
    })
    .optional()
    .ok()
    .flatten()
}

/// After messages were deleted or cleared: the state goes back to what the newest remaining reply left (or to the start).
pub fn rewind(c: &Connection, chat_id: i64) {
    let mut row = chat_row(c, chat_id);
    let _ = c.execute("DELETE FROM playbook_snap WHERE chat_id=?1 AND message_id NOT IN (SELECT id FROM messages WHERE chat_id=?1)", [chat_id]);
    let last = c
        .query_row("SELECT after_state,turn FROM playbook_snap WHERE chat_id=?1 ORDER BY message_id DESC LIMIT 1", [chat_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
        .optional()
        .ok()
        .flatten();
    match last {
        Some((s, t)) => { row.state = serde_json::from_str(&s).unwrap_or_default(); row.turn = t; }
        None => { row.state = row.start.clone(); row.turn = 0; }
    }
    row.pending = None;
    let _ = save_row(c, chat_id, &row);
}

/// A reply failed: put the state back to what it was before this turn's rules ran.
pub fn restore_pending(c: &Connection, chat_id: i64) {
    let mut row = chat_row(c, chat_id);
    if let Some((s, t)) = row.pending.take() {
        row.state = s;
        row.turn = t;
        let _ = save_row(c, chat_id, &row);
    }
}

// ----- the turn -----

/// What a turn remembers between its two halves.
pub struct Turn {
    pub playbook: Playbook,
    pub before: PState,
    pub turn: i64,
    pub llm: bool,
}

fn new_seed() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos() as u64).unwrap_or(1)
}

fn clip(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

/// Asks the model one yes/no question about the story (a rule that "asks"). A model that can't be reached means "no".
async fn judge(st: &Shared, ep: &crate::llm::Endpoint, question: &str, vals: &BTreeMap<String, Value>, user: &str, reply: &str) -> bool {
    let msgs = vec![
        dorms_core::prompt::ChatMsg { role: "system".into(), content: "You judge what happened in a roleplay. Answer with exactly one word: YES or NO.".into() },
        dorms_core::prompt::ChatMsg {
            role: "user".into(),
            content: format!(
                "Question: {question}\n\nThe player wrote: {}\n{}Current story values: {}\n\nAnswer YES or NO.",
                clip(user, 1200),
                if reply.is_empty() { String::new() } else { format!("The reply was: {}\n", clip(reply, 1800)) },
                serde_json::to_string(vals).unwrap_or_default()
            ),
        },
    ];
    let params = crate::llm::GenParams { temperature: 0.0, top_p: 1.0, max_tokens: 4 };
    match crate::llm::stream_chat(&st.http, ep, &msgs, &params, &tokio::sync::Notify::new(), |_| {}).await {
        Ok(t) => t.trim().trim_matches(|c: char| !c.is_alphanumeric()).to_lowercase().starts_with("yes"),
        Err(_) => false,
    }
}

/// Before a reply: the state goes back to what it was before the reply being regenerated (if that is what this is), then the "before" rules run
/// and the new state is saved. Returns what the second half needs; `None` if no playbook is active.
pub async fn before_turn(st: &Shared, o: &Owner, chat: &db::Chat, ep: &crate::llm::Endpoint, user_text: &str, regen: Option<i64>, run_rules: bool) -> Option<Turn> {
    let (pb, mut row, books) = {
        let db = st.db.lock().unwrap();
        let (pb, row) = effective(&db, chat, o)?;
        (pb, row, db::list_lorebooks(&db, o).unwrap_or_default())
    };
    let _ = books;
    if let Some(mid) = regen {
        let snap = { let db = st.db.lock().unwrap(); snapshot(&db, mid) };
        if let Some((before, _, turn)) = snap {
            row.state = before;
            row.turn = turn - 1;
        }
    }
    let before = row.state.clone();
    let start_turn = row.turn;
    if run_rules {
        row.turn += 1;
        let ctx = Ctx { user: user_text.to_string(), reply: String::new(), turn: row.turn, seed: new_seed() };
        let mut s = row.state.clone();
        let ask = |q: String, vals: BTreeMap<String, Value>| { let user = user_text.to_string(); async move { judge(st, ep, &q, &vals, &user, "").await } };
        run_phase(&pb, "before", &mut s, &ctx, row.llm, ask).await;
        let keep: HashSet<String> = pb.variables.iter().map(|v| v.id.clone()).collect();
        s.trim(&keep);
        row.state = s;
    }
    row.pending = Some((before.clone(), start_turn));
    { let db = st.db.lock().unwrap(); let _ = save_row(&db, chat.id, &row); }
    Some(Turn { playbook: pb, before, turn: row.turn, llm: row.llm })
}

/// After a reply: the "after" rules run (they can read what was just written), the state is saved and kept with the reply, so it can be rerun or rewound.
pub async fn after_turn(st: &Shared, o: &Owner, chat: &db::Chat, ep: &crate::llm::Endpoint, t: &Turn, user_text: &str, reply: &str) -> PState {
    let _ = o;
    let mut row = { let db = st.db.lock().unwrap(); chat_row(&db, chat.id) };
    let ctx = Ctx { user: user_text.to_string(), reply: reply.to_string(), turn: t.turn, seed: new_seed() };
    let mut s = row.state.clone();
    let ask = |q: String, vals: BTreeMap<String, Value>| { let (u, r) = (user_text.to_string(), reply.to_string()); async move { judge(st, ep, &q, &vals, &u, &r).await } };
    run_phase(&t.playbook, "after", &mut s, &ctx, t.llm, ask).await;
    let keep: HashSet<String> = t.playbook.variables.iter().map(|v| v.id.clone()).collect();
    s.trim(&keep);
    row.state = s.clone();
    row.pending = None;
    { let db = st.db.lock().unwrap(); let _ = save_row(&db, chat.id, &row); }
    s
}

// ----- what the characters are told, and the lore -----

pub fn prompt_for_chat(c: &Connection, chat: &db::Chat, o: &Owner) -> String {
    match effective(c, chat, o) {
        Some((pb, row)) => prompt_block(&pb, &row.state),
        None => String::new(),
    }
}

/// The lorebook entries this chat's playbook makes available right now.
pub fn lore_for_chat(c: &Connection, chat: &db::Chat, o: &Owner) -> Vec<dorms_core::BookEntry> {
    match effective(c, chat, o) {
        Some((pb, row)) if !pb.lorebooks.is_empty() => lore_entries(&pb, &db::list_lorebooks(c, o).unwrap_or_default(), &row.state),
        _ => vec![],
    }
}

// ----- commands -----

#[derive(Serialize)]
pub struct VarView {
    pub id: String,
    pub label: String,
    pub kind: String,
    pub value: Value,
    pub meaning: String,
    pub note: String,
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub options: Vec<String>,
}

#[derive(Serialize)]
pub struct ChatPlaybook {
    /// `inherit` | `none` | `set`
    pub mode: String,
    /// The one chosen for the chat (when `mode` is `set`).
    pub selected: Option<String>,
    /// The one in use now, with the values.
    pub active: Option<Playbook>,
    pub values: Vec<VarView>,
    pub turn: i64,
    pub llm: bool,
    /// Where it comes from, when it is the character's own.
    pub from_character: bool,
    /// True when the playbook in use comes from the world the chat is in (no character of the chat brings one).
    pub from_world: bool,
}

fn view(c: &Connection, chat: &db::Chat, o: &Owner) -> ChatPlaybook {
    let row = chat_row(c, chat.id);
    let eff = effective(c, chat, o);
    let from_character = row.mode == "inherit" && eff.is_some();
    let from_world = from_character && !chat.character_ids.iter().filter_map(|i| db::get_character(c, i, o).ok().flatten()).any(|ch| !ch.playbook.is_empty());
    match eff {
        Some((pb, row)) => {
            let values = pb.variables.iter().map(|v| {
                let val = row.state.get(v);
                let meaning = val.as_f64().and_then(|n| v.bands.iter().filter(|b| b.from <= n).max_by(|a, b| a.from.total_cmp(&b.from)).map(|b| b.text.clone())).unwrap_or_default();
                VarView { id: v.id.clone(), label: if v.label.is_empty() { v.id.clone() } else { v.label.clone() }, kind: v.kind.clone(), value: val, meaning, note: v.note.clone(), min: v.min, max: v.max, options: v.options.clone() }
            }).collect();
            ChatPlaybook { mode: row.mode.clone(), selected: row.playbook_id.clone(), active: Some(pb), values, turn: row.turn, llm: row.llm, from_character, from_world }
        }
        None => ChatPlaybook { mode: row.mode.clone(), selected: row.playbook_id.clone(), active: None, values: vec![], turn: row.turn, llm: row.llm, from_character: false, from_world: false },
    }
}

fn my_chat(db: &Connection, chat_id: i64, o: &Owner) -> R<db::Chat> {
    db::get_chat(db, chat_id, o).map_err(e)?.ok_or_else(|| "Chat not found".to_string())
}

#[tauri::command]
pub fn list_playbooks(state: State<'_, Shared>) -> R<Vec<Playbook>> {
    list(&state.db.lock().unwrap(), &owner(&state)?)
}

/// Make or change a playbook (an empty id makes a new one). Returns it as it was kept.
#[tauri::command]
pub fn save_playbook(state: State<'_, Shared>, playbook: Playbook) -> R<Playbook> {
    let o = owner(&state)?;
    let db = state.db.lock().unwrap();
    let mine: Vec<String> = db::list_lorebooks(&db, &o).map_err(e)?.into_iter().map(|b| b.id).collect();
    let mut pb = clean_playbook(playbook, &mine)?;
    if pb.id.is_empty() || get(&db, &pb.id, &o).is_none() {
        pb.id = uid();
    }
    save(&db, &pb, &o)?;
    Ok(get(&db, &pb.id, &o).unwrap_or(pb))
}

/// Delete a playbook. Characters that came with it and chats that used it simply have none any more.
#[tauri::command]
pub fn delete_playbook(state: State<'_, Shared>, id: String) -> R<()> {
    let o = owner(&state)?;
    let db = state.db.lock().unwrap();
    if get(&db, &id, &o).is_none() {
        return Ok(());
    }
    for mut ch in db::list_characters(&db, &o).map_err(e)? {
        if ch.playbook == id { ch.playbook.clear(); db::save_character(&db, &ch, &o).map_err(e)?; }
    }
    db.execute("DELETE FROM playbooks WHERE id=?1 AND profile_id IS ?2", params![id, o]).map_err(e)?;
    Ok(())
}

/// The starter playbooks (original examples to begin from): a slow-burn relationship, a locked-room mystery, a supply run, random events.
#[tauri::command]
pub fn playbook_templates() -> Vec<Playbook> {
    templates()
}

#[tauri::command]
pub fn get_chat_playbook(state: State<'_, Shared>, chat_id: i64) -> R<ChatPlaybook> {
    let o = owner(&state)?;
    let db = state.db.lock().unwrap();
    let chat = my_chat(&db, chat_id, &o)?;
    Ok(view(&db, &chat, &o))
}

/// Choose the playbook for a chat: `inherit` (the character's own), `none`, or `set` with a playbook id (and a starting scenario, if you like).
#[tauri::command]
pub fn set_chat_playbook(state: State<'_, Shared>, chat_id: i64, mode: String, playbook_id: Option<String>, scenario: Option<String>) -> R<ChatPlaybook> {
    let o = owner(&state)?;
    let db = state.db.lock().unwrap();
    let chat = my_chat(&db, chat_id, &o)?;
    let mut row = chat_row(&db, chat_id);
    match mode.as_str() {
        "inherit" | "none" => { row.mode = mode; row.playbook_id = None; }
        "set" => {
            let id = playbook_id.unwrap_or_default();
            if get(&db, &id, &o).is_none() {
                return Err("That playbook doesn't exist any more.".into());
            }
            row.mode = "set".into();
            row.playbook_id = Some(id);
        }
        _ => return Err("Choose the character's playbook, none, or one of yours.".into()),
    }
    // the playbook now in use: a chosen scenario sets the starting values; values with matching names carry over from the one before
    if let Some((pb, _)) = effective(&db, &chat, &o).map(|(p, _)| (p, ())) {
        let keep: HashSet<String> = pb.variables.iter().map(|v| v.id.clone()).collect();
        let base = starting_state(&pb, scenario.as_deref());
        if scenario.is_some() || row.state.vars.is_empty() {
            for (k, v) in base.vars.iter() { row.state.set(k, v.clone(), row.turn); }
        } else {
            for (k, v) in base.vars.iter() { if !row.state.vars.contains_key(k) { row.state.set(k, v.clone(), row.turn); } }
        }
        row.state.trim(&keep);
        row.start = if scenario.is_some() || row.start.vars.is_empty() { row.state.clone() } else { row.start.clone() };
    }
    row.pending = None;
    save_row(&db, chat_id, &row)?;
    Ok(view(&db, &chat, &o))
}

/// Change values by hand (the story state is yours to correct, for example after editing the story text).
#[tauri::command]
pub fn set_playbook_values(state: State<'_, Shared>, chat_id: i64, values: BTreeMap<String, Value>) -> R<ChatPlaybook> {
    let o = owner(&state)?;
    let db = state.db.lock().unwrap();
    let chat = my_chat(&db, chat_id, &o)?;
    let (pb, mut row) = effective(&db, &chat, &o).ok_or("This chat has no playbook.")?;
    for (k, val) in values {
        if let Some(v) = pb.variables.iter().find(|v| v.id == k) {
            let c = coerce(v, &val);
            row.state.set(&k, c, row.turn);
        }
    }
    save_row(&db, chat_id, &row)?;
    Ok(view(&db, &chat, &o))
}

/// Let the model judge the rules that ask (on), or use their fallbacks instead (off).
#[tauri::command]
pub fn set_playbook_llm(state: State<'_, Shared>, chat_id: i64, on: bool) -> R<ChatPlaybook> {
    let o = owner(&state)?;
    let db = state.db.lock().unwrap();
    let chat = my_chat(&db, chat_id, &o)?;
    let mut row = chat_row(&db, chat_id);
    row.llm = on;
    save_row(&db, chat_id, &row)?;
    Ok(view(&db, &chat, &o))
}

// ----- the starters -----

fn templates() -> Vec<Playbook> {
    let defs: [&str; 4] = [
        include_str!("playbook_templates/slow_burn.json"),
        include_str!("playbook_templates/locked_room.json"),
        include_str!("playbook_templates/supply_run.json"),
        include_str!("playbook_templates/wildcard.json"),
    ];
    defs.iter().filter_map(|d| serde_json::from_str::<Playbook>(d).ok()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    fn block_on<F: Future>(f: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(f)
    }
    fn pb(j: &str) -> Playbook {
        clean_playbook(serde_json::from_str(j).unwrap(), &[]).expect("a valid playbook")
    }
    fn ctx(user: &str, reply: &str, turn: i64) -> Ctx {
        Ctx { user: user.into(), reply: reply.into(), turn, seed: 7 }
    }
    const BASIC: &str = r#"{"name":"T","variables":[
        {"id":"n","label":"N","kind":"number","default":0,"min":0,"max":5,"bands":[{"from":0,"text":"low"},{"from":3,"text":"high"}]},
        {"id":"flag","kind":"bool","default":false},{"id":"place","kind":"text","default":"home"},
        {"id":"mood","kind":"choice","default":"calm","options":["calm","angry"]}],
        "rules":[
        {"id":"r1","phase":"before","when":[{"type":"user_says","words":["hello"]}],"then":[{"var":"n","op":"add","value":2}]},
        {"id":"r3","phase":"before","when":[{"type":"var","var":"n","op":">=","value":2}],"then":[{"var":"n","op":"add","value":9}]},
        {"id":"r2","phase":"after","when":[{"type":"reply_says","words":["goodbye"]}],"then":[{"var":"flag","op":"toggle"},{"var":"place","op":"append","value":"the road"},{"var":"mood","op":"set","value":"ANGRY"}]}]}"#;

    #[test]
    fn values_fit_their_variables() {
        let p = pb(BASIC);
        let v = |id: &str| p.variables.iter().find(|v| v.id == id).unwrap().clone();
        assert_eq!(coerce(&v("n"), &json!(99)), json!(5), "a number stays inside its range");
        assert_eq!(coerce(&v("n"), &json!("3")), json!(3));
        assert_eq!(coerce(&v("n"), &json!("junk")), json!(0), "nonsense becomes the default");
        assert_eq!(coerce(&v("flag"), &json!("yes")), json!(true));
        assert_eq!(coerce(&v("mood"), &json!("angry")), json!("angry"));
        assert_eq!(coerce(&v("mood"), &json!("sleepy")), json!("calm"), "only the listed choices");
        assert_eq!(coerce(&v("place"), &json!("x".repeat(500))).as_str().unwrap().len(), 200);
        assert_eq!(clean_id(" Trust Level! ").as_deref(), Some("trust_level"));
        assert_eq!(clean_id("9lives"), None, "a name starts with a letter");
    }

    #[test]
    fn rules_run_in_their_phase_and_in_order() {
        let p = pb(BASIC);
        let mut st = starting_state(&p, None);
        block_on(run_phase(&p, "before", &mut st, &ctx("Hello there", "", 1), true, |_, _| async { false }));
        assert_eq!(values(&p, &st)["n"], json!(5), "the first rule added 2 and the next saw it and added more, up to the top of the range");
        let mut st2 = starting_state(&p, None);
        let ran = block_on(run_phase(&p, "before", &mut st2, &ctx("nothing", "goodbye", 1), true, |_, _| async { false }));
        assert!(ran.is_empty() && values(&p, &st2)["n"] == json!(0), "an 'after' rule or a missing word does nothing before the reply");
        let ran = block_on(run_phase(&p, "after", &mut st2, &ctx("x", "Goodbye!", 1), true, |_, _| async { false }));
        let v = values(&p, &st2);
        assert_eq!((ran.len(), &v["flag"], &v["place"], &v["mood"]), (1, &json!(true), &json!("home, the road"), &json!("angry")));
    }

    #[test]
    fn turns_and_chances_are_counted() {
        let p = pb(r#"{"name":"T","variables":[{"id":"n","kind":"number","default":0,"min":0,"max":100}],"rules":[
            {"id":"e","phase":"before","when":[{"type":"every_n","n":3}],"then":[{"var":"n","op":"add","value":1}]},
            {"id":"never","phase":"before","when":[{"type":"chance","percent":0}],"then":[{"var":"n","op":"add","value":10}]},
            {"id":"always","phase":"before","when":[{"type":"chance","percent":100}],"then":[{"var":"n","op":"add","value":100}]}]}"#);
        let mut st = starting_state(&p, None);
        block_on(run_phase(&p, "before", &mut st, &ctx("", "", 2), true, |_, _| async { false }));
        assert_eq!(values(&p, &st)["n"], json!(100), "turn 2 is not a third turn; 0% never; 100% always (and the value stops at 100)");
        let mut st = starting_state(&p, None);
        block_on(run_phase(&p, "before", &mut st, &ctx("", "", 3), true, |_, _| async { false }));
        assert_eq!(values(&p, &st)["n"], json!(100));
        // a chance in between comes out both ways over many different turns
        let half = pb(r#"{"name":"T","variables":[{"id":"n","kind":"number","default":0}],"rules":[{"id":"c","phase":"before","when":[{"type":"chance","percent":50}],"then":[{"var":"n","op":"add","value":1}]}]}"#);
        let hits = (0..200u64).filter(|s| { let mut st = starting_state(&half, None); block_on(run_phase(&half, "before", &mut st, &Ctx { seed: *s * 7919 + 1, ..ctx("", "", 1) }, true, |_, _| async { false })); values(&half, &st)["n"] == json!(1) }).count();
        assert!((60..=140).contains(&hits), "about half the time, got {hits}");
    }

    #[test]
    fn a_rule_that_asks_uses_the_model_or_else_its_fallback() {
        let p = pb(r#"{"name":"T","variables":[{"id":"n","kind":"number","default":0,"min":0,"max":9}],"rules":[
            {"id":"a","phase":"after","ask":"Was that kind?","fallback":[{"type":"user_says","words":["thanks"]}],"then":[{"var":"n","op":"add","value":1}]},
            {"id":"b","phase":"after","ask":"Another?","then":[{"var":"n","op":"add","value":4}]}]}"#);
        let asked = Cell::new(0);
        let mut st = starting_state(&p, None);
        block_on(run_phase(&p, "after", &mut st, &ctx("", "", 1), true, |_, _| { asked.set(asked.get() + 1); async { true } }));
        assert_eq!((values(&p, &st)["n"].clone(), asked.get()), (json!(5), 2), "the model said yes to both");
        let mut st = starting_state(&p, None);
        block_on(run_phase(&p, "after", &mut st, &ctx("", "", 1), true, |_, _| async { false }));
        assert_eq!(values(&p, &st)["n"], json!(0), "the model said no");
        asked.set(0);
        let mut st = starting_state(&p, None);
        block_on(run_phase(&p, "after", &mut st, &ctx("thanks a lot", "", 1), false, |_, _| { asked.set(asked.get() + 1); async { true } }));
        assert_eq!((values(&p, &st)["n"].clone(), asked.get()), (json!(1), 0), "with the model's judgment off the fallback decides, and nothing is asked; a rule with no fallback doesn't run");
    }

    #[test]
    fn lore_is_available_by_the_state() {
        let book = db::Lorebook { id: "b1".into(), name: "Lore".into(), created_at: 0, updated_at: 0,
            book: json!({"entries": [{"name":"Open","keys":["a"],"content":"open lore","enabled":true},{"name":"Secret","keys":["b"],"content":"secret lore","enabled":true},{"keys":["c"],"content":"third","enabled":true}]}) };
        let mine = vec!["b1".to_string()];
        let mk = |default_on: bool| clean_playbook(serde_json::from_value::<Playbook>(json!({"name":"T","variables":[{"id":"n","kind":"number","default":0,"min":0,"max":9}],
            "lorebooks":["b1"],"lore":[{"book":"b1","default_on":default_on,"gates":[{"entry":"Secret","when":[{"type":"var","var":"n","op":">=","value":3}]},{"entry":"#3","when":[{"type":"var","var":"n","op":">=","value":6}]}]}]})).unwrap(), &mine).unwrap();
        let names = |p: &Playbook, n: i64| { let mut st = starting_state(p, None); st.set("n", json!(n), 0); lore_entries(p, &[book.clone()], &st).iter().map(|e| e.content.clone()).collect::<Vec<_>>() };
        let p = mk(true);
        assert_eq!(names(&p, 0), vec!["open lore"], "the gated entries wait for their state");
        assert_eq!(names(&p, 3), vec!["open lore", "secret lore"]);
        assert_eq!(names(&p, 6), vec!["open lore", "secret lore", "third"], "an entry can be named by its place");
        assert!(names(&mk(false), 0).is_empty(), "with the book off by default only what the state opens is available");
        assert_eq!(names(&mk(false), 3), vec!["secret lore"]);
        let none_attached = clean_playbook(serde_json::from_value::<Playbook>(json!({"name":"T","lorebooks":["b1"]})).unwrap(), &[]).unwrap();
        assert!(none_attached.lorebooks.is_empty(), "only the owner's own lorebooks can be attached");
    }

    #[test]
    fn what_is_told_to_the_characters_carries_the_meaning_of_the_numbers() {
        let p = pb(BASIC);
        let mut st = starting_state(&p, None);
        st.set("n", json!(4), 1);
        let t = prompt_block(&p, &st);
        assert!(t.contains("N: 4 (from 0 to 5), meaning: high") && t.contains("flag: no") && t.contains("place: home") && t.contains("never mention"), "{t}");
        assert_eq!(prompt_block(&pb(r#"{"name":"Empty"}"#), &PState::default()), "", "a playbook with no variables says nothing");
    }

    #[test]
    fn mistakes_and_limits_are_caught() {
        let ok = |j: &str| clean_playbook(serde_json::from_str(j).unwrap(), &[]);
        assert!(ok(r#"{"name":"  "}"#).is_err(), "a name is needed");
        let many = |n: usize| format!(r#"{{"name":"T","variables":[{}]}}"#, (0..n).map(|i| format!(r#"{{"id":"v{i}","kind":"number"}}"#)).collect::<Vec<_>>().join(","));
        assert!(ok(&many(10)).is_ok() && ok(&many(11)).unwrap_err().contains("10 variables"));
        let rules = |n: usize, ask: bool| format!(r#"{{"name":"T","variables":[{{"id":"a","kind":"number"}}],"rules":[{}]}}"#, (0..n).map(|i| format!(r#"{{"id":"r{i}","then":[{{"var":"a","op":"add","value":1}}]{}}}"#, if ask && i < 4 { r#","ask":"q?""# } else { "" })).collect::<Vec<_>>().join(","));
        assert!(ok(&rules(15, false)).is_ok() && ok(&rules(16, false)).unwrap_err().contains("15 rules"));
        assert!(ok(&rules(4, true)).unwrap_err().contains("At most 3"), "no more than three rules can ask the model");
        assert!(ok(r#"{"name":"T","variables":[{"id":"a","kind":"number"},{"id":"A","kind":"number"}]}"#).unwrap_err().contains("Two variables"));
        assert!(ok(r#"{"name":"T","variables":[{"id":"a","kind":"choice"}]}"#).unwrap_err().contains("option"));
        assert!(ok(r#"{"name":"T","variables":[{"id":"a","kind":"number"}],"rules":[{"id":"x","then":[{"var":"ghost","op":"add","value":1}]}]}"#).unwrap_err().contains("ghost"));
        assert!(ok(r#"{"name":"T","variables":[{"id":"a","kind":"number"}],"rules":[{"id":"x","when":[{"type":"var","var":"ghost","op":">","value":1}],"then":[{"var":"a","op":"add","value":1}]}]}"#).unwrap_err().contains("ghost"));
        assert!(ok(r#"{"name":"T","variables":[{"id":"a","kind":"number"}],"rules":[{"id":"x","then":[]}]}"#).unwrap_err().contains("doesn't change anything"));
        let cleaned = ok(r#"{"name":"T","variables":[{"id":"a","kind":"number","default":50,"min":10,"max":1}],"rules":[{"id":"x","phase":"before","when":[{"type":"reply_says","words":["x"]}],"then":[{"var":"a","op":"set","value":1}]}]}"#).unwrap();
        assert_eq!((cleaned.variables[0].min, cleaned.variables[0].max, cleaned.variables[0].default.clone()), (Some(1.0), Some(10.0), json!(10)), "a swapped range is put right and the default fits it");
        assert!(cleaned.rules[0].when.is_empty(), "a rule that runs before the reply can't wait for a reply to say something");
    }

    #[test]
    fn the_starter_playbooks_are_all_valid_and_playable() {
        let all = templates();
        assert_eq!(all.len(), 4);
        for t in &all {
            let cleaned = clean_playbook(t.clone(), &[]).unwrap_or_else(|e| panic!("{}: {e}", t.name));
            assert_eq!(cleaned.rules.len(), t.rules.len(), "{} keeps all its rules", t.name);
            assert!(!t.instructions.is_empty() && !t.description.is_empty());
            // run a few turns of each one: it must not panic and must stay inside its ranges
            let mut st = starting_state(&cleaned, None);
            for turn in 1..=12 {
                let c = Ctx { user: "I walk onward, search the room, and thank you; honestly, I care".into(), reply: "Goodbye".into(), turn, seed: turn as u64 * 31 };
                block_on(run_phase(&cleaned, "before", &mut st, &c, false, |_, _| async { false }));
                block_on(run_phase(&cleaned, "after", &mut st, &c, false, |_, _| async { false }));
            }
            for v in &cleaned.variables { assert_eq!(st.get(v), coerce(v, &st.get(v)), "{}: {} stays a valid value", t.name, v.id); }
            for s in &cleaned.scenarios { starting_state(&cleaned, Some(&s.name)); }
        }
        let slow = clean_playbook(all[0].clone(), &[]).unwrap();
        assert_eq!(values(&slow, &starting_state(&slow, Some("old friends")))["trust"], json!(6), "a scenario sets the starting values (its name is not case sensitive)");
    }

    #[test]
    fn a_state_keeps_at_most_fifty_values_and_the_active_ones_stay() {
        let mut st = PState::default();
        for i in 0..60 { st.set(&format!("v{i:02}"), json!(i), i as i64); }
        let keep: HashSet<String> = ["v00".to_string()].into_iter().collect();
        st.trim(&keep);
        assert_eq!(st.vars.len(), MAX_STATE);
        assert!(st.vars.contains_key("v00"), "the active playbook's values are never let go");
        assert!(!st.vars.contains_key("v01") && st.vars.contains_key("v59"), "the oldest unused go first");
        assert!(st.touched.keys().all(|k| st.vars.contains_key(k)));
    }

    #[test]
    fn a_world_adds_a_fallback_playbook_a_persona_and_instructions_and_never_replaces() {
        let c = db::open(std::path::Path::new(":memory:")).unwrap();
        let o: Owner = Some("a".to_string());
        let mut p1 = pb(BASIC); p1.id = "p1".into(); save(&c, &p1, &o).unwrap();
        let mut p2 = pb(BASIC); p2.id = "p2".into(); save(&c, &p2, &o).unwrap();
        db::save_persona(&c, &db::Persona { id: "kai".into(), name: "Kai".into(), description: "A traveller.".into(), style: String::new(), avatar: None, frame: None, created_at: 0 }, &o).unwrap();
        let room = db::create_room(&c, &db::Room { id: 0, name: "Pier".into(), kind: "other".into(), description: String::new(), owner_kind: "self".into(), character_id: None, backdrop: String::new(), created_at: 0, music: String::new(), music_name: String::new(), model: String::new(), model_name: String::new(), model_scale: 1.0, model_rot: 0.0, model_y: 0.0, model_share: false, parent_id: None, links: vec![], deco: db::RoomDeco::default(), world_id: None, gallery: vec![] }, &o).unwrap();
        let w = db::create_world(&c, "Harbour", "", &o).unwrap();
        db::move_rooms_to_world(&c, &[room.id], Some(w.id), &o).unwrap();
        db::set_world_setup(&c, w.id, "kai", "p1", "Keep it salty.", &o).unwrap();
        let w = db::get_world(&c, w.id, &o).unwrap().unwrap();
        assert_eq!((w.persona.as_str(), w.playbook.as_str(), w.instructions.as_str()), ("kai", "p1", "Keep it salty."));
        let ch = db::Character { id: "c1".into(), card: dorms_core::CharacterData { name: "C".into(), ..Default::default() }, media: None, outfits: vec![], gallery: vec![], gallery_mode: String::new(), outfit: Default::default(), ..serde_json::from_value(json!({"id":"c1","card":{"name":"C"}})).unwrap() };
        db::save_character(&c, &ch, &o).unwrap();
        let chat = db::create_chat(&c, None, "x", "dm", &["c1".to_string()], &o).unwrap();
        assert!(effective(&c, &chat, &o).is_none(), "outside a world nothing is added");
        db::set_chat_room(&c, chat.id, Some(room.id), &o).unwrap();
        let chat = db::get_chat(&c, chat.id, &o).unwrap().unwrap();
        assert_eq!(effective(&c, &chat, &o).unwrap().0.id, "p1", "the world's playbook is the fallback");
        let mut ch2 = db::get_character(&c, "c1", &o).unwrap().unwrap(); ch2.playbook = "p2".into(); db::save_character(&c, &ch2, &o).unwrap();
        assert_eq!(effective(&c, &chat, &o).unwrap().0.id, "p2", "the character's own playbook wins over the world's");
        let mut row = chat_row(&c, chat.id); row.mode = "none".into(); save_row(&c, chat.id, &row).unwrap();
        assert!(effective(&c, &chat, &o).is_none(), "the chat's choice of none is respected");
        let mut s = db::get_settings(&c, &o);
        crate::extras::apply_world_persona(&c, &o, &chat, &mut s);
        assert_eq!(s.active_persona, "kai", "the world's persona stands in while the chat is in the world");
        assert!(crate::extras::extra_system(&c, &chat, &o, "").contains("Keep it salty."), "the instructions reach the model");
        let mut s = db::get_settings(&c, &o);
        let plain = db::create_chat(&c, None, "y", "dm", &["c1".to_string()], &o).unwrap();
        crate::extras::apply_world_persona(&c, &o, &plain, &mut s);
        assert_eq!(s.active_persona, "", "a chat outside the world keeps the person's own");
        db::set_world_setup(&c, w.id, "", "", "", &o).unwrap();
    }

    #[test]
    fn a_chat_keeps_its_story_and_can_rerun_and_rewind_it() {
        let c = db::open(std::path::Path::new(":memory:")).unwrap();
        let o: Owner = Some("a".to_string());
        let p = pb(BASIC);
        let mut p1 = p.clone(); p1.id = "p1".into(); save(&c, &p1, &o).unwrap();
        let mut p2 = pb(r#"{"name":"Other","variables":[{"id":"n","kind":"number","default":1,"min":0,"max":5}]}"#); p2.id = "p2".into(); save(&c, &p2, &o).unwrap();
        assert_eq!(list(&c, &o).unwrap().len(), 2);
        assert!(list(&c, &Some("b".to_string())).unwrap().is_empty(), "another profile has none of them");
        let ch = db::Character { id: "c1".into(), card: dorms_core::CharacterData { name: "C".into(), ..Default::default() }, media: None, outfits: vec![], gallery: vec![], gallery_mode: String::new(), outfit: None, frame: None, folder: None, order: None, lorebooks: vec![], playbook: "p1".into(), favorite: false, created_at: 1, updated_at: 1, last_used: 0, trusted: true };
        db::save_character(&c, &ch, &o).unwrap();
        let chat = db::create_chat(&c, None, "x", "dm", &["c1".to_string()], &o).unwrap();
        assert_eq!(effective(&c, &chat, &o).unwrap().0.id, "p1", "a chat uses its character's playbook unless told otherwise");
        let mut row = chat_row(&c, chat.id);
        row.mode = "none".into(); save_row(&c, chat.id, &row).unwrap();
        assert!(effective(&c, &chat, &o).is_none(), "none means none");
        row.mode = "set".into(); row.playbook_id = Some("p2".into()); save_row(&c, chat.id, &row).unwrap();
        assert_eq!(effective(&c, &chat, &o).unwrap().0.id, "p2", "a chat can use another one");
        row.playbook_id = Some("gone".into()); save_row(&c, chat.id, &row).unwrap();
        assert!(effective(&c, &chat, &o).is_none(), "a playbook that is gone means none");
        // the story: state, start, pending
        row.mode = "inherit".into(); row.playbook_id = None;
        row.start = starting_state(&p1, Some("nothing")); row.state = starting_state(&p1, None); row.state.set("n", json!(2), 1); row.turn = 1;
        save_row(&c, chat.id, &row).unwrap();
        assert_eq!(chat_row(&c, chat.id), row, "it all comes back as it was saved");
        let (u1, u2) = (db::add_message(&c, chat.id, "character", Some("c1"), &["one".into()]).unwrap(), db::add_message(&c, chat.id, "character", Some("c1"), &["two".into()]).unwrap());
        let (mut s0, mut s1, mut s2) = (starting_state(&p1, None), starting_state(&p1, None), starting_state(&p1, None));
        s1.set("n", json!(1), 1); s2.set("n", json!(3), 2);
        save_snapshot(&c, u1.id, chat.id, &s0, &s1, 1).unwrap(); save_snapshot(&c, u2.id, chat.id, &s1, &s2, 2).unwrap();
        s0.set("n", json!(0), 0);
        assert_eq!(snapshot(&c, u2.id).unwrap(), (s1.clone(), s2.clone(), 2), "regenerating the second reply starts from the state before it");
        row.state = s2.clone(); row.turn = 2; save_row(&c, chat.id, &row).unwrap();
        db::delete_message(&c, u2.id).unwrap(); rewind(&c, chat.id);
        assert_eq!((chat_row(&c, chat.id).state, chat_row(&c, chat.id).turn), (s1.clone(), 1), "deleting the newest reply rewinds the story to what the one before left");
        db::delete_message(&c, u1.id).unwrap(); rewind(&c, chat.id);
        assert_eq!((chat_row(&c, chat.id).state, chat_row(&c, chat.id).turn), (row.start.clone(), 0), "with no replies left it is back at the start");
        // a reply that fails puts the state back
        let mut r = chat_row(&c, chat.id); let before = r.state.clone(); r.pending = Some((before.clone(), 4)); r.state.set("n", json!(5), 9); r.turn = 5; save_row(&c, chat.id, &r).unwrap();
        restore_pending(&c, chat.id);
        let r = chat_row(&c, chat.id);
        assert_eq!((r.state, r.turn, r.pending), (before, 4, None));
    }
}
