//! Folders for lorebooks and playbooks ("shelves"): make folders, put folders in folders, move things in and out, rename and delete.
//! Deleting a folder never deletes what is in it: its folders and things move up to where it was.

use std::collections::BTreeMap;

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use tauri::State;

use crate::commands::{e, owner, uid};
use crate::db::{self, Owner};
use crate::Shared;

type R<T> = Result<T, String>;

pub const MAX_DEPTH: usize = 4;
pub const MAX_FOLDERS: usize = 200;
const KINDS: [&str; 2] = ["lorebooks", "playbooks"];

#[derive(Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
pub struct ShelfFolder {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub parent: Option<String>,
    pub created_at: i64,
}

#[derive(Serialize)]
pub struct Shelf {
    pub folders: Vec<ShelfFolder>,
    /// Which folder each thing is in (things in no folder are not listed).
    pub items: BTreeMap<String, String>,
}

pub fn init(c: &Connection) -> rusqlite::Result<()> {
    c.execute_batch(
        "CREATE TABLE IF NOT EXISTS shelf_folders(id TEXT PRIMARY KEY, profile_id TEXT, kind TEXT NOT NULL, name TEXT NOT NULL, parent TEXT, created_at INTEGER NOT NULL);
         CREATE TABLE IF NOT EXISTS shelf_items(profile_id TEXT, kind TEXT NOT NULL, item_id TEXT NOT NULL, folder_id TEXT NOT NULL);
         CREATE UNIQUE INDEX IF NOT EXISTS shelf_items_one ON shelf_items(IFNULL(profile_id,''), kind, item_id);",
    )
}

fn clean_name(s: &str) -> R<String> {
    let n: String = s.chars().filter(|c| !c.is_control()).collect::<String>().split_whitespace().collect::<Vec<_>>().join(" ").chars().take(40).collect();
    if n.is_empty() { Err("Give the folder a name.".into()) } else { Ok(n) }
}

fn kind_ok(kind: &str) -> R<()> {
    if KINDS.contains(&kind) { Ok(()) } else { Err("That kind of folder doesn't exist.".into()) }
}

pub fn folders(c: &Connection, kind: &str, o: &Owner) -> Vec<ShelfFolder> {
    let Ok(mut s) = c.prepare("SELECT id,kind,name,parent,created_at FROM shelf_folders WHERE kind=?1 AND profile_id IS ?2 ORDER BY name COLLATE NOCASE") else { return vec![] };
    s.query_map(params![kind, o], |r| Ok(ShelfFolder { id: r.get(0)?, kind: r.get(1)?, name: r.get(2)?, parent: r.get(3)?, created_at: r.get(4)? }))
        .map(|rows| rows.filter_map(|r| r.ok()).collect())
        .unwrap_or_default()
}

/// How many folders deep a folder sits (a folder at the top is 1).
pub fn depth_of(all: &[ShelfFolder], id: &str) -> usize {
    let (mut d, mut cur) = (0, Some(id.to_string()));
    while let Some(c) = cur {
        d += 1;
        if d > 64 { break; }
        cur = all.iter().find(|f| f.id == c).and_then(|f| f.parent.clone());
    }
    d
}

/// The folder and everything inside it.
fn within(all: &[ShelfFolder], id: &str) -> Vec<String> {
    let mut out = vec![id.to_string()];
    let mut i = 0;
    while i < out.len() {
        let here = out[i].clone();
        for f in all.iter().filter(|f| f.parent.as_deref() == Some(here.as_str())) {
            if !out.contains(&f.id) { out.push(f.id.clone()); }
        }
        i += 1;
    }
    out
}

/// How tall the folder tree under a folder is (a folder with nothing in it is 1).
fn height(all: &[ShelfFolder], id: &str) -> usize {
    1 + all.iter().filter(|f| f.parent.as_deref() == Some(id)).map(|f| height(all, &f.id)).max().unwrap_or(0)
}

fn exists(c: &Connection, kind: &str, item: &str, o: &Owner) -> bool {
    match kind {
        "lorebooks" => db::list_lorebooks(c, o).map(|l| l.iter().any(|b| b.id == item)).unwrap_or(false),
        _ => crate::playbook::get(c, item, o).is_some(),
    }
}

pub fn shelf(c: &Connection, kind: &str, o: &Owner) -> Shelf {
    let fs = folders(c, kind, o);
    let mut items = BTreeMap::new();
    if let Ok(mut s) = c.prepare("SELECT item_id,folder_id FROM shelf_items WHERE kind=?1 AND profile_id IS ?2") {
        if let Ok(rows) = s.query_map(params![kind, o], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))) {
            for (item, folder) in rows.filter_map(|r| r.ok()) {
                if fs.iter().any(|f| f.id == folder) && exists(c, kind, &item, o) { items.insert(item, folder); }
            }
        }
    }
    Shelf { folders: fs, items }
}

pub fn make(c: &Connection, kind: &str, name: &str, parent: Option<&str>, o: &Owner) -> R<ShelfFolder> {
    kind_ok(kind)?;
    let name = clean_name(name)?;
    let all = folders(c, kind, o);
    if all.len() >= MAX_FOLDERS {
        return Err(format!("That is a lot of folders ({MAX_FOLDERS} at most)."));
    }
    if let Some(p) = parent {
        if !all.iter().any(|f| f.id == p) { return Err("That folder isn't there any more.".into()); }
        if depth_of(&all, p) >= MAX_DEPTH { return Err(format!("Folders can go {MAX_DEPTH} deep at most.")); }
    }
    if all.iter().any(|f| f.parent.as_deref() == parent && f.name.to_lowercase() == name.to_lowercase()) {
        return Err("A folder with that name is already there.".into());
    }
    let f = ShelfFolder { id: uid(), kind: kind.into(), name, parent: parent.map(String::from), created_at: db::now() };
    c.execute("INSERT INTO shelf_folders(id,profile_id,kind,name,parent,created_at) VALUES(?1,?2,?3,?4,?5,?6)", params![f.id, o, f.kind, f.name, f.parent, f.created_at]).map_err(e)?;
    Ok(f)
}

fn find(c: &Connection, id: &str, o: &Owner) -> R<ShelfFolder> {
    c.query_row("SELECT id,kind,name,parent,created_at FROM shelf_folders WHERE id=?1 AND profile_id IS ?2", params![id, o], |r| Ok(ShelfFolder { id: r.get(0)?, kind: r.get(1)?, name: r.get(2)?, parent: r.get(3)?, created_at: r.get(4)? }))
        .optional().map_err(e)?.ok_or_else(|| "That folder isn't there any more.".to_string())
}

pub fn rename(c: &Connection, id: &str, name: &str, o: &Owner) -> R<ShelfFolder> {
    let f = find(c, id, o)?;
    let name = clean_name(name)?;
    let all = folders(c, &f.kind, o);
    if all.iter().any(|x| x.id != f.id && x.parent == f.parent && x.name.to_lowercase() == name.to_lowercase()) {
        return Err("A folder with that name is already there.".into());
    }
    c.execute("UPDATE shelf_folders SET name=?2 WHERE id=?1", params![id, name]).map_err(e)?;
    find(c, id, o)
}

/// Put a folder inside another (or back at the top with `None`).
pub fn move_folder(c: &Connection, id: &str, parent: Option<&str>, o: &Owner) -> R<ShelfFolder> {
    let f = find(c, id, o)?;
    let all = folders(c, &f.kind, o);
    if let Some(p) = parent {
        if !all.iter().any(|x| x.id == p) { return Err("That folder isn't there any more.".into()); }
        if within(&all, id).iter().any(|x| x == p) { return Err("A folder can't go inside itself.".into()); }
        if depth_of(&all, p) + height(&all, id) > MAX_DEPTH { return Err(format!("Folders can go {MAX_DEPTH} deep at most.")); }
    }
    if all.iter().any(|x| x.id != f.id && x.parent.as_deref() == parent && x.name.to_lowercase() == f.name.to_lowercase()) {
        return Err("A folder with that name is already there.".into());
    }
    c.execute("UPDATE shelf_folders SET parent=?2 WHERE id=?1", params![id, parent]).map_err(e)?;
    find(c, id, o)
}

/// Deletes the folder only: what was inside moves up to where the folder was.
pub fn remove(c: &Connection, id: &str, o: &Owner) -> R<()> {
    let f = find(c, id, o)?;
    c.execute("UPDATE shelf_folders SET parent=?2 WHERE parent=?1 AND profile_id IS ?3", params![id, f.parent, o]).map_err(e)?;
    match &f.parent {
        Some(p) => { c.execute("UPDATE shelf_items SET folder_id=?2 WHERE folder_id=?1 AND profile_id IS ?3", params![id, p, o]).map_err(e)?; }
        None => { c.execute("DELETE FROM shelf_items WHERE folder_id=?1 AND profile_id IS ?2", params![id, o]).map_err(e)?; }
    }
    c.execute("DELETE FROM shelf_folders WHERE id=?1", [id]).map_err(e)?;
    Ok(())
}

pub fn put(c: &Connection, kind: &str, item: &str, folder: Option<&str>, o: &Owner) -> R<()> {
    kind_ok(kind)?;
    if !exists(c, kind, item, o) { return Err("That isn't there any more.".into()); }
    match folder {
        None => { c.execute("DELETE FROM shelf_items WHERE kind=?1 AND item_id=?2 AND profile_id IS ?3", params![kind, item, o]).map_err(e)?; }
        Some(fid) => {
            let f = find(c, fid, o)?;
            if f.kind != kind { return Err("That folder is for something else.".into()); }
            c.execute("DELETE FROM shelf_items WHERE kind=?1 AND item_id=?2 AND profile_id IS ?3", params![kind, item, o]).map_err(e)?;
            c.execute("INSERT INTO shelf_items(profile_id,kind,item_id,folder_id) VALUES(?1,?2,?3,?4)", params![o, kind, item, fid]).map_err(e)?;
        }
    }
    Ok(())
}

// ----- backups -----

#[derive(Serialize, serde::Deserialize, Clone)]
pub struct ShelfItemRow {
    pub kind: String,
    pub item_id: String,
    pub folder_id: String,
}

/// Every folder and what is in them, for a backup file.
pub fn export(c: &Connection, o: &Owner) -> (Vec<ShelfFolder>, Vec<ShelfItemRow>) {
    let mut fs = vec![];
    let mut items = vec![];
    for k in KINDS {
        let sh = shelf(c, k, o);
        fs.extend(sh.folders);
        items.extend(sh.items.into_iter().map(|(item_id, folder_id)| ShelfItemRow { kind: k.to_string(), item_id, folder_id }));
    }
    (fs, items)
}

/// Brings folders back from a backup. `map` turns a lorebook or playbook's old id into its new one.
pub fn import(c: &Connection, o: &Owner, folders: &[ShelfFolder], items: &[ShelfItemRow], map: &std::collections::HashMap<String, String>) {
    let mut new_ids: std::collections::HashMap<String, String> = Default::default();
    // parents first, so a folder's parent already exists when it is made
    let mut left: Vec<&ShelfFolder> = folders.iter().filter(|f| KINDS.contains(&f.kind.as_str())).collect();
    let mut guard = 0;
    while !left.is_empty() && guard < 8 {
        guard += 1;
        left.retain(|f| {
            let parent = match &f.parent { None => Some(None), Some(p) => new_ids.get(p).map(|n| Some(n.clone())) };
            let Some(parent) = parent else { return true };
            if let Ok(made) = make(c, &f.kind, &f.name, parent.as_deref(), o) {
                new_ids.insert(f.id.clone(), made.id);
            }
            false
        });
    }
    for it in items {
        if let (Some(folder), Some(item)) = (new_ids.get(&it.folder_id), map.get(&it.item_id)) {
            let _ = put(c, &it.kind, item, Some(folder), o);
        }
    }
}

// ----- commands -----

#[tauri::command]
pub fn get_shelf(state: State<'_, Shared>, kind: String) -> R<Shelf> {
    kind_ok(&kind)?;
    let o = owner(&state)?;
    Ok(shelf(&state.db.lock().unwrap(), &kind, &o))
}

#[tauri::command]
pub fn create_shelf_folder(state: State<'_, Shared>, kind: String, name: String, parent: Option<String>) -> R<ShelfFolder> {
    let o = owner(&state)?;
    make(&state.db.lock().unwrap(), &kind, &name, parent.as_deref(), &o)
}

#[tauri::command]
pub fn rename_shelf_folder(state: State<'_, Shared>, id: String, name: String) -> R<ShelfFolder> {
    let o = owner(&state)?;
    rename(&state.db.lock().unwrap(), &id, &name, &o)
}

#[tauri::command]
pub fn move_shelf_folder(state: State<'_, Shared>, id: String, parent: Option<String>) -> R<ShelfFolder> {
    let o = owner(&state)?;
    move_folder(&state.db.lock().unwrap(), &id, parent.as_deref(), &o)
}

#[tauri::command]
pub fn delete_shelf_folder(state: State<'_, Shared>, id: String) -> R<()> {
    let o = owner(&state)?;
    remove(&state.db.lock().unwrap(), &id, &o)
}

/// Put a lorebook or playbook in a folder, or take it out (`folder` empty).
#[tauri::command]
pub fn move_to_shelf_folder(state: State<'_, Shared>, kind: String, item_id: String, folder: Option<String>) -> R<()> {
    let o = owner(&state)?;
    put(&state.db.lock().unwrap(), &kind, &item_id, folder.as_deref(), &o)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh() -> Connection {
        db::open(std::path::Path::new(":memory:")).unwrap()
    }
    fn book(c: &Connection, id: &str, o: &Owner) {
        db::save_lorebook(c, &db::Lorebook { id: id.into(), name: id.into(), book: serde_json::Value::Null, created_at: 0, updated_at: 0 }, o).unwrap();
    }

    #[test]
    fn folders_nest_rename_and_keep_their_contents_when_deleted() {
        let c = fresh();
        let (a, b): (Owner, Owner) = (Some("a".into()), Some("b".into()));
        book(&c, "b1", &a);
        book(&c, "b2", &a);
        let world = make(&c, "lorebooks", "  World   notes ", None, &a).unwrap();
        assert_eq!(world.name, "World notes", "spaces tidied");
        assert!(make(&c, "lorebooks", "world NOTES", None, &a).is_err(), "no two of the same name side by side");
        assert!(make(&c, "lorebooks", "  ", None, &a).is_err() && make(&c, "stuff", "x", None, &a).is_err());
        let places = make(&c, "lorebooks", "Places", Some(&world.id), &a).unwrap();
        assert!(make(&c, "lorebooks", "world notes", Some(&places.id), &a).is_ok(), "the same name is fine one level down");
        put(&c, "lorebooks", "b1", Some(&places.id), &a).unwrap();
        put(&c, "lorebooks", "b2", Some(&world.id), &a).unwrap();
        let s = shelf(&c, "lorebooks", &a);
        assert_eq!((s.folders.len(), s.items.get("b1"), s.items.get("b2")), (3, Some(&places.id), Some(&world.id)));
        assert!(shelf(&c, "playbooks", &a).folders.is_empty(), "lorebook folders and playbook folders are separate");
        assert!(shelf(&c, "lorebooks", &b).folders.is_empty() && put(&c, "lorebooks", "b1", Some(&world.id), &b).is_err(), "another profile can't see or use them");
        assert_eq!(rename(&c, &places.id, "Locations", &a).unwrap().name, "Locations");
        // delete: what was inside moves up
        remove(&c, &places.id, &a).unwrap();
        let s = shelf(&c, "lorebooks", &a);
        assert_eq!((s.folders.len(), s.items.get("b1")), (2, Some(&world.id)), "the book moved up into the parent folder");
        remove(&c, &world.id, &a).unwrap();
        let s = shelf(&c, "lorebooks", &a);
        assert!(s.items.is_empty() && s.folders.len() == 1 && s.folders[0].parent.is_none(), "the sub-folder moved to the top, the books are simply in no folder");
        assert!(db::list_lorebooks(&c, &a).unwrap().len() == 2, "no book was deleted");
    }

    #[test]
    fn depth_cycles_and_missing_things_are_refused() {
        let c = fresh();
        let a: Owner = Some("a".into());
        let f1 = make(&c, "playbooks", "1", None, &a).unwrap();
        let f2 = make(&c, "playbooks", "2", Some(&f1.id), &a).unwrap();
        let f3 = make(&c, "playbooks", "3", Some(&f2.id), &a).unwrap();
        let f4 = make(&c, "playbooks", "4", Some(&f3.id), &a).unwrap();
        assert!(make(&c, "playbooks", "5", Some(&f4.id), &a).is_err(), "four deep at most");
        assert!(move_folder(&c, &f1.id, Some(&f3.id), &a).is_err(), "a folder can't go inside itself or its own folders");
        let other = make(&c, "playbooks", "other", None, &a).unwrap();
        assert!(move_folder(&c, &other.id, Some(&f4.id), &a).is_err(), "moving it would make it too deep");
        assert!(move_folder(&c, &f4.id, None, &a).is_ok() && move_folder(&c, &f4.id, Some(&other.id), &a).is_ok());
        assert!(put(&c, "playbooks", "nope", Some(&f1.id), &a).is_err(), "something that isn't there");
        assert!(put(&c, "lorebooks", "x", Some(&f1.id), &a).is_err(), "a playbook folder can't hold a lorebook");
        assert!(remove(&c, "ghost", &a).is_err());
    }
}
