import { blankEntry, type BookEntry, type CharacterBook } from "../api";
import { TagInput } from "./ui";
import { tokens } from "../lib/util";
import TokenatorHelper from "./TokenatorHelper";

const tk = (s: string) => `${tokens(s)} token(s)`;

/** Edits a lorebook: its settings and its entries (keywords, content, order). Used for a card's own book and for library lorebooks. */
export default function BookEditor({ book, setBook, onRemove, removeLabel = "Remove book", showName = true, onAdded }: {
  book: CharacterBook; setBook: (b: CharacterBook) => void; onRemove?: () => void; removeLabel?: string; showName?: boolean;
  /** Called with the book after Tokenator's entries were accepted and added, so the page can save it. */
  onAdded?: (b: CharacterBook) => void | Promise<void>;
}) {
  const setEntry = (i: number, patch: Partial<BookEntry>) =>
    setBook({ ...book, entries: book.entries.map((e, j) => (j === i ? { ...e, ...patch } : e)) });
  return (
  <div>
    <div className="row">
      {showName && <input type="text" style={{ maxWidth: 240 }} placeholder="Book name" value={book.name} onChange={(e) => setBook({ ...book, name: e.target.value })} />}
      <label className="row">Scan depth <input type="number" min={1} style={{ width: 80 }} value={book.scan_depth ?? ""} placeholder="4" onChange={(e) => setBook({ ...book, scan_depth: e.target.value ? Number(e.target.value) : null })} /></label>
      <label className="row">Token budget <input type="number" min={0} style={{ width: 90 }} value={book.token_budget ?? ""} placeholder="∞" onChange={(e) => setBook({ ...book, token_budget: e.target.value ? Number(e.target.value) : null })} /></label>
      {onRemove && <button type="button" className="btn danger sm" onClick={() => window.confirm("Remove the whole book?") && onRemove()}>{removeLabel}</button>}
    </div>
    <div className="tok">{book.entries.length} entr{book.entries.length === 1 ? "y" : "ies"}, {book.entries.reduce((n, e) => n + tokens(e.content), 0)} token(s)</div>
    {book.entries.map((e, i) => (
      <div className="entry" key={i}>
        <div className="row">
          <input type="text" style={{ flex: 1, minWidth: 140 }} placeholder="Entry name" value={e.name || e.comment} onChange={(ev) => setEntry(i, { name: ev.target.value, comment: ev.target.value })} />
          <label className="row"><input type="checkbox" checked={e.enabled} onChange={(ev) => setEntry(i, { enabled: ev.target.checked })} />On</label>
          <label className="row"><input type="checkbox" checked={e.constant} onChange={(ev) => setEntry(i, { constant: ev.target.checked })} />Always</label>
          <label className="row"><input type="checkbox" checked={e.selective} onChange={(ev) => setEntry(i, { selective: ev.target.checked })} />Needs 2nd key</label>
          <button type="button" className="btn danger sm" onClick={() => setBook({ ...book, entries: book.entries.filter((_, j) => j !== i) })}>✕</button>
        </div>
        <div style={{ display: "grid", gap: 8 }}>
          <TagInput value={e.keys} onChange={(v) => setEntry(i, { keys: v })} placeholder="Trigger keys (Enter to add)" />
          {e.selective && <TagInput value={e.secondary_keys} onChange={(v) => setEntry(i, { secondary_keys: v })} placeholder="Secondary keys" />}
          <textarea style={{ minHeight: 80 }} placeholder="Content inserted when triggered" value={e.content} onChange={(ev) => setEntry(i, { content: ev.target.value })} />
          <div className="row">
            <label className="row">Order <input type="number" style={{ width: 90 }} value={e.insertion_order} onChange={(ev) => setEntry(i, { insertion_order: Number(ev.target.value) || 0 })} /></label>
            <select style={{ width: "auto" }} value={e.position} onChange={(ev) => setEntry(i, { position: ev.target.value })}>
              <option value="before_char">Before description</option><option value="after_char">After scenario</option>
            </select>
            <span className="tok">{tk(e.content)}</span>
          </div>
        </div>
      </div>
    ))}
    <div className="row" style={{ marginTop: 8, alignItems: "flex-start" }}>
      <button type="button" className="btn sm" onClick={() => setBook({ ...book, entries: [...book.entries, { ...blankEntry(), id: book.entries.length }] })}>＋ Add entry</button>
      <div className="grow">
        <TokenatorHelper<{ entries: { name: string; keys: string[]; content: string }[] }> kind="lorebook" label="Tokenator: write entries for me"
          intro="Describe the world, place or people in your own words. Tokenator drafts a few entries with your own model and adds them after the ones you already have. Nothing changes until you accept, and you can edit every entry."
          placeholder="e.g. a lantern-lit tea district built along an old canal, with a gossiping tea seller and a library that closes at dusk"
          context={() => (book.name || book.entries.length) ? `Lorebook: ${book.name || "(unnamed)"}. Entries it already has, which must not be repeated: ${book.entries.map((e) => e.name || e.comment).filter(Boolean).join(", ") || "none"}.` : ""}
          preview={(r) => (<div style={{ display: "grid", gap: 6 }}>{r.entries.map((e, i) => (<div className="card" key={i} style={{ background: "var(--panel2)" }} data-testid="tokenator-lore-entry"><b>{e.name}</b><div className="row" style={{ gap: 4, margin: "4px 0" }}>{e.keys.map((k) => <span className="chip" key={k}>{k}</span>)}</div><div>{e.content}</div></div>))}<div className="tok">{r.entries.length} entr{r.entries.length === 1 ? "y" : "ies"} will be added after your own.</div></div>)}
          onAccept={async (r) => { const nb = { ...book, entries: [...book.entries, ...r.entries.map((e, i) => ({ ...blankEntry(), id: book.entries.length + i, name: e.name, comment: e.name, keys: e.keys, content: e.content }))] }; setBook(nb); await onAdded?.(nb); }} />
      </div>
    </div>
  </div>

  );
}
