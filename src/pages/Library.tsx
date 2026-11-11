import { useMemo, useRef, useState } from "react";
import { api, blankCard, displayName } from "../api";
import { Modal, useToast } from "../components/ui";
import { errText } from "../lib/util";
import { useStore } from "../store";
import CharacterCard from "./CharacterCard";
import { FolderBar, FolderTile, MoveTo, NewFolder, draggedFolder, draggedIds, insideOf, isCharDrag, isFolderDrag } from "../components/Folders";

type Sort = "name" | "recent" | "created";

export default function Library() {
  const { characters, folders, go, refresh } = useStore();
  const toast = useToast();
  const [q, setQ] = useState("");
  const [tag, setTag] = useState<string | null>(null);
  const [favOnly, setFavOnly] = useState(false);
  const [sort, setSort] = useState<Sort>("name");
  const [report, setReport] = useState<{ name: string; warnings: string[] }[] | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [newFolder, setNewFolder] = useState(false);
  const [moving, setMoving] = useState<string | null>(null);
  const [upOver, setUpOver] = useState<string | null>(null);   // which crumb a drag is over ("" = the top)
  const [movingFolder, setMovingFolder] = useState<string | null>(null);

  const tags = useMemo(() => {
    const n = new Map<string, number>();
    characters.forEach((c) => c.card.tags.forEach((t) => n.set(t, (n.get(t) ?? 0) + 1)));
    return [...n.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14);
  }, [characters]);

  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    let list = characters.filter((c) =>
      (!favOnly || c.favorite) && (!tag || c.card.tags.includes(tag)) &&
      (!s || `${displayName(c)} ${c.card.name} ${c.card.tags.join(" ")} ${c.card.description}`.toLowerCase().includes(s)));
    list = [...list].sort((a, b) =>
      sort === "name" ? displayName(a).localeCompare(displayName(b))
      : sort === "recent" ? b.last_used - a.last_used || b.updated_at - a.updated_at
      : b.created_at - a.created_at);
    return list;
  }, [characters, q, tag, favOnly, sort]);

  const filtering = !!(q.trim() || tag || favOnly);
  const folderIds = useMemo(() => new Set(folders.map((f) => f.id)), [folders]);
  const open = openId ? folders.find((f) => f.id === openId) ?? null : null;
  const inFolder = (c: (typeof characters)[number]) => (c.folder && folderIds.has(c.folder) ? c.folder : null);
  // searching looks everywhere; otherwise you see the folder you are in (or the top level)
  const visible = filtering ? shown : shown.filter((c) => inFolder(c) === (open ? open.id : null));
  // folders nest: `parentOf` is where a folder sits (a folder whose parent has gone is treated as top level)
  const parentOf = (f: (typeof folders)[number]) => (f.parent && folderIds.has(f.parent) ? f.parent : null);
  const childrenOf = (id: string | null) => folders.filter((f) => parentOf(f) === id);
  /** characters anywhere inside a folder, at any depth */
  const countIn = (id: string) => { const all = new Set([id, ...insideOf(folders, id)]); return characters.filter((c) => c.folder && all.has(c.folder)).length; };
  // the path from the top to the open folder
  const trail = useMemo(() => { const out: typeof folders = []; let cur = open; const seen = new Set<string>(); while (cur && !seen.has(cur.id)) { seen.add(cur.id); out.unshift(cur); const p = parentOf(cur); cur = p ? folders.find((f) => f.id === p) ?? null : null; } return out; }, [open, folders]);
  const moveFolder = async (id: string, to: string | null) => {
    if (id === to) return;
    try { await api.moveFolder(id, to); await refresh(); } catch (e) { toast(errText(e), "err"); }
  };
  const moveIds = async (ids: string[], to: string | null) => {
    const mine = ids.filter((i) => characters.some((c) => c.id === i));
    if (!mine.length) return;
    try { await api.moveCharacters(mine, to); await refresh(); } catch (e) { toast(errText(e), "err"); }
  };

  const importFiles = async (files: FileList | File[] | null) => {
    if (!files) return;
    const notes: { name: string; warnings: string[] }[] = [];
    let ok = 0;
    for (const f of Array.from(files)) {
      try {
        const r = await api.importCard(f);
        ok++;
        if (r.warnings.length) notes.push({ name: r.character.card.name, warnings: r.warnings });
      } catch (e) {
        const m = errText(e);
        if (m === "NO_CARD") {
          // plain image: offer it as the avatar of a new character
          try {
            const base = f.name.replace(/\.[^.]+$/, "") || "New character";
            const created = await api.saveCharacter({ card: { ...blankCard(), name: base } });
            await api.setMedia(created.id, f);
            ok++;
            notes.push({ name: base, warnings: ["No card data was in this PNG, so it was added as a plain image for a new character."] });
          } catch (e2) { toast(`${f.name}: ${errText(e2)}`, "err"); }
        } else toast(`${f.name}: ${m}`, "err");
      }
    }
    await refresh();
    if (ok) toast(`Imported ${ok} character${ok > 1 ? "s" : ""}`, "ok");
    if (notes.length) setReport(notes);
  };

  return (
    <div className="page"
      onDragOver={(e) => { if (isCharDrag(e)) return; e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => { if (isCharDrag(e)) return; e.preventDefault(); setDrag(false); importFiles(e.dataTransfer.files); }}>
      <div className="page-head">
        <div>
          <h1>Characters</h1>
          <div className="sub">{characters.length} in your library{folders.length ? ` · ${folders.length} folder${folders.length === 1 ? "" : "s"}` : ""} · everything stays on this device</div>
        </div>
        <div className="row">
          <button className="btn" onClick={() => file.current?.click()}>⇪ Import cards</button>
          <button className="btn" onClick={() => setNewFolder(true)}>📁 New folder</button>
          <button className="btn primary" onClick={() => go({ page: "editor", id: null })}>＋ New character</button>
          <input ref={file} type="file" hidden multiple accept=".json,.png,application/json,image/png"
            onChange={(e) => { importFiles(e.target.files); e.target.value = ""; }} />
        </div>
      </div>

      <div className="row" style={{ marginBottom: 12 }}>
        <input type="search" placeholder="Search names, tags, descriptions…" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 380 }} />
        <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} style={{ width: "auto" }} aria-label="Sort">
          <option value="name">A–Z</option><option value="recent">Recently chatted</option><option value="created">Newest</option>
        </select>
        <button className={`chip ${favOnly ? "on" : ""}`} onClick={() => setFavOnly(!favOnly)}>★ Favorites</button>
      </div>
      {tags.length > 0 && (
        <div className="chips" style={{ marginBottom: 18 }}>
          {tags.map(([t, n]) => (
            <button key={t} className={`chip ${tag === t ? "on" : ""}`} onClick={() => setTag(tag === t ? null : t)}>{t} · {n}</button>
          ))}
        </div>
      )}

      {open && !filtering && (
        <>
          <div className="crumbs" aria-label="Folder path">
            {[null, ...trail.slice(0, -1)].map((c) => (
              <span key={c?.id ?? "top"} className="row" style={{ gap: 8, flexWrap: "nowrap" }}>
                <button className={`crumb${upOver === (c?.id ?? "") ? " over" : ""}`} data-crumb={c?.name ?? "All characters"} onClick={() => setOpenId(c?.id ?? null)}
                  onDragOver={(e) => { if (isCharDrag(e) || isFolderDrag(e)) { e.preventDefault(); setUpOver(c?.id ?? ""); } }} onDragLeave={() => setUpOver(null)}
                  onDrop={(e) => { setUpOver(null); if (isFolderDrag(e)) { e.preventDefault(); void moveFolder(draggedFolder(e), c?.id ?? null); } else if (isCharDrag(e)) { e.preventDefault(); void moveIds(draggedIds(e), c?.id ?? null); } }}>
                  {c ? c.name : "‹ All characters"}
                </button>
                <span aria-hidden>›</span>
              </span>
            ))}
            <b>{open.name}</b>
          </div>
          <FolderBar f={open} count={countIn(open.id)} onClose={() => setOpenId(parentOf(open))} onChanged={refresh} onMove={() => setMovingFolder(open.id)} />
        </>
      )}
      {!filtering && childrenOf(open ? open.id : null).length > 0 && (
        <div className="ftiles">
          {childrenOf(open ? open.id : null).map((f) => <FolderTile key={f.id} f={f} count={countIn(f.id)} sub={childrenOf(f.id).length} onOpen={() => setOpenId(f.id)} onDropIds={(ids) => void moveIds(ids, f.id)} onDropFolder={(id) => void moveFolder(id, f.id)} />)}
        </div>
      )}
      {drag && <div className="banner">Drop PNG or JSON character cards to import them</div>}
      {characters.length === 0 ? (
        <div className="empty">
          <h3>Your library is empty</h3>
          <p>Drag character cards here, or use Import. Cards from SillyTavern, Chub, and the character editors all work.</p>
        </div>
      ) : shown.length === 0 ? (
        <div className="empty">Nothing matches that search.</div>
      ) : visible.length === 0 ? (
        childrenOf(open ? open.id : null).length > 0 ? null : <div className="empty">{open ? "This folder is empty. Drag characters onto its tile, or use ⋮ → Move to folder." : "Everything is filed in folders. Open one above."}</div>
      ) : (
        <div className="grid">{visible.map((c) => <CharacterCard key={c.id} c={c} onMove={() => setMoving(c.id)} />)}</div>
      )}
      {newFolder && <NewFolder parent={open?.id ?? null} parentName={open?.name} onClose={() => setNewFolder(false)} onCreated={async (f) => { setNewFolder(false); await refresh(); setOpenId(f.id); }} />}
      {movingFolder && (() => { const mf = folders.find((f) => f.id === movingFolder); return mf ? <MoveTo title={`Move “${mf.name}” into…`} folders={folders} current={parentOf(mf)} exclude={new Set([mf.id, ...insideOf(folders, mf.id)])} onClose={() => setMovingFolder(null)} onPick={async (id) => { setMovingFolder(null); await moveFolder(mf.id, id); }} /> : null; })()}
      {moving && <MoveTo folders={folders} current={characters.find((c) => c.id === moving)?.folder ?? null} onClose={() => setMoving(null)} onPick={async (id) => { const m = moving; setMoving(null); await moveIds([m], id); }} />}

      {report && (
        <Modal title="Import notes" onClose={() => setReport(null)}>
          <p className="sub">Everything was imported. A few things were adjusted along the way:</p>
          {report.map((r) => (
            <div key={r.name} style={{ marginTop: 10 }}>
              <b>{r.name}</b>
              <ul>{r.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
            </div>
          ))}
        </Modal>
      )}
    </div>
  );
}
