import { useRef, useState } from "react";
import { api, type Character } from "../api";
import { errText } from "../lib/util";
import type { Accessory } from "../lib/wardrobe";

/** What the 3D viewer needs to offer a character's wardrobe: outfits (extra VRM files) that can be put on. */
export interface Wardrobe {
  outfits: { id: string; name: string }[];
  /** the outfit being worn; null = the original model */
  current: string | null;
  onSwitch: (id: string | null) => void;
  onAdd: (file: File) => void;
  onRename: (id: string, name: string) => void;
  onRemove: (id: string) => void;
}

/** Builds the wardrobe for a 3D character. `apply` receives the updated character after every change. */
export function makeWardrobe(c: Character | null | undefined, apply: (c: Character) => void, toast: (m: string, k?: "ok" | "err" | "info") => void): Wardrobe | undefined {
  if (!c || c.media?.kind !== "vrm") return undefined;
  const run = (p: Promise<Character>, ok?: string) => p.then((n) => { apply(n); if (ok) toast(ok, "ok"); }).catch((e) => toast(errText(e), "err"));
  return {
    outfits: (c.outfits ?? []).map((o) => ({ id: o.id, name: o.name })),
    current: c.outfit ?? null,
    onSwitch: (id) => void run(api.setOutfit(c.id, id)),
    onAdd: (file) => void run(api.addOutfit(c.id, file), `${file.name.replace(/\.[^.]+$/, "")} is in the wardrobe`),
    onRename: (id, name) => void run(api.renameOutfit(c.id, id, name)),
    onRemove: (id) => void run(api.removeOutfit(c.id, id), "Outfit removed"),
  };
}

/** The wardrobe popover: swap outfits (extra VRM files of the same character), and switch accessories on and off. */
export default function WardrobePanel({ wardrobe, accessories, hidden, onToggle, onClose }: {
  wardrobe?: Wardrobe;
  accessories: Accessory[];
  hidden: Set<string>;
  onToggle: (key: string) => void;
  onClose: () => void;
}) {
  const file = useRef<HTMLInputElement>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [confirm, setConfirm] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const add = (f?: File | null) => { if (f) wardrobe?.onAdd(f); };

  return (
    <div className={`wardrobe${drag ? " drag" : ""}`} role="dialog" aria-label="Wardrobe" onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}
      onDragOver={(e) => { if (wardrobe) { e.preventDefault(); setDrag(true); } }} onDragLeave={() => setDrag(false)}
      onDrop={(e) => { e.preventDefault(); setDrag(false); add(e.dataTransfer.files?.[0]); }}>
      <div className="wardrobe-head"><b>Wardrobe</b><button type="button" className="iconbtn" aria-label="Close wardrobe" onClick={onClose}>✕</button></div>

      {wardrobe && (
        <section>
          <h4>Outfits</h4>
          <ul className="outfits">
            <li className={wardrobe.current === null ? "on" : ""}>
              <button type="button" className="pick" onClick={() => wardrobe.onSwitch(null)} aria-pressed={wardrobe.current === null}><span className="dot" />Original</button>
            </li>
            {wardrobe.outfits.map((o) => (
              <li key={o.id} className={wardrobe.current === o.id ? "on" : ""}>
                {renaming === o.id ? (
                  <input autoFocus value={draft} maxLength={40} aria-label="Outfit name" onChange={(e) => setDraft(e.target.value)} onBlur={() => setRenaming(null)}
                    onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") { wardrobe.onRename(o.id, draft); setRenaming(null); } if (e.key === "Escape") setRenaming(null); }} />
                ) : (
                  <button type="button" className="pick" onClick={() => wardrobe.onSwitch(o.id)} aria-pressed={wardrobe.current === o.id}><span className="dot" />{o.name}</button>
                )}
                <button type="button" className="iconbtn" aria-label={`Rename ${o.name}`} title="Rename" onMouseDown={(e) => e.preventDefault()} onClick={() => { setRenaming(o.id); setDraft(o.name); }}>✎</button>
                {confirm === o.id
                  ? <button type="button" className="btn danger sm" onClick={() => { wardrobe.onRemove(o.id); setConfirm(null); }}>Remove?</button>
                  : <button type="button" className="iconbtn" aria-label={`Remove ${o.name}`} title="Remove this outfit" onClick={() => { setConfirm(o.id); setTimeout(() => setConfirm((c) => (c === o.id ? null : c)), 3000); }}>🗑</button>}
              </li>
            ))}
          </ul>
          <button type="button" className="btn sm" onClick={() => file.current?.click()}>+ Add an outfit</button>
          <input ref={file} type="file" hidden onChange={(e) => { add(e.target.files?.[0]); e.target.value = ""; }} />
          <p className="hint">An outfit is another <b>.vrm</b> of the same character in different clothes (for example exported from VRoid Studio). Drop a file here or add it. Each outfit keeps its own accessory choices.</p>
        </section>
      )}

      <section>
        <h4>Accessories</h4>
        {accessories.length === 0
          ? <p className="hint">This model has no switchable accessories (ears, tails, glasses, hats, ribbons, bags, shoes).</p>
          : (
            <ul className="accs">
              {accessories.map((a) => (
                <li key={a.key}><label><input type="checkbox" checked={!hidden.has(a.key)} onChange={() => onToggle(a.key)} /> {a.label}</label></li>
              ))}
            </ul>
          )}
      </section>
    </div>
  );
}
