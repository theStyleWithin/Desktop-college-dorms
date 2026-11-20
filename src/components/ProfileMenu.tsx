import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../api";
import { TEXT_SCALE_MAX, TEXT_SCALE_MIN, useTextScale } from "../lib/textScale";
import { errText } from "../lib/util";
import { useStore } from "../store";
import { Modal, useToast } from "./ui";

const HIDE_KEY = "dorms.profile.hidden";

/** Whether the profile row at the bottom of the side bar is hidden (kept on this device). */
export function useProfileHidden(): [boolean, (v: boolean) => void] {
  const read = () => { try { return localStorage.getItem(HIDE_KEY) === "1"; } catch { return false; } };
  const [hidden, setHidden] = useState(read);
  useEffect(() => { const f = () => setHidden(read()); window.addEventListener("dorms-profile-hidden", f); return () => window.removeEventListener("dorms-profile-hidden", f); }, []);
  const set = (v: boolean) => {
    try { if (v) localStorage.setItem(HIDE_KEY, "1"); else localStorage.removeItem(HIDE_KEY); } catch { /* storage unavailable: it still applies until the app is closed */ }
    setHidden(v); window.dispatchEvent(new Event("dorms-profile-hidden"));
  };
  return [hidden, set];
}

/** The small menu that opens when you right-click your profile at the bottom of the side bar. */
export function ProfileMenu({ x, y, onClose, onQuick, onSwitch, onHide }: { x: number; y: number; onClose: () => void; onQuick: () => void; onSwitch: () => void; onHide: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  useEffect(() => {
    const el = ref.current; if (!el) return;
    const r = el.getBoundingClientRect();
    // open upwards from the pointer when there is no room below, and never off the screen
    setPos({ x: Math.max(6, Math.min(x, window.innerWidth - r.width - 6)), y: Math.max(6, Math.min(y, window.innerHeight - r.height - 6)) });
    el.querySelector<HTMLButtonElement>("button")?.focus();
  }, [x, y]);
  useEffect(() => {
    const down = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => {
      const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
      const i = items.indexOf(document.activeElement as HTMLButtonElement);
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); }
      else if (e.key === "ArrowDown") { e.preventDefault(); e.stopPropagation(); items[(i + 1) % items.length]?.focus(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); e.stopPropagation(); items[(i - 1 + items.length) % items.length]?.focus(); }
    };
    window.addEventListener("mousedown", down, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("blur", onClose);
    return () => { window.removeEventListener("mousedown", down, true); window.removeEventListener("keydown", key, true); window.removeEventListener("blur", onClose); };
  }, [onClose]);
  const pick = (f: () => void) => () => { onClose(); f(); };
  return createPortal(
    <div ref={ref} className="ctx-menu" role="menu" aria-label="Profile options" data-testid="profile-menu" style={{ left: pos.x, top: pos.y }} onContextMenu={(e) => e.preventDefault()}>
      <button role="menuitem" data-testid="pm-quick" onClick={pick(onQuick)}>⚡ Quick settings</button>
      <button role="menuitem" data-testid="pm-switch" onClick={pick(onSwitch)}>🔁 Switch accounts</button>
      <button role="menuitem" data-testid="pm-hide" onClick={pick(onHide)}>🙈 Hide profile</button>
    </div>,
    document.body,
  );
}

/** The settings people reach for most, in one small window. */
export function QuickSettings({ onClose }: { onClose: () => void }) {
  const { settings, setSettings, personas, refresh, go } = useStore();
  const toast = useToast();
  const [scale, setScale] = useTextScale();
  const [hidden, setHidden] = useProfileHidden();
  const save = async (patch: Partial<typeof settings>) => { try { await setSettings({ ...settings, ...patch }); } catch (e) { toast(errText(e), "err"); } };
  return (
    <Modal title="Quick settings" onClose={onClose}>
      <div data-testid="quick-settings" style={{ display: "grid", gap: 14 }}>
        <div>
          <b>Theme</b>
          <div className="row" style={{ marginTop: 6 }}>
            {[["dusk", "Dusk"], ["midnight", "Midnight"], ["paper", "Paper (light)"]].map(([k, l]) => (
              <button key={k} className={`chip ${settings.theme === k ? "on" : ""}`} aria-pressed={settings.theme === k} onClick={() => { document.documentElement.dataset.theme = k; void save({ theme: k }); }}>{l}</button>
            ))}
          </div>
        </div>
        <label className="f2"><span><b>Text size in chats</b> <small className="tok">{Math.round(scale * 100)}%</small></span>
          <input type="range" min={TEXT_SCALE_MIN} max={TEXT_SCALE_MAX} step={0.05} value={scale} aria-label="Text size in chats" onChange={(e) => setScale(Number(e.target.value))} /></label>
        <label className="check" style={{ display: "flex", gap: 8 }}>
          <input type="checkbox" checked={settings.deco?.animate !== false} onChange={(e) => void save({ deco: { ...settings.deco, animate: e.target.checked } })} />
          <span>Animate decorations and moving backdrops</span>
        </label>
        {personas.length > 0 && (
          <label className="f2"><span><b>Playing as</b></span>
            <select value={settings.active_persona} aria-label="Playing as" onChange={(e) => { void api.setActivePersona(e.target.value || null).then(refresh).catch((er) => toast(errText(er), "err")); }}>
              <option value="">Myself ({settings.user_name || "You"})</option>
              {personas.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select></label>
        )}
        <label className="check" style={{ display: "flex", gap: 8 }}>
          <input type="checkbox" checked={!hidden} onChange={(e) => setHidden(!e.target.checked)} />
          <span>Show my profile at the bottom of the side bar</span>
        </label>
        <div className="row"><button className="btn" onClick={() => { onClose(); go({ page: "settings" }); }}>All settings…</button><button className="btn primary" onClick={onClose}>Done</button></div>
      </div>
    </Modal>
  );
}
