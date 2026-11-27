//! Folders on the computer that the person adds to the Gallery, only to look at the pictures in them. Nothing in a folder is ever copied,
//! changed or deleted, and the pictures are not added to any character. The web view may read a folder only while it is on the list.
//! Which folders may be added is decided here, not by the page: never a drive root, the home folder or anything above it, a hidden folder,
//! a system folder, or the app's own data folder (which holds the database and the key file).

use std::path::{Path, PathBuf};

use image::ImageEncoder;
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

/// The longest side of a thumbnail (a tile is about 190 pixels wide; this is sharp on a high-density screen).
const THUMB_SIDE: u32 = 360;

/// A small picture of one picture inside a folder on the list: made once, kept in `media/gallery-thumbs`, and found again by the picture's path,
/// size and date (so a changed picture gets a new one). The Gallery shows these in its grids instead of loading every full-size photo, which is
/// what made a folder of big photos too heavy for the window. Only a picture inside a folder on the list is read; a link that leads out is refused.
pub fn make_thumb(data: &Path, folders: &[db::ViewFolder], path: &str) -> R<String> {
    use sha2::{Digest, Sha256};
    let real = Path::new(path).canonicalize().map_err(|_| "That picture isn't there any more.".to_string())?;
    let inside = folders.iter().any(|f| Path::new(&f.path).canonicalize().map(|r| real.starts_with(r)).unwrap_or(false));
    if !inside { return Err("That picture isn't in a Gallery folder.".into()); }
    let name = real.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    if !matches!(kind_of(&name), Some("image") | Some("gif")) { return Err("There is no small picture for this kind of file.".into()); }
    let meta = std::fs::metadata(&real).map_err(|e| e.to_string())?;
    let stamp = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0);
    let key: String = Sha256::digest(format!("{}|{}|{}", real.display(), meta.len(), stamp).as_bytes()).iter().take(12).map(|b| format!("{b:02x}")).collect();
    let dir = data.join("media").join("gallery-thumbs");
    for ext in ["jpg", "png"] {
        let c = dir.join(format!("{key}.{ext}"));
        if c.is_file() { return Ok(c.to_string_lossy().into_owned()); }
    }
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut reader = image::ImageReader::open(&real).map_err(|e| e.to_string())?.with_guessed_format().map_err(|e| e.to_string())?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(16_384);
    limits.max_image_height = Some(16_384);
    limits.max_alloc = Some(512 * 1024 * 1024);
    reader.limits(limits);
    let img = reader.decode().map_err(|e| format!("That picture can't be read ({e})."))?;
    let small = img.thumbnail(THUMB_SIDE, THUMB_SIDE).to_rgba8();
    let see_through = small.pixels().any(|p| p[3] < 255);
    let (file, bytes) = if see_through {
        let mut out = Vec::new();
        image::codecs::png::PngEncoder::new(&mut out).write_image(small.as_raw(), small.width(), small.height(), image::ExtendedColorType::Rgba8).map_err(|e| e.to_string())?;
        (dir.join(format!("{key}.png")), out)
    } else {
        let rgb = image::DynamicImage::ImageRgba8(small).to_rgb8();
        let mut out = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 82).encode_image(&rgb).map_err(|e| e.to_string())?;
        (dir.join(format!("{key}.jpg")), out)
    };
    std::fs::write(&file, bytes).map_err(|e| e.to_string())?;
    Ok(file.to_string_lossy().into_owned())
}

/// The small picture for one picture in a folder on the list (see `make_thumb`). Done off the main thread.
#[tauri::command]
pub async fn view_thumb(state: State<'_, Shared>, path: String) -> R<String> {
    let o = owner(&state)?;
    let folders = db::list_view_folders(&state.db.lock().unwrap(), &o).map_err(e)?;
    let data = state.data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || make_thumb(&data, &folders, &path)).await.map_err(|x| x.to_string())?
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
    #[test]
    fn a_thumbnail_is_small_kept_and_only_made_for_pictures_in_a_listed_folder() {
        let root = scratch("thumb");
        let (folder, data, other) = (root.join("art"), root.join("data"), root.join("elsewhere"));
        for d in [&folder, &data, &other] { fs::create_dir_all(d).unwrap(); }
        image::RgbaImage::from_fn(2400, 1600, |x, y| image::Rgba([(x % 255) as u8, (y % 255) as u8, 90, 255])).save(folder.join("photo.png")).unwrap();
        image::RgbaImage::from_fn(300, 300, |x, _| image::Rgba([200, 30, 30, if x < 150 { 0 } else { 255 }])).save(folder.join("cutout.png")).unwrap();
        image::RgbaImage::from_pixel(50, 50, image::Rgba([1, 2, 3, 255])).save(other.join("secret.png")).unwrap();
        fs::write(folder.join("notes.txt"), b"x").unwrap();
        fs::write(folder.join("clip.mp4"), b"x").unwrap();
        let folders = vec![db::ViewFolder { id: "f".into(), path: folder.to_string_lossy().into_owned(), added_at: 0 }];
        let t = make_thumb(&data, &folders, &folder.join("photo.png").to_string_lossy()).unwrap();
        assert!(t.ends_with(".jpg") && t.contains("gallery-thumbs"), "an opaque picture gets a small JPEG: {t}");
        let im = image::open(&t).unwrap();
        assert_eq!((im.width(), im.height()), (360, 240), "shrunk to fit 360, keeping its shape");
        assert!(fs::metadata(&t).unwrap().len() < 100_000);
        let again = make_thumb(&data, &folders, &folder.join("photo.png").to_string_lossy()).unwrap();
        assert_eq!(again, t, "made once, found again");
        let cut = make_thumb(&data, &folders, &folder.join("cutout.png").to_string_lossy()).unwrap();
        assert!(cut.ends_with(".png"), "a picture with see-through parts keeps them");
        assert!(make_thumb(&data, &folders, &other.join("secret.png").to_string_lossy()).is_err(), "not in a listed folder");
        assert!(make_thumb(&data, &folders, &folder.join("../elsewhere/secret.png").to_string_lossy()).is_err(), "a path that climbs out is refused");
        assert!(make_thumb(&data, &folders, &folder.join("notes.txt").to_string_lossy()).is_err());
        assert!(make_thumb(&data, &folders, &folder.join("clip.mp4").to_string_lossy()).is_err(), "clips have no thumbnail");
        assert!(make_thumb(&data, &folders, &folder.join("missing.png").to_string_lossy()).is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&other, folder.join("sneaky")).unwrap();
            assert!(make_thumb(&data, &folders, &folder.join("sneaky/secret.png").to_string_lossy()).is_err(), "a link that leads out of the folder is refused");
        }
        let _ = fs::remove_dir_all(&root);
    }

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
