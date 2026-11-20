import { useState } from "react";
import { api, type ProfileInfo, type SessionState } from "../api";
import { errText } from "../lib/util";
import { CreateProfileModal, ProfileAvatar } from "./ProfileForms";
import { Modal, useToast } from "./ui";

/** Shown on the start screen right after an account was hidden: make another account, use the guest space, or pick one that is there. */
export function HiddenNotice({ name, others, onSession, onClose }: { name: string; others: number; onSession: (s: SessionState) => void; onClose: () => void }) {
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const guest = async () => { setBusy(true); try { onSession(await api.signIn(null)); onClose(); } catch (e) { toast(errText(e), "err"); setBusy(false); } };
  if (creating) return <CreateProfileModal onClose={() => setCreating(false)} onDone={(s) => { onSession(s); onClose(); }} />;
  return (
    <Modal title={`“${name}” is hidden`} onClose={onClose}>
      <div data-testid="hidden-notice" style={{ display: "grid", gap: 12 }}>
        {others > 0
          ? <p style={{ margin: 0 }}>It no longer shows on this start screen. Choose another account from the list, or create a new one.</p>
          : <p style={{ margin: 0 }}>It no longer shows on this start screen, and it was the only account here. Create another account to carry on, or use the guest space (no name, no passcode).</p>}
        <p className="hint" style={{ margin: 0 }}>Nothing was deleted. You can show “{name}” again in Settings → Profile → Hidden accounts. Hiding keeps an account out of sight; a passcode is what locks it.</p>
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <button className="btn primary" onClick={() => setCreating(true)} data-testid="hn-create">＋ Create a new account</button>
          {others === 0 && <button className="btn" disabled={busy} onClick={() => void guest()} data-testid="hn-guest">Use as guest</button>}
          {others > 0 && <button className="btn" onClick={onClose} data-testid="hn-choose">Choose an account</button>}
        </div>
      </div>
    </Modal>
  );
}

/** Settings → Profile: accounts that were hidden from the start screen, each with a way to show it again. */
export function HiddenAccountsList({ hidden, onSession }: { hidden: ProfileInfo[]; onSession: (s: SessionState) => void }) {
  const toast = useToast();
  const [asking, setAsking] = useState<ProfileInfo | null>(null);
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);
  if (!hidden.length) return null;
  const show = async (p: ProfileInfo, passcode?: string) => {
    setBusy(true);
    try { onSession(await api.unhideProfile(p.id, passcode)); setAsking(null); setPass(""); toast(`${p.display_name || p.handle} is on the start screen again.`, "ok"); } catch (e) { toast(errText(e), "err"); } finally { setBusy(false); }
  };
  return (
    <div className="card" data-testid="hidden-accounts">
      <h3>Hidden accounts</h3>
      <p className="sub" style={{ margin: "4px 0 10px" }}>These accounts don't show on the start screen. Nothing was deleted. Hiding keeps an account out of sight; it is not a lock, so give an account a passcode if it needs one. An account with a passcode asks for it before it is shown again.</p>
      <div style={{ display: "grid", gap: 8 }}>
        {hidden.map((p) => (
          <div className="row" key={p.id} data-hidden-account={p.handle} style={{ gap: 10 }}>
            <ProfileAvatar name={p.display_name || p.handle} size={36} src={null} />
            <div className="grow"><b>{p.display_name || p.handle}</b>{p.has_passcode && <span className="hint"> · has a passcode</span>}</div>
            <button className="btn sm" disabled={busy} onClick={() => (p.has_passcode ? setAsking(p) : void show(p))} data-testid="ha-show">Show again</button>
          </div>
        ))}
      </div>
      {asking && (
        <Modal title={`Show ${asking.display_name || asking.handle} again`} onClose={() => { setAsking(null); setPass(""); }}>
          <form onSubmit={(e) => { e.preventDefault(); void show(asking, pass); }} style={{ display: "grid", gap: 10 }}>
            <label className="f2"><span>Passcode for this account</span><input type="password" autoFocus value={pass} onChange={(e) => setPass(e.target.value)} aria-label="Passcode" /></label>
            <div className="row"><button className="btn primary" type="submit" disabled={busy || !pass}>Show again</button><button className="btn ghost" type="button" onClick={() => { setAsking(null); setPass(""); }}>Cancel</button></div>
          </form>
        </Modal>
      )}
    </div>
  );
}
