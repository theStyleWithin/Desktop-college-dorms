import { useState } from "react";
import { api, displayName, mediaUrl, type Character } from "../api";
import { putCharDeco, useCharDeco } from "../lib/deco";
import { errText } from "../lib/util";
import { useStore } from "../store";
import DecoPicker, { type Look } from "./DecoPicker";
import { ProfileAvatar } from "./ProfileForms";
import { useToast } from "./ui";

/** A character's decorations: a nameplate, a moving profile background and an avatar wreath, chosen by hand or by the model. Saved as soon as they change. */
export default function CharDecoEditor({ char }: { char: Character | null }) {
  const { settings } = useStore();
  const toast = useToast();
  const map = useCharDeco();
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  if (!char) return <div className="hint">Save the character first, then you can dress them.</div>;
  const cur = map.get(char.id);
  const look: Look = { plate: cur?.plate ?? "none", bg: cur?.bg ?? "", wreath: cur?.wreath ?? "" };
  const name = displayName(char);
  const avatar = (size: number) => <ProfileAvatar name={name} size={size} src={char.media?.kind === "image" || char.media?.kind === "gif" ? mediaUrl(char) : null} frame={char.frame} />;
  const change = async (p: Partial<Look>) => {
    const n = { ...look, ...p };
    try { putCharDeco(char.id, await api.setCharDeco(char.id, n.plate, n.bg, n.wreath)); } catch (e) { toast(errText(e), "err"); }
  };
  const choose = async () => {
    setBusy(true);
    try { putCharDeco(char.id, await api.generateCharDeco(char.id)); } catch (e) { toast(errText(e), "err"); } finally { setBusy(false); }
  };
  return (
    <div className="char-deco" data-testid="char-deco">
      <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
        <span data-testid="char-deco-source" className="tok">{cur ? (cur.source === "ai" ? "Chosen by the model" : "Chosen by you") : "Not dressed yet"}</span>
        <button type="button" className="btn" disabled={busy} onClick={() => void choose()} title="Let the model choose a nameplate, background and wreath that suit them">✨ {busy ? "Choosing…" : "Let the model choose"}</button>
        <button type="button" className="btn" onClick={() => setOpen((o) => !o)} aria-expanded={open}>{open ? "Hide the choices" : "Choose myself…"}</button>
        {!settings.deco?.ai_pick && <small className="muted">To dress characters automatically, switch it on in Settings → Decorations.</small>}
      </div>
      {open && <DecoPicker value={look} animate={settings.deco?.animate !== false} avatar={avatar} name={name} onChange={(p) => void change(p)} />}
    </div>
  );
}
