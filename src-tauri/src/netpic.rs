//! Fetching a picture from a web address, so a link can be pasted instead of a file being uploaded (the character editor's Avatar).
//! The bytes are handed to the page, which treats them exactly like a file the person chose (framing, saving, the same checks).
//! Only the person's own action reaches this: nothing in a card or a chat can start a fetch.

use base64::Engine as _;
use serde::Serialize;
use std::time::Duration;
use tauri::State;

use crate::Shared;

type R<T> = Result<T, String>;

/// The biggest picture or clip that is fetched (the same room the upload buttons give a file).
const MAX_BYTES: usize = 40 * 1024 * 1024;

#[derive(Serialize)]
pub struct Fetched {
    /// A file name with the right ending (`cat.png`), so the page can tell what it is.
    pub name: String,
    pub mime: String,
    /// The file itself.
    pub data: String,
}

/// What a file is, from its first bytes (a server's own label is often wrong or missing): (ending, mime type).
pub fn sniff(b: &[u8]) -> Option<(&'static str, &'static str)> {
    if b.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) { return Some(("png", "image/png")); }
    if b.starts_with(&[0xff, 0xd8, 0xff]) { return Some(("jpg", "image/jpeg")); }
    if b.starts_with(b"GIF87a") || b.starts_with(b"GIF89a") { return Some(("gif", "image/gif")); }
    if b.len() > 12 && &b[0..4] == b"RIFF" && &b[8..12] == b"WEBP" { return Some(("webp", "image/webp")); }
    if b.len() > 12 && &b[4..8] == b"ftyp" { return Some(("mp4", "video/mp4")); }
    if b.starts_with(&[0x1a, 0x45, 0xdf, 0xa3]) { return Some(("webm", "video/webm")); }
    None
}

/// Only web addresses: `http` or `https`, with a host, and nothing that carries a name and password.
pub fn check_url(raw: &str) -> R<reqwest::Url> {
    let raw = raw.trim();
    if raw.is_empty() { return Err("Paste the address of a picture first.".into()); }
    if raw.len() > 2000 { return Err("That address is too long.".into()); }
    let u = reqwest::Url::parse(raw).map_err(|_| "That doesn't look like a web address. It should start with https://".to_string())?;
    if !matches!(u.scheme(), "http" | "https") { return Err("Only web addresses (https://…) can be used.".into()); }
    if u.host_str().map_or(true, |h| h.is_empty()) { return Err("That address has no website in it.".into()); }
    if !u.username().is_empty() || u.password().is_some() { return Err("Addresses with a name and password in them aren't used.".into()); }
    Ok(u)
}

/// A readable file name from the address (`https://x.com/a/my%20cat.png?w=1` → `my cat`), plain letters, numbers, spaces, dashes and underscores.
pub fn base_name(u: &reqwest::Url) -> String {
    let last = u.path_segments().and_then(|s| s.filter(|x| !x.is_empty()).last()).unwrap_or("picture");
    let decoded = percent_decode(last);
    let stem = decoded.rsplit_once('.').map_or(decoded.as_str(), |(a, _)| a);
    let clean: String = stem.chars().map(|c| if c.is_alphanumeric() || c == ' ' || c == '-' || c == '_' { c } else { '-' }).collect::<String>().trim_matches(|c: char| c == '-' || c == ' ').chars().take(50).collect();
    if clean.is_empty() { "picture".into() } else { clean }
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let hex = |c: u8| (c as char).to_digit(16).map(|d| d as u8);
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let (Some(h), Some(l)) = (hex(b[i + 1]), hex(b[i + 2])) { out.push(h * 16 + l); i += 3; continue; }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Fetches the picture at a web address and hands it to the page as a file.
#[tauri::command]
pub async fn fetch_picture(state: State<'_, Shared>, url: String) -> R<Fetched> {
    let u = check_url(&url)?;
    let mut resp = state.http.get(u.clone()).timeout(Duration::from_secs(60)).header("Accept", "image/*,video/mp4,video/webm,*/*;q=0.5").send().await
        .map_err(|e| if e.is_timeout() { "The site took too long to answer.".to_string() } else { format!("I couldn't reach that address: {}", e.without_url()) })?;
    if !resp.status().is_success() { return Err(format!("The site said no ({}). Check the address, or save the picture and upload it.", resp.status().as_u16())); }
    if resp.content_length().map_or(false, |n| n as usize > MAX_BYTES) { return Err("That file is too big (40 MB at most).".into()); }
    let mut bytes: Vec<u8> = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("The download stopped: {}", e.without_url()))? {
        if bytes.len() + chunk.len() > MAX_BYTES { return Err("That file is too big (40 MB at most).".into()); }
        bytes.extend_from_slice(&chunk);
    }
    let Some((ext, mime)) = sniff(&bytes) else {
        let looks_like_page = bytes.iter().take(300).copied().collect::<Vec<u8>>().windows(5).any(|w| w.eq_ignore_ascii_case(b"<html") || w.eq_ignore_ascii_case(b"<!doc"));
        return Err(if looks_like_page { "That link is a web page, not a picture. Right-click the picture and choose Copy image address (or Copy image link), then paste that.".into() } else { "That isn't a picture or video the app can use (JPG, PNG, WebP, GIF, MP4 or WebM).".into() });
    };
    Ok(Fetched { name: format!("{}.{ext}", base_name(&u)), mime: mime.into(), data: base64::engine::general_purpose::STANDARD.encode(&bytes) })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_file_is_known_by_its_first_bytes() {
        assert_eq!(sniff(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]), Some(("png", "image/png")));
        assert_eq!(sniff(&[0xff, 0xd8, 0xff, 0xe0]), Some(("jpg", "image/jpeg")));
        assert_eq!(sniff(b"GIF89a....").map(|x| x.0), Some("gif"));
        assert_eq!(sniff(b"RIFF\x10\0\0\0WEBPVP8 ").map(|x| x.0), Some("webp"));
        assert_eq!(sniff(b"\0\0\0\x18ftypmp42\0\0\0\0").map(|x| x.0), Some("mp4"));
        assert_eq!(sniff(&[0x1a, 0x45, 0xdf, 0xa3, 1]).map(|x| x.0), Some("webm"));
        assert_eq!(sniff(b"<!DOCTYPE html><html>"), None, "a web page is not a picture");
        assert_eq!(sniff(b"%PDF-1.7"), None);
        assert_eq!(sniff(b""), None);
    }

    #[test]
    fn only_plain_web_addresses_are_used() {
        assert!(check_url("https://example.com/a/cat.png?w=1").is_ok());
        assert!(check_url("  http://example.com/cat.jpg  ").is_ok(), "spaces around it are fine");
        for bad in ["", "   ", "cat.png", "file:///etc/passwd", "ftp://example.com/a.png", "javascript:alert(1)", "data:image/png;base64,AAAA", "https://user:pw@example.com/a.png", "https://"] {
            assert!(check_url(bad).is_err(), "{bad:?} should be refused");
        }
        assert!(check_url(&format!("https://example.com/{}", "a".repeat(2100))).is_err(), "far too long");
    }

    #[test]
    fn the_file_name_comes_from_the_address() {
        let n = |s: &str| base_name(&reqwest::Url::parse(s).unwrap());
        assert_eq!(n("https://x.com/a/my%20cat.png?w=1#top"), "my cat");
        assert_eq!(n("https://x.com/"), "picture");
        assert_eq!(n("https://x.com/caf%C3%A9%2"), "café-2", "a broken or multi-byte escape never panics, and the odd sign is replaced");
        assert_eq!(n("https://x.com/a/b/"), "b");
        assert_eq!(n("https://x.com/%2e%2e%2f..%2fevil.png"), "evil", "no folders, no dots");
        assert!(!n("https://x.com/a<b>c|d.png").contains(['<', '>', '|']));
        assert!(n(&format!("https://x.com/{}.png", "n".repeat(300))).chars().count() <= 50);
    }
}
