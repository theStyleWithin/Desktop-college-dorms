import { useRef, useState } from "react";
import { api, folderCover, type Folder } from "../api";
import { frameStyle } from "./Art";
import FrameEditor from "./FrameEditor";
import { Modal, useToast } from "./ui";
import { errText, hue } from "../lib/util";

export const DRAG_TYPE = "application/x-dorms-characters";
export const draggedIds = (e: React.DragEvent): string[] => {
  try { return JSON.parse(e.dataTransfer.getData(DRAG_TYPE) || "[]"); } catch { return []; }
};
export const isCharDrag = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes(DRAG_TYPE);

/** A folder in the grid: its picture (or a colour), its name, how many characters are inside. A character can be dropped on it. */
export function FolderTile({ f, count, onOpen, onDropIds }: { f: Folder; count: number; onOpen: () => void; onDropIds: (ids: string[]) => void }) {
  const [over, setOver] = useState(false);
  const cover = folderCover(f);
  const bg = `linear-gradient(135deg, hsl(${hue(f.name)} 40% 32%), hsl(${(hue(f.name) + 50) % 360} 45% 20%))`;
  return (
    <button className={`ftile${over ? " over" : ""}`} data-folder={f.name} onClick={onOpen} aria-label={`Folder ${f.name}, ${count} character${count === 1 ? "" : "s"}`}
      onDragOver={(e) => { if (isCharDrag(e)) { e.preventDefault(); e.stopPropagation(); setOver(true); } }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { if (!isCharDrag(e)) return; e.preventDefault(); e.stopPropagation(); setOver(false); onDropIds(draggedIds(e)); }}>
      <div className="fcover" style={{ background: bg }}>
        {cover ? <img src={cover} alt="" draggable={false} style={frameStyle(f.frame)} /> : <span className="fglyph" aria-hidden>📁</span>}
      </div>
      <div className="fname"><b>{f.name}</b><span className="hint">{count} character{count === 1 ? "" : "s"}</span></div>
    </button>
  );
}

/** Name, picture and delete for the folder that is open. */
export function FolderBar({ f, count, onClose, onChanged }: { f: Folder; count: number; onClose: () => void; onChanged: () => Promise<void> }) {
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
        <div className="sub">{count} character{count === 1 ? "" : "s"} · drag characters onto “All characters” to take them out</div>
      </div>
      <div className="row" style={{ gap: 6 }}>
        <button className="btn sm" onClick={() => setName(f.name)}>✎ Rename</button>
        <button className="btn sm" onClick={() => file.current?.click()}>🖼 {cover ? "Change picture" : "Add picture"}</button>
        {cover && <button className="btn sm" onClick={() => setFraming({ url: cover })}>⤧ Position</button>}
        {cover && <button className="btn sm" onClick={() => void run(api.clearFolderCover(f.id))}>Remove picture</button>}
        <button className="btn sm danger" onClick={() => { if (window.confirm(`Delete the folder "${f.name}"? Its characters are kept and move back to All characters.`)) { void api.deleteFolder(f.id).then(onClose).then(onChanged).catch((e) => toast(errText(e), "err")); } }}>🗑 Delete folder</button>
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
export function NewFolder({ onClose, onCreated }: { onClose: () => void; onCreated: (f: Folder) => void }) {
  const toast = useToast();
  const [name, setName] = useState("");
  const go = async () => { try { onCreated(await api.createFolder(name)); } catch (e) { toast(errText(e), "err"); } };
  return (
    <Modal title="New folder" onClose={onClose}>
      <input type="text" autoFocus placeholder="Folder name" aria-label="Folder name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && name.trim() && void go()} />
      <div className="row" style={{ marginTop: 14 }}><button className="btn primary" disabled={!name.trim()} onClick={() => void go()}>Create folder</button></div>
    </Modal>
  );
}

/** Pick where a character goes (for people who don't drag). */
export function MoveTo({ folders, current, onPick, onClose }: { folders: Folder[]; current: string | null; onPick: (id: string | null) => void; onClose: () => void }) {
  return (
    <Modal title="Move to folder" onClose={onClose}>
      <div className="who-list">
        <button className={current == null ? "on" : ""} onClick={() => onPick(null)}><span>🧑‍🎤</span><span className="grow">All characters (no folder)</span>{current == null && <span>✓</span>}</button>
        {folders.map((f) => <button key={f.id} className={current === f.id ? "on" : ""} onClick={() => onPick(f.id)}><span>📁</span><span className="grow">{f.name}</span>{current === f.id && <span>✓</span>}</button>)}
      </div>
      {folders.length === 0 && <p className="hint">No folders yet. Make one with “New folder”.</p>}
    </Modal>
  );
}
