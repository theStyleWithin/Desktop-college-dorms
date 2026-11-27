//! Folders on the computer that the person adds to the Gallery, only to look at the pictures in them. Nothing in a folder is ever copied,
//! changed or deleted, and the pictures are not added to any character. The web view may read a folder only while it is on the list.
//! Which folders may be added is decided here, not by the page: never a drive root, the home folder or anything above it, a hidden folder,
//! a system folder, or the app's own data folder (which holds the database and the key file).

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{Manager, State};

use crate::commands::{e, owner, uid};
use crate::db;
use crate::Shared;

type R<T> = Result<T, String>;

const MAX_DEPTH: usize = 8;
const MAX_FILES: usize = 5000;

#[derive(Serialize)]
pub struct Folder {
    pub id: String,
    pub path: String,
    pub name: String,
    /// False when the folder has been moved or deleted since it was added.
    pub exists: bool,
}

#[derive(Serialize, Default)]
pub struct Pic {
    pub name: String,
    pub path: String,
    /// image | gif | video
    pub kind: &'static str,
    pub size: u64,
}

#[derive(Serialize, Default)]
pub struct Dir {
    pub name: String,
    pub files: Vec<Pic>,
    pub dirs: Vec<Dir>,
    /// How many pictures are in it and in everything inside it.
    pub total: usize,
}

#[derive(Serialize)]
pub struct Scan {
    pub root: Dir,
    /// True if there were more pictures than are shown (the first ones are listed).
    pub truncated: bool,
}

/// What a file is, by its ending: pictures, GIFs and short clips the web view can show.
pub fn kind_of(name: &str) -> Option<&'static str> {
    match name.rsplit_once('.')?.1.to_ascii_lowercase().as_str() {
        "png" | "jpg" | "jpeg" | "webp" | "bmp" | "avif" => Some("image"),
        "gif" => Some("gif"),
        "mp4" | "webm" | "m4v" => Some("video"),
        _ => None,
    }
}

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from)
}

/// Whether a folder may be added. `Ok` holds its real path (links resolved).
pub fn check_folder(raw: &str, data_dir: &Path, home: Option<&Path>) -> R<PathBuf> {
    let raw = raw.trim();
    if raw.is_empty() { return Err("Choose a folder first.".into()); }
    let p = PathBuf::from(raw);
    if !p.is_absolute() { return Err("That isn't a full folder path.".into()); }
    let real = p.canonicalize().map_err(|_| "That folder isn't there.".to_string())?;
    if !real.is_dir() { return Err("That isn't a folder.".into()); }
    if real.parent().is_none() { return Err("A whole drive is too much to add. Choose a folder inside it.".into()); }
    if real.components().any(|c| c.as_os_str().to_string_lossy().starts_with('.') && c.as_os_str() != "." && c.as_os_str() != "..") {
        return Err("Hidden folders can't be added.".into());
    }
    let dd = data_dir.canonicalize().unwrap_or_else(|_| data_dir.to_path_buf());
    if real.starts_with(&dd) || dd.starts_with(&real) { return Err("That folder holds the app's own data, so it can't be added.".into()); }
    if let Some(h) = home {
        let h = h.canonicalize().unwrap_or_else(|_| h.to_path_buf());
        if h.starts_with(&real) { return Err("Your whole home folder is too much to add. Choose a folder inside it, such as Pictures.".into()); }
    }
    let s = real.to_string_lossy().to_lowercase().replace('\\', "/");
    for bad in ["/etc", "/proc", "/sys", "/dev", "/boot", "/usr", "/var", "/bin", "/sbin", "/lib", "/root", "/windows", "/program files", "/programdata", "/system", "/library", "/private"] {
        // on Windows the path starts with a drive (`c:/windows`): the system folders are named after it
        let after_drive = if s.len() > 2 && s.as_bytes()[1] == b':' { &s[2..] } else { s.as_str() };
        if after_drive == bad || after_drive.starts_with(&format!("{bad}/")) { return Err("System folders can't be added.".into()); }
    }
    Ok(real)
}

/// The pictures in a folder and the folders inside it (not following links, skipping hidden things, and stopping at a sensible size).
pub fn scan_dir(path: &Path, depth: usize, budget: &mut usize, truncated: &mut bool) -> Dir {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let mut dir = Dir { name, ..Dir::default() };
    let Ok(rd) = std::fs::read_dir(path) else { return dir };
    let mut entries: Vec<_> = rd.filter_map(|x| x.ok()).collect();
    entries.sort_by_key(|x| x.file_name().to_string_lossy().to_lowercase());
    for en in entries {
        let fname = en.file_name().to_string_lossy().into_owned();
        if fname.starts_with('.') { continue; }
        let Ok(ft) = en.file_type() else { continue };
        if ft.is_symlink() { continue; }
        if ft.is_dir() {
            if depth < MAX_DEPTH && *budget > 0 {
                let sub = scan_dir(&en.path(), depth + 1, budget, truncated);
                if sub.total > 0 { dir.dirs.push(sub); }
            } else {
                *truncated = true;   // not looked into: it may hold more pictures
            }
        } else if ft.is_file() {
            let Some(kind) = kind_of(&fname) else { continue };
            if *budget == 0 { *truncated = true; break; }
            *budget -= 1;
            let size = en.metadata().map(|m| m.len()).unwrap_or(0);
            dir.files.push(Pic { name: fname, path: en.path().to_string_lossy().into_owned(), kind, size });
        }
    }
    dir.total = dir.files.len() + dir.dirs.iter().map(|d| d.total).sum::<usize>();
    dir
}

fn shown(id: String, path: String) -> Folder {
    let name = Path::new(&path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| path.clone());
    let exists = Path::new(&path).is_dir();
    Folder { id, path, name, exists }
}

/// The folders on the list. Each one that is still there is made readable for the page.
#[tauri::command]
pub fn list_view_folders(state: State<'_, Shared>) -> R<Vec<Folder>> {
    let o = owner(&state)?;
    let rows = db::list_view_folders(&state.db.lock().unwrap(), &o).map_err(e)?;
    let scope = state.app.asset_protocol_scope();
    Ok(rows.into_iter().map(|f| { if Path::new(&f.path).is_dir() { let _ = scope.allow_directory(&f.path, true); } shown(f.id, f.path) }).collect())
}

/// Adds a folder to look at. It has to pass `check_folder`, and the same folder is not added twice.
#[tauri::command]
pub fn add_view_folder(state: State<'_, Shared>, path: String) -> R<Folder> {
    let o = owner(&state)?;
    let real = check_folder(&path, &state.data_dir, home().as_deref())?;
    let real_s = real.to_string_lossy().into_owned();
    let db = state.db.lock().unwrap();
    let have = db::list_view_folders(&db, &o).map_err(e)?;
    if have.iter().any(|f| f.path == real_s) { return Err("That folder is already in the Gallery.".into()); }
    if have.len() >= db::MAX_VIEW_FOLDERS { return Err(format!("The Gallery can hold {} folders. Remove one first.", db::MAX_VIEW_FOLDERS)); }
    let id = uid();
    db::add_view_folder(&db, &id, &real_s, &o).map_err(e)?;
    let _ = state.app.asset_protocol_scope().allow_directory(&real, true);
    Ok(shown(id, real_s))
}

/// Takes a folder off the list (nothing on the computer is touched) and stops the page reading it.
#[tauri::command]
pub fn remove_view_folder(state: State<'_, Shared>, id: String) -> R<()> {
    let o = owner(&state)?;
    let path = db::remove_view_folder(&state.db.lock().unwrap(), &id, &o).map_err(e)?;
    if let Some(p) = path { let _ = state.app.asset_protocol_scope().forbid_directory(&p, true); }
    Ok(())
}

/// What is in a folder on the list: its pictures, and its folders with theirs.
#[tauri::command]
pub async fn scan_view_folder(state: State<'_, Shared>, id: String) -> R<Scan> {
    let o = owner(&state)?;
    let path = db::list_view_folders(&state.db.lock().unwrap(), &o).map_err(e)?.into_iter().find(|f| f.id == id).map(|f| f.path).ok_or("That folder isn't on the list any more.")?;
    if !Path::new(&path).is_dir() { return Err("That folder has been moved or deleted.".into()); }
    let _ = state.app.asset_protocol_scope().allow_directory(&path, true);
    tauri::async_runtime::spawn_blocking(move || {
        let (mut budget, mut truncated) = (MAX_FILES, false);
        let root = scan_dir(Path::new(&path), 0, &mut budget, &mut truncated);
        Scan { root, truncated }
    }).await.map_err(|x| x.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn scratch(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("dorms-vf-{}-{tag}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn a_file_is_a_picture_by_its_ending() {
        assert_eq!(kind_of("a.PNG"), Some("image"));
        assert_eq!(kind_of("a.jpeg"), Some("image"));
        assert_eq!(kind_of("a.gif"), Some("gif"));
        assert_eq!(kind_of("a.MP4"), Some("video"));
        assert_eq!(kind_of("a.svg"), None, "pictures that can carry scripts are left out");
        assert_eq!(kind_of("notes.txt"), None);
        assert_eq!(kind_of("noending"), None);
    }

    #[test]
    fn only_sensible_folders_may_be_added() {
        let root = scratch("check");
        let (data, home_dir, art, hidden) = (root.join("data"), root.join("home"), root.join("home/Pictures/art"), root.join("home/.secret"));
        for d in [&data, &art, &hidden] { fs::create_dir_all(d).unwrap(); }
        fs::write(root.join("file.txt"), b"x").unwrap();
        let ok = |p: &Path| check_folder(&p.to_string_lossy(), &data, Some(&home_dir));
        assert!(ok(&art).is_ok(), "a folder inside the home folder is fine");
        assert!(ok(&root.join("home/Pictures")).is_ok());
        assert!(ok(&home_dir).is_err(), "the whole home folder is too much");
        assert!(ok(&root).is_err(), "so is anything above it");
        assert!(ok(&hidden).is_err(), "a hidden folder is refused");
        assert!(ok(&data).is_err(), "the app's own data folder is refused");
        assert!(ok(&data.join("media")).is_err() || !data.join("media").exists());
        assert!(ok(&root.join("file.txt")).is_err(), "a file is not a folder");
        assert!(ok(&root.join("nope")).is_err());
        assert!(check_folder("relative/path", &data, None).is_err());
        assert!(check_folder("", &data, None).is_err());
        assert!(check_folder("/", &data, None).is_err(), "a drive root is refused");
        assert!(check_folder("/etc", &data, None).is_err(), "system folders are refused");
        assert!(check_folder("/usr/share", &data, None).is_err());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_folder_is_read_into_pictures_and_folders_without_following_links() {
        let root = scratch("scan");
        fs::create_dir_all(root.join("sets/one")).unwrap();
        fs::create_dir_all(root.join("empty")).unwrap();
        fs::create_dir_all(root.join(".hidden")).unwrap();
        fs::write(root.join("b.png"), b"x").unwrap();
        fs::write(root.join("A.jpg"), b"x").unwrap();
        fs::write(root.join("notes.txt"), b"x").unwrap();
        fs::write(root.join("sets/one/c.gif"), b"x").unwrap();
        fs::write(root.join("sets/d.mp4"), b"x").unwrap();
        fs::write(root.join(".hidden/e.png"), b"x").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(root.join("sets"), root.join("link")).unwrap();
        let (mut budget, mut trunc) = (100, false);
        let d = scan_dir(&root, 0, &mut budget, &mut trunc);
        assert_eq!(d.files.iter().map(|f| f.name.as_str()).collect::<Vec<_>>(), vec!["A.jpg", "b.png"], "pictures only, sorted without regard to case");
        assert_eq!(d.dirs.iter().map(|x| x.name.as_str()).collect::<Vec<_>>(), vec!["sets"], "an empty folder, a hidden one and a link are left out");
        assert_eq!(d.total, 4);
        assert_eq!(d.dirs[0].dirs[0].files[0].kind, "gif");
        assert!(!trunc);
        let (mut budget, mut trunc) = (2, false);
        let d = scan_dir(&root, 0, &mut budget, &mut trunc);
        assert!(trunc && d.total <= 2, "a huge folder stops at the limit and says so");
        let _ = fs::remove_dir_all(&root);
    }
}
