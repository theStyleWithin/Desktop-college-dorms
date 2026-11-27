//! Comments under pictures in the Gallery: the person's own notes about a picture they like, kept only on this device (nothing is sent anywhere).
//! They work like a forum thread: any number of comments under a picture, written whenever, each of which can be answered by more comments.
//! There is no limit on how many comments a picture can have; one comment can be long, but not endless.

use std::collections::HashMap;

use tauri::State;

use crate::commands::{e, owner, uid};
use crate::db::{self, GalleryComment, MAX_COMMENT_CHARS};
use crate::Shared;

type R<T> = Result<T, String>;

/// A picture's name, as the page makes it: `char:<character id>:profile`, `char:<character id>:<gallery item id>` or `disk:<full path>`.
pub fn pic_key_ok(k: &str) -> bool {
    !k.is_empty() && k.chars().count() <= 1000 && !k.chars().any(|c| c.is_control()) && (k.starts_with("char:") || k.starts_with("disk:"))
}

/// A comment's words: trimmed, with the line breaks kept, and not empty or endless.
pub fn clean_body(s: &str) -> R<String> {
    let t = s.replace("\r\n", "\n").replace('\r', "\n");
    let t = t.trim();
    if t.is_empty() { return Err("Write something first.".into()); }
    if t.chars().count() > MAX_COMMENT_CHARS { return Err(format!("That comment is too long ({MAX_COMMENT_CHARS} characters at most).")); }
    Ok(t.chars().filter(|c| !c.is_control() || *c == '\n' || *c == '\t').collect())
}

fn clean_author(s: &str) -> String {
    s.chars().filter(|c| !c.is_control()).collect::<String>().trim().chars().take(60).collect()
}

#[tauri::command]
pub fn gallery_comments(state: State<'_, Shared>, pic_key: String) -> R<Vec<GalleryComment>> {
    if !pic_key_ok(&pic_key) { return Ok(vec![]); }
    let o = owner(&state)?;
    db::list_gallery_comments(&state.db.lock().unwrap(), &o, &pic_key).map_err(e)
}

/// How many comments each picture has, so a picture can show a count.
#[tauri::command]
pub fn gallery_comment_counts(state: State<'_, Shared>) -> R<HashMap<String, i64>> {
    let o = owner(&state)?;
    db::gallery_comment_counts(&state.db.lock().unwrap(), &o).map_err(e)
}

/// Posts a comment under a picture, or (with `parent_id`) as an answer to a comment under the same picture.
#[tauri::command]
pub fn add_gallery_comment(state: State<'_, Shared>, pic_key: String, parent_id: Option<String>, author: String, body: String) -> R<GalleryComment> {
    if !pic_key_ok(&pic_key) { return Err("That picture can't have comments.".into()); }
    let body = clean_body(&body)?;
    let o = owner(&state)?;
    let db = state.db.lock().unwrap();
    if let Some(p) = &parent_id {
        match db::get_gallery_comment(&db, &o, p).map_err(e)? {
            Some(par) if par.pic_key == pic_key => {}
            _ => return Err("The comment you are answering isn't there any more.".into()),
        }
    }
    let g = GalleryComment { id: uid(), pic_key, parent_id, author: clean_author(&author), body, created_at: db::now(), edited_at: None };
    db::insert_gallery_comment(&db, &o, &g).map_err(e)?;
    Ok(g)
}

#[tauri::command]
pub fn edit_gallery_comment(state: State<'_, Shared>, id: String, body: String) -> R<GalleryComment> {
    let body = clean_body(&body)?;
    let o = owner(&state)?;
    let db = state.db.lock().unwrap();
    if db::get_gallery_comment(&db, &o, &id).map_err(e)?.is_none() { return Err("That comment isn't there any more.".into()); }
    db::edit_gallery_comment(&db, &o, &id, &body).map_err(e)?;
    db::get_gallery_comment(&db, &o, &id).map_err(e)?.ok_or_else(|| "That comment isn't there any more.".to_string())
}

/// Deletes a comment and the answers under it. Returns how many comments went.
#[tauri::command]
pub fn delete_gallery_comment(state: State<'_, Shared>, id: String) -> R<usize> {
    let o = owner(&state)?;
    db::delete_gallery_comment(&state.db.lock().unwrap(), &o, &id).map_err(e)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn g(id: &str, key: &str, parent: Option<&str>, t: i64) -> GalleryComment {
        GalleryComment { id: id.into(), pic_key: key.into(), parent_id: parent.map(String::from), author: "Me".into(), body: format!("body {id}"), created_at: t, edited_at: None }
    }

    #[test]
    fn a_picture_is_named_one_of_three_ways_only() {
        assert!(pic_key_ok("char:abc:profile") && pic_key_ok("char:abc:item1") && pic_key_ok("disk:/home/me/art/cat.png") && pic_key_ok("disk:C:\\Art\\cat.png"));
        for bad in ["", "nope", "file:/etc/passwd", "char:a\nb", &format!("disk:{}", "x".repeat(1001))] { assert!(!pic_key_ok(bad), "{bad:?}"); }
    }

    #[test]
    fn a_comment_keeps_its_line_breaks_and_is_never_empty_or_endless() {
        assert_eq!(clean_body("  Lovely light.\r\n\r\nSecond line.  ").unwrap(), "Lovely light.\n\nSecond line.");
        assert!(clean_body("   \n ").is_err());
        assert!(clean_body("").is_err());
        assert!(clean_body(&"x".repeat(MAX_COMMENT_CHARS)).is_ok());
        assert!(clean_body(&"x".repeat(MAX_COMMENT_CHARS + 1)).is_err());
        assert_eq!(clean_body("a\u{0}b\u{7}c").unwrap(), "abc", "control characters are dropped");
        assert_eq!(clean_author("  Alex\n "), "Alex");
        assert_eq!(clean_author(&"n".repeat(100)).chars().count(), 60);
    }

    #[test]
    fn a_picture_can_have_any_number_of_comments_in_threads() {
        let c = db::open(std::path::Path::new(":memory:")).unwrap();
        let (a, b): (db::Owner, db::Owner) = (Some("a".into()), Some("b".into()));
        let key = "char:c1:profile";
        // a great many comments under one picture: there is no limit
        for i in 0..500 { db::insert_gallery_comment(&c, &a, &g(&format!("c{i}"), key, None, i)).unwrap(); }
        assert_eq!(db::list_gallery_comments(&c, &a, key).unwrap().len(), 500);
        assert_eq!(db::gallery_comment_counts(&c, &a).unwrap()[key], 500);
        // answers, and answers to answers
        db::insert_gallery_comment(&c, &a, &g("r1", key, Some("c0"), 1000)).unwrap();
        db::insert_gallery_comment(&c, &a, &g("r2", key, Some("r1"), 1001)).unwrap();
        db::insert_gallery_comment(&c, &a, &g("other", "char:c1:item9", None, 5)).unwrap();
        assert_eq!(db::list_gallery_comments(&c, &a, key).unwrap().len(), 502);
        assert_eq!(db::list_gallery_comments(&c, &a, "char:c1:item9").unwrap().len(), 1, "each picture has its own");
        assert!(db::list_gallery_comments(&c, &b, key).unwrap().is_empty(), "another profile sees none of them");
        // editing
        db::edit_gallery_comment(&c, &a, "c1", "changed").unwrap();
        let e1 = db::get_gallery_comment(&c, &a, "c1").unwrap().unwrap();
        assert_eq!(e1.body, "changed");
        assert!(e1.edited_at.is_some(), "an edited comment says so");
        db::edit_gallery_comment(&c, &b, "c2", "stolen").unwrap();
        assert_eq!(db::get_gallery_comment(&c, &a, "c2").unwrap().unwrap().body, "body c2", "another profile can't edit them");
        // deleting a comment takes the answers under it
        assert_eq!(db::delete_gallery_comment(&c, &b, "c0").unwrap(), 0, "another profile can't delete them");
        assert_eq!(db::delete_gallery_comment(&c, &a, "c0").unwrap(), 3, "the comment, its answer and the answer to that");
        assert!(db::get_gallery_comment(&c, &a, "r2").unwrap().is_none());
        assert_eq!(db::list_gallery_comments(&c, &a, key).unwrap().len(), 499);
        // a deleted character's pictures take their comments, and nothing else
        db::delete_gallery_comments_under(&c, &a, "char:c1:").unwrap();
        db::insert_gallery_comment(&c, &a, &g("keep", "char:c10:profile", None, 1)).unwrap();
        db::delete_gallery_comments_under(&c, &a, "char:c1:").unwrap();
        assert_eq!(db::gallery_comment_counts(&c, &a).unwrap().len(), 1, "only the other character's picture still has comments");
        db::delete_gallery_comments_under(&c, &a, "char:c10:pro%").unwrap();
        assert_eq!(db::gallery_comment_counts(&c, &a).unwrap().len(), 1, "a % in the start is not a wildcard");
    }
}
