import { blankEntry, type BookEntry, type CharacterBook } from "../api";
import { TagInput } from "./ui";
import { tokens } from "../lib/util";

const tk = (s: string) => `${tokens(s)} token(s)`;

/** Edits a lorebook: its settings and its entries (keywords, content, order). Used for a card's own book and for library lorebooks. */
export default function BookEditor({ book, setBook, onRemove, removeLabel = "Remove book", showName = true }: {
  book: CharacterBook; setBook: (b: CharacterBook) => void; onRemove?: () => void; removeLabel?: string; showName?: boolean;
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
    <button type="button" className="btn sm" onClick={() => setBook({ ...book, entries: [...book.entries, { ...blankEntry(), id: book.entries.length }] })}>＋ Add entry</button>
  </div>

  );
}
