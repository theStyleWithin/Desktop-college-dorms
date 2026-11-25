import { useCallback, useEffect, useRef, useState } from "react";
import { api, type SavedPrompt } from "../api";
import { Modal, useToast } from "./ui";
import { errText } from "../lib/util";

export const PROMPT_DRAG = "application/x-dorms-prompt";

/**
 * Prompts: saved pieces of text for roleplay. It opens as a drop-down in the side bar, so the chat you are in stays open.
 * Press and hold a prompt and drag it into the chat to send it as a message; click one to put it in the message box instead.
 */
export default function PromptsMenu() {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<SavedPrompt[] | null>(null);
  const [edit, setEdit] = useState<SavedPrompt | "new" | null>(null);
  const [q, setQ] = useState("");
  // the drawer: pulled down (taller) or out to the right (wider), the list floats over what is below it until it is pushed back
  const [pull, setPull] = useState<{ h: number; w: number; home: number } | null>(null);
  const slot = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => { if (!open) setPull(null); }, [open]);
  const grab = (e: React.PointerEvent, axis: "y" | "x") => {
    if (e.button !== 0 || !slot.current || !panel.current) return;
    e.preventDefault();
    const box = slot.current.getBoundingClientRect();
    const base = pull ?? { h: panel.current.offsetHeight, w: box.width, home: panel.current.offsetHeight };
    const x0 = e.clientX, y0 = e.clientY;
    const maxH = Math.max(base.home, window.innerHeight - box.top - 12), maxW = Math.max(box.width, window.innerWidth * 0.7 - box.left);
    let last = base;
    const move = (ev: PointerEvent) => {
      last = {
        home: base.home,
        h: axis === "y" ? Math.round(Math.min(maxH, Math.max(120, base.h + ev.clientY - y0))) : base.h,
        w: axis === "x" ? Math.round(Math.min(maxW, Math.max(box.width, base.w + ev.clientX - x0))) : base.w,
      };
      setPull(last);
    };
    const up = () => {
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); window.removeEventListener("pointercancel", up);
      document.body.classList.remove("resizing");
      if (last.h <= last.home + 4 && last.w <= box.width + 4) setPull(null); // pushed back in: the drawer is closed again
    };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up); window.addEventListener("pointercancel", up);
    document.body.classList.add("resizing");
  };
  const nudge = (e: React.KeyboardEvent, axis: "y" | "x") => {
    const k = axis === "y" ? ["ArrowUp", "ArrowDown"] : ["ArrowLeft", "ArrowRight"];
    if (!k.includes(e.key) || !slot.current || !panel.current) return;
    e.preventDefault();
    const box = slot.current.getBoundingClientRect();
    const base = pull ?? { h: panel.current.offsetHeight, w: box.width, home: panel.current.offsetHeight };
    const d = e.key === k[1] ? 40 : -40;
    const n = { ...base, h: axis === "y" ? Math.min(window.innerHeight - box.top - 12, Math.max(120, base.h + d)) : base.h, w: axis === "x" ? Math.min(window.innerWidth * 0.7 - box.left, Math.max(box.width, base.w + d)) : base.w };
    setPull(n.h <= n.home + 4 && n.w <= box.width + 4 ? null : n);
  };

  const load = useCallback(async () => {
    try { setItems(await api.listPrompts()); } catch (e) { toast(errText(e), "err"); setItems([]); }
  }, [toast]);
  useEffect(() => { if (open && items === null) void load(); }, [open, items, load]);

  /** Click: into the message box of the chat that is open; with no chat open, onto the clipboard. */
  const use = async (p: SavedPrompt) => {
    const detail = { body: p.body, handled: false };
    window.dispatchEvent(new CustomEvent("dorms-prompt-insert", { detail }));
    if (detail.handled) return;
    try { await navigator.clipboard.writeText(p.body); toast("No chat is open, so the prompt was copied.", "ok"); } catch { toast("Open a chat first, then click the prompt.", "err"); }
  };
  const copy = async (p: SavedPrompt) => { try { await navigator.clipboard.writeText(p.body); toast("Copied", "ok"); } catch { toast("Couldn't copy it.", "err"); } };
  const del = async (p: SavedPrompt) => {
    if (!window.confirm(`Delete the prompt “${p.title}”?`)) return;
    try { await api.deletePrompt(p.id); await load(); } catch (e) { toast(errText(e), "err"); }
  };
  const shown = (items ?? []).filter((p) => !q.trim() || `${p.title} ${p.tag}`.toLowerCase().includes(q.trim().toLowerCase()));

  return (
    <div className="prompts">
      <button className={`nav${open ? " on" : ""}`} data-testid="prompts-toggle" aria-expanded={open} aria-controls="prompts-panel" onClick={() => setOpen((o) => !o)}>
        <span aria-hidden>📜</span>Prompts<span className="caret" aria-hidden>{open ? "▴" : "▾"}</span>
      </button>
      {open && (
        <div className="prompts-slot" ref={slot} style={pull ? { height: pull.home } : undefined}>
          <div className={`prompts-panel${pull ? " pulled" : ""}`} ref={panel} id="prompts-panel" data-testid="prompts-panel" style={pull ? { height: pull.h, width: pull.w } : undefined}>
            <div className="prompts-scroll">
            <button className="btn sm primary" style={{ width: "100%" }} onClick={() => setEdit("new")}>＋ New prompt</button>
            {items && items.length > 4 && <input type="search" placeholder="Search prompts…" aria-label="Search prompts" value={q} onChange={(e) => setQ(e.target.value)} />}
            {items === null && <div className="hint">Loading…</div>}
            {items && items.length === 0 && <div className="hint">No prompts yet. Add one, then drag it into a chat to send it, or click it to put it in your message box.</div>}
            {shown.map((p) => (
              <div key={p.id} className="prompt-row" draggable data-prompt={p.title} title={`${p.title}\n\nDrag into the chat to send it. Click to put it in your message box.`}
                onDragStart={(e) => { e.dataTransfer.setData(PROMPT_DRAG, JSON.stringify({ title: p.title, body: p.body })); e.dataTransfer.effectAllowed = "copy"; }}
                onClick={() => void use(p)}>
                <div className="prompt-title">{p.title}</div>
                {p.tag && <span className="chip">{p.tag}</span>}
                <div className="prompt-acts">
                  <button className="iconbtn" aria-label={`Copy ${p.title}`} title="Copy" onClick={(e) => { e.stopPropagation(); void copy(p); }}>⧉</button>
                  <button className="iconbtn" aria-label={`Edit ${p.title}`} title="Edit" onClick={(e) => { e.stopPropagation(); setEdit(p); }}>✎</button>
                  <button className="iconbtn" aria-label={`Delete ${p.title}`} title="Delete" onClick={(e) => { e.stopPropagation(); void del(p); }}>🗑</button>
                </div>
              </div>
            ))}
            </div>
            <div className="drawer-pull" role="separator" aria-orientation="horizontal" aria-label="Pull the drawer down to see more prompts" title="Pull down for more · double-click to close the drawer" data-testid="drawer-pull" tabIndex={0}
              onPointerDown={(e) => grab(e, "y")} onDoubleClick={() => setPull(null)} onKeyDown={(e) => nudge(e, "y")}><span /></div>
            <div className="drawer-edge" role="separator" aria-orientation="vertical" aria-label="Stretch the drawer to the right" title="Drag right to widen · double-click to close the drawer" data-testid="drawer-edge" tabIndex={0}
              onPointerDown={(e) => grab(e, "x")} onDoubleClick={() => setPull(null)} onKeyDown={(e) => nudge(e, "x")} />
          </div>
        </div>
      )}
      {edit && <PromptEditor initial={edit === "new" ? null : edit} onClose={() => setEdit(null)} onSaved={async () => { setEdit(null); await load(); }} />}
    </div>
  );
}

function PromptEditor({ initial, onClose, onSaved }: { initial: SavedPrompt | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [title, setTitle] = useState(initial?.title ?? "");
  const [tag, setTag] = useState(initial?.tag ?? "");
  const [body, setBody] = useState(initial?.body ?? "");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try { await api.savePrompt({ id: initial?.id, title, tag, body }); onSaved(); } catch (e) { toast(errText(e), "err"); setBusy(false); }
  };
  return (
    <Modal title={initial ? "Edit prompt" : "New prompt"} onClose={onClose} wide>
      <div style={{ display: "grid", gap: 10 }}>
        <input type="text" autoFocus placeholder="Title, e.g. Soft redirect" aria-label="Prompt title" maxLength={100} value={title} onChange={(e) => setTitle(e.target.value)} />
        <input type="text" placeholder="Label (optional), e.g. Advanced Prompt" aria-label="Prompt label" maxLength={30} value={tag} onChange={(e) => setTag(e.target.value)} />
        <textarea rows={10} placeholder="The text that is sent to the chat…" aria-label="Prompt text" value={body} onChange={(e) => setBody(e.target.value)} />
        <div className="hint">Drag the prompt into a chat to send this text as your message, or click it to put it in your message box.</div>
        <div className="row"><button className="btn primary" disabled={busy || !title.trim() || !body.trim()} onClick={() => void save()}>Save prompt</button><button className="btn" onClick={onClose}>Cancel</button></div>
      </div>
    </Modal>
  );
}
