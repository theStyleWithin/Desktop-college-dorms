import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open as pickFolder } from "@tauri-apps/plugin-dialog";
import { api, displayName, mediaUrl, type Character, type ViewDir, type ViewFolder } from "../api";
import { useStore } from "../store";
import { errText } from "../lib/util";
import { useToast } from "../components/ui";
import PictureComments from "../components/PictureComments";

/**
 * Gallery: a quick look at pictures, for when you just want to look at the art and not chat. Every character is an art folder holding
 * their profile picture; if they have a gallery of their own it is a sub folder inside. You can also add folders from your computer,
 * which have nothing to do with any character, only to look at. Nothing here changes anything: a folder from your computer is never
 * copied, changed or deleted (taking it off the list only forgets it).
 */
type Tile = { id: string; key: string; url: string; kind: "image" | "gif" | "video"; title: string; note?: string; who?: Character };

const profileTile = (c: Character): Tile | null => {
  const url = mediaUrl(c);
  if (!url || !c.media || c.media.kind === "vrm") return null;
  return { id: `${c.id}:profile`, key: `char:${c.id}:profile`, url, kind: c.media.kind, title: displayName(c), note: "Profile picture", who: c };
};
const galleryTiles = (c: Character): Tile[] =>
  (c.gallery ?? []).flatMap((g) => {
    const p = c.gallery_paths?.find((x) => x.id === g.id)?.path;
    return p ? [{ id: `${c.id}:${g.id}`, key: `char:${c.id}:${g.id}`, url: convertFileSrc(p), kind: g.kind, title: displayName(c), note: g.moods.length ? g.moods.join(", ") : "Gallery", who: c } as Tile] : [];
  });
const picCount = (c: Character) => (profileTile(c) ? 1 : 0) + galleryTiles(c).length;
const diskTiles = (d: ViewDir): Tile[] => d.files.map((f) => ({ id: f.path, key: `disk:${f.path}`, url: convertFileSrc(f.path), kind: f.kind, title: f.name, note: d.name }));
const firstPic = (d: ViewDir): Tile | null => (d.files[0] ? diskTiles(d)[0] : d.dirs.map(firstPic).find(Boolean) ?? null);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** One picture, a picture file or a short clip (a clip shows its first frame and plays while the pointer is on it). */
function Pic({ t, fit = "cover", big }: { t: Tile; fit?: "cover" | "contain"; big?: boolean }) {
  if (t.kind === "video") {
    return <video src={t.url} muted={!big} loop playsInline preload="metadata" controls={big} autoPlay={big} style={{ objectFit: fit }}
      onMouseEnter={(e) => { if (!big) void e.currentTarget.play().catch(() => {}); }} onMouseLeave={(e) => { if (!big) { e.currentTarget.pause(); e.currentTarget.currentTime = 0; } }} />;
  }
  return <img src={t.url} alt={t.note ? `${t.title}: ${t.note}` : t.title} loading="lazy" decoding="async" draggable={false} style={{ objectFit: fit }} />;
}

type Where = { kind: "char"; id: string; sub: boolean } | { kind: "disk"; id: string; path: string[] } | null;

export default function Gallery() {
  const { characters, go, info, me } = useStore();
  const toast = useToast();
  const [q, setQ] = useState("");
  const [onlyGalleries, setOnlyGalleries] = useState(false);
  const [at, setAt] = useState<Where>(null);
  const [view, setView] = useState<{ list: Tile[]; at: number } | null>(null);
  // folders from the computer
  const [disk, setDisk] = useState<ViewFolder[]>([]);
  const [scans, setScans] = useState<Record<string, { root: ViewDir; truncated: boolean } | "error">>({});
  const canAddFolders = info?.platform !== "android";
  // how many comments each picture has (shown as a count on the picture)
  const [counts, setCounts] = useState<Record<string, number>>({});
  useEffect(() => { api.galleryCommentCounts().then(setCounts).catch(() => {}); }, []);
  const setCount = useCallback((key: string, n: number) => setCounts((c) => (c[key] === n ? c : { ...c, [key]: n })), []);

  const sorted = useMemo(() => [...characters].sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9) || displayName(a).localeCompare(displayName(b))), [characters]);
  const shown = sorted.filter((c) => (!onlyGalleries || (c.gallery?.length ?? 0) > 0)
    && (!q.trim() || `${displayName(c)} ${c.card.tags.join(" ")}`.toLowerCase().includes(q.trim().toLowerCase())));
  const total = characters.reduce((n, c) => n + picCount(c), 0);

  const scan = useCallback(async (f: ViewFolder) => {
    if (!f.exists) { setScans((s) => ({ ...s, [f.id]: "error" })); return; }
    try { const r = await api.scanViewFolder(f.id); setScans((s) => ({ ...s, [f.id]: r })); } catch { setScans((s) => ({ ...s, [f.id]: "error" })); }
  }, []);
  const loadDisk = useCallback(async () => {
    try { const l = await api.listViewFolders(); setDisk(l); l.forEach((f) => void scan(f)); } catch { setDisk([]); }
  }, [scan]);
  useEffect(() => { if (canAddFolders) void loadDisk(); }, [canAddFolders, loadDisk]);

  const addFolder = async () => {
    try {
      const p = await pickFolder({ directory: true, multiple: false, title: "Choose a folder of pictures to look at" });
      if (!p || Array.isArray(p)) return;
      const f = await api.addViewFolder(p);
      setDisk((d) => [...d, f]); void scan(f);
      toast(`Added "${f.name}" to the Gallery.`, "ok");
    } catch (e) { toast(errText(e), "err"); }
  };
  const removeFolder = async (f: ViewFolder) => {
    if (!window.confirm(`Take "${f.name}" off the Gallery? Nothing on your computer is changed or deleted; it just isn't listed here any more.`)) return;
    try { await api.removeViewFolder(f.id); setDisk((d) => d.filter((x) => x.id !== f.id)); setScans((s) => { const n = { ...s }; delete n[f.id]; return n; }); if (at?.kind === "disk" && at.id === f.id) setAt(null); }
    catch (e) { toast(errText(e), "err"); }
  };

  // the big viewer: arrows move between the pictures of the folder that is open, Escape closes
  const viewRef = useRef(view); viewRef.current = view;
  useEffect(() => {
    if (!view) return;
    const k = (e: KeyboardEvent) => {
      const v = viewRef.current; if (!v) return;
      if ((e.target as HTMLElement | null)?.closest?.("input, textarea")) return;   // typing a comment: the keys are for the text
      if (e.key === "Escape") setView(null);
      else if (e.key === "ArrowRight") setView({ ...v, at: (v.at + 1) % v.list.length });
      else if (e.key === "ArrowLeft") setView({ ...v, at: (v.at - 1 + v.list.length) % v.list.length });
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [!!view]);   // eslint-disable-line react-hooks/exhaustive-deps

  const tileGrid = (list: Tile[]) => (
    <div className="gal-grid" data-testid="gallery-tiles">
      {list.map((t, i) => (
        <button key={t.id} type="button" className="gal-tile" data-gallery-tile={t.id} title={t.kind === "video" || !t.who ? t.title : t.note} onClick={() => setView({ list, at: i })}>
          <Pic t={t} />
          {t.kind === "video" ? <span className="gal-badge">▶ clip</span> : t.kind === "gif" ? <span className="gal-badge">GIF</span> : null}
          {counts[t.key] ? <span className="gal-badge left" data-testid="comment-count">💬 {counts[t.key]}</span> : null}
          {!t.who ? <span className="gal-cap">{t.title}</span> : null}
        </button>
      ))}
    </div>
  );

  function viewer(v: { list: Tile[]; at: number }) {
    const t = v.list[v.at];
    return (
      <div className="gal-viewer" role="dialog" aria-label="Picture viewer" data-testid="gallery-viewer" onMouseDown={(e) => { if (e.target === e.currentTarget) setView(null); }}>
        <div className="gal-vbar">
          <span><b>{t.title}</b>{t.note ? <small> · {t.note}</small> : null} <small>({v.at + 1} of {v.list.length})</small></span>
          <span className="row" style={{ gap: 8 }}>
            {t.who ? <button className="btn sm" onClick={() => { setView(null); go({ page: "editor", id: t.who!.id }); }}>Open character</button> : null}
            <button className="btn sm" data-testid="gallery-close" onClick={() => setView(null)} aria-label="Close">✕</button>
          </span>
        </div>
        <div className="gal-vbody">
        <div className="gal-vmain">
          {v.list.length > 1 && <button className="gal-nav left" aria-label="Previous picture" data-testid="gallery-prev" onClick={() => setView({ ...v, at: (v.at - 1 + v.list.length) % v.list.length })}>‹</button>}
          <div className="gal-vpic" data-testid="gallery-big"><Pic key={t.id} t={t} fit="contain" big /></div>
          {v.list.length > 1 && <button className="gal-nav right" aria-label="Next picture" data-testid="gallery-next" onClick={() => setView({ ...v, at: (v.at + 1) % v.list.length })}>›</button>}
        </div>
        <aside className="gal-comments" aria-label="Comments on this picture"><PictureComments picKey={t.key} author={me.name} onCount={(n) => setCount(t.key, n)} /></aside>
        </div>
      </div>
    );
  }

  const crumbs = (items: { label: string; go?: () => void }[]) => (
    <div className="gal-crumbs" data-testid="gallery-crumbs">
      {items.map((x, i) => (
        <span key={i} style={{ display: "contents" }}>
          {i > 0 ? <span aria-hidden>›</span> : null}
          {x.go ? <button type="button" className="btn ghost sm" onClick={x.go}>{x.label}</button> : <b>{x.label}</b>}
        </span>
      ))}
    </div>
  );

  // ---- a character's folder (or its gallery sub folder) ----
  const who = at?.kind === "char" ? characters.find((c) => c.id === at.id) ?? null : null;
  if (at?.kind === "char" && who) {
    const prof = profileTile(who), gal = galleryTiles(who);
    return (
      <div className="page" data-testid="gallery-folder">
        <div className="page-head">
          <div>
            {crumbs([{ label: "🖼️ Gallery", go: () => setAt(null) }, at.sub ? { label: `📁 ${displayName(who)}`, go: () => setAt({ ...at, sub: false }) } : { label: `📁 ${displayName(who)}` }, ...(at.sub ? [{ label: "Gallery" }] : [])])}
            <h1 style={{ marginTop: 6 }}>{displayName(who)}</h1>
            <div className="sub">{at.sub ? `${gal.length} in their gallery` : plural(picCount(who), "picture")}</div>
          </div>
          <div className="row"><button className="btn" onClick={() => go({ page: "editor", id: who.id })}>Open character</button></div>
        </div>
        {at.sub ? tileGrid(gal) : (
          <>
            <div className="gal-grid" data-testid="gallery-contents">
              {prof ? (
                <button type="button" className="gal-tile" data-gallery-tile={prof.id} onClick={() => setView({ list: [prof, ...gal], at: 0 })}>
                  <Pic t={prof} />
                  {counts[prof.key] ? <span className="gal-badge left" data-testid="comment-count">💬 {counts[prof.key]}</span> : null}
                  <span className="gal-cap">Profile picture</span>
                </button>
              ) : null}
              {gal.length ? (
                <button type="button" className="gal-folder sub" data-gallery-sub="gallery" onClick={() => setAt({ ...at, sub: true })}>
                  <span className="gal-stack">{gal.slice(0, 3).map((t) => <span key={t.id}><Pic t={{ ...t, kind: t.kind === "video" ? "image" : t.kind }} /></span>)}</span>
                  <b>📁 Gallery</b><small>{plural(gal.length, "picture")}</small>
                </button>
              ) : null}
            </div>
            {!prof && !gal.length ? (
              <p className="hint" data-testid="gallery-empty-folder">{who.media?.kind === "vrm" ? "This character is a 3D model, so there is no flat picture to show here." : "This character has no pictures yet."} Add some in the character's editor.</p>
            ) : null}
          </>
        )}
        {view && viewer(view)}
      </div>
    );
  }

  // ---- a folder from the computer (and the folders inside it) ----
  if (at?.kind === "disk") {
    const f = disk.find((x) => x.id === at.id), sc = scans[at.id];
    const root = sc && sc !== "error" ? sc.root : null;
    let dir: ViewDir | null = root;
    for (const part of at.path) dir = dir?.dirs.find((d) => d.name === part) ?? null;
    if (!f || !root || !dir) {
      return (
        <div className="page" data-testid="gallery-folder">
          {crumbs([{ label: "🖼️ Gallery", go: () => setAt(null) }])}
          <p className="hint">{sc === "error" || (f && !f.exists) ? "That folder has been moved or deleted. You can take it off the Gallery from the list." : "Looking in the folder…"}</p>
        </div>
      );
    }
    const here = dir, tiles = diskTiles(here);
    const up = (n: number) => setAt({ ...at, path: at.path.slice(0, n) });
    return (
      <div className="page" data-testid="gallery-folder" data-gallery-disk={f.name}>
        <div className="page-head">
          <div>
            {crumbs([{ label: "🖼️ Gallery", go: () => setAt(null) }, ...[f.name, ...at.path].map((label, i, a) => (i === a.length - 1 ? { label: `📁 ${label}` } : { label: `📁 ${label}`, go: () => up(i) }))])}
            <h1 style={{ marginTop: 6 }}>{at.path.length ? at.path[at.path.length - 1] : f.name}</h1>
            <div className="sub">{plural(here.total, "picture")}{here.dirs.length ? ` · ${plural(here.dirs.length, "folder")} inside` : ""} · <span title={f.path}>from your computer</span>{sc && sc !== "error" && sc.truncated && at.path.length === 0 ? " · only the first pictures are shown" : ""}</div>
          </div>
        </div>
        {here.dirs.length ? (
          <div className="gal-folders" data-testid="gallery-subfolders" style={{ marginBottom: 16 }}>
            {here.dirs.map((d) => { const cover = firstPic(d); return (
              <button key={d.name} type="button" className="gal-folder" data-gallery-subdir={d.name} onClick={() => setAt({ ...at, path: [...at.path, d.name] })}>
                <span className="gal-cover">{cover ? <Pic t={{ ...cover, kind: cover.kind === "video" ? "video" : cover.kind }} /> : null}</span>
                <b>📁 {d.name}</b><small>{plural(d.total, "picture")}</small>
              </button>
            ); })}
          </div>
        ) : null}
        {tiles.length ? tileGrid(tiles) : !here.dirs.length ? <p className="hint">No pictures in this folder.</p> : null}
        {view && viewer(view)}
      </div>
    );
  }

  // ---- everything: the characters' folders, then the folders from the computer ----
  return (
    <div className="page" data-testid="gallery-page">
      <div className="page-head">
        <div>
          <h1>Gallery</h1>
          <div className="sub">{plural(characters.length, "character folder")} · {plural(total, "picture")}{disk.length ? ` · ${plural(disk.length, "folder")} from your computer` : ""} · a quick look at the art, nothing here changes anything</div>
        </div>
        {canAddFolders ? <div className="row"><button className="btn" data-testid="gallery-add-folder" onClick={() => void addFolder()}>📁 Add a folder from my computer</button></div> : null}
      </div>
      <div className="row" style={{ marginBottom: 14, flexWrap: "wrap" }}>
        <input type="search" placeholder="Search names and tags…" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 380 }} aria-label="Search the gallery" />
        <label className="check" style={{ display: "flex", gap: 6, alignItems: "center" }}><input type="checkbox" checked={onlyGalleries} onChange={(e) => setOnlyGalleries(e.target.checked)} data-testid="gallery-only" /> Only characters with a gallery</label>
      </div>
      {!characters.length ? (
        <p className="hint" data-testid="gallery-empty">No characters yet. Add some on the <button className="link" onClick={() => go({ page: "library" })}>Characters</button> page and their pictures will show up here.</p>
      ) : !shown.length ? (
        <p className="hint">No folders match.</p>
      ) : (
        <div className="gal-folders" data-testid="gallery-folders">
          {shown.map((c) => {
            const prof = profileTile(c), n = picCount(c), g = c.gallery?.length ?? 0;
            return (
              <button key={c.id} type="button" className="gal-folder" data-gallery-folder={displayName(c)} onClick={() => setAt({ kind: "char", id: c.id, sub: false })}>
                <span className="gal-cover">
                  {prof ? <Pic t={prof} /> : <span className="gal-none">{c.media?.kind === "vrm" ? "3D" : displayName(c).slice(0, 1).toUpperCase()}</span>}
                </span>
                <b>📁 {displayName(c)}</b>
                <small>{n ? plural(n, "picture") : c.media?.kind === "vrm" ? "3D model" : "no pictures yet"}{g ? ` · gallery of ${g}` : ""}</small>
              </button>
            );
          })}
        </div>
      )}

      {canAddFolders ? (
        <section style={{ marginTop: 28 }} data-testid="gallery-disk">
          <h2 className="sect" style={{ borderTop: 0, marginTop: 0 }}>From my computer</h2>
          <p className="sub" style={{ marginTop: 0 }}>Folders of pictures on this computer that aren't part of any character, only to look at. Pictures in subfolders show up as folders inside. Nothing is copied, changed or deleted.</p>
          {!disk.length ? <p className="hint" data-testid="gallery-disk-empty">No folders added yet. Press <b>Add a folder from my computer</b> and choose one, such as your Pictures folder or a folder of fan art.</p> : (
            <div className="gal-folders" data-testid="gallery-disk-folders">
              {disk.map((f) => {
                const sc = scans[f.id], root = sc && sc !== "error" ? sc.root : null, cover = root ? firstPic(root) : null;
                return (
                  <div key={f.id} className="gal-folder-wrap">
                    <button type="button" className="gal-folder" data-gallery-disk-folder={f.name} disabled={!f.exists} onClick={() => setAt({ kind: "disk", id: f.id, path: [] })} title={f.path}>
                      <span className="gal-cover">{cover ? <Pic t={cover} /> : <span className="gal-none">{f.exists ? "…" : "?"}</span>}</span>
                      <b>📁 {f.name}</b>
                      <small>{!f.exists || sc === "error" ? "moved or deleted" : root ? `${plural(root.total, "picture")}${root.dirs.length ? ` · ${plural(root.dirs.length, "folder")}` : ""}${sc?.truncated ? " (first ones)" : ""}` : "looking…"}</small>
                    </button>
                    <button type="button" className="btn ghost sm gal-remove" data-testid="gallery-remove-folder" aria-label={`Take ${f.name} off the Gallery`} title="Take it off the Gallery (nothing on your computer is touched)" onClick={() => void removeFolder(f)}>✕</button>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      ) : null}
    </div>
  );
}
