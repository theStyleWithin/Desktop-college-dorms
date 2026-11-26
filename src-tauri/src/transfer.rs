//! Moving a profile from one device to another over the home network: direct, encrypted, nothing in the cloud.
//!
//! The sending device listens (only while its Send screen is open, and only for a few minutes) on its address on the home network. The receiving
//! device connects to it. Both know a code: the one shown as a QR code, or one the person chose. The code is not sent. The two devices turn it into a
//! shared key with SPAKE2, which lets a short code be safe: someone who records the exchange cannot guess the code from the recording, and can only
//! try by connecting for real, which the sender allows three times before it locks. Everything after that is encrypted and checked, frame by frame.
//!
//! The file is the ordinary profile export, and it arrives in the same staging place a profile file chosen on the device does, so the person sees what
//! came (the same preview as an import) and chooses to add it or not.

use std::net::{IpAddr, SocketAddr, UdpSocket};
use std::sync::Arc;
use std::time::{Duration, Instant};

use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use spake2::{Ed25519Group, Identity, Password, Spake2};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Notify;

type R<T> = Result<T, String>;

const MAGIC: &[u8] = b"DCDX1";
/// How much of the file goes in one frame.
const CHUNK: usize = 192 * 1024;
/// The biggest frame that is accepted (a chunk, its type byte and the 16 bytes that check it).
const MAX_FRAME: usize = CHUNK + 64;
/// The biggest first message of the key agreement.
const MAX_HANDSHAKE: usize = 256;
const ID_SENDER: &[u8] = b"desktop-college-dorms:sender";
const ID_RECEIVER: &[u8] = b"desktop-college-dorms:receiver";
/// How long the other device may stay quiet in the middle of a transfer.
const QUIET: Duration = Duration::from_secs(30);
/// Wrong codes tried before the sender locks.
pub const MAX_TRIES: u32 = 3;
/// How long the sender stays open.
pub const OPEN_FOR: Duration = Duration::from_secs(5 * 60);

const WRONG: &str = "The other device sent something that doesn't check out. The code was probably wrong, or someone is interfering.";

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn nonce(dir: u8, ctr: u64) -> Nonce {
    let mut n = [0u8; 12];
    n[0] = dir;
    n[4..].copy_from_slice(&ctr.to_be_bytes());
    *Nonce::from_slice(&n)
}

async fn write_raw<S: AsyncWrite + Unpin>(s: &mut S, bytes: &[u8]) -> R<()> {
    s.write_all(&(bytes.len() as u32).to_be_bytes()).await.map_err(|e| format!("The connection broke: {e}"))?;
    s.write_all(bytes).await.map_err(|e| format!("The connection broke: {e}"))?;
    s.flush().await.map_err(|e| format!("The connection broke: {e}"))
}

async fn read_raw<S: AsyncRead + Unpin>(s: &mut S, max: usize) -> R<Vec<u8>> {
    let mut len = [0u8; 4];
    tokio::time::timeout(QUIET, s.read_exact(&mut len)).await.map_err(|_| "The other device stopped answering.".to_string())?.map_err(|_| "The other device closed the connection.".to_string())?;
    let n = u32::from_be_bytes(len) as usize;
    if n > max { return Err("The other device sent something far too big.".into()); }
    let mut buf = vec![0u8; n];
    tokio::time::timeout(QUIET, s.read_exact(&mut buf)).await.map_err(|_| "The other device stopped answering.".to_string())?.map_err(|_| "The other device closed the connection.".to_string())?;
    Ok(buf)
}

/// An encrypted, checked, ordered line between two devices. Each direction has its own counter, which is part of every frame's nonce, so a frame that
/// is changed, dropped, repeated or moved is refused.
pub struct Channel<S> {
    s: S,
    cipher: ChaCha20Poly1305,
    send_dir: u8,
    recv_dir: u8,
    send_ctr: u64,
    recv_ctr: u64,
}

impl<S: AsyncRead + AsyncWrite + Unpin> Channel<S> {
    fn new(s: S, key: [u8; 32], send_dir: u8, recv_dir: u8) -> Self {
        Channel { s, cipher: ChaCha20Poly1305::new(Key::from_slice(&key)), send_dir, recv_dir, send_ctr: 0, recv_ctr: 0 }
    }
    pub async fn send(&mut self, plain: &[u8]) -> R<()> {
        let ct = self.cipher.encrypt(&nonce(self.send_dir, self.send_ctr), plain).map_err(|_| "Could not encrypt.".to_string())?;
        self.send_ctr += 1;
        write_raw(&mut self.s, &ct).await
    }
    pub async fn recv(&mut self) -> R<Vec<u8>> {
        let ct = read_raw(&mut self.s, MAX_FRAME).await?;
        let plain = self.cipher.decrypt(&nonce(self.recv_dir, self.recv_ctr), ct.as_slice()).map_err(|_| WRONG.to_string())?;
        self.recv_ctr += 1;
        Ok(plain)
    }
}

/// The key both devices end up with: what SPAKE2 agreed on, tied to the two messages that were exchanged.
fn derive(shared: &[u8], sender_msg: &[u8], receiver_msg: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"desktop-college-dorms transfer v1");
    for part in [shared, sender_msg, receiver_msg] {
        h.update((part.len() as u32).to_be_bytes());
        h.update(part);
    }
    h.finalize().into()
}

/// The sending side of the key agreement (the one that was listening).
pub async fn pair_as_sender<S: AsyncRead + AsyncWrite + Unpin>(mut s: S, code: &str) -> R<Channel<S>> {
    let first = read_raw(&mut s, MAX_HANDSHAKE).await?;
    if !first.starts_with(MAGIC) { return Err("That wasn't a Desktop College Dorms device.".into()); }
    let theirs = first[MAGIC.len()..].to_vec();
    let (state, mine) = Spake2::<Ed25519Group>::start_a(&Password::new(code.as_bytes()), &Identity::new(ID_SENDER), &Identity::new(ID_RECEIVER));
    write_raw(&mut s, &mine).await?;
    let shared = state.finish(&theirs).map_err(|_| "The pairing message was damaged.".to_string())?;
    let mut ch = Channel::new(s, derive(&shared, &mine, &theirs), 1, 2);
    ch.send(b"sender-ok").await?;
    if ch.recv().await? != b"receiver-ok" { return Err(WRONG.into()); }
    Ok(ch)
}

/// The receiving side of the key agreement (the one that connected).
pub async fn pair_as_receiver<S: AsyncRead + AsyncWrite + Unpin>(mut s: S, code: &str) -> R<Channel<S>> {
    let (state, mine) = Spake2::<Ed25519Group>::start_b(&Password::new(code.as_bytes()), &Identity::new(ID_SENDER), &Identity::new(ID_RECEIVER));
    let mut first = MAGIC.to_vec();
    first.extend_from_slice(&mine);
    write_raw(&mut s, &first).await?;
    let theirs = read_raw(&mut s, MAX_HANDSHAKE).await?;
    let shared = state.finish(&theirs).map_err(|_| "The pairing message was damaged.".to_string())?;
    let mut ch = Channel::new(s, derive(&shared, &theirs, &mine), 2, 1);
    if ch.recv().await? != b"sender-ok" { return Err(WRONG.into()); }
    ch.send(b"receiver-ok").await?;
    Ok(ch)
}

/// What the sender says about the file before it goes.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Meta {
    pub v: u32,
    pub kind: String,
    pub name: String,
    pub size: u64,
    pub sha256: String,
}

/// Sends a file: what it is, then the pieces, then waits to hear that it arrived whole.
pub async fn send_blob<S: AsyncRead + AsyncWrite + Unpin>(ch: &mut Channel<S>, kind: &str, name: &str, bytes: &[u8], mut progress: impl FnMut(u64)) -> R<()> {
    let meta = Meta { v: 1, kind: kind.into(), name: name.into(), size: bytes.len() as u64, sha256: hex(&Sha256::digest(bytes)) };
    let mut m = vec![b'M'];
    m.extend(serde_json::to_vec(&meta).map_err(|e| e.to_string())?);
    ch.send(&m).await?;
    let ans = ch.recv().await?;
    if ans.first() != Some(&b'A') { return Err(format!("The other device didn't take it: {}", String::from_utf8_lossy(ans.get(1..).unwrap_or_default()))); }
    let mut sent = 0u64;
    for chunk in bytes.chunks(CHUNK) {
        let mut f = Vec::with_capacity(chunk.len() + 1);
        f.push(b'D');
        f.extend_from_slice(chunk);
        ch.send(&f).await?;
        sent += chunk.len() as u64;
        progress(sent);
    }
    ch.send(b"E").await?;
    if ch.recv().await? != b"K" { return Err("The other device said the file did not arrive whole.".into()); }
    Ok(())
}

/// Takes a file: refuses one that is too big, collects the pieces, and checks the length and the checksum.
pub async fn recv_blob<S: AsyncRead + AsyncWrite + Unpin>(ch: &mut Channel<S>, max: u64, mut progress: impl FnMut(u64, u64)) -> R<(Meta, Vec<u8>)> {
    let f = ch.recv().await?;
    if f.first() != Some(&b'M') { return Err("The other device started in an unexpected way.".into()); }
    let meta: Meta = serde_json::from_slice(&f[1..]).map_err(|_| "The other device described the file in a way I can't read.".to_string())?;
    if meta.v != 1 || meta.kind != "profile" {
        let _ = ch.send(b"Rthis kind of transfer isn't supported").await;
        return Err("The other device is sending something this version can't take.".into());
    }
    if meta.size > max {
        let _ = ch.send(b"Rit is too big").await;
        return Err("That profile is too big to take.".into());
    }
    ch.send(b"A").await?;
    let mut buf: Vec<u8> = Vec::with_capacity(meta.size.min(64 * 1024 * 1024) as usize);
    loop {
        let f = ch.recv().await?;
        match f.first() {
            Some(b'D') => {
                buf.extend_from_slice(&f[1..]);
                if buf.len() as u64 > meta.size { let _ = ch.send(b"X").await; return Err("More arrived than was announced.".into()); }
                progress(buf.len() as u64, meta.size);
            }
            Some(b'E') => break,
            _ => return Err("The other device sent something unexpected.".into()),
        }
    }
    if buf.len() as u64 != meta.size || hex(&Sha256::digest(&buf)) != meta.sha256 {
        let _ = ch.send(b"X").await;
        return Err("The file did not arrive whole. Try again.".into());
    }
    ch.send(b"K").await?;
    Ok((meta, buf))
}

// ----- addresses and codes -----

/// The address of this device on the network it uses to reach others (found without sending anything).
pub fn lan_ip() -> Option<IpAddr> {
    let s = UdpSocket::bind("0.0.0.0:0").ok()?;
    s.connect("192.0.2.1:9").ok()?;
    s.local_addr().ok().map(|a| a.ip())
}

/// Whether an address is on a home or office network (or this very device), and not out on the internet.
pub fn is_local(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => v.is_private() || v.is_loopback() || v.is_link_local(),
        IpAddr::V6(v) => v.is_loopback() || (v.segments()[0] & 0xffc0) == 0xfe80 || (v.segments()[0] & 0xfe00) == 0xfc00,
    }
}

/// The address to listen on: this device's address on a home network. Only for tests (`loopback_ok`) is this very device used when there is no such address.
pub fn pick_ip(found: Option<IpAddr>, loopback_ok: bool) -> R<IpAddr> {
    match found {
        Some(ip) if is_local(ip) => Ok(ip),
        _ if loopback_ok => Ok(IpAddr::from([127, 0, 0, 1])),
        Some(ip) => Err(format!("This device's network address ({ip}) doesn't look like a home network, so I won't open it to others. Connect to your home Wi-Fi.")),
        None => Err("I couldn't find this device on a network. Connect to your home Wi-Fi first.".into()),
    }
}

/// A short random code with no look-alike letters, for when the person doesn't choose one.
pub fn random_code() -> String {
    use rand_core::{OsRng, RngCore};
    const A: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    (0..8).map(|_| A[(OsRng.next_u32() as usize) % A.len()] as char).collect()
}

/// What the QR code says: where to connect and the code to use. (The code is everything after the second bar, exactly as it was, so it may contain anything, spaces included.)
pub fn pairing_text(addr: &SocketAddr, code: &str) -> String {
    format!("DCD1|{addr}|{code}")
}

pub fn parse_pairing(text: &str) -> Option<(SocketAddr, String)> {
    let rest = text.strip_prefix("DCD1|")?;
    let (addr, code) = rest.split_once('|')?;
    let addr: SocketAddr = addr.parse().ok()?;
    if code.is_empty() { return None; }
    Some((addr, code.to_string()))
}

// ----- the commands -----

/// The largest profile file that is taken (the same limit as a profile file chosen on the device).
const MAX_PROFILE: u64 = 2 * 1024 * 1024 * 1024;

/// Where a transfer is, for the screen. `phase`: `idle`, `waiting` (the sender is listening), `connected`, `sending`, `receiving`, `arrived` (a profile
/// is waiting in the staging place for the person to look at), `done`, `failed`, `cancelled`.
#[derive(Serialize, Clone, Default, Debug)]
pub struct TransferStatus {
    pub phase: String,
    /// `send` or `receive`.
    pub role: String,
    pub message: String,
    pub done: u64,
    pub total: u64,
    pub addr: String,
    pub code: String,
    pub qr_svg: String,
    pub expires_in: u64,
    /// The staging token of a profile that arrived.
    pub token: Option<String>,
    /// The name of the profile that is being sent or arrived.
    pub name: String,
}

/// One direction of transfer. A device can be set up to send and to receive independently.
#[derive(Default)]
pub struct Slot {
    status: TransferStatus,
    gen: u64,
    cancel: Option<Arc<Notify>>,
    deadline: Option<Instant>,
}

#[derive(Default)]
pub struct TransferState {
    send: Slot,
    recv: Slot,
}

const SEND: bool = true;
const RECV: bool = false;

fn slot(t: &mut TransferState, send: bool) -> &mut Slot {
    if send { &mut t.send } else { &mut t.recv }
}

fn update(st: &crate::AppState, send: bool, gen: u64, f: impl FnOnce(&mut TransferStatus)) {
    let mut t = st.transfer.lock().unwrap();
    let g = slot(&mut t, send);
    if g.gen == gen { f(&mut g.status); }
}

fn finish(st: &crate::AppState, send: bool, gen: u64, phase: &str, message: &str) {
    let mut t = st.transfer.lock().unwrap();
    let g = slot(&mut t, send);
    if g.gen != gen { return; }
    g.status.phase = phase.into();
    g.status.message = message.into();
    g.status.qr_svg.clear();
    g.cancel = None;
    g.deadline = None;
}

fn qr_svg(text: &str) -> String {
    use qrcode::{render::svg, QrCode};
    QrCode::new(text.as_bytes()).map(|c| c.render::<svg::Color>().min_dimensions(240, 240).dark_color(svg::Color("#000000")).light_color(svg::Color("#ffffff")).build()).unwrap_or_default()
}

/// Opens this device to send the open profile. It listens on the home network address, for a few minutes, until one device pairs (or three wrong codes).
#[tauri::command]
pub async fn transfer_send_start(state: tauri::State<'_, crate::Shared>, code: String, passcode: Option<String>) -> R<TransferStatus> {
    let st: crate::Shared = state.inner().clone();
    if code.is_empty() { return Err("Type a code, or use the one shown.".into()); }
    if code.chars().count() > 200 { return Err("That code is too long (200 characters at most).".into()); }
    let o = crate::accounts::owner_now(&st)?;
    let name = match &o {
        Some(id) => {
            let prof = crate::db::get_profile(&st.db.lock().unwrap(), id).map_err(|e| e.to_string())?.ok_or("That profile isn't here any more.")?;
            crate::accounts::check_passcode(&st, &prof, passcode).await?;
            prof.display_name.clone()
        }
        None => "Guest".to_string(),
    };
    let (st2, o2) = (st.clone(), o.clone());
    let (bytes, _info, _file) = tauri::async_runtime::spawn_blocking(move || crate::accounts::build_export(&st2, &o2)).await.map_err(|e| e.to_string())??;
    let ip = pick_ip(lan_ip(), std::env::var_os("DORMS_TRANSFER_LOOPBACK").is_some())?;
    let listener = TcpListener::bind((ip, 0)).await.map_err(|e| format!("I couldn't open a connection on this device: {e}"))?;
    let addr = listener.local_addr().map_err(|e| e.to_string())?;
    let cancel = Arc::new(Notify::new());
    let deadline = Instant::now() + OPEN_FOR;
    let gen = {
        let mut t = st.transfer.lock().unwrap();
        let g = slot(&mut t, SEND);
        if let Some(c) = g.cancel.take() { c.notify_one(); }
        g.gen += 1;
        g.cancel = Some(cancel.clone());
        g.deadline = Some(deadline);
        g.status = TransferStatus { phase: "waiting".into(), role: "send".into(), message: "Waiting for the other device.".into(), total: bytes.len() as u64, addr: addr.to_string(), code: code.clone(), qr_svg: qr_svg(&pairing_text(&addr, &code)), expires_in: OPEN_FOR.as_secs(), name: name.clone(), ..Default::default() };
        g.gen
    };
    let st3 = st.clone();
    tauri::async_runtime::spawn(async move { run_send(st3, gen, listener, code, bytes, name, cancel, deadline).await });
    Ok(transfer_status(state, "send".into()))
}

#[allow(clippy::too_many_arguments)]
async fn run_send(st: crate::Shared, gen: u64, listener: TcpListener, code: String, bytes: Vec<u8>, name: String, cancel: Arc<Notify>, deadline: Instant) {
    let mut tries = 0u32;
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() { finish(&st, SEND, gen, "failed", "Nobody connected in time, so this device closed itself. Start again when the other device is ready."); return; }
        let accepted = tokio::select! {
            _ = cancel.notified() => { finish(&st, SEND, gen, "cancelled", "Stopped. Nothing was sent."); return; }
            r = tokio::time::timeout(left, listener.accept()) => r,
        };
        let sock = match accepted {
            Err(_) => { finish(&st, SEND, gen, "failed", "Nobody connected in time, so this device closed itself. Start again when the other device is ready."); return; }
            Ok(Err(_)) => continue,
            Ok(Ok((sock, _))) => sock,
        };
        update(&st, SEND, gen, |s| { s.phase = "connected".into(); s.message = "A device is connecting…".into(); });
        let paired = tokio::select! {
            _ = cancel.notified() => { finish(&st, SEND, gen, "cancelled", "Stopped. Nothing was sent."); return; }
            r = tokio::time::timeout(Duration::from_secs(20), pair_as_sender(sock, &code)) => r,
        };
        let mut ch = match paired {
            Ok(Ok(ch)) => ch,
            _ => {
                tries += 1;
                if tries >= MAX_TRIES { finish(&st, SEND, gen, "failed", "Three tries with a wrong code, so this device locked itself. Nothing was sent. Start again to try once more."); return; }
                let left_tries = MAX_TRIES - tries;
                update(&st, SEND, gen, |s| { s.phase = "waiting".into(); s.message = format!("A device tried and the code didn't match. {left_tries} {} left.", if left_tries == 1 { "try" } else { "tries" }); });
                continue;
            }
        };
        update(&st, SEND, gen, |s| { s.phase = "sending".into(); s.message = "Sending…".into(); });
        let st2 = st.clone();
        let res = send_blob(&mut ch, "profile", &name, &bytes, move |n| update(&st2, SEND, gen, |s| s.done = n)).await;
        match res {
            Ok(()) => finish(&st, SEND, gen, "done", "Sent. The other device will show what arrived and ask before adding it."),
            Err(e) => finish(&st, SEND, gen, "failed", &e),
        }
        return;
    }
}

/// Connects to a sending device and takes the profile it sends into the staging place, ready to be looked at and added.
#[tauri::command]
pub async fn transfer_receive_start(state: tauri::State<'_, crate::Shared>, addr: String, code: String) -> R<TransferStatus> {
    let st: crate::Shared = state.inner().clone();
    if code.is_empty() { return Err("Type the code shown on the other device.".into()); }
    let addr: SocketAddr = addr.trim().parse().map_err(|_| "Type the address the way the other device shows it, with its port, like 192.168.1.20:48123.".to_string())?;
    if !is_local(addr.ip()) { return Err("That doesn't look like an address on your home network, so I won't connect to it.".into()); }
    let cancel = Arc::new(Notify::new());
    let gen = {
        let mut t = st.transfer.lock().unwrap();
        let g = slot(&mut t, RECV);
        if let Some(c) = g.cancel.take() { c.notify_one(); }
        g.gen += 1;
        g.cancel = Some(cancel.clone());
        g.deadline = None;
        g.status = TransferStatus { phase: "receiving".into(), role: "receive".into(), message: "Connecting…".into(), addr: addr.to_string(), ..Default::default() };
        g.gen
    };
    let st2 = st.clone();
    tauri::async_runtime::spawn(async move { run_receive(st2, gen, addr, code, cancel).await });
    Ok(transfer_status(state, "receive".into()))
}

async fn run_receive(st: crate::Shared, gen: u64, addr: SocketAddr, code: String, cancel: Arc<Notify>) {
    const UNREACHABLE: &str = "I couldn't reach that device. Check that it is on the same Wi-Fi and its Send screen is open.";
    let work = async {
        let sock = tokio::time::timeout(Duration::from_secs(8), TcpStream::connect(addr)).await.map_err(|_| UNREACHABLE.to_string())?.map_err(|_| UNREACHABLE.to_string())?;
        update(&st, RECV, gen, |s| s.message = "Checking the code…".into());
        let mut ch = tokio::time::timeout(Duration::from_secs(20), pair_as_receiver(sock, &code)).await.map_err(|_| "The other device didn't answer.".to_string())??;
        update(&st, RECV, gen, |s| s.message = "Receiving…".into());
        let st2 = st.clone();
        recv_blob(&mut ch, MAX_PROFILE, move |n, total| update(&st2, RECV, gen, |s| { s.done = n; s.total = total; })).await
    };
    let res = tokio::select! {
        _ = cancel.notified() => { finish(&st, RECV, gen, "cancelled", "Stopped."); return; }
        r = work => r,
    };
    match res {
        Ok((meta, bytes)) => {
            let token = uuid::Uuid::new_v4().to_string();
            *st.staged.lock().unwrap() = Some((token.clone(), Arc::new(bytes)));
            update(&st, RECV, gen, |s| { s.token = Some(token); s.name = meta.name.clone(); });
            finish(&st, RECV, gen, "arrived", "A profile arrived. Nothing has been added yet.");
        }
        Err(e) => finish(&st, RECV, gen, "failed", &e),
    }
}

/// Where a transfer is (`role` is `send` or `receive`); the screen asks every second or so.
#[tauri::command]
pub fn transfer_status(state: tauri::State<'_, crate::Shared>, role: String) -> TransferStatus {
    let mut t = state.transfer.lock().unwrap();
    let g = slot(&mut t, role == "send");
    let mut s = g.status.clone();
    s.expires_in = g.deadline.map(|d| d.saturating_duration_since(Instant::now()).as_secs()).unwrap_or(0);
    s
}

/// Stops a transfer in progress (and closes the sending device).
#[tauri::command]
pub fn transfer_cancel(state: tauri::State<'_, crate::Shared>, role: String) {
    let mut t = state.transfer.lock().unwrap();
    if let Some(c) = slot(&mut t, role == "send").cancel.take() { c.notify_one(); }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::duplex;

    async fn pair(sender_code: &str, receiver_code: &str) -> (R<Channel<tokio::io::DuplexStream>>, R<Channel<tokio::io::DuplexStream>>) {
        let (a, b) = duplex(1 << 20);
        let (sc, rc) = (sender_code.to_string(), receiver_code.to_string());
        let s = tokio::spawn(async move { pair_as_sender(a, &sc).await });
        let r = tokio::spawn(async move { pair_as_receiver(b, &rc).await });
        (s.await.unwrap(), r.await.unwrap())
    }

    #[tokio::test]
    async fn the_same_code_pairs_and_any_text_will_do() {
        for code in ["K3F9Q2M7", "pizza", "a", "pass word with spaces", "日本語のコード 🍕", "x|y|z:1"] {
            let (s, r) = pair(code, code).await;
            assert!(s.is_ok() && r.is_ok(), "the code {code:?} should pair");
        }
    }

    #[tokio::test]
    async fn a_wrong_code_does_not_pair() {
        let (s, r) = pair("pizza", "pizzA").await;
        assert!(s.is_err() && r.is_err(), "a code that is off by one letter must fail on both sides");
        assert!(r.err().unwrap().contains("doesn't check out"));
    }

    #[tokio::test]
    async fn a_profile_arrives_whole_and_the_progress_is_reported() {
        let (s, r) = pair("pizza", "pizza").await;
        let (mut s, mut r) = (s.unwrap(), r.unwrap());
        let data: Vec<u8> = (0..(CHUNK * 2 + 777)).map(|i| (i % 251) as u8).collect();
        let d2 = data.clone();
        let send = tokio::spawn(async move { let mut last = 0; let res = send_blob(&mut s, "profile", "Alex", &d2, |n| last = n).await; (res, last) });
        let recv = tokio::spawn(async move { let mut ticks = 0; let res = recv_blob(&mut r, 1 << 30, |_, _| ticks += 1).await; (res, ticks) });
        let ((sres, last), (rres, ticks)) = (send.await.unwrap(), recv.await.unwrap());
        sres.unwrap();
        let (meta, got) = rres.unwrap();
        assert_eq!((meta.name.as_str(), meta.size, got == data), ("Alex", data.len() as u64, true));
        assert_eq!((last, ticks), (data.len() as u64, 3));
    }

    #[tokio::test]
    async fn a_file_that_is_too_big_is_refused_before_it_is_sent() {
        let (s, r) = pair("c", "c").await;
        let (mut s, mut r) = (s.unwrap(), r.unwrap());
        let send = tokio::spawn(async move { send_blob(&mut s, "profile", "Big", &vec![1u8; 5000], |_| {}).await });
        let recv = tokio::spawn(async move { recv_blob(&mut r, 1000, |_, _| {}).await });
        let (sres, rres) = (send.await.unwrap(), recv.await.unwrap());
        assert!(sres.unwrap_err().contains("too big") && rres.unwrap_err().contains("too big"));
    }

    #[tokio::test]
    async fn a_changed_or_repeated_frame_is_caught() {
        // a frame that was changed on the way
        let (s, r) = pair("c", "c").await;
        let (mut s, mut r) = (s.unwrap(), r.unwrap());
        s.send(b"hello").await.unwrap();
        let mut raw = read_raw(&mut r.s, MAX_FRAME).await.unwrap();
        raw[0] ^= 1;
        let (a, mut b) = duplex(4096);
        let mut a = a;
        write_raw(&mut a, &raw).await.unwrap();
        r.s = b_into(&mut b);
        assert!(r.recv().await.is_err(), "one changed bit must be noticed");
        // the same frame twice
        let (s, r) = pair("c", "c").await;
        let (mut s, mut r) = (s.unwrap(), r.unwrap());
        s.send(b"once").await.unwrap();
        let raw = read_raw(&mut r.s, MAX_FRAME).await.unwrap();
        let (mut a, b) = duplex(4096);
        write_raw(&mut a, &raw).await.unwrap();
        write_raw(&mut a, &raw).await.unwrap();
        r.s = b;
        assert_eq!(r.recv().await.unwrap(), b"once");
        assert!(r.recv().await.is_err(), "a frame sent twice must be refused the second time");
    }

    /// Lets a test swap in a stream carrying a doctored frame (takes the stream out of `b`).
    fn b_into(b: &mut tokio::io::DuplexStream) -> tokio::io::DuplexStream {
        std::mem::replace(b, duplex(1).0)
    }

    #[tokio::test]
    async fn it_works_over_a_real_connection_too() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { let (sock, _) = listener.accept().await.unwrap(); let mut ch = pair_as_sender(sock, "pizza").await.unwrap(); send_blob(&mut ch, "profile", "Alex", b"zip bytes", |_| {}).await });
        let sock = TcpStream::connect(addr).await.unwrap();
        let mut ch = pair_as_receiver(sock, "pizza").await.unwrap();
        let (meta, got) = recv_blob(&mut ch, 1 << 20, |_, _| {}).await.unwrap();
        server.await.unwrap().unwrap();
        assert_eq!((meta.name.as_str(), got.as_slice()), ("Alex", b"zip bytes".as_slice()));
    }

    #[test]
    fn the_pairing_text_round_trips_whatever_the_code_is() {
        let addr: SocketAddr = "192.168.1.20:48123".parse().unwrap();
        for code in ["K3F9Q2M7", "a|b|c", "pizza 🍕", " spaced "] {
            let t = pairing_text(&addr, code);
            assert_eq!(parse_pairing(&t), Some((addr, code.to_string())), "{t}");
        }
        assert_eq!(parse_pairing("hello"), None);
        assert_eq!(parse_pairing("DCD1|192.168.1.20:1|"), None, "no code is not a pairing");
        assert_eq!(parse_pairing("DCD1|not an address|x"), None);
    }

    #[test]
    fn the_sender_only_opens_on_a_home_network() {
        let home: IpAddr = "192.168.1.5".parse().unwrap();
        let out: IpAddr = "8.8.8.8".parse().unwrap();
        assert_eq!(pick_ip(Some(home), false).unwrap(), home);
        assert!(pick_ip(Some(out), false).unwrap_err().contains("home network"));
        assert!(pick_ip(None, false).unwrap_err().contains("couldn't find"));
        assert_eq!(pick_ip(Some(out), true).unwrap(), IpAddr::from([127, 0, 0, 1]), "tests only");
        assert_eq!(pick_ip(None, true).unwrap(), IpAddr::from([127, 0, 0, 1]));
    }

    #[test]
    fn only_home_network_addresses_are_accepted() {
        for ok in ["192.168.1.5", "10.0.0.7", "172.16.4.4", "127.0.0.1", "169.254.1.1", "fe80::1", "fd00::1", "::1"] {
            assert!(is_local(ok.parse().unwrap()), "{ok}");
        }
        for bad in ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700::1111"] {
            assert!(!is_local(bad.parse().unwrap()), "{bad}");
        }
        assert_eq!(random_code().len(), 8);
        assert_ne!(random_code(), random_code());
    }
}
