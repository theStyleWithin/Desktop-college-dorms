//! "Add to Steam": puts this app in the person's Steam library as a non-Steam game, by adding a shortcut to Steam's own list of them
//! (`userdata/<id>/config/shortcuts.vdf`). Nothing else of Steam's is touched. Steam rewrites that file when it closes, so the app only does this while
//! Steam is not running (and says so), and it keeps a copy of the original file the first time it changes it. Desktop only.

use serde::Serialize;
use std::path::{Path, PathBuf};

type R<T> = Result<T, String>;

/// The name the shortcut has in Steam.
const NAME: &str = "Desktop College Dorms";

// ---- Steam's binary list of shortcuts (a tree of named values) ----

#[derive(Debug, Clone, PartialEq)]
pub enum Val { Map(Vec<(String, Val)>), Str(String), Int(u32) }

fn cstr(b: &[u8], i: &mut usize) -> R<String> {
    let start = *i;
    while *i < b.len() && b[*i] != 0 { *i += 1; }
    if *i >= b.len() { return Err("Steam's shortcut list ends in the middle of a word.".into()); }
    let s = String::from_utf8_lossy(&b[start..*i]).into_owned();
    *i += 1;
    Ok(s)
}

/// Reads a group of values up to its end marker.
fn parse_map(b: &[u8], i: &mut usize, depth: usize) -> R<Vec<(String, Val)>> {
    if depth > 8 { return Err("Steam's shortcut list is nested too deeply.".into()); }
    let mut out = Vec::new();
    loop {
        let t = *b.get(*i).ok_or("Steam's shortcut list ends too soon.")?;
        *i += 1;
        match t {
            0x08 => return Ok(out),
            0x00 => { let k = cstr(b, i)?; out.push((k, Val::Map(parse_map(b, i, depth + 1)?))); }
            0x01 => { let k = cstr(b, i)?; let v = cstr(b, i)?; out.push((k, Val::Str(v))); }
            0x02 => {
                let k = cstr(b, i)?;
                let raw = b.get(*i..*i + 4).ok_or("Steam's shortcut list ends too soon.")?;
                *i += 4;
                out.push((k, Val::Int(u32::from_le_bytes([raw[0], raw[1], raw[2], raw[3]]))));
            }
            _ => return Err("Steam's shortcut list has something this app doesn't know, so it was left alone.".into()),
        }
    }
}

pub fn parse(bytes: &[u8]) -> R<Vec<(String, Val)>> {
    let mut i = 0;
    let root = parse_map(bytes, &mut i, 0)?;
    if i != bytes.len() { return Err("Steam's shortcut list has extra bytes after its end, so it was left alone.".into()); }
    Ok(root)
}

fn write_map(m: &[(String, Val)], out: &mut Vec<u8>) {
    for (k, v) in m {
        match v {
            Val::Map(inner) => { out.push(0x00); out.extend_from_slice(k.as_bytes()); out.push(0); write_map(inner, out); }
            Val::Str(s) => { out.push(0x01); out.extend_from_slice(k.as_bytes()); out.push(0); out.extend_from_slice(s.as_bytes()); out.push(0); }
            Val::Int(n) => { out.push(0x02); out.extend_from_slice(k.as_bytes()); out.push(0); out.extend_from_slice(&n.to_le_bytes()); }
        }
    }
    out.push(0x08);
}

pub fn serialize(root: &[(String, Val)]) -> Vec<u8> { let mut out = Vec::new(); write_map(root, &mut out); out }

fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for &b in data {
        crc ^= b as u32;
        for _ in 0..8 { crc = if crc & 1 != 0 { (crc >> 1) ^ 0xEDB8_8320 } else { crc >> 1 }; }
    }
    !crc
}

/// The number Steam gives a non-Steam shortcut: a checksum of its program and name, with the top bit set.
pub fn shortcut_id(exe_quoted: &str, name: &str) -> u32 { crc32(format!("{exe_quoted}{name}").as_bytes()) | 0x8000_0000 }

fn entry(exe: &str, start_dir: &str, options: &str) -> Val {
    let exe_q = format!("\"{exe}\"");
    let s = |v: &str| Val::Str(v.to_string());
    Val::Map(vec![
        ("appid".into(), Val::Int(shortcut_id(&exe_q, NAME))),
        ("AppName".into(), s(NAME)),
        ("Exe".into(), s(&exe_q)),
        ("StartDir".into(), s(&format!("\"{start_dir}\""))),
        ("icon".into(), s("")),
        ("ShortcutPath".into(), s("")),
        ("LaunchOptions".into(), s(options)),
        ("IsHidden".into(), Val::Int(0)),
        ("AllowDesktopConfig".into(), Val::Int(1)),
        ("AllowOverlay".into(), Val::Int(1)),
        ("OpenVR".into(), Val::Int(0)),
        ("Devkit".into(), Val::Int(0)),
        ("DevkitGameID".into(), s("")),
        ("DevkitOverrideAppID".into(), Val::Int(0)),
        ("LastPlayTime".into(), Val::Int(0)),
        ("FlatpakAppID".into(), s("")),
        ("tags".into(), Val::Map(vec![])),
    ])
}

fn is_ours(v: &Val) -> bool {
    matches!(v, Val::Map(m) if m.iter().any(|(k, x)| k.eq_ignore_ascii_case("appname") && matches!(x, Val::Str(s) if s == NAME)))
}

fn shortcuts_mut(root: &mut Vec<(String, Val)>) -> &mut Vec<(String, Val)> {
    if !root.iter().any(|(k, _)| k.eq_ignore_ascii_case("shortcuts")) { root.push(("shortcuts".into(), Val::Map(vec![]))); }
    match root.iter_mut().find(|(k, _)| k.eq_ignore_ascii_case("shortcuts")).map(|(_, v)| v) {
        Some(Val::Map(m)) => m,
        _ => unreachable!("just made sure it is a group"),
    }
}

fn renumber(list: &mut [(String, Val)]) { for (i, e) in list.iter_mut().enumerate() { e.0 = i.to_string(); } }

/// Adds this app's shortcut (or brings an existing one up to date), keeping every other shortcut as it is. Returns true if it was already there.
pub fn add_entry(root: &mut Vec<(String, Val)>, exe: &str, start_dir: &str, options: &str) -> bool {
    let list = shortcuts_mut(root);
    let new = entry(exe, start_dir, options);
    if let Some(slot) = list.iter_mut().find(|(_, v)| is_ours(v)) { slot.1 = new; return true; }
    list.push((list.len().to_string(), new));
    renumber(list);
    false
}

/// Takes this app's shortcut out (others stay). Returns how many were removed.
pub fn remove_entry(root: &mut Vec<(String, Val)>) -> usize {
    let list = shortcuts_mut(root);
    let before = list.len();
    list.retain(|(_, v)| !is_ours(v));
    renumber(list);
    before - list.len()
}

pub fn has_entry(root: &[(String, Val)]) -> bool {
    root.iter().find(|(k, _)| k.eq_ignore_ascii_case("shortcuts")).map_or(false, |(_, v)| matches!(v, Val::Map(m) if m.iter().any(|(_, e)| is_ours(e))))
}

// ---- finding Steam ----

fn steam_dirs() -> Vec<PathBuf> {
    if let Some(p) = std::env::var_os("DORMS_STEAM_DIR") { return vec![PathBuf::from(p)]; }   // for tests
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from);
    let mut v: Vec<PathBuf> = Vec::new();
    if cfg!(target_os = "windows") {
        for var in ["ProgramFiles(x86)", "ProgramFiles"] { if let Some(p) = std::env::var_os(var) { v.push(PathBuf::from(p).join("Steam")); } }
        v.push(PathBuf::from(r"C:\Program Files (x86)\Steam"));
    } else if cfg!(target_os = "macos") {
        if let Some(h) = &home { v.push(h.join("Library/Application Support/Steam")); }
    } else if let Some(h) = &home {
        v.push(h.join(".local/share/Steam"));
        v.push(h.join(".steam/steam"));
        v.push(h.join(".var/app/com.valvesoftware.Steam/.local/share/Steam"));
    }
    v
}

fn find_steam() -> Option<PathBuf> { steam_dirs().into_iter().find(|d| d.join("userdata").is_dir()) }

/// The Steam accounts that have logged in on this computer: (account number, name if known).
fn steam_users(steam: &Path) -> Vec<(String, String)> {
    let names = std::fs::read_to_string(steam.join("config/loginusers.vdf")).map(|t| login_names(&t)).unwrap_or_default();
    let mut out: Vec<(String, String)> = std::fs::read_dir(steam.join("userdata")).map(|r| r.filter_map(|e| e.ok()).filter_map(|e| {
        let n = e.file_name().to_string_lossy().into_owned();
        (e.path().is_dir() && n.chars().all(|c| c.is_ascii_digit()) && n != "0" && !n.is_empty()).then(|| { let name = names.iter().find(|(id, _)| *id == n).map(|(_, x)| x.clone()).unwrap_or_default(); (n, name) })
    }).collect()).unwrap_or_default();
    out.sort();
    out
}

/// Names from Steam's list of accounts (a text file): (account number, display name).
pub fn login_names(text: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut id64: Option<u64> = None;
    for line in text.lines() {
        let parts: Vec<&str> = line.split('"').collect();
        // a line like:  "76561198000000000"   (the start of an account's block)
        if parts.len() >= 2 && parts.iter().skip(2).all(|p| p.trim().is_empty()) && parts[1].len() == 17 && parts[1].chars().all(|c| c.is_ascii_digit()) { id64 = parts[1].parse().ok(); continue; }
        if parts.len() >= 4 && parts[1] == "PersonaName" {
            if let Some(id) = id64.take() { out.push(((id.saturating_sub(76_561_197_960_265_728)).to_string(), parts[3].to_string())); }
        }
    }
    out
}

fn steam_running() -> Option<bool> {
    if std::env::var_os("DORMS_STEAM_DIR").is_some() { return Some(std::env::var_os("DORMS_STEAM_RUNNING").is_some()); }   // for tests
    use std::process::{Command, Stdio};
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let out = Command::new("tasklist").args(["/FI", "IMAGENAME eq steam.exe", "/NH"]).creation_flags(0x0800_0000).stderr(Stdio::null()).output().ok()?;
        return Some(String::from_utf8_lossy(&out.stdout).to_lowercase().contains("steam.exe"));
    }
    #[cfg(not(target_os = "windows"))]
    {
        let name = if cfg!(target_os = "macos") { "steam_osx" } else { "steam" };
        let st = Command::new("pgrep").args(["-x", name]).stdout(Stdio::null()).stderr(Stdio::null()).status().ok()?;
        Some(st.success())
    }
}

/// What Steam should launch: (program, folder to start in, launch options).
fn launcher() -> R<(String, String, String)> {
    if let Ok(id) = std::env::var("FLATPAK_ID") {
        if !id.is_empty() { return Ok(("/usr/bin/flatpak".into(), "/usr/bin".into(), format!("run {id}"))); }
    }
    let exe = std::env::var_os("APPIMAGE").map(PathBuf::from).filter(|p| p.is_file()).or_else(|| std::env::current_exe().ok()).ok_or("I couldn't find out where this app is.")?;
    let dir = exe.parent().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
    Ok((exe.to_string_lossy().into_owned(), dir, String::new()))
}

#[derive(Serialize)]
pub struct SteamUser { pub id: String, pub name: String, pub added: bool }

#[derive(Serialize)]
pub struct SteamStatus {
    /// False on a phone.
    pub supported: bool,
    /// Whether Steam is installed here (and has been logged into).
    pub found: bool,
    /// Whether Steam is running now (None: couldn't tell).
    pub running: Option<bool>,
    pub users: Vec<SteamUser>,
    /// What Steam would launch.
    pub exe: String,
}

fn shortcuts_path(steam: &Path, user: &str) -> PathBuf { steam.join("userdata").join(user).join("config").join("shortcuts.vdf") }

fn read_root(path: &Path) -> R<Vec<(String, Val)>> {
    match std::fs::read(path) {
        Ok(b) if b.is_empty() => Ok(vec![]),
        Ok(b) => parse(&b),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(vec![]),
        Err(e) => Err(format!("I couldn't read Steam's shortcut list: {e}")),
    }
}

/// Where this app stands with Steam: found, which accounts, and whether it is already in each one's library.
#[tauri::command]
pub fn steam_status() -> SteamStatus {
    if cfg!(target_os = "android") { return SteamStatus { supported: false, found: false, running: None, users: vec![], exe: String::new() }; }
    let exe = launcher().map(|l| l.0).unwrap_or_default();
    let Some(steam) = find_steam() else { return SteamStatus { supported: true, found: false, running: steam_running(), users: vec![], exe }; };
    let users = steam_users(&steam).into_iter().map(|(id, name)| {
        let added = read_root(&shortcuts_path(&steam, &id)).map(|r| has_entry(&r)).unwrap_or(false);
        SteamUser { id, name, added }
    }).collect();
    SteamStatus { supported: true, found: true, running: steam_running(), users, exe }
}

fn change(user: &str, add: bool) -> R<String> {
    if cfg!(target_os = "android") { return Err("Steam isn't on phones.".into()); }
    let steam = find_steam().ok_or("I couldn't find Steam on this computer.")?;
    if !steam_users(&steam).iter().any(|(id, _)| id == user) { return Err("That isn't a Steam account on this computer.".into()); }
    if steam_running() == Some(true) { return Err("Steam is running. Close it completely first (right-click its icon and choose Exit), then try again: it would undo the change when it closes.".into()); }
    let path = shortcuts_path(&steam, user);
    let mut root = read_root(&path)?;
    let msg = if add {
        let (exe, dir, opts) = launcher()?;
        if add_entry(&mut root, &exe, &dir, &opts) { "Updated the Steam shortcut. Start Steam and look in your Library for Desktop College Dorms." } else { "Added to Steam. Start Steam and look in your Library for Desktop College Dorms." }
    } else if remove_entry(&mut root) > 0 { "Taken out of Steam." } else { return Ok("It wasn't in Steam.".into()) };
    if let Some(dir) = path.parent() { std::fs::create_dir_all(dir).map_err(|e| format!("I couldn't make Steam's folder: {e}"))?; }
    // keep the original the first time
    if path.is_file() {
        let bak = path.with_extension("vdf.dorms-backup");
        if !bak.exists() { std::fs::copy(&path, &bak).map_err(|e| format!("I couldn't back up Steam's shortcut list first, so I changed nothing: {e}"))?; }
    }
    let tmp = path.with_extension("vdf.dorms-tmp");
    std::fs::write(&tmp, serialize(&root)).map_err(|e| format!("I couldn't write Steam's shortcut list: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("I couldn't save Steam's shortcut list: {e}"))?;
    Ok(msg.into())
}

/// Adds this app to a Steam account's library (a non-Steam game).
#[tauri::command]
pub fn steam_add(user: String) -> R<String> { change(&user, true) }

/// Takes this app out of a Steam account's library again.
#[tauri::command]
pub fn steam_remove(user: String) -> R<String> { change(&user, false) }

#[cfg(test)]
mod tests {
    use super::*;

    fn other() -> Val { Val::Map(vec![("appid".into(), Val::Int(5)), ("AppName".into(), Val::Str("Other Game".into())), ("Exe".into(), Val::Str("\"/games/other\"".into())), ("tags".into(), Val::Map(vec![("0".into(), Val::Str("fun".into()))]))]) }

    #[test]
    fn a_shortcut_list_round_trips_byte_for_byte() {
        let root = vec![("shortcuts".to_string(), Val::Map(vec![("0".into(), other())]))];
        let bytes = serialize(&root);
        assert_eq!(&bytes[..11], b"\x00shortcuts\x00");
        assert_eq!(*bytes.last().unwrap(), 0x08);
        assert_eq!(parse(&bytes).unwrap(), root);
        assert_eq!(serialize(&parse(&bytes).unwrap()), bytes);
    }

    #[test]
    fn adding_keeps_other_shortcuts_and_is_not_done_twice() {
        let mut root = vec![("shortcuts".to_string(), Val::Map(vec![("0".into(), other())]))];
        assert!(!add_entry(&mut root, "/apps/dorms", "/apps", ""));
        assert!(has_entry(&root));
        assert!(add_entry(&mut root, "/apps/dorms2", "/apps", "run x"), "the second time it is an update");
        let Val::Map(list) = &root[0].1 else { panic!() };
        assert_eq!(list.len(), 2, "one other game and one of ours, not two of ours");
        assert_eq!(list[0].0, "0");
        assert_eq!(list[0].1, other(), "the other game is untouched");
        let Val::Map(ours) = &list[1].1 else { panic!() };
        assert!(ours.iter().any(|(k, v)| k == "Exe" && *v == Val::Str("\"/apps/dorms2\"".into())));
        assert!(ours.iter().any(|(k, v)| k == "LaunchOptions" && *v == Val::Str("run x".into())));
        assert_eq!(remove_entry(&mut root), 1);
        assert!(!has_entry(&root));
        let Val::Map(left) = &root[0].1 else { panic!() };
        assert_eq!(left.len(), 1);
        assert_eq!(remove_entry(&mut root), 0);
    }

    #[test]
    fn an_empty_or_new_file_gets_a_list_made() {
        let mut root: Vec<(String, Val)> = vec![];
        add_entry(&mut root, "/apps/dorms", "/apps", "");
        assert!(has_entry(&root));
        assert!(parse(&serialize(&root)).is_ok());
    }

    #[test]
    fn a_file_that_isnt_understood_is_refused_not_overwritten() {
        assert!(parse(b"\x07nonsense").is_err());
        assert!(parse(b"\x00shortcuts\x00").is_err(), "cut off");
        let mut ok = serialize(&vec![("shortcuts".to_string(), Val::Map(vec![]))]);
        ok.push(0);
        assert!(parse(&ok).is_err(), "extra bytes after the end");
    }

    #[test]
    fn the_shortcut_number_has_the_top_bit_and_depends_on_program_and_name() {
        let a = shortcut_id("\"/a\"", NAME);
        assert!(a & 0x8000_0000 != 0);
        assert_ne!(a, shortcut_id("\"/b\"", NAME));
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926, "the standard checksum test value");
    }

    #[test]
    fn account_names_are_read_from_steams_list() {
        let t = "\"users\"\n{\n\t\"76561198000000001\"\n\t{\n\t\t\"AccountName\"\t\t\"bob\"\n\t\t\"PersonaName\"\t\t\"Bobby\"\n\t}\n}\n";
        assert_eq!(login_names(t), vec![("39734273".to_string(), "Bobby".to_string())]);
    }
}
