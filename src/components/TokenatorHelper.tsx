import { useState, type ReactNode } from "react";
import { api } from "../api";
import { useToast } from "./ui";
import { modelName } from "../lib/tokenator";
import { errText } from "../lib/util";
import { useStore } from "../store";

/**
 * Tokenator's "write it for me" box, for any editor: it starts as one button, opens to a place for rough notes, asks the person's own
 * model, and shows what it wrote. Nothing changes until the person presses Accept. `kind` says what to write (the backend knows each one).
 */
export default function TokenatorHelper<T>({ kind, label, intro, placeholder, preview, onAccept, startOpen, context }: {
  kind: "prompt" | "lorebook";
  label: string;
  intro: string;
  placeholder: string;
  preview: (r: T) => ReactNode;
  onAccept: (r: T) => void;
  startOpen?: boolean;
  /** anything the editor already holds that helps (shown to the model after the instructions) */
  context?: () => string;
}) {
  const { settings } = useStore();
  const toast = useToast();
  const model = modelName(settings);
  const [open, setOpen] = useState(!!startOpen);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<T | null>(null);
  const run = async () => {
    setBusy(true); setRes(null);
    try { setRes((await api.tokenatorMake(kind, notes, context?.() ?? "")) as T); } catch (e) { toast(errText(e), "err"); } finally { setBusy(false); }
  };
  if (!open) return <button type="button" className="btn sm" style={{ justifySelf: "start" }} onClick={() => setOpen(true)} data-testid={`tokenator-make-${kind}`}>✂️ {label}</button>;
  return (
    <div className="card" data-testid={`tokenator-helper-${kind}`} style={{ display: "grid", gap: 8 }}>
      <div className="row"><b className="grow">✂️ Tokenator</b><button type="button" className="btn ghost sm" onClick={() => setOpen(false)} aria-label="Close Tokenator">✕</button></div>
      <div className="hint">{intro}</div>
      <textarea rows={3} maxLength={2000} value={notes} placeholder={placeholder} aria-label="What do you want?" data-testid="tokenator-make-notes" onChange={(e) => setNotes(e.target.value)} />
      <div className="row" style={{ gap: 8 }}>
        <button type="button" className="btn primary sm" disabled={!model || !notes.trim() || busy} onClick={() => void run()} data-testid="tokenator-make-go">{busy ? "Working…" : "Write a draft"}</button>
        <span className="tok grow">{model ? `Uses ${model}.` : "No model is set up, so Tokenator can't write yet. Set one up in Settings → Models."}</span>
      </div>
      {res !== null && (
        <div data-testid="tokenator-make-result" style={{ display: "grid", gap: 6 }}>
          {preview(res)}
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="btn primary sm" data-testid="tokenator-make-accept" onClick={() => { onAccept(res); setRes(null); setOpen(false); setNotes(""); }}>Accept</button>
            <button type="button" className="btn sm" disabled={busy} onClick={() => void run()}>Try again</button>
            <button type="button" className="btn ghost sm" onClick={() => setRes(null)}>Discard</button>
          </div>
        </div>
      )}
    </div>
  );
}
