import { sget, sset } from "../lib/scoped";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, type Shelf, type ShelfFolder, type ShelfKind } from "../api";
import { errText } from "../lib/util";
import { useToast } from "./ui";

const FOLD_KEY = "dorms.shelf.folded";
const readFolded = (): Record<string, boolean> => { try { return JSON.parse(sget(FOLD_KEY) || "{}") ?? {}; } catch { return {}; } };

/** The folders of lorebooks or playbooks, and what is in them. */
export function useShelf(kind: ShelfKind) {
  const toast = useToast();
  const [shelf, setShelf] = useState<Shelf>({ folders: [], items: {} });
  /** a new folder being named (inside `parent`, or at the top) */
  const [creating, setCreating] = useState<{ parent: string | null; name: string } | null>(null);
  const reload = useCallback(async () => { try { setShelf(await api.getShelf(kind)); } catch (e) { toast(errText(e), "err"); } }, [kind, toast]);
  useEffect(() => { void reload(); }, [reload]);
  const run = async (f: () => Promise<unknown>) => { try { await f(); await reload(); return true; } catch (e) { toast(errText(e), "err"); return false; } };
  return {
    shelf, reload, creating, setCreating,
    make: (name: string, parent: string | null) => run(() => api.createShelfFolder(kind, name, parent)),
    rename: (id: string, name: string) => run(() => api.renameShelfFolder(id, name)),
    moveFolder: (id: string, parent: string | null) => run(() => api.moveShelfFolder(id, parent)),
    remove: (id: string) => run(() => api.deleteShelfFolder(id)),
    put: (item: string, folder: string | null) => run(() => api.moveToShelfFolder(kind, item, folder)),
  };
}
type ShelfApi = ReturnType<typeof useShelf>;

/** "Move to…" with the folders indented by how deep they are. */
function MoveSelect({ folders, value, exclude, label, onPick }: { folders: ShelfFolder[]; value: string | null; exclude?: Set<string>; label: string; onPick: (id: string | null) => void }) {
  const rows: { f: ShelfFolder; depth: number }[] = [];
  const walk = (parent: string | null, depth: number) => folders.filter((f) => f.parent === parent).forEach((f) => { rows.push({ f, depth }); walk(f.id, depth + 1); });
  walk(null, 0);
  return (
    <select className="shelf-move" aria-label={label} value="" onChange={(e) => { const v = e.target.value; if (v === "__top") onPick(null); else if (v) onPick(v); }} onClick={(e) => e.stopPropagation()}>
      <option value="">Move to…</option>
      {value !== null && <option value="__top">Not in a folder</option>}
      {rows.filter((r) => r.f.id !== value && !exclude?.has(r.f.id)).map((r) => <option key={r.f.id} value={r.f.id}>{"  ".repeat(r.depth)}📁 {r.f.name}</option>)}
    </select>
  );
}

const within = (folders: ShelfFolder[], id: string): Set<string> => {
  const out = new Set([id]); let grew = true;
  while (grew) { grew = false; folders.forEach((f) => { if (f.parent && out.has(f.parent) && !out.has(f.id)) { out.add(f.id); grew = true; } }); }
  return out;
};

/** The button that makes a folder at the top. */
export function NewFolderButton({ api: s }: { api: ShelfApi }) {
  return <button className="btn" data-testid="shelf-new-folder" title="Make a folder to keep things tidy" onClick={() => s.setCreating({ parent: null, name: "" })}>📁 New folder</button>;
}

/** Items in their folders: drag one onto a folder (or use "Move to…"), rename and delete folders, folders inside folders. */
export default function ShelfView<T extends { id: string; name: string }>({ items, api: s, kind, renderItem, layout = "list", empty }: {
  items: T[]; api: ShelfApi; kind: ShelfKind; renderItem: (item: T) => ReactNode; layout?: "list" | "grid"; empty?: ReactNode;
}) {
  const { shelf } = s;
  const [folded, setFolded] = useState(readFolded);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const toggle = (id: string) => setFolded((f) => { const n = { ...f, [id]: !f[id] }; try { sset(FOLD_KEY, JSON.stringify(n)); } catch { /* not remembered */ } return n; });
  const sorted = [...items].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  const inFolder = (fid: string | null) => sorted.filter((i) => (shelf.items[i.id] ?? null) === fid);
  const count = (fid: string): number => inFolder(fid).length + shelf.folders.filter((f) => f.parent === fid).reduce((n, f) => n + count(f.id), 0);
  const drop = (e: React.DragEvent, target: string | null) => {
    e.preventDefault(); e.stopPropagation();
    const item = e.dataTransfer.getData("application/x-shelf-item"), fold = e.dataTransfer.getData("application/x-shelf-folder");
    if (item) void s.put(item, target); else if (fold && fold !== target) void s.moveFolder(fold, target);
  };
  const row = (i: T) => (
    <div key={i.id} className="shelf-item" draggable data-shelf-item={i.id} onDragStart={(e) => { e.dataTransfer.setData("application/x-shelf-item", i.id); e.dataTransfer.effectAllowed = "move"; }}>
      {renderItem(i)}
      {shelf.folders.length > 0 && <MoveSelect folders={shelf.folders} value={shelf.items[i.id] ?? null} label={`Move ${i.name} to a folder`} onPick={(f) => void s.put(i.id, f)} />}
    </div>
  );
  const finishNew = (save: boolean) => { const c = s.creating; s.setCreating(null); if (save && c && c.name.trim()) void s.make(c.name, c.parent); };
  const newBox = (parent: string | null): ReactNode => s.creating && s.creating.parent === parent ? (
    <input autoFocus className="shelf-rename" data-testid="shelf-new-name" placeholder="Folder name" maxLength={40} aria-label="New folder name" value={s.creating.name}
      onChange={(e) => s.setCreating({ parent, name: e.target.value })} onBlur={() => finishNew(true)} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); else if (e.key === "Escape") { e.stopPropagation(); finishNew(false); } }} />
  ) : null;
  const block = (f: ShelfFolder): ReactNode => {
    const open = !folded[f.id];
    return (
      <div key={f.id} className="shelf-folder" data-shelf-folder={f.name} onDragOver={(e) => e.preventDefault()} onDrop={(e) => drop(e, f.id)}>
        <div className="shelf-head" draggable onDragStart={(e) => { e.stopPropagation(); e.dataTransfer.setData("application/x-shelf-folder", f.id); e.dataTransfer.effectAllowed = "move"; }}>
          {renaming?.id === f.id
            ? <input autoFocus className="shelf-rename" value={renaming.name} maxLength={40} aria-label="Folder name" onChange={(e) => setRenaming({ id: f.id, name: e.target.value })} onBlur={() => { const r = renaming; setRenaming(null); if (r && r.name.trim() && r.name.trim() !== f.name) void s.rename(f.id, r.name); }} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); else if (e.key === "Escape") { e.stopPropagation(); setRenaming(null); } }} />
            : <button className="shelf-title" aria-expanded={open} onClick={() => toggle(f.id)} onDoubleClick={() => setRenaming({ id: f.id, name: f.name })}>{open ? "📂" : "📁"} {f.name} <span className="m-count">{count(f.id)}</span></button>}
          <button className="iconbtn" aria-label={`Rename ${f.name}`} title="Rename" onClick={() => setRenaming({ id: f.id, name: f.name })}>✎</button>
          <button className="iconbtn" aria-label={`New folder inside ${f.name}`} title="New folder inside" onClick={() => { s.setCreating({ parent: f.id, name: "" }); if (folded[f.id]) toggle(f.id); }}>＋</button>
          <MoveSelect folders={shelf.folders} value={f.parent} exclude={within(shelf.folders, f.id)} label={`Move folder ${f.name}`} onPick={(p) => void s.moveFolder(f.id, p)} />
          <button className="iconbtn" aria-label={`Delete folder ${f.name}`} title="Delete the folder (what is in it moves up, nothing is deleted)" onClick={() => { if (window.confirm(`Delete the folder “${f.name}”?\n\nWhat is inside moves up. Nothing else is deleted.`)) void s.remove(f.id); }}>🗑</button>
        </div>
        {open && (
          <div className="shelf-body">
            {newBox(f.id)}
            {shelf.folders.filter((c) => c.parent === f.id).map(block)}
            <div className={layout === "grid" ? "shelf-grid" : "shelf-list"}>{inFolder(f.id).map(row)}</div>
            {count(f.id) === 0 && <div className="hint">Empty. Drag something here, or use “Move to…”.</div>}
          </div>
        )}
      </div>
    );
  };
  const loose = inFolder(null);
  return (
    <div className="shelf" data-shelf={kind}>
      {newBox(null)}
      {shelf.folders.filter((f) => f.parent === null).map(block)}
      <div onDragOver={(e) => e.preventDefault()} onDrop={(e) => drop(e, null)}>
        {shelf.folders.length > 0 && loose.length > 0 && <div className="hint shelf-loose">Not in a folder</div>}
        <div className={layout === "grid" ? "shelf-grid" : "shelf-list"}>{loose.map(row)}</div>
      </div>
      {items.length === 0 && empty}
    </div>
  );
}
