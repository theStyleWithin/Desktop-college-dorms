import { useRef, useState } from "react";
import { api, type Frame, type ImportPreview, type SessionState } from "../api";
import { frameStyle } from "./Art";
import { errText, hue, timeAgo } from "../lib/util";
import { Modal } from "./ui";

export const PASSCODE_NOTE =
  "A passcode keeps other people on this computer out of your profile inside the app. It doesn't encrypt your files on disk.";

/** A person's picture, or their initial on a colour when they have none. */
export function ProfileAvatar({ name, size = 56, src, frame }: { name: string; size?: number; src?: string | null; frame?: Frame | null }) {
  const h = hue(name);
  return (
    <div className="avatar" style={{ width: size, height: size, display: "grid", placeItems: "center", fontFamily: "var(--serif)", fontSize: size * 0.45, color: "#fff", overflow: "hidden", flex: "none",
      background: `linear-gradient(135deg, hsl(${h} 45% 38%), hsl(${(h + 50) % 360} 50% 24%))` }}>
      {src ? <img src={src} alt="" draggable={false} style={{ width: "100%", height: "100%", objectFit: "cover", ...frameStyle(frame) }} /> : (name.trim()[0] ?? "?").toUpperCase()}
    </div>
  );
}

/** Create a new profile, or (claim) turn the guest space into one. */
export function CreateProfileModal({ claim, onClose, onDone }: { claim?: boolean; onClose: () => void; onDone: (s: SessionState) => void }) {
  const [handle, setHandle] = useState("");
  const [display, setDisplay] = useState("");
  const [pass, setPass] = useState("");
  const [pass2, setPass2] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setErr("");
    if (pass !== pass2) return setErr("The two passcodes don't match.");
    setBusy(true);
    try {
      onDone(await (claim ? api.claimGuest : api.createProfile)(handle, display, pass));
    } catch (e) { setErr(errText(e)); setBusy(false); }
  };

  return (
    <Modal title={claim ? "Make this a real profile" : "Create a profile"} onClose={onClose}>
      {claim && <p className="sub" style={{ marginTop: 0 }}>Your characters, dorms and chats move into the new profile. Nothing is lost.</p>}
      <div style={{ display: "grid", gap: 10 }}>
        <label>Profile name<input type="text" autoFocus maxLength={24} value={handle} onChange={(e) => setHandle(e.target.value)} placeholder="2 to 24 characters" /></label>
        <label>What characters call you <span className="tok">(optional)</span><input type="text" maxLength={40} value={display} onChange={(e) => setDisplay(e.target.value)} placeholder={handle || "Same as the profile name"} /></label>
        <label>Passcode <span className="tok">(optional)</span><input type="password" autoComplete="new-password" value={pass} onChange={(e) => setPass(e.target.value)} placeholder="At least 4 characters, or leave empty" /></label>
        {pass && <label>Passcode again<input type="password" autoComplete="new-password" value={pass2} onChange={(e) => setPass2(e.target.value)} /></label>}
        <p className="hint" style={{ margin: 0 }}>{PASSCODE_NOTE}</p>
        {err && <div className="hint" style={{ color: "var(--danger)" }} role="alert">{err}</div>}
        <div className="row"><button className="btn primary" disabled={busy || handle.trim().length < 2} onClick={submit}>{busy ? "Working…" : claim ? "Make it a profile" : "Create profile"}</button></div>
      </div>
    </Modal>
  );
}

/** Pick a profile file made by Eject or Export, look inside it, then import it as a new profile. */
export function ImportProfileModal({ onClose, onDone }: { onClose: () => void; onDone: (s: SessionState) => void }) {
  const file = useRef<HTMLInputElement>(null);
  const [token, setToken] = useState<string | null>(null);
  const [reading, setReading] = useState<number | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [handle, setHandle] = useState("");
  const [pass, setPass] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const pick = async (picked: File | undefined) => {
    if (!picked) return;
    setErr(""); setPreview(null); setToken(null); setReading(0);
    try {
      const t = await api.stageProfileFile(picked, setReading);
      const p = await api.inspectStaged(t);
      setToken(t); setPreview(p);
      setHandle(p.handle_taken ? `${p.handle.slice(0, 20)}_2` : p.handle);
    } catch (e) { setErr(errText(e)); setToken(null); } finally { setReading(null); }
  };
  const run = async () => {
    if (!token) return;
    setBusy(true); setErr("");
    try { onDone(await api.importStaged(token, handle, pass)); } catch (e) { setErr(errText(e)); setBusy(false); }
  };
  const close = () => { void api.clearStage().catch(() => {}); onClose(); };

  return (
    <Modal title="Import a profile file" onClose={close}>
      <p className="sub" style={{ marginTop: 0 }}>Choose a <b>.dorms</b> file saved by Eject or Export. It comes back as a new profile; nothing already on this device is overwritten.</p>
      <button className="btn" disabled={reading !== null} onClick={() => file.current?.click()}>⇪ Choose file…</button>
      {reading !== null && <span className="hint" role="status" style={{ marginLeft: 10 }}>Reading the file… {Math.round(reading * 100)}%</span>}
      {/* No type filter on purpose: phone file pickers build their list from MIME types, and ".dorms" has none, so a filter can grey the file out.
          Whatever is chosen is checked; a file that isn't a profile gets a clear message. */}
      <input ref={file} type="file" hidden onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ""; }} />
      {preview && (
        <div style={{ display: "grid", gap: 10, marginTop: 14 }}>
          <div className="card">
            <b>{preview.guest ? "Guest data" : preview.handle}</b>
            <div className="hint">
              {preview.characters} characters, {preview.dorms} dorms, {preview.chats} chats, {preview.messages} messages, {preview.media} media files.
              Saved {timeAgo(preview.exported_at)} by version {preview.app_version}.
            </div>
            {preview.already_here && <div className="hint">A profile from this same file is already on this device. This will import a separate copy.</div>}
          </div>
          <label>Profile name<input type="text" maxLength={24} value={handle} onChange={(e) => setHandle(e.target.value)} />
            {preview.handle_taken && <span className="hint">"{preview.handle}" is already used here, so pick another name.</span>}
          </label>
          <label>New passcode <span className="tok">(optional; passcodes are never saved in the file)</span><input type="password" autoComplete="new-password" value={pass} onChange={(e) => setPass(e.target.value)} /></label>
          <p className="hint" style={{ margin: 0 }}>API keys are not in the file either, so add them again in Settings.</p>
          <div className="row"><button className="btn primary" disabled={busy || handle.trim().length < 2} onClick={run}>{busy ? "Importing…" : "Import"}</button></div>
        </div>
      )}
      {err && <div className="hint" style={{ color: "var(--danger)", marginTop: 10 }} role="alert">{err}</div>}
    </Modal>
  );
}
