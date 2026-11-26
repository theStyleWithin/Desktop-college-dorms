//! Command-line hand-off: other programs (Sudo Make Art's character card editor, a file manager)
//! start the app with a card to import. This only picks the card paths out of the arguments;
//! reading and importing them is done by the app, after a profile is open.

use std::path::PathBuf;

/// Card files named in the arguments (the first one is the program itself and is skipped).
/// Accepted: `--import-card <file>`, `--import-card=<file>`, or a bare path ending in `.png` or `.json`.
/// Anything else (other flags, other file types) is ignored.
pub fn card_args<S: AsRef<str>>(args: &[S]) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut it = args.iter().skip(1).map(|a| a.as_ref());
    while let Some(a) = it.next() {
        if a == "--import-card" {
            if let Some(p) = it.next() {
                if is_card_path(p) { out.push(PathBuf::from(p)); }
            }
        } else if let Some(p) = a.strip_prefix("--import-card=") {
            if is_card_path(p) { out.push(PathBuf::from(p)); }
        } else if !a.starts_with('-') && is_card_path(a) {
            out.push(PathBuf::from(a));
        }
    }
    out.truncate(20);
    out
}

fn is_card_path(p: &str) -> bool {
    let l = p.to_ascii_lowercase();
    !p.is_empty() && (l.ends_with(".png") || l.ends_with(".json"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flag_form() {
        assert_eq!(card_args(&["dorms", "--import-card", "/a/b.png"]), vec![PathBuf::from("/a/b.png")]);
        assert_eq!(card_args(&["dorms", "--import-card=/a/b.JSON"]), vec![PathBuf::from("/a/b.JSON")]);
    }
    #[test]
    fn bare_path_and_junk() {
        assert_eq!(card_args(&["dorms", "x.png", "--foo", "y.txt", "z.json"]), vec![PathBuf::from("x.png"), PathBuf::from("z.json")]);
        assert!(card_args(&["dorms", "--import-card", "notes.txt"]).is_empty());
        assert!(card_args(&["dorms"]).is_empty());
        assert!(card_args::<&str>(&[]).is_empty());
    }
    #[test]
    fn program_name_is_skipped() {
        assert!(card_args(&["card.png"]).is_empty());
    }
}
