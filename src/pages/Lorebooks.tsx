import { useEffect, useRef, useState } from "react";
import { api, type CharacterBook, type Lorebook } from "../api";
import BookEditor from "../components/BookEditor";
import { useToast } from "../components/ui";
import { emptyBook, readLorebook } from "../lib/lore";
import { errText, tokens } from "../lib/util";
import { useStore } from "../store";

/** Lorebooks: keyword-triggered lore, kept in your library and attached to as many characters as you like. */
export default function Lorebooks() {
  const { characters, refresh } = useStore();
  const toast = useToast();
  const [books, setBooks] = useState<Lorebook[] | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [book, setBook] = useState<CharacterBook>(emptyBook());
  const [dirty, setDirty] = useState(false);
  const file = useRef<HTMLInputElement>(null);

  const open = (b: Lorebook) => { setSel(b.id); setName(b.name); setBook({ ...emptyBook(), ...b.book }); setDirty(false); };
  const load = async (pick?: string) => {
    try {
      const l = await api.listLorebooks(); setBooks(l);
      const t = l.find((b) => b.id === (pick ?? sel)) ?? l[0];
      if (t) open(t); else { setSel(null); }
    } catch (e) { toast(errText(e), "err"); }
  };
  useEffect(() => { void load(); /* eslint-disable-next-line */ }, []);

  const save = async () => {
    try { const b = await api.saveLorebook({ id: sel ?? undefined, name, book }); toast("Saved", "ok"); await load(b.id); } catch (e) { toast(errText(e), "err"); }
  };
  const create = async () => {
    try { const b = await api.saveLorebook({ name: "New lorebook", book: emptyBook("New lorebook") }); await load(b.id); } catch (e) { toast(errText(e), "err"); }
  };
  const importFiles = async (files: FileList | null) => {
    for (const f of Array.from(files ?? [])) {
      try {
        const bk = readLorebook(await f.text(), f.name.replace(/\.[^.]+$/, ""));
        const b = await api.saveLorebook({ name: bk.name || f.name, book: bk });
        toast(`Imported “${b.name}” (${bk.entries.length} entries)`, "ok"); await load(b.id);
      } catch (e) { toast(`${f.name}: ${errText(e)}`, "err"); }
    }
  };
  const del = async () => {
    const used = characters.filter((c) => c.lorebooks?.includes(sel ?? "")).length;
    if (!sel || !window.confirm(`Delete “${name}”?${used ? ` It is attached to ${used} character${used === 1 ? "" : "s"}; they just lose it.` : ""}`)) return;
    try { await api.deleteLorebook(sel); setSel(null); await load(); await refresh(); } catch (e) { toast(errText(e), "err"); }
  };
  const attached = characters.filter((c) => sel && c.lorebooks?.includes(sel));

  if (books == null) return <div className="page sub">Loading…</div>;
  return (
    <div className="notes">
      <aside className="notes-list">
        <div className="row" style={{ marginBottom: 8 }}>
          <button className="btn primary grow" onClick={() => void create()}>＋ New lorebook</button>
          <button className="btn" onClick={() => file.current?.click()} title="Import a lorebook or world info .json">⇪</button>
          <input ref={file} type="file" hidden multiple accept=".json,application/json" aria-label="Import lorebooks" onChange={(e) => { void importFiles(e.target.files); e.target.value = ""; }} />
        </div>
        <div className="notes-items">
          {books.map((b) => (
            <button key={b.id} className={`note-item ${b.id === sel ? "on" : ""}`} onClick={() => open(b)}>
              <b>📚 {b.name}</b>
              <span className="hint">{(b.book?.entries?.length ?? 0)} entr{(b.book?.entries?.length ?? 0) === 1 ? "y" : "ies"} · {characters.filter((c) => c.lorebooks?.includes(b.id)).length} character(s)</span>
            </button>
          ))}
          {!books.length && <div className="hint" style={{ padding: 10 }}>No lorebooks yet. Make one, or import a world info file.</div>}
        </div>
      </aside>
      <section className="notes-main" style={{ overflow: "auto" }}>
        {sel ? (
          <>
            <div className="row" style={{ marginBottom: 6 }}>
              <input type="text" className="note-title grow" value={name} placeholder="Lorebook name" aria-label="Lorebook name" onChange={(e) => { setName(e.target.value); setDirty(true); }} />
              <button className="btn primary" disabled={!dirty || !name.trim()} onClick={() => void save()}>Save</button>
              <button className="btn danger" onClick={() => void del()} aria-label="Delete lorebook">🗑</button>
            </div>
            <div className="hint" style={{ marginBottom: 10 }}>
              Keyword-triggered lore: when a key appears in recent messages, its content joins the prompt. Attach this book to characters from their editor (Character → Lorebooks).
              {attached.length > 0 && <> Used by: {attached.map((c) => c.card.name).join(", ")}.</>}
              {" "}{book.entries.reduce((n, e) => n + tokens(e.content), 0)} token(s) of lore in total.
            </div>
            <BookEditor book={book} setBook={(b) => { setBook(b); setDirty(true); }} showName={false} />
          </>
        ) : (
          <div className="empty-state" style={{ margin: "auto" }}>
            <h3>Lorebooks</h3>
            <p className="sub" style={{ margin: "6px 0 14px" }}>World, places, people and rules your characters should know. Write once, attach to any character.</p>
            <button className="btn primary" onClick={() => void create()}>＋ Make a lorebook</button>
          </div>
        )}
      </section>
    </div>
  );
}
