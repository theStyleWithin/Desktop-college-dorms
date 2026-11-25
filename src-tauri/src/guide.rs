//! The app guide: the README, the spec and the security notes are built into the app, so Tokenator can look things up offline. They are cut into
//! sections by heading (and by the bullets of the long feature lists), and a question only pulls in the few sections that match it well. Nothing
//! is sent to the model for a question that is not about the app.

use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

const DOCS: [(&str, &str); 3] = [
    ("README", include_str!("../../README.md")),
    ("Spec", include_str!("../../SPEC.md")),
    ("Security", include_str!("../../SECURITY.md")),
];

pub struct Section {
    pub doc: &'static str,
    pub title: String,
    pub text: String,
    /// Written about something that is planned and not built yet.
    pub planned: bool,
    words: HashMap<String, u32>,
    title_words: HashSet<String>,
}

pub struct Index {
    pub sections: Vec<Section>,
    df: HashMap<String, usize>,
}

const STOP: [&str; 52] = [
    "the", "and", "for", "are", "but", "not", "you", "your", "can", "how", "what", "why", "when", "where", "does", "did", "this", "that", "with", "from", "have", "has",
    "was", "were", "will", "would", "could", "should", "its", "into", "than", "then", "there", "their", "them", "they", "about", "just", "some", "any", "all", "get", "use",
    "using", "make", "want", "need", "like", "please", "tell", "show", "also",
];

/// Words that say a question is about the app. (Compared after `norm`.)
const APP_TERMS: [&str; 41] = [
    "playbook", "lorebook", "persona", "tokenator", "dorm", "profile", "character", "card", "room", "world", "setting", "prompt", "note", "decoration", "emoji", "sticker", "voice",
    "controller", "novel", "android", "phone", "windows", "linux", "install", "download", "engine", "desktop", "mobile", "app", "folder", "gallery", "outfit", "wardrobe", "theme",
    "passcode", "export", "import", "microphone", "status", "college", "tab",
];

/// Lower case, and a trailing "s" taken off a longer word ("playbooks" is "playbook").
fn norm(w: &str) -> String {
    let w = w.to_lowercase();
    if w.len() > 4 && w.ends_with('s') && !w.ends_with("ss") { w[..w.len() - 1].to_string() } else { w }
}

fn words_of(text: &str) -> Vec<String> {
    text.split(|c: char| !c.is_alphanumeric()).filter(|w| w.chars().count() >= 3).map(norm).filter(|w| !STOP.contains(&w.as_str())).collect()
}

fn bold_title(line: &str) -> String {
    let t = line.trim_start_matches(|c: char| c == '-' || c == ' ').trim_start_matches("**");
    t.split("**").next().unwrap_or("").trim().trim_end_matches(['.', ':']).trim().to_string()
}

pub fn build(docs: &[(&'static str, &str)]) -> Index {
    let mut sections: Vec<Section> = vec![];
    for (doc, text) in docs {
        let (mut h2, mut h3, mut planned) = (String::new(), String::new(), false);
        let mut cur: Option<(String, String, bool)> = None; // title, text, planned
        let flush = |cur: &mut Option<(String, String, bool)>, sections: &mut Vec<Section>| {
            if let Some((title, body, pl)) = cur.take() {
                if body.trim().chars().count() > 30 {
                    let mut words: HashMap<String, u32> = HashMap::new();
                    for w in words_of(&body) { *words.entry(w).or_insert(0) += 1; }
                    let title_words = words_of(&title).into_iter().collect();
                    sections.push(Section { doc, title, text: body.trim().to_string(), planned: pl, words, title_words });
                }
            }
        };
        for line in text.lines() {
            if let Some(h) = line.strip_prefix("## ") {
                flush(&mut cur, &mut sections);
                h2 = h.trim().to_string(); h3.clear();
                planned = h2.to_lowercase().starts_with("planned") || h2.to_lowercase().contains("coming soon");
                cur = Some((h2.clone(), String::new(), planned));
            } else if let Some(h) = line.strip_prefix("### ") {
                flush(&mut cur, &mut sections);
                h3 = h.trim().to_string();
                cur = Some((format!("{h2} › {h3}"), String::new(), planned));
            } else if line.starts_with("- **") {
                flush(&mut cur, &mut sections);
                let t = bold_title(line);
                let base = if h3.is_empty() { h2.clone() } else { format!("{h2} › {h3}") };
                cur = Some((if t.is_empty() { base } else { format!("{base} › {t}") }, String::new(), planned));
            }
            if let Some(c) = cur.as_mut() { c.1.push_str(line); c.1.push('\n'); }
            else if !line.starts_with("# ") { cur = Some((doc.to_string(), format!("{line}\n"), false)); }
        }
        flush(&mut cur, &mut sections);
    }
    let mut df: HashMap<String, usize> = HashMap::new();
    for s in &sections { for w in s.words.keys().chain(s.title_words.iter()).collect::<HashSet<_>>() { *df.entry(w.clone()).or_insert(0) += 1; } }
    Index { sections, df }
}

pub fn index() -> &'static Index {
    static I: OnceLock<Index> = OnceLock::new();
    I.get_or_init(|| build(&DOCS))
}

/// The best sections for a question, at most `max` and about `budget` characters in all. Empty when the question does not look like one about the app,
/// or when nothing matches well enough.
pub fn search<'a>(ix: &'a Index, question: &str, max: usize, budget: usize) -> Vec<&'a Section> {
    let q: Vec<String> = { let mut seen = HashSet::new(); words_of(question).into_iter().filter(|w| seen.insert(w.clone())).collect() };
    if !q.iter().any(|w| APP_TERMS.contains(&w.as_str())) { return vec![]; }
    let n = ix.sections.len() as f64;
    let idf = |w: &str| ((n / (1.0 + *ix.df.get(w).unwrap_or(&0) as f64)).ln()).max(0.0);
    let mut scored: Vec<(f64, &Section)> = ix.sections.iter().map(|s| {
        let sc: f64 = q.iter().map(|w| {
            let tf = *s.words.get(w).unwrap_or(&0) as f64;
            let t = if s.title_words.contains(w) { 2.5 } else { 0.0 };
            idf(w) * ((if tf > 0.0 { 1.0 + tf.ln() } else { 0.0 }) + t)
        }).sum();
        (sc, s)
    }).filter(|(sc, _)| *sc >= 3.0).collect();
    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    let best = scored.first().map(|x| x.0).unwrap_or(0.0);
    let (mut out, mut used) = (vec![], 0usize);
    for (sc, s) in scored {
        if out.len() >= max || sc < best * 0.4 { break; }
        let len = s.text.chars().count().min(1600);
        if used + len > budget && !out.is_empty() { break; }
        used += len;
        out.push(s);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn titles(q: &str) -> Vec<String> { search(index(), q, 4, 5000).iter().map(|s| format!("{} {}", s.doc, s.title)).collect() }

    #[test]
    fn the_docs_are_cut_into_sections() {
        let ix = index();
        assert!(ix.sections.len() > 40, "{} sections", ix.sections.len());
        assert!(ix.sections.iter().any(|s| s.planned) && ix.sections.iter().any(|s| !s.planned));
        assert!(ix.sections.iter().all(|s| !s.text.trim().is_empty()));
    }

    #[test]
    fn app_questions_find_their_sections() {
        let t = titles("What is a playbook and how do the rules work?").join(" | ").to_lowercase();
        assert!(t.contains("playbook"), "{t}");
        let t = titles("How do I put my profile on my phone?").join(" | ").to_lowercase();
        assert!(t.contains("wi-fi") || t.contains("profile") || t.contains("android"), "{t}");
        let t = titles("Does Tokenator work with a cloud model?").join(" | ").to_lowercase();
        assert!(t.contains("tokenator"), "{t}");
    }

    #[test]
    fn other_questions_pull_in_nothing() {
        for q in ["Write me a short poem about the sea", "What is the capital of France?", "Can you help me plan a birthday party?", "Explain how photosynthesis works"] {
            assert!(titles(q).is_empty(), "{q}: {:?}", titles(q));
        }
    }

    #[test]
    fn sections_about_plans_are_marked() {
        let found = search(index(), "Is Wi-Fi transfer of a profile to a phone available yet?", 4, 5000);
        assert!(found.iter().any(|s| s.planned), "{:?}", found.iter().map(|s| (&s.title, s.planned)).collect::<Vec<_>>());
    }

    #[test]
    fn the_search_is_small_enough_for_a_small_model() {
        let found = search(index(), "Tell me everything about playbooks, lorebooks, rooms, worlds and settings", 4, 5000);
        assert!(found.len() <= 4 && found.iter().map(|s| s.text.chars().count().min(1600)).sum::<usize>() <= 6400);
    }
}
