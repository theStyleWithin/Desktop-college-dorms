import { useEffect, useRef, useState } from "react";
import { api, type ImportPreview, type TransferStatus } from "../api";
import { Modal, useToast } from "./ui";
import QrScanner from "./QrScanner";
import { errText } from "../lib/util";
import { useStore } from "../store";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const randomCode = () => { const a = new Uint32Array(8); crypto.getRandomValues(a); return Array.from(a, (n) => ALPHABET[n % ALPHABET.length]).join(""); };
const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
const SEND_ACTIVE = ["waiting", "connected", "sending"];

/** The name to suggest for a profile that arrived: its own name (a guest space has no name of its own, so the display name is used), with "-2" if that is taken. */
export function suggestName(p: Pick<ImportPreview, "handle" | "display_name" | "guest" | "handle_taken">): string {
  const base = p.guest ? (p.display_name.trim() || "My profile") : p.handle;
  return p.handle_taken && !p.guest ? `${base}-2` : base;
}

/** The QR text is `DCD1|<address>|<code>`; the code is everything after the second bar. */
export function parsePairing(text: string): { addr: string; code: string } | null {
  if (!text.startsWith("DCD1|")) return null;
  const rest = text.slice(5), i = rest.indexOf("|");
  if (i < 1 || i === rest.length - 1) return null;
  return { addr: rest.slice(0, i), code: rest.slice(i + 1) };
}

/** Moving the open profile to or from another device over the home Wi-Fi: send (a QR code and a code to type) or receive (scan or type), then look at what arrived before adding it. */
export default function TransferDialog({ profileName, hasPasscode, onClose }: { profileName: string; hasPasscode: boolean; onClose: () => void }) {
  const { setSession } = useStore();
  const toast = useToast();
  const [mode, setMode] = useState<"choose" | "send" | "receive">("choose");
  const [send, setSend] = useState<TransferStatus | null>(null);
  const [recv, setRecv] = useState<TransferStatus | null>(null);
  const [code, setCode] = useState(randomCode);
  const [pass, setPass] = useState("");
  const [addr, setAddr] = useState("");
  const [rcode, setRcode] = useState("");
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [handle, setHandle] = useState("");
  const [newPass, setNewPass] = useState("");
  const live = useRef({ send, mode });
  live.current = { send, mode };

  // pick up where a transfer already is (the dialog may have been closed and opened again)
  useEffect(() => {
    void api.transferStatus("send").then((s) => { setSend(s); if (SEND_ACTIVE.includes(s.phase)) { setMode("send"); setCode(s.code); } }).catch(() => {});
    void api.transferStatus("receive").then((s) => { setRecv(s); if (s.phase === "arrived" || s.phase === "receiving") setMode("receive"); }).catch(() => {});
  }, []);
  useEffect(() => {
    if (mode === "choose") return;
    const t = window.setInterval(() => { void api.transferStatus("send").then(setSend).catch(() => {}); void api.transferStatus("receive").then(setRecv).catch(() => {}); }, 700);
    return () => window.clearInterval(t);
  }, [mode]);
  // a profile arrived: look inside it (the same preview an imported file gets)
  useEffect(() => {
    if (recv?.phase === "arrived" && recv.token && !preview) {
      api.inspectStaged(recv.token).then((p) => { setPreview(p); setHandle(suggestName(p)); }).catch((e) => toast(errText(e), "err"));
    }
  }, [recv?.phase, recv?.token]); // eslint-disable-line react-hooks/exhaustive-deps
  // closing the dialog closes the sending device: it only listens while this screen is open
  const close = () => { if (live.current.send && SEND_ACTIVE.includes(live.current.send.phase)) void api.transferCancel("send"); onClose(); };

  const start = async () => {
    setBusy(true);
    try { setSend(await api.transferSendStart(code, hasPasscode ? pass : null)); } catch (e) { toast(errText(e), "err"); } finally { setBusy(false); }
  };
  const connect = async (a = addr, c = rcode) => {
    setBusy(true); setPreview(null);
    try { setRecv(await api.transferReceiveStart(a, c)); } catch (e) { toast(errText(e), "err"); } finally { setBusy(false); }
  };
  const scanned = (text: string) => {
    setScanning(false);
    const p = parsePairing(text);
    if (!p) { toast("That QR code isn't from Desktop College Dorms.", "err"); return; }
    setAddr(p.addr); setRcode(p.code);
    void connect(p.addr, p.code);
  };
  const add = async () => {
    if (!recv?.token) return;
    setBusy(true);
    try { setSession(await api.importStaged(recv.token, handle, newPass)); toast("Added as a new profile.", "ok"); onClose(); } catch (e) { toast(errText(e), "err"); } finally { setBusy(false); }
  };
  const discard = () => { void api.clearStage(); setPreview(null); setRecv(null); };

  const sendActive = !!send && SEND_ACTIVE.includes(send.phase);
  const bar = (s: TransferStatus) => s.total > 0 && <div className="bar" style={{ margin: "8px 0" }}><div style={{ width: `${Math.min(100, Math.round((s.done / s.total) * 100))}%` }} /></div>;

  return (
    <Modal title="📶 Move a profile over Wi-Fi" onClose={close} wide>
      <div data-testid="transfer-dialog" style={{ display: "grid", gap: 12 }}>
        {mode === "choose" && (
          <>
            <p className="sub" style={{ margin: 0 }}>Move a whole profile between your computer and your phone over your home Wi-Fi. It goes straight from one device to the other, encrypted, and never leaves your home network. Nothing is sent until you start it, and nothing is added on the other side until you say so.</p>
            <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
              <button className="btn primary" data-testid="transfer-choose-send" onClick={() => setMode("send")}>Send {profileName} to another device</button>
              <button className="btn" data-testid="transfer-choose-receive" onClick={() => setMode("receive")}>Receive a profile from another device</button>
            </div>
            <div className="hint">Both devices need to be on the same Wi-Fi. A guest network or a router that keeps devices apart can stop it; if so, the file backup in "Your data" still works. API keys are never sent; add them again on the other device.</div>
          </>
        )}

        {mode === "send" && (
          <>
            {send && ["done", "failed", "cancelled"].includes(send.phase) && <div className={send.phase === "done" ? "hint" : "banner"} data-testid="transfer-send-result">{send.message}</div>}
            {!sendActive ? (
              <>
                <p className="sub" style={{ margin: 0 }}>This sends everything in <b>{profileName}</b>. This device only listens while this screen is open, for up to 5 minutes, and locks after three wrong codes.</p>
                <label className="field"><span>Code</span>
                  <input type="text" value={code} data-testid="transfer-code" aria-label="Pairing code" maxLength={200} onChange={(e) => setCode(e.target.value)} />
                  <div className="hint">Any characters you like, as short or long as you like. The other device types the same, or scans the QR code, which has it in it. Spaces count.</div></label>
                {hasPasscode && <label className="field"><span>This profile's passcode</span><input type="password" value={pass} data-testid="transfer-passcode" aria-label="Passcode" onChange={(e) => setPass(e.target.value)} /></label>}
                <div className="row"><button className="btn primary" disabled={busy || !code || (hasPasscode && !pass)} data-testid="transfer-start" onClick={() => void start()}>{busy ? "Getting ready…" : "Start sending"}</button><button className="btn" onClick={() => setMode("choose")}>Back</button></div>
              </>
            ) : (
              <div data-testid="transfer-send-active" style={{ display: "grid", gap: 8, justifyItems: "center" }}>
                {send.qr_svg && <img alt="QR code to scan on the other device" data-testid="transfer-qr" width={240} height={240} style={{ background: "#fff", borderRadius: 8 }} src={`data:image/svg+xml;base64,${btoa(send.qr_svg)}`} />}
                <div>On the other device, choose <b>Receive</b>, then scan this, or type:</div>
                <div className="row" style={{ gap: 18 }}><span>Address <b data-testid="transfer-addr">{send.addr}</b></span><span>Code <b data-testid="transfer-code-shown">{send.code}</b></span></div>
                <div className="tok" data-testid="transfer-send-message">{send.message} {send.phase === "waiting" && `Closes in ${clock(send.expires_in)}.`}</div>
                {send.phase === "sending" && bar(send)}
                <button className="btn" data-testid="transfer-stop" onClick={() => void api.transferCancel("send")}>Stop</button>
              </div>
            )}
          </>
        )}

        {mode === "receive" && (
          <>
            {recv && ["failed", "cancelled"].includes(recv.phase) && <div className="banner" data-testid="transfer-recv-result">{recv.message}</div>}
            {recv?.phase === "receiving" ? (
              <div data-testid="transfer-receiving"><div>{recv.message}</div>{bar(recv)}<button className="btn" onClick={() => void api.transferCancel("receive")}>Stop</button></div>
            ) : recv?.phase === "arrived" && preview ? (
              <div className="card" data-testid="transfer-arrived" style={{ display: "grid", gap: 8 }}>
                <h3 style={{ margin: 0 }}>A profile arrived: {preview.display_name || preview.handle}</h3>
                <div data-testid="transfer-arrived-counts">{preview.characters} character{preview.characters === 1 ? "" : "s"}, {preview.dorms} dorm{preview.dorms === 1 ? "" : "s"}, {preview.chats} chat{preview.chats === 1 ? "" : "s"} with {preview.messages} message{preview.messages === 1 ? "" : "s"}, and {preview.media} picture{preview.media === 1 ? "" : "s"} and other file{preview.media === 1 ? "" : "s"}.</div>
                <div className="hint">Nothing has been added yet. {preview.already_here ? "This profile is already on this device, so adding it makes a separate new copy." : ""}</div>
                <label className="field"><span>Name for the new profile</span><input type="text" value={handle} data-testid="transfer-handle" aria-label="Profile name" onChange={(e) => setHandle(e.target.value)} />
                  {preview.handle_taken && <div className="hint">A profile with that name is already here, so I suggested another.</div>}</label>
                <label className="field"><span>Passcode for it (optional)</span><input type="password" value={newPass} aria-label="Passcode for the new profile" onChange={(e) => setNewPass(e.target.value)} /></label>
                <div className="row"><button className="btn primary" disabled={busy || !handle.trim()} data-testid="transfer-add" onClick={() => void add()}>Add as a new profile</button><button className="btn" data-testid="transfer-discard" onClick={discard}>Discard</button></div>
              </div>
            ) : scanning ? (
              <QrScanner onResult={scanned} onCancel={() => setScanning(false)} />
            ) : (
              <>
                <p className="sub" style={{ margin: 0 }}>On the other device, open this screen and choose <b>Send</b>. Then scan its QR code, or type what it shows.</p>
                <button className="btn primary" data-testid="transfer-scan" onClick={() => setScanning(true)}>Scan its QR code</button>
                <div className="hint">Or type them:</div>
                <label className="field"><span>Address</span><input type="text" value={addr} placeholder="192.168.1.20:48123" data-testid="transfer-recv-addr" aria-label="Address" onChange={(e) => setAddr(e.target.value)} /></label>
                <label className="field"><span>Code</span><input type="text" value={rcode} data-testid="transfer-recv-code" aria-label="Code" onChange={(e) => setRcode(e.target.value)} /></label>
                <div className="row"><button className="btn primary" disabled={busy || !addr.trim() || !rcode} data-testid="transfer-connect" onClick={() => void connect()}>Connect</button><button className="btn" onClick={() => setMode("choose")}>Back</button></div>
              </>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
