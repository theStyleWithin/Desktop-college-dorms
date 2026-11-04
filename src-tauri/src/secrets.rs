//! API key storage. Uses the OS keychain where one exists; if it is missing or
//! locked (common on minimal Linux setups) or on mobile, falls back to a
//! private file in the app data dir. The UI shows which one is in use.

use std::path::Path;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
const SERVICE: &str = "desktop-college-dorms";

fn file_path(dir: &Path) -> std::path::PathBuf {
    dir.join("secrets.json")
}

fn read_file(dir: &Path) -> serde_json::Map<String, serde_json::Value> {
    std::fs::read_to_string(file_path(dir))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_file(dir: &Path, m: &serde_json::Map<String, serde_json::Value>) -> Result<(), String> {
    let p = file_path(dir);
    std::fs::write(&p, serde_json::to_vec(m).unwrap_or_default()).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// Returns where the key was stored: "keychain" or "file".
pub fn set(dir: &Path, name: &str, value: &str) -> Result<&'static str, String> {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        if let Ok(e) = keyring::Entry::new(SERVICE, name) {
            if e.set_password(value).is_ok() && e.get_password().is_ok() {
                // make sure no stale plaintext copy lingers
                let mut m = read_file(dir);
                if m.remove(name).is_some() {
                    let _ = write_file(dir, &m);
                }
                return Ok("keychain");
            }
        }
    }
    let mut m = read_file(dir);
    m.insert(name.into(), value.into());
    write_file(dir, &m)?;
    Ok("file")
}

pub fn get(dir: &Path, name: &str) -> Option<String> {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        if let Ok(e) = keyring::Entry::new(SERVICE, name) {
            if let Ok(v) = e.get_password() {
                return Some(v);
            }
        }
    }
    read_file(dir).get(name).and_then(|v| v.as_str()).map(String::from)
}

pub fn delete(dir: &Path, name: &str) {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        if let Ok(e) = keyring::Entry::new(SERVICE, name) {
            let _ = e.delete_credential();
        }
    }
    let mut m = read_file(dir);
    if m.remove(name).is_some() {
        let _ = write_file(dir, &m);
    }
}
