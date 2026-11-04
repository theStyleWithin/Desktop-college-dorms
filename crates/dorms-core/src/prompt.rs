//! Chat prompt assembly: card fields, lorebook activation, depth notes and
//! post-history instructions, normalised into the strict
//! `system, user, assistant, user, ...` shape every chat template accepts.

use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};

use crate::card::{BookEntry, CharacterData};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChatMsg {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone)]
pub struct HistoryItem {
    /// `None` = the user, `Some(id)` = a character.
    pub speaker_id: Option<String>,
    pub name: String,
    pub text: String,
}

#[derive(Debug, Clone)]
pub struct PromptSettings {
    pub user_name: String,
    pub user_description: String,
    pub context_tokens: usize,
    pub max_response_tokens: usize,
    pub use_card_system_prompt: bool,
    pub default_system: Option<String>,
    pub default_scan_depth: usize,
}

impl Default for PromptSettings {
    fn default() -> Self {
        PromptSettings {
            user_name: "You".into(),
            user_description: String::new(),
            context_tokens: 4096,
            max_response_tokens: 512,
            use_card_system_prompt: true,
            default_system: None,
            default_scan_depth: 4,
        }
    }
}

pub struct PromptInput<'a> {
    pub speaker_id: &'a str,
    pub speaker: &'a CharacterData,
    /// Other characters present (group chats / channels).
    pub others: &'a [(String, CharacterData)],
    pub history: &'a [HistoryItem],
    pub settings: &'a PromptSettings,
    pub group: bool,
}

pub const DEFAULT_SYSTEM: &str = "Write {{char}}'s next reply in a fictional chat between {{char}} and {{user}}. Stay in character. Write natural dialogue and actions; do not speak or act for {{user}}.";
pub const DEFAULT_GROUP_SYSTEM: &str = "This is a fictional group chat. Write only {{char}}'s next reply. Stay in character and do not speak or act for any other participant.";

/// Rough token estimate (~4 chars per token). Good enough for budgeting and
/// the editor's live counters.
pub fn estimate_tokens(s: &str) -> usize {
    (s.chars().count() + 3) / 4
}

pub fn substitute(text: &str, char_name: &str, user_name: &str, original: &str) -> String {
    let mut t = text.to_string();
    for (pat, rep) in [
        (r"(?i)\{\{\s*char\s*\}\}", char_name),
        (r"(?i)\{\{\s*user\s*\}\}", user_name),
        (r"(?i)\{\{\s*original\s*\}\}", original),
        (r"(?i)<BOT>", char_name),
        (r"(?i)<USER>", user_name),
    ] {
        if let Ok(re) = Regex::new(pat) {
            t = re.replace_all(&t, regex::NoExpand(rep)).into_owned();
        }
    }
    t
}

fn key_matches(key: &str, hay: &str, hay_lower: &str, case_sensitive: bool) -> bool {
    let key = key.trim();
    if key.is_empty() {
        return false;
    }
    // /pattern/flags
    if key.starts_with('/') {
        if let Some(end) = key.rfind('/') {
            if end > 0 {
                let (pat, flags) = (&key[1..end], &key[end + 1..]);
                if let Ok(re) = RegexBuilder::new(pat)
                    .case_insensitive(flags.contains('i'))
                    .multi_line(true)
                    .build()
                {
                    return re.is_match(hay);
                }
            }
        }
    }
    if case_sensitive {
        hay.contains(key)
    } else {
        hay_lower.contains(&key.to_lowercase())
    }
}

fn entry_active(e: &BookEntry, hay: &str, hay_lower: &str) -> bool {
    if !e.enabled || e.content.trim().is_empty() {
        return false;
    }
    if e.constant {
        return true;
    }
    let cs = e.case_sensitive.unwrap_or(false);
    let primary = e.keys.iter().any(|k| key_matches(k, hay, hay_lower, cs));
    if !primary {
        return false;
    }
    if e.selective && !e.secondary_keys.is_empty() {
        return e.secondary_keys.iter().any(|k| key_matches(k, hay, hay_lower, cs));
    }
    true
}

/// Lorebook entries activated by recent chat text, as `(before, after)` text.
pub fn active_lore(card: &CharacterData, history: &[HistoryItem], default_depth: usize) -> (Vec<String>, Vec<String>) {
    let Some(book) = &card.character_book else { return (vec![], vec![]) };
    let depth = book.scan_depth.filter(|d| *d > 0).map(|d| d as usize).unwrap_or(default_depth);
    let hay = history
        .iter()
        .rev()
        .take(depth)
        .map(|h| h.text.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    let hay_lower = hay.to_lowercase();

    let mut hits: Vec<&BookEntry> = book.entries.iter().filter(|e| entry_active(e, &hay, &hay_lower)).collect();
    hits.sort_by_key(|e| e.insertion_order);

    let budget = book.token_budget.filter(|b| *b > 0).map(|b| b as usize);
    let mut used = 0usize;
    let (mut before, mut after) = (vec![], vec![]);
    for e in hits {
        let cost = estimate_tokens(&e.content);
        if let Some(b) = budget {
            if used + cost > b {
                break;
            }
        }
        used += cost;
        if e.position == "after_char" {
            after.push(e.content.clone());
        } else {
            before.push(e.content.clone());
        }
    }
    (before, after)
}

struct DepthPrompt {
    text: String,
    depth: usize,
}

fn depth_prompt(card: &CharacterData) -> Option<DepthPrompt> {
    let dp = card.extensions.get("depth_prompt")?.as_object()?;
    let text = dp.get("prompt")?.as_str()?.trim().to_string();
    if text.is_empty() {
        return None;
    }
    let depth = dp.get("depth").and_then(|d| d.as_u64()).unwrap_or(4) as usize;
    Some(DepthPrompt { text, depth })
}

fn push_section(parts: &mut Vec<String>, title: &str, body: &str) {
    if !body.trim().is_empty() {
        parts.push(format!("{title}\n{}", body.trim()));
    }
}

pub fn build_system(input: &PromptInput) -> String {
    let s = input.settings;
    let c = input.speaker;
    let name = c.name.as_str();

    let default = match &s.default_system {
        Some(d) if !d.trim().is_empty() => d.clone(),
        _ if input.group => DEFAULT_GROUP_SYSTEM.to_string(),
        _ => DEFAULT_SYSTEM.to_string(),
    };
    let base = if s.use_card_system_prompt && !c.system_prompt.trim().is_empty() {
        substitute(&c.system_prompt, name, &s.user_name, &default)
    } else {
        default
    };

    let (lore_before, lore_after) = active_lore(c, input.history, s.default_scan_depth);

    let mut parts = vec![base];
    if !lore_before.is_empty() {
        parts.push(lore_before.join("\n"));
    }
    push_section(&mut parts, &format!("{name}'s description:"), &c.description);
    push_section(&mut parts, &format!("{name}'s personality:"), &c.personality);
    push_section(&mut parts, "Scenario:", &c.scenario);
    if !lore_after.is_empty() {
        parts.push(lore_after.join("\n"));
    }
    push_section(&mut parts, &format!("About {}:", s.user_name), &s.user_description);

    if input.group {
        let roster: Vec<&str> = std::iter::once(name)
            .chain(input.others.iter().map(|(_, o)| o.name.as_str()))
            .collect();
        parts.push(format!("Participants: {}, and {}.", roster.join(", "), s.user_name));
        for (_, o) in input.others {
            push_section(&mut parts, &format!("{}'s description:", o.name), &o.description);
        }
    }
    if !c.mes_example.trim().is_empty() {
        let ex = c.mes_example.replace("<START>", "[Example conversation]");
        push_section(&mut parts, "Example dialogue:", &ex);
    }
    substitute(&parts.join("\n\n"), name, &s.user_name, "")
}

fn merge_consecutive(msgs: Vec<ChatMsg>) -> Vec<ChatMsg> {
    let mut out: Vec<ChatMsg> = vec![];
    for m in msgs {
        match out.last_mut() {
            Some(l) if l.role == m.role => {
                l.content.push_str("\n\n");
                l.content.push_str(&m.content);
            }
            _ => out.push(m),
        }
    }
    out
}

pub fn build_prompt(input: &PromptInput) -> Vec<ChatMsg> {
    let s = input.settings;
    let name = input.speaker.name.as_str();

    // Trim history to the token budget, newest first.
    let system = build_system(input);
    let reserve = estimate_tokens(&system) + s.max_response_tokens + 64;
    let budget = s.context_tokens.saturating_sub(reserve).max(256);
    let mut kept: Vec<&HistoryItem> = vec![];
    let mut used = 0;
    for h in input.history.iter().rev() {
        let cost = estimate_tokens(&h.text) + 8;
        if used + cost > budget && !kept.is_empty() {
            break;
        }
        used += cost;
        kept.push(h);
    }
    kept.reverse();

    let mut msgs: Vec<ChatMsg> = kept
        .iter()
        .map(|h| {
            let mine = h.speaker_id.as_deref() == Some(input.speaker_id);
            let text = substitute(&h.text, name, &s.user_name, "");
            let content = if input.group { format!("{}: {}", h.name, text) } else { text };
            ChatMsg { role: if mine { "assistant" } else { "user" }.into(), content }
        })
        .collect();

    // Character's note, injected `depth` messages from the end.
    if let Some(dp) = depth_prompt(input.speaker) {
        let note = substitute(&dp.text, name, &s.user_name, "");
        if msgs.is_empty() {
            msgs.push(ChatMsg { role: "user".into(), content: format!("[{note}]") });
        } else {
            let idx = msgs.len().saturating_sub(dp.depth.max(1));
            msgs[idx].content.push_str(&format!("\n\n[{note}]"));
        }
    }

    // Post-history instructions ride on the final user turn.
    let phi = input.speaker.post_history_instructions.trim();
    if s.use_card_system_prompt && !phi.is_empty() {
        let phi = substitute(phi, name, &s.user_name, "");
        match msgs.last_mut() {
            Some(l) if l.role == "user" => l.content.push_str(&format!("\n\n[{phi}]")),
            _ => msgs.push(ChatMsg { role: "user".into(), content: format!("[{phi}]") }),
        }
    }

    let mut msgs = merge_consecutive(msgs);
    // Chat templates want the first turn to be the user's and the last to be
    // the user's (we are asking the model to answer).
    if msgs.first().map(|m| m.role == "assistant").unwrap_or(false) {
        msgs.insert(0, ChatMsg { role: "user".into(), content: "(The chat begins.)".into() });
    }
    if msgs.is_empty() || msgs.last().map(|m| m.role == "assistant").unwrap_or(false) {
        msgs.push(ChatMsg { role: "user".into(), content: "(Continue.)".into() });
    }

    let mut out = vec![ChatMsg { role: "system".into(), content: system }];
    out.extend(msgs);
    out
}

/// Models in group chats sometimes echo "Name:" at the start of a reply.
pub fn clean_reply(text: &str, char_name: &str) -> String {
    let t = text.trim();
    let prefix = format!("{char_name}:");
    t.strip_prefix(&prefix).map(|r| r.trim_start()).unwrap_or(t).to_string()
}
