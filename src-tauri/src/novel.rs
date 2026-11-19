//! Write a novel: the character writes a long story chapter by chapter, from a plot the reader gave, in the chat they are in.
//! Each chapter is its own reply (so no single request is huge, and a failure costs at most one chapter). The writer knows how many
//! requests the day's allowance of a free model leaves, plans the story to fit it, and stops after a finished chapter, never in the
//! middle of one, with a message that says why.

use std::collections::HashMap;
use std::time::Duration;

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::json;
use tauri::State;

use crate::commands::{e, emit, generate_once, owner, uid};
use crate::db::{self, Owner};
use crate::{AppState, Shared};

type R<T> = Result<T, String>;

pub const MAX_CHAPTERS: u32 = 60;
pub const MIN_CHAPTER_TOKENS: u32 = 300;
pub const MAX_CHAPTER_TOKENS: u32 = 4000;

/// A novel being written right now in one chat.
#[derive(Default)]
pub struct Run {
    pub stop: bool,
    /// The reply being written (so Stop can cut it short).
    pub rid: Option<String>,
    pub directive: String,
    pub max_tokens: usize,
}

/// What a chat's novel is (kept so it can be picked up again).
#[derive(Serialize, Clone, Debug, PartialEq, Default)]
pub struct Plan {
    pub plot: String,
    pub tone: String,
    pub pov: String,
    pub chapters: u32,
    pub chapter_tokens: u32,
    pub done: u32,
}

#[derive(Serialize)]
pub struct Status {
    pub running: bool,
    pub plan: Option<Plan>,
    /// Requests the novel writer used today, and the daily limit (0 = none set).
    pub used_today: u32,
    pub limit: u32,
    pub reserve: u32,
}

// ----- the rules, as plain functions -----

/// Whether an error from the model is about a rate or quota limit.
pub fn is_rate_limit(err: &str) -> bool {
    let l = err.to_lowercase();
    l.contains("429") || l.contains("rate limit") || l.contains("rate_limit") || l.contains("too many requests") || l.contains("quota") || l.contains("limit reached") || l.contains("exceeded")
}

/// Whether a limit error says the whole day's allowance is gone (waiting a minute won't help).
pub fn is_daily(err: &str) -> bool {
    let l = err.to_lowercase();
    l.contains("daily") || l.contains("per day") || l.contains("a day") || l.contains("quota") || l.contains("tomorrow") || l.contains("resets")
}

/// How many chapters the day's allowance leaves room for: `limit` requests in a day (0 = no limit), `used` already spent, `reserve` kept for chatting.
pub fn chapters_allowed(wanted: u32, limit: u32, used: u32, reserve: u32) -> u32 {
    if limit == 0 {
        return wanted;
    }
    wanted.min(limit.saturating_sub(used.saturating_add(reserve)))
}

pub fn clean_plan(plot: &str, tone: &str, pov: &str, chapters: u32, chapter_tokens: u32) -> Plan {
    let clip = |s: &str, n: usize| s.chars().filter(|c| !c.is_control() || *c == '\n').collect::<String>().trim().chars().take(n).collect::<String>();
    Plan {
        plot: clip(plot, 2000),
        tone: clip(tone, 60),
        pov: clip(pov, 60),
        chapters: chapters.clamp(1, MAX_CHAPTERS),
        chapter_tokens: chapter_tokens.clamp(MIN_CHAPTER_TOKENS, MAX_CHAPTER_TOKENS),
        done: 0,
    }
}

/// What the writer is told for one chapter.
pub fn directive(p: &Plan, n: u32) -> String {
    let words = (p.chapter_tokens as f64 * 0.7) as u32 / 10 * 10;
    let mut d = format!(
        "[NOVEL MODE] You are no longer replying inside a chat: you are writing a novel for the reader, one chapter at a time. {} ",
        if p.plot.is_empty() { "No plot was given, so choose one that suits this scene, these characters and this place, and carry it through.".to_string() } else { format!("What the reader wants to read: {}", p.plot) }
    );
    if !p.tone.is_empty() {
        d.push_str(&format!("Tone and genre: {}. ", p.tone));
    }
    d.push_str(&format!("Point of view: {}. ", if p.pov.is_empty() { "whatever fits the story best" } else { &p.pov }));
    d.push_str(&format!(
        "Write chapter {n} of {total}. Start with a heading line \"Chapter {n}\" and a short title, then about {words} words of polished prose: scenes, dialogue and description, not a summary. Do not address the reader, do not ask questions, do not write the reader's own actions and do not step out of the story. ",
        total = p.chapters
    ));
    if n > 1 {
        d.push_str("Carry on exactly where the previous chapter ended (if it stopped in the middle of a sentence, finish that first), and keep names, places and facts consistent with what is already written. ");
    }
    if n >= p.chapters {
        d.push_str("This is the final chapter: bring every thread of the story to a satisfying end.");
    } else {
        d.push_str("Do not end the story yet.");
    }
    d
}

pub fn stop_note(why: &str, done: u32, total: u32, used: u32, limit: u32, err: &str) -> String {
    let ch = |n: u32| if n == 1 { "1 chapter".to_string() } else { format!("{n} chapters") };
    match why {
        "finished" => format!("The novel is finished: {} written. Enjoy your story! 📖", ch(done)),
        "budget" => format!("I stopped here on purpose. Today's request allowance for this model is nearly used up ({used} of {limit}), and I'd rather stop after a finished chapter than leave one half-written. I wrote {} ({done} of {total} planned). You can keep going when the allowance resets. Enjoy your story! 📖", ch(done)),
        "limit" => format!("The model said its limit was reached ({}), so I stopped after a finished chapter instead of leaving one half-written. I wrote {} ({done} of {total} planned). You can keep going later. Enjoy your story! 📖", err.chars().take(160).collect::<String>(), ch(done)),
        "stopped" => format!("Stopped after {}. Press Keep going whenever you like. Enjoy your story so far! 📖", ch(done)),
        _ => format!("Something went wrong ({}), so I stopped after {} ({done} of {total} planned). Nothing half-written was kept. You can keep going.", err.chars().take(160).collect::<String>(), ch(done)),
    }
}

// ----- keeping it -----

pub fn init(c: &Connection) -> rusqlite::Result<()> {
    c.execute_batch(
        "CREATE TABLE IF NOT EXISTS chat_novel(chat_id INTEGER PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE, plot TEXT NOT NULL DEFAULT '', tone TEXT NOT NULL DEFAULT '', pov TEXT NOT NULL DEFAULT '',
            chapters INTEGER NOT NULL DEFAULT 10, chapter_tokens INTEGER NOT NULL DEFAULT 1200, done INTEGER NOT NULL DEFAULT 0);
         CREATE TABLE IF NOT EXISTS novel_usage(profile TEXT NOT NULL, day INTEGER NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(profile, day));",
    )
}

fn day() -> i64 {
    db::now() / 86400
}

fn who(o: &Owner) -> String {
    o.clone().unwrap_or_default()
}

pub fn used_today(c: &Connection, o: &Owner) -> u32 {
    c.query_row("SELECT n FROM novel_usage WHERE profile=?1 AND day=?2", params![who(o), day()], |r| r.get::<_, i64>(0)).optional().ok().flatten().unwrap_or(0).max(0) as u32
}

fn add_usage(c: &Connection, o: &Owner, n: u32) {
    let _ = c.execute(
        "INSERT INTO novel_usage(profile,day,n) VALUES(?1,?2,?3) ON CONFLICT(profile,day) DO UPDATE SET n=n+excluded.n",
        params![who(o), day(), n as i64],
    );
    let _ = c.execute("DELETE FROM novel_usage WHERE day < ?1", [day() - 7]);
}

/// A limit was hit for real: today counts as used up.
fn exhaust_usage(c: &Connection, o: &Owner, limit: u32) {
    let used = used_today(c, o);
    if limit > used {
        add_usage(c, o, limit - used);
    }
}

pub fn load_plan(c: &Connection, chat_id: i64) -> Option<Plan> {
    c.query_row("SELECT plot,tone,pov,chapters,chapter_tokens,done FROM chat_novel WHERE chat_id=?1", [chat_id], |r| {
        Ok(Plan { plot: r.get(0)?, tone: r.get(1)?, pov: r.get(2)?, chapters: r.get::<_, i64>(3)? as u32, chapter_tokens: r.get::<_, i64>(4)? as u32, done: r.get::<_, i64>(5)? as u32 })
    })
    .optional()
    .ok()
    .flatten()
}

fn save_plan(c: &Connection, chat_id: i64, p: &Plan) {
    let _ = c.execute(
        "INSERT INTO chat_novel(chat_id,plot,tone,pov,chapters,chapter_tokens,done) VALUES(?1,?2,?3,?4,?5,?6,?7)
         ON CONFLICT(chat_id) DO UPDATE SET plot=excluded.plot, tone=excluded.tone, pov=excluded.pov, chapters=excluded.chapters, chapter_tokens=excluded.chapter_tokens, done=excluded.done",
        params![chat_id, p.plot, p.tone, p.pov, p.chapters as i64, p.chapter_tokens as i64, p.done as i64],
    );
}

/// What the novel being written in this chat wants added to the reply's instructions, if one is being written.
pub fn running_directive(st: &AppState, chat_id: i64) -> Option<(String, usize)> {
    st.novels.lock().unwrap().get(&chat_id).filter(|r| !r.directive.is_empty()).map(|r| (r.directive.clone(), r.max_tokens))
}

fn note(st: &AppState, chat_id: i64, text: &str) {
    let db = st.db.lock().unwrap();
    let _ = db::add_message(&db, chat_id, "note", None, &[text.to_string()]);
}

fn event(st: &AppState, chat_id: i64, state: &str, chapter: u32, of: u32, detail: &str) {
    emit(st, "dorms://novel", json!({ "chat_id": chat_id, "state": state, "chapter": chapter, "of": of, "detail": detail }));
}

async fn pause(st: &AppState, chat_id: i64, secs: u64) -> bool {
    for _ in 0..secs {
        if st.novels.lock().unwrap().get(&chat_id).map_or(true, |r| r.stop) {
            return false;
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    true
}

async fn write(st: Shared, o: Owner, chat_id: i64, mut plan: Plan, limit: u32, reserve: u32) {
    let total = plan.chapters;
    let mut why = "finished";
    let mut err_text = String::new();
    while plan.done < total {
        let n = plan.done + 1;
        if st.novels.lock().unwrap().get(&chat_id).map_or(true, |r| r.stop) {
            why = "stopped";
            break;
        }
        let used = used_today(&st.db.lock().unwrap(), &o);
        if chapters_allowed(1, limit, used, reserve) == 0 {
            why = "budget";
            break;
        }
        let rid = uid();
        {
            let mut m = st.novels.lock().unwrap();
            let Some(r) = m.get_mut(&chat_id) else { return };
            r.rid = Some(rid.clone());
            r.directive = directive(&plan, n);
            r.max_tokens = plan.chapter_tokens as usize;
        }
        event(&st, chat_id, "writing", n, total, "");
        let mut attempt = 0;
        let res = loop {
            add_usage(&st.db.lock().unwrap(), &o, 1);
            let res = generate_once(&st, &o, chat_id, None, None, None, rid.clone()).await;
            match &res {
                Err(er) if is_rate_limit(er) && !is_daily(er) && attempt < 2 => {
                    attempt += 1;
                    let wait = if attempt == 1 { 30 } else { 90 };
                    event(&st, chat_id, "waiting", n, total, &format!("The model asked for a pause (too many requests). Trying again in {wait} seconds."));
                    if !pause(&st, chat_id, wait).await {
                        break res;
                    }
                }
                _ => break res,
            }
        };
        let stopped = st.novels.lock().unwrap().get(&chat_id).map_or(true, |r| r.stop);
        match res {
            Ok(_) if stopped => {
                // Stop cut the chapter short: it is not kept, so nothing half-written stays
                let db = st.db.lock().unwrap();
                if let Ok(msgs) = db::list_messages(&db, chat_id) {
                    if let Some(last) = msgs.last().filter(|m| m.role == "character") {
                        let _ = db::delete_message(&db, last.id);
                    }
                }
                why = "stopped";
                break;
            }
            Ok(_) => {
                plan.done = n;
                save_plan(&st.db.lock().unwrap(), chat_id, &plan);
                event(&st, chat_id, "chapter", n, total, "");
                if limit > 0 && plan.done < total && !pause(&st, chat_id, 2).await {
                    why = "stopped";
                    break;
                }
            }
            Err(er) => {
                err_text = er.clone();
                if is_rate_limit(&er) {
                    exhaust_usage(&st.db.lock().unwrap(), &o, limit);
                    why = "limit";
                } else {
                    why = "error";
                }
                break;
            }
        }
    }
    let used = used_today(&st.db.lock().unwrap(), &o);
    note(&st, chat_id, &stop_note(why, plan.done, total, used, limit, &err_text));
    let none_left = {
        let mut m = st.novels.lock().unwrap();
        m.remove(&chat_id);
        m.is_empty()
    };
    event(&st, chat_id, why, plan.done, total, &err_text);
    // written while the window was hidden in the tray: bring it back, so you see it is done
    if none_left && st.hidden.load(std::sync::atomic::Ordering::SeqCst) {
        crate::tray::reveal(&st.app);
    }
}

// ----- commands -----

#[tauri::command]
pub fn novel_status(state: State<'_, Shared>, chat_id: i64) -> R<Status> {
    let o = owner(&state)?;
    let db = state.db.lock().unwrap();
    db::get_chat(&db, chat_id, &o).map_err(e)?.ok_or("Chat not found")?;
    let s = db::get_settings(&db, &o);
    Ok(Status { running: state.novels.lock().unwrap().contains_key(&chat_id), plan: load_plan(&db, chat_id), used_today: used_today(&db, &o), limit: s.novel_daily_limit as u32, reserve: s.novel_reserve as u32 })
}

/// Begin a novel in this chat, or (with `resume`) carry on the one already begun.
#[tauri::command]
pub fn novel_start(state: State<'_, Shared>, chat_id: i64, plot: String, tone: String, pov: String, chapters: u32, chapter_tokens: u32, resume: bool) -> R<Plan> {
    let o = owner(&state)?;
    let st: Shared = state.inner().clone();
    let (plan, limit, reserve) = {
        let db = st.db.lock().unwrap();
        let chat = db::get_chat(&db, chat_id, &o).map_err(e)?.ok_or("Chat not found")?;
        if chat.character_ids.is_empty() {
            return Err("This chat has no characters yet. Add one first.".into());
        }
        let s = db::get_settings(&db, &o);
        let (limit, reserve) = (s.novel_daily_limit as u32, s.novel_reserve as u32);
        let mut plan = match (resume, load_plan(&db, chat_id)) {
            (true, Some(p)) if p.done < p.chapters => p,
            _ => clean_plan(&plot, &tone, &pov, chapters, chapter_tokens),
        };
        // the story is planned to fit what today's allowance leaves
        let left = plan.chapters - plan.done;
        let fits = chapters_allowed(left, limit, used_today(&db, &o), reserve);
        if fits == 0 {
            return Err(format!("Today's request allowance for novels is used up ({} of {limit}). Come back when it resets, or raise the limit in Settings.", used_today(&db, &o)));
        }
        plan.chapters = plan.done + fits;
        save_plan(&db, chat_id, &plan);
        (plan, limit, reserve)
    };
    if st.busy.lock().unwrap().contains(&chat_id) {
        return Err("This chat is already generating a reply.".into());
    }
    {
        let mut m = st.novels.lock().unwrap();
        if m.contains_key(&chat_id) {
            return Err("A novel is already being written in this chat.".into());
        }
        m.insert(chat_id, Run::default());
    }
    let p = plan.clone();
    tauri::async_runtime::spawn(write(st, o, chat_id, p, limit, reserve));
    Ok(plan)
}

#[tauri::command]
pub fn novel_stop(state: State<'_, Shared>, chat_id: i64) {
    let rid = {
        let mut m = state.novels.lock().unwrap();
        m.get_mut(&chat_id).and_then(|r| { r.stop = true; r.rid.clone() })
    };
    if let Some(rid) = rid {
        if let Some(n) = state.cancels.lock().unwrap().get(&rid) {
            n.notify_one();
        }
    }
}

/// Whether any novel is being written (so closing the window can warn first).
#[tauri::command]
pub fn novels_running(state: State<'_, Shared>) -> Vec<i64> {
    let m: &HashMap<i64, Run> = &state.novels.lock().unwrap();
    m.keys().copied().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limits_are_told_from_other_errors() {
        assert!(is_rate_limit("The model server answered 429 Too Many Requests: slow down"));
        assert!(is_rate_limit("You exceeded your current quota"));
        assert!(!is_rate_limit("Could not reach the model: connection refused"));
        assert!(is_daily("Daily limit reached, resets tomorrow"));
        assert!(!is_daily("429 Too Many Requests"));
    }

    #[test]
    fn the_story_is_planned_to_fit_the_allowance() {
        assert_eq!(chapters_allowed(10, 0, 500, 3), 10, "no limit set: all of it");
        assert_eq!(chapters_allowed(10, 40, 0, 5), 10);
        assert_eq!(chapters_allowed(60, 40, 10, 5), 25, "40 a day, 10 used, 5 kept for chatting");
        assert_eq!(chapters_allowed(10, 40, 36, 5), 0, "when the reserve is reached nothing more is started");
        assert_eq!(chapters_allowed(10, 40, 90, 5), 0);
    }

    #[test]
    fn a_plan_is_made_safe_and_the_chapter_is_asked_for_properly() {
        let p = clean_plan("  a mystery in the library \u{7}", "", "first person", 500, 10);
        assert_eq!((p.chapters, p.chapter_tokens, p.plot.as_str()), (MAX_CHAPTERS, MIN_CHAPTER_TOKENS, "a mystery in the library"));
        let p = Plan { chapters: 3, ..clean_plan("", "gothic", "", 3, 1200) };
        let d1 = directive(&p, 1);
        assert!(d1.contains("Chapter 1") && d1.contains("gothic") && d1.contains("choose one that suits") && d1.contains("Do not end the story yet") && !d1.contains("Carry on exactly"));
        let d3 = directive(&p, 3);
        assert!(d3.contains("Carry on exactly") && d3.contains("final chapter") && !d3.contains("Do not end the story yet"));
    }

    #[test]
    fn the_stop_message_says_why_and_wishes_a_good_read() {
        let b = stop_note("budget", 7, 12, 36, 40, "");
        assert!(b.contains("36 of 40") && b.contains("7 chapters") && b.contains("on purpose") && b.contains("Enjoy your story"));
        assert!(stop_note("finished", 1, 1, 0, 0, "").contains("1 chapter written"));
        assert!(stop_note("limit", 2, 5, 0, 0, "429 slow down").contains("429 slow down"));
    }

    #[test]
    fn usage_is_counted_per_day_and_per_profile() {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch("CREATE TABLE chats(id INTEGER PRIMARY KEY); INSERT INTO chats(id) VALUES(7);").unwrap();
        init(&c).unwrap();
        let (a, b): (Owner, Owner) = (Some("a".into()), Some("b".into()));
        add_usage(&c, &a, 3);
        add_usage(&c, &a, 2);
        add_usage(&c, &b, 1);
        assert_eq!((used_today(&c, &a), used_today(&c, &b), used_today(&c, &None)), (5, 1, 0));
        exhaust_usage(&c, &a, 40);
        assert_eq!(used_today(&c, &a), 40, "a real limit counts the day as used up");
        let p = Plan { plot: "x".into(), tone: String::new(), pov: String::new(), chapters: 5, chapter_tokens: 900, done: 2 };
        save_plan(&c, 7, &p);
        assert_eq!(load_plan(&c, 7), Some(p));
    }
}
