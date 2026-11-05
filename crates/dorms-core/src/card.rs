//! Lenient character card model.
//!
//! Importing never rejects a card because a field has the "wrong" type or is
//! missing: values are coerced, defaults are filled in, and anything we do not
//! model is kept in `extra` / `extensions` and written back on export so a
//! round trip does not lose data.

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{json, Map, Value};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum CardSpec {
    V1,
    V2,
    V3,
}

#[derive(Debug, Clone)]
pub struct ParsedCard {
    pub data: CharacterData,
    pub spec: CardSpec,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct CharacterData {
    pub name: String,
    pub description: String,
    pub personality: String,
    pub scenario: String,
    pub first_mes: String,
    pub mes_example: String,
    pub creator_notes: String,
    pub system_prompt: String,
    pub post_history_instructions: String,
    pub alternate_greetings: Vec<String>,
    pub character_book: Option<CharacterBook>,
    pub tags: Vec<String>,
    pub creator: String,
    pub character_version: String,
    pub nickname: String,
    pub group_only_greetings: Vec<String>,
    pub extensions: Map<String, Value>,
    /// Unknown fields from the source card, preserved verbatim.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct CharacterBook {
    pub name: String,
    pub description: String,
    pub scan_depth: Option<i64>,
    pub token_budget: Option<i64>,
    pub recursive_scanning: Option<bool>,
    pub extensions: Map<String, Value>,
    pub entries: Vec<BookEntry>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct BookEntry {
    pub keys: Vec<String>,
    pub content: String,
    pub extensions: Map<String, Value>,
    pub enabled: bool,
    pub insertion_order: i64,
    pub case_sensitive: Option<bool>,
    pub name: String,
    pub priority: Option<i64>,
    pub id: Option<i64>,
    pub comment: String,
    pub selective: bool,
    pub secondary_keys: Vec<String>,
    pub constant: bool,
    pub position: String,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Default for BookEntry {
    fn default() -> Self {
        BookEntry {
            keys: vec![],
            content: String::new(),
            extensions: Map::new(),
            enabled: true,
            insertion_order: 100,
            case_sensitive: None,
            name: String::new(),
            priority: None,
            id: None,
            comment: String::new(),
            selective: false,
            secondary_keys: vec![],
            constant: false,
            position: "before_char".into(),
            extra: Map::new(),
        }
    }
}

// ---------------------------------------------------------------------------
// Lenient value readers
// ---------------------------------------------------------------------------

fn coerce_str(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Array(a) => a
            .iter()
            .map(coerce_str)
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn take_str(m: &mut Map<String, Value>, keys: &[&str]) -> String {
    let mut out = String::new();
    for k in keys {
        if let Some(v) = m.remove(*k) {
            if out.is_empty() {
                out = coerce_str(&v);
            }
        }
    }
    out
}

fn split_list(s: &str) -> Vec<String> {
    s.split(',')
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .collect()
}

/// Array of strings, or a comma separated string (tags, lorebook keys).
fn take_list(m: &mut Map<String, Value>, keys: &[&str]) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    let mut found = false;
    for k in keys {
        if let Some(v) = m.remove(*k) {
            if found {
                continue;
            }
            found = true;
            out = match v {
                Value::Array(a) => a
                    .iter()
                    .map(coerce_str)
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect(),
                Value::String(s) => split_list(&s),
                _ => vec![],
            };
        }
    }
    out
}

/// Array of free-text strings that must not be comma-split (greetings).
fn take_text_list(m: &mut Map<String, Value>, key: &str) -> Vec<String> {
    match m.remove(key) {
        Some(Value::Array(a)) => a
            .iter()
            .map(coerce_str)
            .filter(|s| !s.trim().is_empty())
            .collect(),
        Some(Value::String(s)) if !s.trim().is_empty() => vec![s],
        _ => vec![],
    }
}

fn as_i64(v: &Value) -> Option<i64> {
    match v {
        Value::Number(n) => n.as_i64().or_else(|| n.as_f64().map(|f| f as i64)),
        Value::String(s) => s.trim().parse::<i64>().ok(),
        _ => None,
    }
}

fn take_i64(m: &mut Map<String, Value>, keys: &[&str]) -> Option<i64> {
    let mut out = None;
    for k in keys {
        if let Some(v) = m.remove(*k) {
            if out.is_none() {
                out = as_i64(&v);
            }
        }
    }
    out
}

fn as_bool(v: &Value) -> Option<bool> {
    match v {
        Value::Bool(b) => Some(*b),
        Value::Number(n) => n.as_i64().map(|i| i != 0),
        Value::String(s) => match s.trim().to_ascii_lowercase().as_str() {
            "true" | "1" | "yes" => Some(true),
            "false" | "0" | "no" | "" => Some(false),
            _ => None,
        },
        _ => None,
    }
}

fn take_bool(m: &mut Map<String, Value>, keys: &[&str]) -> Option<bool> {
    let mut out = None;
    for k in keys {
        if let Some(v) = m.remove(*k) {
            if out.is_none() {
                out = as_bool(&v);
            }
        }
    }
    out
}

fn take_object(m: &mut Map<String, Value>, key: &str) -> Map<String, Value> {
    match m.remove(key) {
        Some(Value::Object(o)) => o,
        _ => Map::new(),
    }
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

impl CharacterData {
    /// Build from any JSON object. Never fails.
    pub fn from_value(v: &Value, warnings: &mut Vec<String>) -> CharacterData {
        let mut m = match v {
            Value::Object(o) => o.clone(),
            _ => {
                warnings.push("Card data was not an object; started from an empty card".into());
                Map::new()
            }
        };

        let name = take_str(&mut m, &["name", "char_name"]);
        // TavernAI/Pygmalion style `char_persona` is the description.
        let mut description = take_str(&mut m, &["description"]);
        let persona = take_str(&mut m, &["char_persona"]);
        if description.is_empty() {
            description = persona;
        }
        let personality = take_str(&mut m, &["personality"]);
        let scenario = take_str(&mut m, &["scenario", "world_scenario"]);
        let first_mes = take_str(&mut m, &["first_mes", "char_greeting"]);
        let mes_example = take_str(&mut m, &["mes_example", "example_dialogue"]);
        let creator_notes = {
            let c = take_str(&mut m, &["creator_notes"]);
            let legacy = take_str(&mut m, &["creatorcomment"]);
            if c.is_empty() { legacy } else { c }
        };
        let system_prompt = take_str(&mut m, &["system_prompt"]);
        let post_history_instructions = take_str(&mut m, &["post_history_instructions"]);
        let alternate_greetings = take_text_list(&mut m, "alternate_greetings");
        let tags = take_list(&mut m, &["tags"]);
        let creator = take_str(&mut m, &["creator"]);
        let character_version = take_str(&mut m, &["character_version"]);
        let nickname = take_str(&mut m, &["nickname"]);
        let group_only_greetings = take_text_list(&mut m, "group_only_greetings");

        let extensions = match m.remove("extensions") {
            Some(Value::Object(o)) => o,
            Some(Value::Null) | None => Map::new(),
            Some(_) => {
                warnings.push("Ignored a non-object `extensions` field".into());
                Map::new()
            }
        };

        let character_book = match m.remove("character_book") {
            Some(Value::Null) | None => None,
            Some(b) => Some(CharacterBook::from_value(&b, warnings)),
        };

        CharacterData {
            name,
            description,
            personality,
            scenario,
            first_mes,
            mes_example,
            creator_notes,
            system_prompt,
            post_history_instructions,
            alternate_greetings,
            character_book,
            tags,
            creator,
            character_version,
            nickname,
            group_only_greetings,
            extensions,
            extra: m,
        }
    }

    /// Fields shared by the V2 and V3 `data` object.
    fn base_object(&self) -> Map<String, Value> {
        let mut o = Map::new();
        o.insert("name".into(), json!(self.name));
        o.insert("description".into(), json!(self.description));
        o.insert("personality".into(), json!(self.personality));
        o.insert("scenario".into(), json!(self.scenario));
        o.insert("first_mes".into(), json!(self.first_mes));
        o.insert("mes_example".into(), json!(self.mes_example));
        o.insert("creator_notes".into(), json!(self.creator_notes));
        o.insert("system_prompt".into(), json!(self.system_prompt));
        o.insert(
            "post_history_instructions".into(),
            json!(self.post_history_instructions),
        );
        o.insert("alternate_greetings".into(), json!(self.alternate_greetings));
        if let Some(b) = &self.character_book {
            o.insert("character_book".into(), b.to_value());
        }
        o.insert("tags".into(), json!(self.tags));
        o.insert("creator".into(), json!(self.creator));
        o.insert("character_version".into(), json!(self.character_version));
        o.insert("extensions".into(), Value::Object(self.extensions.clone()));
        o
    }

    /// `chara_card_v2` document (also carries the legacy top-level fields that
    /// some older tools still read).
    pub fn to_v2_value(&self) -> Value {
        let mut data = self.base_object();
        for (k, v) in &self.extra {
            data.entry(k.clone()).or_insert_with(|| v.clone());
        }
        let mut root = Map::new();
        root.insert("spec".into(), json!("chara_card_v2"));
        root.insert("spec_version".into(), json!("2.0"));
        for k in ["name", "description", "personality", "scenario", "first_mes", "mes_example"] {
            if let Some(v) = data.get(k) {
                root.insert(k.into(), v.clone());
            }
        }
        root.insert("data".into(), Value::Object(data));
        Value::Object(root)
    }

    /// `chara_card_v3` document.
    pub fn to_v3_value(&self) -> Value {
        let mut data = self.base_object();
        if !self.nickname.is_empty() {
            data.insert("nickname".into(), json!(self.nickname));
        }
        data.insert("group_only_greetings".into(), json!(self.group_only_greetings));
        for (k, v) in &self.extra {
            data.entry(k.clone()).or_insert_with(|| v.clone());
        }
        json!({ "spec": "chara_card_v3", "spec_version": "3.0", "data": Value::Object(data) })
    }
}

impl<'de> Deserialize<'de> for CharacterData {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let v = Value::deserialize(d)?;
        Ok(CharacterData::from_value(&v, &mut Vec::new()))
    }
}

impl CharacterBook {
    pub fn from_value(v: &Value, warnings: &mut Vec<String>) -> CharacterBook {
        let mut m = match v {
            Value::Object(o) => o.clone(),
            Value::Array(a) => {
                // Some tools export a bare entry list.
                let mut o = Map::new();
                o.insert("entries".into(), Value::Array(a.clone()));
                o
            }
            _ => {
                warnings.push("Ignored a malformed character book".into());
                return CharacterBook::default();
            }
        };

        let name = take_str(&mut m, &["name"]);
        let description = take_str(&mut m, &["description"]);
        let scan_depth = take_i64(&mut m, &["scan_depth"]);
        let token_budget = take_i64(&mut m, &["token_budget"]);
        let recursive_scanning = take_bool(&mut m, &["recursive_scanning"]);
        let extensions = take_object(&mut m, "extensions");

        // `entries` is an array in the spec but a map keyed by uid in
        // SillyTavern world-info exports.
        let raw_entries: Vec<Value> = match m.remove("entries") {
            Some(Value::Array(a)) => a,
            Some(Value::Object(o)) => o.into_iter().map(|(_, v)| v).collect(),
            _ => vec![],
        };
        let entries = raw_entries
            .iter()
            .enumerate()
            .map(|(i, e)| BookEntry::from_value(e, i as i64, warnings))
            .collect();

        CharacterBook {
            name,
            description,
            scan_depth,
            token_budget,
            recursive_scanning,
            extensions,
            entries,
            extra: m,
        }
    }

    pub fn to_value(&self) -> Value {
        let mut o = Map::new();
        o.insert("name".into(), json!(self.name));
        o.insert("description".into(), json!(self.description));
        if let Some(v) = self.scan_depth {
            o.insert("scan_depth".into(), json!(v));
        }
        if let Some(v) = self.token_budget {
            o.insert("token_budget".into(), json!(v));
        }
        if let Some(v) = self.recursive_scanning {
            o.insert("recursive_scanning".into(), json!(v));
        }
        o.insert("extensions".into(), Value::Object(self.extensions.clone()));
        o.insert(
            "entries".into(),
            Value::Array(self.entries.iter().map(BookEntry::to_value).collect()),
        );
        for (k, v) in &self.extra {
            o.entry(k.clone()).or_insert_with(|| v.clone());
        }
        Value::Object(o)
    }
}

impl<'de> Deserialize<'de> for CharacterBook {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let v = Value::deserialize(d)?;
        Ok(CharacterBook::from_value(&v, &mut Vec::new()))
    }
}

impl BookEntry {
    pub fn from_value(v: &Value, index: i64, warnings: &mut Vec<String>) -> BookEntry {
        let mut m = match v {
            Value::Object(o) => o.clone(),
            _ => {
                warnings.push("Skipped a malformed lorebook entry".into());
                Map::new()
            }
        };

        let keys = take_list(&mut m, &["keys", "key"]);
        let secondary_keys = take_list(&mut m, &["secondary_keys", "keysecondary"]);
        let content = take_str(&mut m, &["content"]);
        let extensions = take_object(&mut m, "extensions");
        // ST uses `disable`, the spec uses `enabled`.
        let disable = take_bool(&mut m, &["disable"]);
        let enabled = take_bool(&mut m, &["enabled"]).unwrap_or(!disable.unwrap_or(false));
        let insertion_order = take_i64(&mut m, &["insertion_order", "order"]).unwrap_or(100);
        let case_sensitive = take_bool(&mut m, &["case_sensitive"]);
        let name = take_str(&mut m, &["name"]);
        let priority = take_i64(&mut m, &["priority"]);
        let id = take_i64(&mut m, &["id", "uid"]).or(Some(index));
        let comment = take_str(&mut m, &["comment"]);
        let selective = take_bool(&mut m, &["selective"]).unwrap_or(false);
        let constant = take_bool(&mut m, &["constant"]).unwrap_or(false);
        let position = match m.remove("position") {
            Some(Value::String(s)) if s == "after_char" => "after_char".to_string(),
            Some(Value::String(_)) => "before_char".to_string(),
            // ST numeric positions: 0 = before, everything else after.
            Some(Value::Number(n)) if n.as_i64() == Some(0) => "before_char".into(),
            Some(Value::Number(_)) => "after_char".into(),
            _ => "before_char".into(),
        };

        BookEntry {
            keys,
            content,
            extensions,
            enabled,
            insertion_order,
            case_sensitive,
            name,
            priority,
            id,
            comment,
            selective,
            secondary_keys,
            constant,
            position,
            extra: m,
        }
    }

    pub fn to_value(&self) -> Value {
        let mut o = Map::new();
        o.insert("keys".into(), json!(self.keys));
        o.insert("content".into(), json!(self.content));
        o.insert("extensions".into(), Value::Object(self.extensions.clone()));
        o.insert("enabled".into(), json!(self.enabled));
        o.insert("insertion_order".into(), json!(self.insertion_order));
        if let Some(v) = self.case_sensitive {
            o.insert("case_sensitive".into(), json!(v));
        }
        o.insert("name".into(), json!(self.name));
        if let Some(v) = self.priority {
            o.insert("priority".into(), json!(v));
        }
        if let Some(v) = self.id {
            o.insert("id".into(), json!(v));
        }
        o.insert("comment".into(), json!(self.comment));
        o.insert("selective".into(), json!(self.selective));
        o.insert("secondary_keys".into(), json!(self.secondary_keys));
        o.insert("constant".into(), json!(self.constant));
        o.insert("position".into(), json!(self.position));
        for (k, v) in &self.extra {
            o.entry(k.clone()).or_insert_with(|| v.clone());
        }
        Value::Object(o)
    }
}

impl<'de> Deserialize<'de> for BookEntry {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let v = Value::deserialize(d)?;
        Ok(BookEntry::from_value(&v, 0, &mut Vec::new()))
    }
}

/// Keys that, if present at the top level of a flat (V1-style) card, mark it
/// as a character card rather than arbitrary JSON.
pub(crate) const V1_MARKERS: &[&str] = &[
    "name", "char_name", "description", "char_persona", "personality", "scenario",
    "world_scenario", "first_mes", "char_greeting", "mes_example", "example_dialogue",
];

/// Parse a card from an arbitrary JSON value (V1, V2, V3, or loose variants).
pub fn parse_card_value(mut v: Value) -> Result<ParsedCard, String> {
    let mut warnings = vec![];

    if let Value::String(s) = &v {
        v = serde_json::from_str(s.trim_start_matches('\u{feff}').trim())
            .map_err(|_| "The file does not contain a character card".to_string())?;
    }
    let obj = v
        .as_object()
        .ok_or_else(|| "The file does not contain a character card".to_string())?;

    let spec_str = obj.get("spec").and_then(Value::as_str).map(str::to_owned);
    let data_field = obj.get("data").cloned();

    let (spec, mut data_val) = match (spec_str.as_deref(), data_field) {
        (Some("chara_card_v3"), Some(d)) => (CardSpec::V3, d),
        (Some("chara_card_v2"), Some(d)) => (CardSpec::V2, d),
        (Some(other), Some(d)) => {
            warnings.push(format!("Unrecognised card spec \"{other}\"; read it as V2"));
            (CardSpec::V2, d)
        }
        (None, Some(d)) if d.is_object() || d.is_string() => {
            warnings.push("Card had a `data` object but no `spec`; read it as V2".into());
            (CardSpec::V2, d)
        }
        _ => {
            if !V1_MARKERS.iter().any(|k| obj.contains_key(*k)) {
                return Err("The file does not look like a character card".into());
            }
            (CardSpec::V1, Value::Object(obj.clone()))
        }
    };

    if let Value::String(s) = &data_val {
        data_val = serde_json::from_str(s).unwrap_or(Value::Null);
    }

    let mut data = CharacterData::from_value(&data_val, &mut warnings);

    // V2 files written by SillyTavern-like tools duplicate fields at the top
    // level; use them to fill any gaps in `data`.
    if spec != CardSpec::V1 {
        let mut top = obj.clone();
        let fill = |dst: &mut String, keys: &[&str], top: &mut Map<String, Value>| {
            let v = take_str(top, keys);
            if dst.is_empty() {
                *dst = v;
            }
        };
        fill(&mut data.name, &["name"], &mut top);
        fill(&mut data.description, &["description"], &mut top);
        fill(&mut data.personality, &["personality"], &mut top);
        fill(&mut data.scenario, &["scenario"], &mut top);
        fill(&mut data.first_mes, &["first_mes"], &mut top);
        fill(&mut data.mes_example, &["mes_example"], &mut top);
    }

    if data.name.trim().is_empty() {
        warnings.push("Card has no name".into());
    }
    Ok(ParsedCard { data, spec, warnings })
}
