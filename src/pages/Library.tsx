import { useMemo, useRef, useState } from "react";
import { api, blankCard, displayName } from "../api";
import { Modal, useToast } from "../components/ui";
import { errText } from "../lib/util";
import { useStore } from "../store";
import CharacterCard from "./CharacterCard";

type Sort = "name" | "recent" | "created";

export default function Library() {
  const { characters, go, refresh } = useStore();
  const toast = useToast();
  const [q, setQ] = useState("");
  const [tag, setTag] = useState<string | null>(null);
  const [favOnly, setFavOnly] = useState(false);
  const [sort, setSort] = useState<Sort>("name");
  const [report, setReport] = useState<{ name: string; warnings: string[] }[] | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);

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
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => { e.preventDefault(); setDrag(false); importFiles(e.dataTransfer.files); }}>
      <div className="page-head">
        <div>
          <h1>Characters</h1>
          <div className="sub">{characters.length} in your library · everything stays on this device</div>
        </div>
        <div className="row">
          <button className="btn" onClick={() => file.current?.click()}>⇪ Import cards</button>
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

      {drag && <div className="banner">Drop PNG or JSON character cards to import them</div>}
      {characters.length === 0 ? (
        <div className="empty">
          <h3>Your library is empty</h3>
          <p>Drag character cards here, or use Import. Cards from SillyTavern, Chub, and the character editors all work.</p>
        </div>
      ) : shown.length === 0 ? (
        <div className="empty">Nothing matches that search.</div>
      ) : (
        <div className="grid">{shown.map((c) => <CharacterCard key={c.id} c={c} />)}</div>
      )}

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
