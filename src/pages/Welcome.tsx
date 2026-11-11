import { useState } from "react";
import { api, profileAvatar, type ProfileInfo, type SessionState } from "../api";
import { CreateProfileModal, ImportProfileModal, ProfileAvatar } from "../components/ProfileForms";
import { Logo, Modal } from "../components/ui";
import { errText, timeAgo } from "../lib/util";

/** Shown before anything else once at least one local profile exists (or after switching profiles). */
export default function Welcome({ session, onSession }: { session: SessionState; onSession: (s: SessionState) => void }) {
  const [modal, setModal] = useState<null | "create" | "import">(null);
  const [asking, setAsking] = useState<ProfileInfo | null>(null);
  const [pass, setPass] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const enter = async (id: string | null, passcode?: string) => {
    setBusy(true); setErr("");
    try { onSession(await api.signIn(id, passcode)); } catch (e) { setErr(errText(e)); setBusy(false); }
  };
  const pickProfile = (p: ProfileInfo) => {
    if (p.has_passcode) { setAsking(p); setPass(""); setErr(""); } else enter(p.id);
  };

  return (
    <div className="page" style={{ maxWidth: 820, margin: "0 auto" }}>
      <div className="hero" style={{ textAlign: "center" }}>
        <div style={{ display: "grid", placeItems: "center", marginBottom: 8 }}><Logo size={52} /></div>
        <h1>Welcome to the dorms</h1>
        <p style={{ margin: "8px auto 0" }}>Pick your profile, or hop right in as a guest. Everything stays on this device.</p>
      </div>

      <h2 style={{ marginBottom: 10 }}>Profiles</h2>
      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(270px, 1fr))" }}>
        {session.profiles.map((p) => (
          <button key={p.id} className="ccard" style={{ gridTemplateColumns: "auto 1fr", alignItems: "center", gap: 14, padding: 14, minHeight: 0, textAlign: "left" }} onClick={() => pickProfile(p)} disabled={busy}>
            <ProfileAvatar name={p.display_name || p.handle} src={profileAvatar(p)} frame={p.avatar_frame} />
            <div style={{ minWidth: 0 }}>
              <h3 style={{ padding: 0 }}>{p.handle} {p.has_passcode && <span title="Has a passcode" aria-label="Has a passcode">🔒</span>}</h3>
              <div className="hint">{p.last_login ? `Last here ${timeAgo(p.last_login)}` : "New"}</div>
            </div>
          </button>
        ))}
        <button className="ccard" style={{ gridTemplateColumns: "auto 1fr", alignItems: "center", gap: 14, padding: 14, minHeight: 0, textAlign: "left", borderStyle: "dashed" }} onClick={() => enter(null)} disabled={busy}>
          <ProfileAvatar name="Guest" />
          <div style={{ minWidth: 0 }}>
            <h3 style={{ padding: 0, whiteSpace: "normal" }}>Continue as guest</h3>
            <div className="hint">No name, no passcode.{session.guest_items > 0 ? ` ${session.guest_items} items already here.` : ""}</div>
          </div>
        </button>
      </div>
      {err && !asking && <div className="hint" style={{ color: "var(--danger)", marginTop: 10 }} role="alert">{err}</div>}

      <div className="row" style={{ marginTop: 22 }}>
        <button className="btn primary" onClick={() => setModal("create")}>＋ Create a profile</button>
        <button className="btn" onClick={() => setModal("import")}>⇪ Import a profile file</button>
      </div>
      <p className="hint" style={{ marginTop: 14 }}>Guest chats aren't tied to any profile. You can turn the guest space into a profile later, and a profile can be saved to a file and taken off this device (Eject) at any time.</p>

      {modal === "create" && <CreateProfileModal onClose={() => setModal(null)} onDone={onSession} />}
      {modal === "import" && <ImportProfileModal onClose={() => setModal(null)} onDone={onSession} />}
      {asking && (
        <Modal title={`Welcome back, ${asking.handle}`} onClose={() => setAsking(null)}>
          <form onSubmit={(ev) => { ev.preventDefault(); enter(asking.id, pass); }} style={{ display: "grid", gap: 10 }}>
            <label>Passcode<input type="password" autoFocus autoComplete="current-password" value={pass} onChange={(e) => setPass(e.target.value)} /></label>
            {err && <div className="hint" style={{ color: "var(--danger)" }} role="alert">{err}</div>}
            <div className="row"><button className="btn primary" type="submit" disabled={busy || !pass}>{busy ? "Checking…" : "Open profile"}</button></div>
          </form>
        </Modal>
      )}
    </div>
  );
}
