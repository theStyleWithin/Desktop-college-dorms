import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type Note } from "../api";
import { useToast } from "../components/ui";
import { errText, timeAgo } from "../lib/util";

const words = (t: string) => (t.trim() ? t.trim().split(/\s+/).length : 0);
const titleOf = (n: Pick<Note, "title" | "body">) => n.title.trim() || n.body.trim().split("\n")[0].slice(0, 60) || "Untitled note";

/**
 * Notes: free writing with no length limit, like a card's creator notes but a click away. Saves by itself a moment
 * after you stop typing.
 */
export default function Notes() {
  const toast = useToast();
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [draft, setDraft] = useState<{ title: string; body: string; pinned: boolean } | null>(null);
  const [state, setState] = useState<"saved" | "saving" | "dirty">("saved");
  const timer = useRef<number | undefined>(undefined);
  const latest = useRef({ sel, draft });
  latest.current = { sel, draft };

  const load = useCallback(async () => {
    try { const l = await api.listNotes(); setNotes(l); return l; } catch (e) { toast(errText(e), "err"); return [] as Note[]; }
  }, [toast]);
  useEffect(() => { void load().then((l) => { if (l[0]) open(l[0]); }); /* eslint-disable-next-line */ }, []);

  const flush = useCallback(async () => {
    window.clearTimeout(timer.current);
    const { sel: id, draft: d } = latest.current;
    if (!d || id == null) return;
    setState("saving");
    try {
      const saved = await api.saveNote({ id, ...d });
      setNotes((l) => (l ?? []).map((n) => (n.id === saved.id ? saved : n)).sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updated_at - a.updated_at));
      setState(latest.current.draft === d ? "saved" : "dirty");
    } catch (e) { toast(errText(e), "err"); setState("dirty"); }
  }, [toast]);
  // leaving the page never loses typing
  useEffect(() => () => { window.clearTimeout(timer.current); const { sel: id, draft: d } = latest.current; if (d && id) void api.saveNote({ id, ...d }); }, []);

  function open(n: Note) { setSel(n.id); setDraft({ title: n.title, body: n.body, pinned: n.pinned }); setState("saved"); }
  const edit = (p: Partial<{ title: string; body: string; pinned: boolean }>) => {
    setDraft((d) => (d ? { ...d, ...p } : d)); setState("dirty");
    window.clearTimeout(timer.current); timer.current = window.setTimeout(() => void flush(), 700);
  };
  const pick = async (n: Note) => { if (n.id === sel) return; await flush(); open(n); };
  const create = async () => {
    await flush();
    try { const n = await api.saveNote({ title: "", body: "", pinned: false }); setNotes((l) => [n, ...(l ?? [])]); open(n); } catch (e) { toast(errText(e), "err"); }
  };
  const remove = async () => {
    const n = notes?.find((x) => x.id === sel);
    if (!n || !window.confirm(`Delete "${titleOf(n)}"? This can't be undone.`)) return;
    window.clearTimeout(timer.current);
    try { await api.deleteNote(n.id); const l = (notes ?? []).filter((x) => x.id !== n.id); setNotes(l); if (l[0]) open(l[0]); else { setSel(null); setDraft(null); } } catch (e) { toast(errText(e), "err"); }
  };

  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (notes ?? []).filter((n) => !t || n.title.toLowerCase().includes(t) || n.body.toLowerCase().includes(t));
  }, [notes, q]);

  if (notes == null) return <div className="page sub">Loading…</div>;
  return (
    <div className="notes">
      <aside className="notes-list">
        <div className="row" style={{ marginBottom: 8 }}>
          <button className="btn primary grow" onClick={() => void create()}>＋ New note</button>
        </div>
        <input type="search" placeholder="Search notes…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search notes" />
        <div className="notes-items">
          {shown.map((n) => (
            <button key={n.id} className={`note-item ${n.id === sel ? "on" : ""}`} onClick={() => void pick(n)}>
              <b>{n.pinned && "📌 "}{titleOf(n.id === sel && draft ? { title: draft.title, body: draft.body } : n)}</b>
              <span className="hint">{((n.id === sel && draft ? draft.body : n.body).replace(/\s+/g, " ").trim().slice(0, 70)) || "Empty"}</span>
              <span className="hint">{timeAgo(n.updated_at)}</span>
            </button>
          ))}
          {!shown.length && <div className="hint" style={{ padding: 10 }}>{notes.length ? "No notes match." : "No notes yet. Plans, lore, character ideas, anything."}</div>}
        </div>
      </aside>
      <section className="notes-main">
        {draft && sel ? (
          <>
            <div className="row" style={{ marginBottom: 8 }}>
              <input type="text" className="note-title grow" placeholder="Title" value={draft.title} onChange={(e) => edit({ title: e.target.value })} aria-label="Note title" />
              <button className={`btn sm ${draft.pinned ? "primary" : ""}`} aria-pressed={draft.pinned} onClick={() => edit({ pinned: !draft.pinned })} title="Keep at the top">📌</button>
              <button className="btn sm danger" onClick={() => void remove()} aria-label="Delete note">🗑</button>
            </div>
            <textarea className="note-body" placeholder="Write anything. There is no length limit." value={draft.body} onChange={(e) => edit({ body: e.target.value })} aria-label="Note text" spellCheck />
            <div className="tok" style={{ marginTop: 6 }}>
              {draft.body.length.toLocaleString()} characters · {words(draft.body).toLocaleString()} words · {state === "saved" ? "Saved" : state === "saving" ? "Saving…" : "Unsaved…"}
            </div>
          </>
        ) : (
          <div className="empty-state" style={{ margin: "auto" }}>
            <h3>Notes</h3>
            <p className="sub" style={{ margin: "6px 0 14px" }}>A place to write without limits, like a character's creator notes, but always within reach.</p>
            <button className="btn primary" onClick={() => void create()}>＋ Write your first note</button>
          </div>
        )}
      </section>
    </div>
  );
}
