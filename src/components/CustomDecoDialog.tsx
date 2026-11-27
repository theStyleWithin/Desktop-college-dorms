import { useEffect, useRef, useState, type ReactNode } from "react";
import { Modal, useToast } from "./ui";
import { errText } from "../lib/util";
import Pk, { type PackItem } from "../lib/decoPack";
import { exportCustom, readFiles, removeCustom, saveCustom, useCustomDeco, type OwnDeco } from "../lib/decoCustom";

const KIND_LABEL = (k: string) => Pk.KINDS[k as keyof typeof Pk.KINDS]?.label ?? k;
const creditLine = (it: { author?: string; license?: string; pack?: string }) => [it.author && `by ${it.author}`, it.license, it.pack && `from ${it.pack}`].filter(Boolean).join(" · ");

/** A little picture of an item, for the lists. */
function Preview({ it, avatar }: { it: { kind: string; mode: string; art: string; cols?: number; rows?: number }; avatar: (size: number) => ReactNode }) {
  const sprite = it.mode === "sprite";
  const src = it.mode === "svg" ? "data:image/svg+xml," + encodeURIComponent(it.art) : it.art;
  const face = (cls: string) => sprite
    ? <span className={cls} style={{ backgroundImage: `url("${it.art}")`, backgroundRepeat: "no-repeat", backgroundSize: `${(it.cols || 1) * 100}% ${(it.rows || 1) * 100}%`, backgroundPosition: "0 0" }} />
    : <img className={cls} src={src} alt="" />;
  if (it.kind === "wreath") return <span className="dcp-wr">{avatar(44)}{face("dcp-over")}</span>;
  return face("dcp-" + it.kind);
}

/** "Add my own decorations": choose files, see what is in them, choose what to add. */
export function ImportDecorations({ files, avatar, onClose }: { files: File[]; avatar: (size: number) => ReactNode; onClose: () => void }) {
  const toast = useToast();
  const mine = useCustomDeco();
  const [state, setState] = useState<{ say: string } | { items: PackItem[]; skipped: { name: string; why: string }[] }>({ say: "One moment." });
  const [picks, setPicks] = useState<Set<string>>(new Set());
  const have = new Set(mine.map((m) => m.id));
  const room = Pk.LIMITS.library - mine.length;
  useEffect(() => {
    let live = true;
    readFiles(files, (t) => live && setState({ say: t })).then((r) => {
      if (!live) return;
      if (!r.items.length) { toast(r.skipped[0] ? `${r.skipped[0].name}: ${r.skipped[0].why}` : "Nothing to import.", "err"); onClose(); return; }
      setState(r); setPicks(new Set(r.items.filter((i) => !have.has(i.id)).map((i) => i.id)));
    }).catch((e) => { toast(errText(e), "err"); onClose(); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if ("say" in state) return <Modal title="Reading your files…" onClose={onClose}><p className="fine" data-testid="deco-reading">{state.say}</p></Modal>;
  const n = [...picks].filter((id) => !have.has(id)).length;
  const add = async () => {
    const chosen = state.items.filter((i) => picks.has(i.id) && !have.has(i.id)).slice(0, Math.max(0, room));
    try { const kept = await saveCustom(chosen); toast(kept ? (kept === 1 ? "Decoration added." : `${kept} decorations added.`) : "Nothing was added.", kept ? "ok" : "err"); onClose(); }
    catch (e) { toast(errText(e), "err"); }
  };
  return (
    <Modal title="Add decorations" onClose={onClose}>
      <div data-testid="deco-import">
        <p className="fine">Choose which to add. Only add decorations you made or have permission to use.</p>
        <div className="dcp-list">
          {state.items.map((it) => (
            <label key={it.id} className={`dcp-row${have.has(it.id) ? " dim" : ""}`} data-deco-item={it.name}>
              <input type="checkbox" checked={picks.has(it.id)} disabled={have.has(it.id)} onChange={(e) => setPicks((p) => { const q = new Set(p); if (e.target.checked) q.add(it.id); else q.delete(it.id); return q; })} />
              <span className={`dcp-pv dcp-pv-${it.kind}`}><Preview it={it} avatar={avatar} /></span>
              <span className="dcp-nm"><b>{it.name}</b><small>{KIND_LABEL(it.kind)}{it.mode === "sprite" ? " · from video" : it.moves ? " · moves" : ""}{have.has(it.id) ? " · already added" : ""}</small>{creditLine(it) ? <small>{creditLine(it)}</small> : null}</span>
            </label>
          ))}
        </div>
        {state.skipped.length ? <div className="dcp-skip"><b>{state.skipped.length} not added</b><ul>{state.skipped.map((x, i) => <li key={i}><b>{x.name}</b>: {x.why}</li>)}</ul></div> : null}
        {n > room ? <p className="fine">Your library can hold {Pk.LIMITS.library}, so only {Math.max(0, room)} more will fit.</p> : null}
        <div className="row"><button className="btn primary" disabled={!n} data-testid="deco-import-add" onClick={() => void add()}>{n ? `Add ${n} decoration${n === 1 ? "" : "s"}` : "Nothing to add"}</button><button className="btn" onClick={onClose}>Cancel</button></div>
      </div>
    </Modal>
  );
}

/** "My decorations": what is in the library, with a way to delete each and to export the lot as a pack. */
export function ManageDecorations({ avatar, author, onClose }: { avatar: (size: number) => ReactNode; author: string; onClose: () => void }) {
  const toast = useToast();
  const mine = useCustomDeco();
  const [sure, setSure] = useState<string | null>(null);
  const del = async (m: OwnDeco) => {
    if (sure !== m.id) { setSure(m.id); return; }
    try { await removeCustom(m.id); setSure(null); toast("Deleted.", "ok"); } catch (e) { toast(errText(e), "err"); }
  };
  const exp = async () => { try { const p = await exportCustom(author); if (p) toast(`Saved to ${p}.`, "ok"); } catch (e) { toast(errText(e), "err"); } };
  return (
    <Modal title="My decorations" onClose={onClose}>
      <div data-testid="deco-manage">
        {mine.length ? (
          <div className="dcp-list">
            {mine.map((m) => (
              <div key={m.id} className="dcp-row" data-deco-item={m.name}>
                <span className={`dcp-pv dcp-pv-${m.dkind}`}><Preview it={{ kind: m.dkind, mode: m.mode, art: m.art, cols: m.cols, rows: m.rows }} avatar={avatar} /></span>
                <span className="dcp-nm"><b>{m.name}</b><small>{KIND_LABEL(m.dkind)}{m.moves ? " · moves" : ""}</small>{creditLine(m) ? <small>{creditLine(m)}</small> : null}</span>
                <button className="btn" data-testid="deco-delete" onClick={() => void del(m)}>{sure === m.id ? "Really delete?" : "Delete"}</button>
              </div>
            ))}
          </div>
        ) : <p className="fine">You have not added any yet.</p>}
        <div className="row">{mine.length ? <button className="btn" onClick={() => void exp()}>Export all as a pack</button> : null}<button className="btn" onClick={onClose}>Done</button></div>
      </div>
    </Modal>
  );
}

/** The buttons that go at the top of a picker. The file chooser is always in the page (hidden), so it can be driven by the app's tests. */
export function CustomDecoBar({ avatar, author }: { avatar: (size: number) => ReactNode; author: string }) {
  const mine = useCustomDeco();
  const [files, setFiles] = useState<File[] | null>(null);
  const [manage, setManage] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="dc-custom row" data-testid="deco-custom-bar">
      <input ref={input} type="file" hidden multiple data-testid="deco-import-input" accept=".asdeco,.json,.svg,.png,.gif,.webp,.jpg,.jpeg,.mp4,.webm,image/*,video/mp4,video/webm"
        onChange={(e) => { const f = [...(e.target.files ?? [])]; e.target.value = ""; if (f.length) setFiles(f); }} />
      <button className="btn" type="button" data-testid="deco-import-open" onClick={() => input.current?.click()}>＋ Add my own decorations</button>
      {mine.length ? <button className="btn" type="button" data-testid="deco-manage-open" onClick={() => setManage(true)}>My decorations ({mine.length})</button> : null}
      <small className="muted">Nameplates, profile backgrounds and avatar wreaths from a .asdeco pack, an SVG, a picture or a short video. Only you have them.</small>
      {files && <ImportDecorations files={files} avatar={avatar} onClose={() => setFiles(null)} />}
      {manage && <ManageDecorations avatar={avatar} author={author} onClose={() => setManage(false)} />}
    </div>
  );
}
