//! "Can this phone run a built-in model?": what the phone has (memory, free storage, a 64-bit ARM processor) against what each model needs.
//! This only gives the answer. A download is offered only for a model the phone can run AND only once the app has an engine for phones, so a phone
//! that cannot run a model, or any phone before the engine exists, gets a plain explanation and no download button.

use std::path::Path;

use serde::Serialize;

use crate::llama::PRESETS;

/// Models offered on a phone: (preset id, phone memory needed in GB, whether to warn). Phones report a bit less than the number on the box, so a small
/// allowance is added to what is read (`RAM_ALLOWANCE_GB`). These start as guesses to be confirmed on real phones.
const RULES: [(&str, f32, bool); 3] = [("llama-3.2-1b", 6.0, false), ("llama-3.2-3b", 8.0, false), ("qwen-2.5-7b", 16.0, true)];
const RAM_ALLOWANCE_GB: f32 = 1.0;
/// Free storage wanted on top of the model file.
const SPARE_GB: f32 = 1.0;

#[derive(Serialize, Clone, Debug)]
pub struct PhoneOption {
    pub id: String,
    pub label: String,
    pub size_gb: f32,
    pub min_ram_gb: f32,
    pub fits: bool,
    /// Why not (when it does not fit), or a caution (when it does but is a stretch).
    pub note: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
pub struct PhoneCheck {
    pub is_android: bool,
    pub arm64: bool,
    pub ram_gb: f32,
    pub free_gb: Option<f32>,
    pub options: Vec<PhoneOption>,
    /// The phone could run at least one model.
    pub can_run_any: bool,
    /// The app has an engine for this device yet.
    pub engine_ready: bool,
    /// Show a download button: only for a phone that can run a model, and only once there is an engine.
    pub download_allowed: bool,
    pub summary: String,
}

fn gb(x: f32) -> String {
    if x >= 10.0 { format!("{x:.0} GB") } else { format!("{x:.1} GB") }
}

pub fn check(is_android: bool, arm64: bool, ram_gb: f32, free_gb: Option<f32>, engine_ready: bool) -> PhoneCheck {
    let options: Vec<PhoneOption> = RULES.iter().filter_map(|(id, need_ram, warn)| {
        let p = PRESETS.iter().find(|p| p.id == *id)?;
        let need_free = p.size_gb + SPARE_GB;
        let note = if !arm64 { Some("It needs a 64-bit ARM processor, which this phone doesn't have.".to_string()) }
            else if ram_gb + RAM_ALLOWANCE_GB < *need_ram { Some(format!("It needs about {} of memory and this phone has about {}.", gb(*need_ram), gb(ram_gb))) }
            else if free_gb.map(|f| f < need_free).unwrap_or(false) { Some(format!("It needs about {} of free storage (the file plus some spare) and this phone has about {} free.", gb(need_free), gb(free_gb.unwrap_or(0.0)))) }
            else if *warn { Some("This one is a stretch for a phone: it may be slow, get the phone hot and drain the battery quickly.".to_string()) }
            else { None };
        let fits = arm64 && ram_gb + RAM_ALLOWANCE_GB >= *need_ram && free_gb.map(|f| f >= need_free).unwrap_or(true);
        Some(PhoneOption { id: p.id.to_string(), label: p.label.to_string(), size_gb: p.size_gb, min_ram_gb: *need_ram, fits, note })
    }).collect();
    let can_run_any = options.iter().any(|o| o.fits);
    let best = options.iter().rev().find(|o| o.fits && !o.note.is_some()).or_else(|| options.iter().rev().find(|o| o.fits));
    let summary = if !arm64 {
        "This phone's processor isn't a 64-bit ARM one, which the built-in model needs, so it can't run one. Use a cloud provider, or a model on your home network.".to_string()
    } else if !can_run_any {
        let smallest = &options[0];
        let why = if ram_gb + RAM_ALLOWANCE_GB < smallest.min_ram_gb {
            format!("This phone has about {} of memory. The smallest built-in model needs about {}, so it would run out of memory or be far too slow.", gb(ram_gb), gb(smallest.min_ram_gb))
        } else {
            format!("This phone has about {} of free storage and the smallest built-in model needs about {} (the file plus some spare).", gb(free_gb.unwrap_or(0.0)), gb(smallest.size_gb + SPARE_GB))
        };
        format!("{why} Use a cloud provider, or a model on your home network.")
    } else {
        let b = best.map(|b| b.label.clone()).unwrap_or_default();
        let tail = if engine_ready { "" } else { " The built-in engine for phones isn't ready yet, so there is nothing to download yet." };
        format!("This phone (about {} of memory) could run a built-in model; the best fit is {b}.{tail}", gb(ram_gb))
    };
    PhoneCheck { is_android, arm64, ram_gb, free_gb, options, can_run_any, engine_ready, download_allowed: can_run_any && engine_ready, summary }
}

/// Free space, in GB, on the disk that holds `path` (the longest matching mount point). `None` when it cannot be read.
pub fn free_gb(path: &Path) -> Option<f32> {
    let disks = sysinfo::Disks::new_with_refreshed_list();
    let p = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    disks.list().iter().filter(|d| p.starts_with(d.mount_point())).max_by_key(|d| d.mount_point().as_os_str().len()).map(|d| d.available_space() as f32 / 1_073_741_824.0)
}

#[tauri::command]
pub fn phone_check(state: tauri::State<'_, crate::Shared>) -> PhoneCheck {
    let mut sys = sysinfo::System::new();
    sys.refresh_memory();
    check(cfg!(target_os = "android"), cfg!(target_arch = "aarch64"), sys.total_memory() as f32 / 1_073_741_824.0, free_gb(&state.data_dir), crate::llama::engine_supported())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fits(c: &PhoneCheck) -> Vec<&str> { c.options.iter().filter(|o| o.fits).map(|o| o.id.as_str()).collect() }

    #[test]
    fn a_weak_phone_gets_an_explanation_and_never_a_download() {
        let c = check(true, true, 4.0, Some(30.0), true);
        assert!(fits(&c).is_empty() && !c.can_run_any && !c.download_allowed, "even with an engine, a phone that can't run one gets no download");
        assert!(c.summary.contains("about 4.0 GB of memory") && c.summary.contains("6.0 GB") && c.summary.contains("cloud provider"), "{}", c.summary);
        assert!(c.options.iter().all(|o| o.note.as_deref().unwrap_or("").contains("memory")));
    }

    #[test]
    fn what_a_phone_can_run_follows_its_memory() {
        // phones read a little less than the number on the box: a 6, 8, 12 and 16 GB phone read about 5.5, 7.3, 11 and 15
        assert_eq!(fits(&check(true, true, 5.5, Some(30.0), true)), vec!["llama-3.2-1b"]);
        assert_eq!(fits(&check(true, true, 7.3, Some(30.0), true)), vec!["llama-3.2-1b", "llama-3.2-3b"]);
        assert_eq!(fits(&check(true, true, 11.0, Some(30.0), true)), vec!["llama-3.2-1b", "llama-3.2-3b"]);
        let big = check(true, true, 15.0, Some(30.0), true);
        assert_eq!(fits(&big), vec!["llama-3.2-1b", "llama-3.2-3b", "qwen-2.5-7b"]);
        assert!(big.options[2].note.as_deref().unwrap().contains("stretch") && big.options[0].note.is_none());
        assert!(big.summary.contains("best fit is Llama 3.2 3B"), "a stretch model is not called the best fit: {}", big.summary);
    }

    #[test]
    fn storage_and_the_processor_count_too() {
        let low = check(true, true, 11.0, Some(1.5), true);
        assert!(!low.can_run_any && low.summary.contains("free storage") && low.options[0].note.as_deref().unwrap().contains("free storage"), "{}", low.summary);
        assert_eq!(fits(&check(true, true, 7.3, Some(2.9), true)), vec!["llama-3.2-1b"], "2.9 GB free fits the small file (0.8 + 1) but not the bigger one (2.0 + 1)");
        assert_eq!(fits(&check(true, true, 7.3, Some(3.0), true)).len(), 2, "exactly enough fits");
        assert_eq!(fits(&check(true, true, 7.3, None, true)).len(), 2, "unknown free space does not rule a model out");
        let old = check(true, false, 12.0, Some(50.0), true);
        assert!(!old.can_run_any && old.summary.contains("64-bit"), "{}", old.summary);
    }

    #[test]
    fn nothing_is_offered_for_download_until_there_is_an_engine() {
        let c = check(true, true, 11.0, Some(30.0), false);
        assert!(c.can_run_any && !c.download_allowed && c.summary.contains("isn't ready yet"), "{}", c.summary);
        assert!(check(true, true, 11.0, Some(30.0), true).download_allowed);
    }

    /// Prints the answer for a few example phones (`cargo test phone -- --ignored --nocapture`), for pictures and the docs.
    #[test]
    #[ignore]
    fn print_samples() {
        for (name, ram, free) in [("weak", 3.6, 20.0), ("mid", 7.3, 40.0), ("strong", 15.0, 120.0)] {
            println!("SAMPLE {name} {}", serde_json::to_string(&check(true, true, ram, Some(free), false)).unwrap());
        }
    }

    #[test]
    fn free_space_can_be_read_here() {
        assert!(free_gb(&std::env::temp_dir()).map(|g| g > 0.0).unwrap_or(false));
    }
}
