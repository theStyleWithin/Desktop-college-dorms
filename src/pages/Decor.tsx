import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type DecorItem, type PackageModel } from "../api";
import { fbxToGlb, importDecorPackage } from "../lib/unityPackage";
import { useToast } from "../components/ui";
import { errText, fmtBytes } from "../lib/util";

/**
 * Decorations: the library of 3D props (furniture, plants, food...) kept for decorating rooms. Import a Unity package full of
 * props (you choose which models to take), or a single .glb / .fbx. Each one has a sharing mark: only decorations marked
 * "May be shared" go into an exported profile.
 */
export default function Decor() {
  const toast = useToast();
  const [items, setItems] = useState<DecorItem[] | null>(null);
  const [working, setWorking] = useState("");
  const [problem, setProblem] = useState("");
  const [pick, setPick] = useState<{ models: PackageModel[]; done: (m: PackageModel[] | null) => void } | null>(null);
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try { setItems(await api.listDecor()); } catch (e) { toast(errText(e), "err"); setItems([]); }
  }, [toast]);
  useEffect(() => { void load(); }, [load]);

  const importFile = async (f: File) => {
    setProblem(""); setWorking("Starting…");
    const ext = f.name.split(".").pop()?.toLowerCase() ?? "";
    const base = f.name.replace(/\.[^.]+$/, "") || "Decoration";
    try {
      if (ext === "unitypackage") {
        const n = await importDecorPackage(f, setWorking,
          (models) => new Promise((done) => setPick({ models, done: (m) => { setPick(null); done(m); } })),
          async (glb) => { await api.addDecor(glb, glb.name.replace(/\.[^.]+$/, "")); });
        if (n) toast(`Added ${n} decoration${n === 1 ? "" : "s"}. They are not marked as shareable.`, "ok");
      } else if (ext === "glb") {
        setWorking(`Adding ${base}…`);
        await api.addDecor(f, base, (p) => setWorking(`Adding ${base}… ${Math.round(p * 100)}%`));
        toast("Added. It is not marked as shareable.", "ok");
      } else if (ext === "fbx") {
        setWorking(`Converting ${base}…`);
        const url = URL.createObjectURL(f);
        try {
          const glb = await fbxToGlb({ file: url, name: f.name }, [], (t) => setWorking(t), (p) => p);
          await api.addDecor(glb, base);
        } finally { URL.revokeObjectURL(url); }
        toast("Added. It is not marked as shareable.", "ok");
      } else {
        setProblem("A decoration has to be a .glb or .fbx file, or a Unity package (.unitypackage).");
      }
    } catch (e) { setProblem(errText(e)); } finally { setWorking(""); await load(); }
  };

  const shown = useMemo(() => (items ?? []).filter((d) => !q.trim() || d.name.toLowerCase().includes(q.trim().toLowerCase())), [items, q]);
  const run = async (p: Promise<unknown>) => { try { await p; await load(); } catch (e) { toast(errText(e), "err"); } };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Decorations</h1>
          <div className="sub">{items ? `${items.length} in your library` : "Loading…"} · props for decorating your rooms (furniture, plants, food…) · everything stays on this device</div>
        </div>
        <div className="row">
          <button className="btn primary" disabled={!!working} onClick={() => file.current?.click()}>＋ Import decorations</button>
          {/* no `accept` filter: some pickers hide these types; the app checks the file itself */}
          <input ref={file} type="file" hidden aria-label="Import decorations"
            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void importFile(f); }} />
        </div>
      </div>

      {working && <div className="hint" role="status" data-testid="decor-status">{working} Big packages take a while, please stay on this page.</div>}
      {problem && <div className="hint" role="alert" data-testid="decor-problem" style={{ color: "var(--danger)" }}>{problem}</div>}
      {pick && <ModelPicker models={pick.models} onDone={pick.done} />}

      {items && items.length > 0 && (
        <div className="row" style={{ margin: "12px 0" }}>
          <input type="search" placeholder="Search decorations…" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 320 }} aria-label="Search decorations" />
        </div>
      )}

      {items && items.length === 0 && !working ? (
        <div className="empty">
          <h3>No decorations yet</h3>
          <p>Import a Unity package (for example a pack of furniture or food from Booth) and choose which props to keep, or a single .glb or .fbx file. Placing them in your rooms comes next.</p>
        </div>
      ) : (
        <div style={{ display: "grid", gap: 8 }}>
          {shown.map((d) => (
            <div key={d.id} className="row" data-decor={d.name} style={{ gap: 10, padding: "8px 10px", border: "1px solid var(--line, #3335)", borderRadius: 10, alignItems: "center", flexWrap: "wrap" }}>
              <div className="grow" style={{ minWidth: 180 }}>
                {editing === d.id ? (
                  <input type="text" autoFocus defaultValue={d.name} aria-label="Decoration name" maxLength={80}
                    onKeyDown={(e) => { if (e.key === "Enter") { const v = (e.target as HTMLInputElement).value; setEditing(null); if (v.trim()) void run(api.renameDecor(d.id, v)); } if (e.key === "Escape") setEditing(null); }}
                    onBlur={(e) => { const v = e.target.value; setEditing(null); if (v.trim() && v.trim() !== d.name) void run(api.renameDecor(d.id, v)); }} />
                ) : (<b>{d.name}</b>)}
                <div className="hint">{fmtBytes(d.bytes)}</div>
              </div>
              <div className="chips">
                <button type="button" className={`chip ${!d.share ? "on" : ""}`} aria-pressed={!d.share} data-share="no" onClick={() => void run(api.setDecorShare(d.id, false))}>Not allowed to share</button>
                <button type="button" className={`chip ${d.share ? "on" : ""}`} aria-pressed={d.share} data-share="yes" onClick={() => void run(api.setDecorShare(d.id, true))}>May be shared</button>
              </div>
              <button className="btn sm" onClick={() => setEditing(d.id)}>✎ Rename</button>
              <button className="btn sm danger" onClick={() => { if (window.confirm(`Delete “${d.name}”? The file is removed from this device.`)) void run(api.deleteDecor(d.id)); }}>🗑 Delete</button>
            </div>
          ))}
        </div>
      )}
      {items && items.length > 0 && <p className="hint" style={{ marginTop: 14 }}>Only mark a decoration <b>May be shared</b> if the seller's terms allow passing the file on. One that is not allowed to be shared stays out of exported profile files. This is your own declaration; the app can't check the seller's licence.</p>}
    </div>
  );
}

/** Tick the models of a package to keep as decorations (a pack can have dozens, so there is a filter and select all). */
function ModelPicker({ models, onDone }: { models: PackageModel[]; onDone: (m: PackageModel[] | null) => void }) {
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [f, setF] = useState("");
  const list = models.filter((m) => !f.trim() || `${m.name} ${m.path}`.toLowerCase().includes(f.trim().toLowerCase()));
  const toggle = (g: string) => setSel((s) => { const n = new Set(s); if (n.has(g)) n.delete(g); else n.add(g); return n; });
  return (
    <div className="field" data-testid="decor-picker" style={{ margin: "10px 0" }}>
      <span>Which of these {models.length} models do you want as decorations?</span>
      <div className="row" style={{ margin: "6px 0" }}>
        <input type="search" placeholder="Filter…" value={f} onChange={(e) => setF(e.target.value)} style={{ maxWidth: 240 }} aria-label="Filter models" />
        <button type="button" className="btn sm" data-act="all" onClick={() => setSel(new Set([...sel, ...list.map((m) => m.guid)]))}>Select all{f.trim() ? " shown" : ""}</button>
        <button type="button" className="btn sm" data-act="none" onClick={() => setSel(new Set())}>Select none</button>
      </div>
      <div className="who-list" style={{ maxHeight: 320, overflow: "auto" }}>
        {list.map((m) => (
          <label key={m.guid} className="row" data-pick={m.name} style={{ gap: 8, padding: "4px 8px", cursor: "pointer" }}>
            <input type="checkbox" checked={sel.has(m.guid)} onChange={() => toggle(m.guid)} />
            <span className="grow">{m.name}<span className="hint"> · {m.path}</span></span><span>{fmtBytes(m.size)}</span>
          </label>
        ))}
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <button type="button" className="btn primary" data-act="add" disabled={!sel.size} onClick={() => onDone(models.filter((m) => sel.has(m.guid)))}>Add {sel.size || ""} decoration{sel.size === 1 ? "" : "s"}</button>
        <button type="button" className="btn ghost" onClick={() => onDone(null)}>Cancel</button>
      </div>
    </div>
  );
}
