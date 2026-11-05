//! The bundled llama.cpp engine: locating and launching `llama-server`,
//! managing GGUF model files, and picking a model that fits the machine.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use futures_util::StreamExt;
use serde::Serialize;
use tauri::Emitter;
use tokio::io::AsyncWriteExt;
use tokio::process::{Child, Command};

use crate::AppState;

#[derive(Default)]
pub struct LlamaState {
    child: Option<Child>,
    pub port: u16,
    model: String,
    ctx: usize,
    gpu: bool,
    pub backend: String,
    /// Context window the engine actually allocated (a model's training
    /// context can be smaller than what we asked for).
    pub n_ctx: usize,
}

#[derive(Serialize, Clone)]
pub struct Preset {
    pub id: &'static str,
    pub label: &'static str,
    pub blurb: &'static str,
    pub file: &'static str,
    pub url: &'static str,
    pub size_gb: f32,
    pub min_ram_gb: u64,
}

pub const PRESETS: &[Preset] = &[
    Preset {
        id: "llama-3.2-1b",
        label: "Llama 3.2 1B",
        blurb: "Tiny and quick. Good for older laptops and a first try.",
        file: "Llama-3.2-1B-Instruct-Q4_K_M.gguf",
        url: "https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF/resolve/main/Llama-3.2-1B-Instruct-Q4_K_M.gguf",
        size_gb: 0.8,
        min_ram_gb: 4,
    },
    Preset {
        id: "llama-3.2-3b",
        label: "Llama 3.2 3B",
        blurb: "Balanced for most laptops and the Steam Deck.",
        file: "Llama-3.2-3B-Instruct-Q4_K_M.gguf",
        url: "https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF/resolve/main/Llama-3.2-3B-Instruct-Q4_K_M.gguf",
        size_gb: 2.0,
        min_ram_gb: 6,
    },
    Preset {
        id: "qwen-2.5-7b",
        label: "Qwen 2.5 7B",
        blurb: "Noticeably smarter replies. Best with 20 GB+ of memory or a graphics card.",
        file: "Qwen2.5-7B-Instruct-Q4_K_M.gguf",
        url: "https://huggingface.co/bartowski/Qwen2.5-7B-Instruct-GGUF/resolve/main/Qwen2.5-7B-Instruct-Q4_K_M.gguf",
        size_gb: 4.7,
        min_ram_gb: 20,
    },
    Preset {
        id: "mistral-nemo-12b",
        label: "Mistral Nemo 12B",
        blurb: "Best writing of the set; needs a strong PC (28 GB+) or a graphics card.",
        file: "Mistral-Nemo-Instruct-2407-Q4_K_M.gguf",
        url: "https://huggingface.co/bartowski/Mistral-Nemo-Instruct-2407-GGUF/resolve/main/Mistral-Nemo-Instruct-2407-Q4_K_M.gguf",
        size_gb: 7.5,
        min_ram_gb: 28,
    },
];

#[derive(Serialize)]
pub struct Hardware {
    pub total_ram_gb: f32,
    pub recommended: &'static str,
    pub presets: &'static [Preset],
    pub engine_available: bool,
}

pub fn hardware() -> Hardware {
    let mut sys = sysinfo::System::new();
    sys.refresh_memory();
    let ram_gb = sys.total_memory() as f32 / 1_073_741_824.0;
    let rec = PRESETS
        .iter()
        .rev()
        .find(|p| ram_gb >= p.min_ram_gb as f32)
        .unwrap_or(&PRESETS[0]);
    Hardware { total_ram_gb: ram_gb, recommended: rec.id, presets: PRESETS, engine_available: engine_supported() }
}

pub fn engine_supported() -> bool {
    !cfg!(any(target_os = "android", target_os = "ios"))
}

#[derive(Serialize)]
pub struct ModelFile {
    pub file: String,
    pub size: u64,
}

pub fn models_dir(data: &Path) -> PathBuf {
    data.join("models")
}

pub fn list_models(data: &Path) -> Vec<ModelFile> {
    let mut out = vec![];
    if let Ok(rd) = std::fs::read_dir(models_dir(data)) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if name.to_lowercase().ends_with(".gguf") {
                out.push(ModelFile { file: name, size: e.metadata().map(|m| m.len()).unwrap_or(0) });
            }
        }
    }
    out.sort_by(|a, b| a.file.cmp(&b.file));
    out
}

fn safe_file_name(name: &str) -> Result<String, String> {
    let n = Path::new(name).file_name().and_then(|n| n.to_str()).unwrap_or("");
    if n.is_empty() || n.starts_with('.') || !n.to_lowercase().ends_with(".gguf") {
        return Err("Model files must end in .gguf".into());
    }
    Ok(n.to_string())
}

pub fn delete_model(data: &Path, file: &str) -> Result<(), String> {
    let f = safe_file_name(file)?;
    std::fs::remove_file(models_dir(data).join(f)).map_err(|e| e.to_string())
}

#[derive(Serialize, Clone)]
struct Progress<'a> {
    file: &'a str,
    downloaded: u64,
    total: u64,
    done: bool,
    error: Option<String>,
}

/// Download a model with resume support. Emits `dorms://model-progress`.
pub async fn download_model(st: &AppState, url: &str, file: &str, cancel: &tokio::sync::Notify) -> Result<(), String> {
    let file = safe_file_name(file)?;
    if !url.starts_with("https://") {
        return Err("Model downloads must use https://".into());
    }
    let dir = models_dir(&st.data_dir);
    tokio::fs::create_dir_all(&dir).await.map_err(|e| e.to_string())?;
    let final_path = dir.join(&file);
    let part = dir.join(format!("{file}.part"));

    let have = tokio::fs::metadata(&part).await.map(|m| m.len()).unwrap_or(0);
    let mut req = st.http.get(url);
    if have > 0 {
        req = req.header("Range", format!("bytes={have}-"));
    }
    let resp = req.send().await.map_err(|e| format!("Download failed: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("Download failed: server answered {status}"));
    }
    let resumed = status.as_u16() == 206;
    let mut downloaded = if resumed { have } else { 0 };
    let total = resp.content_length().map(|l| l + downloaded).unwrap_or(0);

    let mut f = tokio::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(resumed)
        .truncate(!resumed)
        .open(&part)
        .await
        .map_err(|e| e.to_string())?;

    let notified = cancel.notified();
    tokio::pin!(notified);
    let mut stream = resp.bytes_stream();
    let mut last_emit = std::time::Instant::now();
    loop {
        tokio::select! {
            _ = &mut notified => {
                let _ = f.flush().await;
                return Err("Download cancelled (progress kept, you can resume)".into());
            }
            chunk = stream.next() => {
                let Some(chunk) = chunk else { break };
                let chunk = chunk.map_err(|e| format!("Download interrupted: {e}"))?;
                f.write_all(&chunk).await.map_err(|e| e.to_string())?;
                downloaded += chunk.len() as u64;
                if last_emit.elapsed() > Duration::from_millis(250) {
                    last_emit = std::time::Instant::now();
                    let _ = st.app.emit("dorms://model-progress", Progress { file: &file, downloaded, total, done: false, error: None });
                }
            }
        }
    }
    f.flush().await.map_err(|e| e.to_string())?;
    drop(f);
    tokio::fs::rename(&part, &final_path).await.map_err(|e| e.to_string())?;
    let _ = st.app.emit("dorms://model-progress", Progress { file: &file, downloaded, total: downloaded, done: true, error: None });
    Ok(())
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

#[cfg(feature = "embed-llama")]
static EMBEDDED_CPU: &[u8] = include_bytes!(env!("DORMS_LLAMA_EMBED"));
#[cfg(feature = "embed-llama-vulkan")]
static EMBEDDED_VULKAN: &[u8] = include_bytes!(env!("DORMS_LLAMA_EMBED_VULKAN"));

/// Write an embedded engine out next to the app data (once per version).
#[cfg(feature = "embed-llama")]
fn extract_embedded(data: &Path, name: &str, bytes: &[u8]) -> Option<PathBuf> {
    let dir = data.join("bin");
    std::fs::create_dir_all(&dir).ok()?;
    let p = dir.join(exe_name(name));
    let up_to_date = std::fs::metadata(&p).map(|m| m.len() == bytes.len() as u64).unwrap_or(false);
    if !up_to_date {
        std::fs::write(&p, bytes).ok()?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755));
        }
    }
    Some(p)
}

#[cfg(feature = "embed-llama")]
fn embedded_server(data: &Path, vulkan: bool) -> Option<PathBuf> {
    if vulkan {
        #[cfg(feature = "embed-llama-vulkan")]
        return extract_embedded(data, "dorms-engine-vulkan", EMBEDDED_VULKAN);
        #[cfg(not(feature = "embed-llama-vulkan"))]
        return None;
    }
    extract_embedded(data, "dorms-engine", EMBEDDED_CPU)
}

#[cfg(not(feature = "embed-llama"))]
fn embedded_server(_data: &Path, _vulkan: bool) -> Option<PathBuf> {
    None
}

fn exe_name(base: &str) -> String {
    if cfg!(windows) { format!("{base}.exe") } else { base.to_string() }
}

fn find_in_path(name: &str) -> Option<PathBuf> {
    std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths).map(|d| d.join(name)).find(|p| p.is_file())
    })
}

/// Look next to the app (where Tauri puts sidecars), then the embedded copy,
/// then `$PATH` so a system llama.cpp `llama-server` works as a last resort.
fn find_server(data: &Path, vulkan: bool) -> Option<PathBuf> {
    let base = if vulkan { "dorms-engine-vulkan" } else { "dorms-engine" };
    let name = exe_name(base);
    if let Some(p) = std::env::var_os("DORMS_LLAMA_SERVER").filter(|_| !vulkan) {
        return Some(PathBuf::from(p));
    }
    if let Some(dir) = std::env::current_exe().ok().and_then(|e| e.parent().map(Path::to_path_buf)) {
        let p = dir.join(&name);
        if p.is_file() {
            return Some(p);
        }
    }
    if let Some(p) = embedded_server(data, vulkan) {
        return Some(p);
    }
    // a system-wide llama.cpp is a last resort for the CPU engine
    if vulkan { None } else { find_in_path(&exe_name("llama-server")) }
}

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .unwrap_or(18080)
}

fn log_tail(data: &Path) -> String {
    let s = std::fs::read_to_string(data.join("llama.log")).unwrap_or_default();
    let lines: Vec<&str> = s.lines().rev().take(6).collect();
    lines.into_iter().rev().collect::<Vec<_>>().join("\n")
}

async fn wait_healthy(child: &mut Child, port: u16, http: &reqwest::Client) -> Result<(), String> {
    let url = format!("http://127.0.0.1:{port}/health");
    for _ in 0..600 {
        if let Ok(Some(status)) = child.try_wait() {
            return Err(format!("engine exited ({status})"));
        }
        if let Ok(r) = http.get(&url).timeout(Duration::from_secs(2)).send().await {
            if r.status().is_success() {
                return Ok(());
            }
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    Err("engine took too long to load the model".into())
}

pub async fn stop(st: &AppState) {
    let mut g = st.llama.lock().await;
    if let Some(mut c) = g.child.take() {
        let _ = c.kill().await;
    }
    g.model.clear();
}

#[derive(Serialize)]
pub struct Status {
    pub running: bool,
    pub model: String,
    pub backend: String,
}

pub async fn status(st: &AppState) -> Status {
    let mut g = st.llama.lock().await;
    let running = match g.child.as_mut() {
        Some(c) => matches!(c.try_wait(), Ok(None)),
        None => false,
    };
    Status { running, model: g.model.clone(), backend: g.backend.clone() }
}

/// Ask the running server how much context it really has.
async fn actual_ctx(http: &reqwest::Client, port: u16, fallback: usize) -> usize {
    let Ok(r) = http.get(format!("http://127.0.0.1:{port}/props")).timeout(Duration::from_secs(5)).send().await else {
        return fallback;
    };
    let Ok(v) = r.json::<serde_json::Value>().await else { return fallback };
    v["default_generation_settings"]["n_ctx"]
        .as_u64()
        .or_else(|| v["n_ctx"].as_u64())
        .map(|n| n as usize)
        .filter(|n| *n > 0)
        .unwrap_or(fallback)
}

/// Make sure a server is running for `model_file`; returns its OpenAI base URL
/// and the context size it actually has.
pub async fn ensure_running(st: &AppState, model_file: &str, ctx: usize, gpu: bool) -> Result<(String, usize), String> {
    if !engine_supported() {
        return Err("The built-in engine isn't available on this platform yet. Pick a cloud or network model in Settings.".into());
    }
    if model_file.is_empty() {
        return Err("No local model selected. Open Settings → Models and download one.".into());
    }
    let model_file = safe_file_name(model_file)?;
    let model_path = models_dir(&st.data_dir).join(&model_file);
    if !model_path.is_file() {
        return Err(format!("Model file {model_file} is missing. Re-download it in Settings → Models."));
    }

    let mut g = st.llama.lock().await;
    if let Some(c) = g.child.as_mut() {
        if matches!(c.try_wait(), Ok(None)) && g.model == model_file && g.ctx == ctx && g.gpu == gpu {
            return Ok((format!("http://127.0.0.1:{}/v1", g.port), g.n_ctx));
        }
    }
    if let Some(mut c) = g.child.take() {
        let _ = c.kill().await;
    }

    let mut candidates: Vec<(PathBuf, bool)> = vec![];
    if gpu {
        if let Some(p) = find_server(&st.data_dir, true) {
            candidates.push((p, true));
        }
    }
    match find_server(&st.data_dir, false) {
        Some(p) => candidates.push((p, false)),
        None if candidates.is_empty() => {
            return Err("The bundled engine (dorms-engine) was not found next to the app. Reinstall, or set DORMS_LLAMA_SERVER to a llama-server binary.".into());
        }
        None => {}
    }

    let mut last_err = String::new();
    for (bin, vulkan) in candidates {
        let port = free_port();
        let log = std::fs::File::create(st.data_dir.join("llama.log")).map_err(|e| e.to_string())?;
        let log2 = log.try_clone().map_err(|e| e.to_string())?;
        let mut cmd = Command::new(&bin);
        cmd.arg("-m").arg(&model_path)
            .args(["--host", "127.0.0.1", "--port", &port.to_string()])
            .args(["-c", &ctx.to_string()])
            .args(["-ngl", if vulkan { "999" } else { "0" }])
            .stdin(Stdio::null())
            .stdout(Stdio::from(log))
            .stderr(Stdio::from(log2))
            .kill_on_drop(true);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                last_err = format!("could not start {}: {e}", bin.display());
                continue;
            }
        };
        match wait_healthy(&mut child, port, &st.http).await {
            Ok(()) => {
                g.n_ctx = actual_ctx(&st.http, port, ctx).await;
                g.child = Some(child);
                g.port = port;
                g.model = model_file;
                g.ctx = ctx;
                g.gpu = gpu;
                g.backend = if vulkan { "GPU (Vulkan)".into() } else { "CPU".into() };
                return Ok((format!("http://127.0.0.1:{port}/v1"), g.n_ctx));
            }
            Err(e) => {
                let _ = child.kill().await;
                last_err = format!("{e}\n{}", log_tail(&st.data_dir));
            }
        }
    }
    Err(format!("The local engine could not start: {last_err}"))
}
