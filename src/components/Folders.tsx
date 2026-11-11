import { useRef, useState } from "react";
import { api, folderCover, type Folder } from "../api";
import { frameStyle } from "./Art";
import FrameEditor from "./FrameEditor";
import { Modal, useToast } from "./ui";
import { errText, hue } from "../lib/util";

export const DRAG_TYPE = "application/x-dorms-characters";
export const DRAG_FOLDER = "application/x-dorms-folder";
export const isFolderDrag = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes(DRAG_FOLDER);
export const draggedFolder = (e: React.DragEvent): string => e.dataTransfer.getData(DRAG_FOLDER);

/** Folders in tree order (a folder, then what is inside it), each with how deep it is and its full path. */
export function folderTree(folders: Folder[]): { f: Folder; depth: number; path: string }[] {
  const ids = new Set(folders.map((f) => f.id));
  const kids = (p: string | null) => folders.filter((f) => ((f.parent && ids.has(f.parent) ? f.parent : null) === p));
  const out: { f: Folder; depth: number; path: string }[] = [];
  const walk = (p: string | null, depth: number, path: string, seen: Set<string>) => {
    for (const f of kids(p)) { if (seen.has(f.id)) continue; const pp = path ? `${path} › ${f.name}` : f.name; out.push({ f, depth, path: pp }); walk(f.id, depth + 1, pp, new Set(seen).add(f.id)); }
  };
  walk(null, 0, "", new Set());
  return out;
}
/** Everything inside a folder, at any depth (not the folder itself). */
export function insideOf(folders: Folder[], id: string): Set<string> {
  const out = new Set<string>(); const stack = [id];
  while (stack.length) { const c = stack.pop()!; for (const f of folders) if (f.parent === c && !out.has(f.id) && f.id !== id) { out.add(f.id); stack.push(f.id); } }
  return out;
}
export const draggedIds = (e: React.DragEvent): string[] => {
  try { return JSON.parse(e.dataTransfer.getData(DRAG_TYPE) || "[]"); } catch { return []; }
};
export const isCharDrag = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes(DRAG_TYPE);

/** A folder in the grid: its picture (or a colour), its name, how many characters are inside. A character can be dropped on it. */
export function FolderTile({ f, count, sub, onOpen, onDropIds, onDropFolder }: { f: Folder; count: number; /** folders directly inside */ sub: number; onOpen: () => void; onDropIds: (ids: string[]) => void; onDropFolder: (id: string) => void }) {
  const [over, setOver] = useState(false);
  const cover = folderCover(f);
  const bg = `linear-gradient(135deg, hsl(${hue(f.name)} 40% 32%), hsl(${(hue(f.name) + 50) % 360} 45% 20%))`;
  return (
    <button className={`ftile${over ? " over" : ""}`} data-folder={f.name} onClick={onOpen} draggable
      aria-label={`Folder ${f.name}, ${count} character${count === 1 ? "" : "s"}${sub ? `, ${sub} folder${sub === 1 ? "" : "s"}` : ""}`}
      onDragStart={(e) => { e.dataTransfer.setData(DRAG_FOLDER, f.id); e.dataTransfer.effectAllowed = "move"; e.stopPropagation(); }}
      onDragOver={(e) => { if (isCharDrag(e) || isFolderDrag(e)) { e.preventDefault(); e.stopPropagation(); setOver(true); } }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        if (isFolderDrag(e)) { e.preventDefault(); e.stopPropagation(); setOver(false); onDropFolder(draggedFolder(e)); return; }
        if (!isCharDrag(e)) return; e.preventDefault(); e.stopPropagation(); setOver(false); onDropIds(draggedIds(e));
      }}>
      <div className="fcover" style={{ background: bg }}>
        {cover ? <img src={cover} alt="" draggable={false} style={frameStyle(f.frame)} /> : <span className="fglyph" aria-hidden>📁</span>}
      </div>
      <div className="fname"><b>{f.name}</b><span className="hint">{count} character{count === 1 ? "" : "s"}{sub ? ` · ${sub} folder${sub === 1 ? "" : "s"}` : ""}</span></div>
    </button>
  );
}

/** Name, picture and delete for the folder that is open. */
export function FolderBar({ f, count, onClose, onChanged, onMove }: { f: Folder; count: number; onClose: () => void; onChanged: () => Promise<void>; onMove: () => void }) {
  const toast = useToast();
  const [name, setName] = useState<string | null>(null);
  const [framing, setFraming] = useState<{ file?: File; url: string } | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const cover = folderCover(f);
  const run = async (p: Promise<unknown>) => { try { await p; await onChanged(); } catch (e) { toast(errText(e), "err"); } };
  return (
    <div className="fbar">
      <div className="fbar-art" style={{ background: `linear-gradient(135deg, hsl(${hue(f.name)} 40% 32%), hsl(${(hue(f.name) + 50) % 360} 45% 20%))` }}>
        {cover ? <img src={cover} alt="" draggable={false} style={frameStyle(f.frame)} /> : <span aria-hidden>📁</span>}
      </div>
      <div className="grow">
        {name === null ? (
          <h2 style={{ margin: 0 }}>{f.name}</h2>
        ) : (
          <input type="text" autoFocus value={name} aria-label="Folder name" maxLength={60} onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) { void run(api.renameFolder(f.id, name)); setName(null); } if (e.key === "Escape") { e.stopPropagation(); setName(null); } }}
            onBlur={() => { if (name.trim() && name.trim() !== f.name) void run(api.renameFolder(f.id, name)); setName(null); }} />
        )}
        <div className="sub">{count} character{count === 1 ? "" : "s"} · drag characters or folders onto a folder (or onto the path above) to move them</div>
      </div>
      <div className="row" style={{ gap: 6 }}>
        <button className="btn sm" onClick={() => setName(f.name)}>✎ Rename</button>
        <button className="btn sm" onClick={onMove}>📂 Move folder…</button>
        <button className="btn sm" onClick={() => file.current?.click()}>🖼 {cover ? "Change picture" : "Add picture"}</button>
        {cover && <button className="btn sm" onClick={() => setFraming({ url: cover })}>⤧ Position</button>}
        {cover && <button className="btn sm" onClick={() => void run(api.clearFolderCover(f.id))}>Remove picture</button>}
        <button className="btn sm danger" onClick={() => { if (window.confirm(`Delete the folder "${f.name}"? Its characters and subfolders are kept and move up one level.`)) { void api.deleteFolder(f.id).then(onClose).then(onChanged).catch((e) => toast(errText(e), "err")); } }}>🗑 Delete folder</button>
        <input ref={file} type="file" hidden accept="image/*" aria-label="Folder picture" onChange={(e) => { const x = e.target.files?.[0]; e.target.value = ""; if (x) setFraming({ file: x, url: URL.createObjectURL(x) }); }} />
      </div>
      {framing && (
        <FrameEditor title="Position the folder picture" src={framing.url} initial={framing.file ? null : f.frame}
          onClose={() => { if (framing.file) URL.revokeObjectURL(framing.url); setFraming(null); }}
          onSave={(fr) => { const cur = framing; setFraming(null); void run((async () => { if (cur.file) { await api.setFolderCover(f.id, cur.file); URL.revokeObjectURL(cur.url); } await api.setFolderFrame(f.id, fr); })()); }} />
      )}
    </div>
  );
}

/** A small window to name a new folder. */
export function NewFolder({ parent, parentName, onClose, onCreated }: { parent?: string | null; parentName?: string; onClose: () => void; onCreated: (f: Folder) => void }) {
  const toast = useToast();
  const [name, setName] = useState("");
  const go = async () => { try { onCreated(await api.createFolder(name, parent ?? null)); } catch (e) { toast(errText(e), "err"); } };
  return (
    <Modal title={parentName ? `New folder in ${parentName}` : "New folder"} onClose={onClose}>
      <input type="text" autoFocus placeholder="Folder name" aria-label="Folder name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && name.trim() && void go()} />
      <div className="row" style={{ marginTop: 14 }}><button className="btn primary" disabled={!name.trim()} onClick={() => void go()}>Create folder</button></div>
    </Modal>
  );
}

/** Pick where something goes (a character, or a folder: then `exclude` leaves out the folder itself and what is inside it). */
export function MoveTo({ folders, current, exclude, title = "Move to folder", onPick, onClose }: { folders: Folder[]; current: string | null; exclude?: Set<string>; title?: string; onPick: (id: string | null) => void; onClose: () => void }) {
  const list = folderTree(folders).filter((x) => !exclude?.has(x.f.id));
  return (
    <Modal title={title} onClose={onClose}>
      <div className="who-list" style={{ maxHeight: 360, overflow: "auto" }}>
        <button className={current == null ? "on" : ""} onClick={() => onPick(null)}><span>🧑‍🎤</span><span className="grow">All characters (top level)</span>{current == null && <span>✓</span>}</button>
        {list.map(({ f, depth }) => <button key={f.id} className={current === f.id ? "on" : ""} data-pick={f.name} style={{ paddingLeft: 10 + depth * 18 }} onClick={() => onPick(f.id)}><span>📁</span><span className="grow">{f.name}</span>{current === f.id && <span>✓</span>}</button>)}
      </div>
      {list.length === 0 && <p className="hint">No folders yet. Make one with “New folder”.</p>}
    </Modal>
  );
}
