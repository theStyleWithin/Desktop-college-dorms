import { Component, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open as pickFolder } from "@tauri-apps/plugin-dialog";
import { api, displayName, mediaUrl, type Character, type ViewDir, type ViewFolder } from "../api";
import { useStore } from "../store";
import { errText } from "../lib/util";
import { Modal, useToast } from "../components/ui";
import PictureComments from "../components/PictureComments";
import PictureLinkBox, { pastedPicture } from "../components/PictureLinkBox";
import GalleryStage from "../components/GalleryStage";
import PictureChat from "../components/PictureChat";

/**
 * Gallery: a quick look at pictures, for when you just want to look at the art and not chat. Every character is an art folder holding
 * their profile picture; if they have a gallery of their own it is a sub folder inside. You can also add folders from your computer,
 * which have nothing to do with any character, only to look at. Nothing here changes anything: a folder from your computer is never
 * copied, changed or deleted (taking it off the list only forgets it).
 */
type Tile = { id: string; key: string; url: string; kind: "image" | "gif" | "video"; title: string; note?: string; who?: Character; path?: string };

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
const diskTiles = (d: ViewDir): Tile[] => d.files.map((f) => ({ id: f.path, key: `disk:${f.path}`, url: convertFileSrc(f.path), kind: f.kind, title: f.name, note: d.name, path: f.path }));
const firstPic = (d: ViewDir): Tile | null => (d.files[0] ? diskTiles(d)[0] : d.dirs.map(firstPic).find(Boolean) ?? null);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/**
 * A small preview of a picture from a folder on the computer. The full file is never loaded for a tile (a folder of big photos or 4K clips
 * would fill the memory, which is what made the Gallery look like it crashed): the app makes a small copy, a few at a time, as the tile scrolls into view.
 */
const thumbCache = new Map<string, string>();
let thumbBusy = 0; const thumbWait: (() => void)[] = [];
const thumbSlot = () => new Promise<void>((ok) => { if (thumbBusy < 3) { thumbBusy++; ok(); } else thumbWait.push(() => { thumbBusy++; ok(); }); });
const thumbFree = () => { thumbBusy--; thumbWait.shift()?.(); };
function DiskThumb({ t, fit }: { t: Tile; fit: "cover" | "contain" }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [src, setSrc] = useState<string | null>(t.path ? thumbCache.get(t.path) ?? null : null);
  const [bad, setBad] = useState(false);
  useEffect(() => {
    if (src || bad || !t.path || t.kind === "video") return;
    const el = ref.current; if (!el) return;
    let dead = false;
    const io = new IntersectionObserver((es) => {
      if (!es.some((e) => e.isIntersecting)) return;
      io.disconnect();
      void (async () => {
        await thumbSlot();
        try {
          if (dead) return;
          const p = await api.viewThumb(t.path!);
          thumbCache.set(t.path!, convertFileSrc(p));
          if (!dead) setSrc(thumbCache.get(t.path!)!);
        } catch { if (!dead) setBad(true); } finally { thumbFree(); }
      })();
    }, { rootMargin: "200px" });
    io.observe(el);
    return () => { dead = true; io.disconnect(); };
  }, [src, bad, t.path, t.kind]);
  return (
    <span ref={ref} className="gal-thumb" data-testid="gallery-thumb" style={{ display: "block", width: "100%", height: "100%" }}>
      {src ? <img src={src} alt={t.note ? `${t.title}: ${t.note}` : t.title} decoding="async" draggable={false} style={{ objectFit: fit }} />
        : <span className="gal-none">{t.kind === "video" ? "▶" : bad ? "?" : "…"}</span>}
    </span>
  );
}

/** One picture, a picture file or a short clip (a clip from the computer is a plain tile, so a folder of big videos never loads at once). */
function Pic({ t, fit = "cover" }: { t: Tile; fit?: "cover" | "contain" }) {
  if (t.path) return <DiskThumb t={t} fit={fit} />;
  if (t.kind === "video") {
    return <video src={t.url} muted loop playsInline preload="none" style={{ objectFit: fit }}
      onMouseEnter={(e) => { void e.currentTarget.play().catch(() => {}); }} onMouseLeave={(e) => { e.currentTarget.pause(); e.currentTarget.currentTime = 0; }} />;
  }
  return <img src={t.url} alt={t.note ? `${t.title}: ${t.note}` : t.title} loading="lazy" decoding="async" draggable={false} style={{ objectFit: fit }} />;
}

/** Asks for a name and makes a new, empty gallery folder in the app. */
function NewFolderDialog({ make, onClose }: { make: (name: string) => Promise<ViewFolder>; onClose: () => void }) {
  const toast = useToast();
  const [name, setName] = useState(""), [busy, setBusy] = useState(false);
  const go = async () => { setBusy(true); try { await make(name); toast(`Made the gallery folder "${name.trim()}".`, "ok"); onClose(); } catch (e) { toast(errText(e), "err"); } finally { setBusy(false); } };
  return (
    <Modal title="✨ New gallery folder" onClose={onClose}>
      <div data-testid="gallery-new-folder" style={{ display: "grid", gap: 10 }}>
        <p className="sub" style={{ margin: 0 }}>An empty folder kept by the app, for pictures you add from links or files.</p>
        <label className="field"><span>Folder name</span><input type="text" autoFocus maxLength={60} value={name} data-testid="gallery-new-folder-name" aria-label="Folder name" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && name.trim() && !busy) void go(); }} /></label>
        <div className="row"><button className="btn primary" disabled={busy || !name.trim()} data-testid="gallery-new-folder-make" onClick={() => void go()}>Make folder</button><button className="btn" onClick={onClose}>Cancel</button></div>
      </div>
    </Modal>
  );
}

/** Copies a picture from a web address into one of the person's own gallery folders (or a new one made on the spot). */
function LinkDialog({ own, make, added, onClose }: { own: ViewFolder[]; make: (name: string) => Promise<ViewFolder>; added: (f: ViewFolder) => void; onClose: () => void }) {
  const toast = useToast();
  const [pick, setPick] = useState<string>(own[0]?.id ?? "new"), [name, setName] = useState("");
  const [folders, setFolders] = useState(own);
  const put = async (file: File) => {
    let f = folders.find((x) => x.id === pick);
    if (!f) {
      f = await make(name);
      setFolders((l) => [...l, f!]); setPick(f.id); setName("");
    }
    await api.addFolderPicture(f.id, file);
    added(f);
    toast(`Added to "${f.name}".`, "ok");
  };
  return (
    <Modal title="🔗 Copy a picture from a link" onClose={onClose}>
      <div data-testid="gallery-link-dialog" style={{ display: "grid", gap: 10 }}>
        <p className="sub" style={{ margin: 0 }}>Paste the address of a picture, GIF or short video. The app makes its own copy in the folder you choose.</p>
        <label className="field"><span>Put it in</span>
          <select value={pick} data-testid="gallery-link-folder" aria-label="Folder to add to" onChange={(e) => setPick(e.target.value)}>
            {folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            <option value="new">➕ A new folder…</option>
          </select></label>
        {pick === "new" ? <label className="field"><span>New folder name</span><input type="text" maxLength={60} value={name} data-testid="gallery-link-newname" aria-label="New folder name" onChange={(e) => setName(e.target.value)} /></label> : null}
        <PictureLinkBox testid="gallery-link-box" busy={pick === "new" && !name.trim()} onFile={async (f) => { try { await put(f); } catch (e) { toast(errText(e), "err"); } }} />
        {pick === "new" && !name.trim() ? <div className="hint">Name the new folder first.</div> : null}
        <div className="row"><button className="btn" onClick={onClose}>Done</button></div>
      </div>
    </Modal>
  );
}

/** If something in the Gallery breaks, say what, instead of leaving a blank page. */
class GalleryGuard extends Component<{ children: ReactNode }, { err: string | null }> {
  state = { err: null as string | null };
  static getDerivedStateFromError(e: unknown) { return { err: e instanceof Error ? e.message : String(e) }; }
  render() {
    return this.state.err === null ? this.props.children : (
      <div className="page" role="alert" data-testid="gallery-error"><h2>The Gallery hit a problem</h2><p className="hint">{this.state.err}</p>
        <button className="btn" onClick={() => this.setState({ err: null })}>Try again</button></div>
    );
  }
}

type Where = { kind: "char"; id: string; sub: boolean } | { kind: "disk"; id: string; path: string[] } | null;

function GalleryPage() {
  const { characters, go, info, me, refresh, settings } = useStore();
  const toast = useToast();
  const [q, setQ] = useState("");
  const [onlyGalleries, setOnlyGalleries] = useState(false);
  const [at, setAt] = useState<Where>(null);
  const [view, setView] = useState<{ list: Tile[]; at: number } | null>(null);
  // folders from the computer
  const [disk, setDisk] = useState<ViewFolder[]>([]);
  const [scans, setScans] = useState<Record<string, { root: ViewDir; truncated: boolean } | "error">>({});
  const canAddFolders = info?.platform !== "android";   // choosing a folder on the computer; making a folder in the app and adding from links works everywhere
  // how many comments each picture has (shown as a count on the picture)
  const [counts, setCounts] = useState<Record<string, number>>({});
  useEffect(() => { api.galleryCommentCounts().then(setCounts).catch(() => {}); }, []);
  const setCount = useCallback((key: string, n: number) => setCounts((c) => (c[key] === n ? c : { ...c, [key]: n })), []);

  // how the folders are arranged: the order the person chose, and whether everything is in one place
  const [order, setOrder] = useState<string[]>(settings.gallery_order ?? []);
  const [merge, setMerge] = useState<boolean>(!!settings.gallery_merge);
  const [arrange, setArrange] = useState(false);
  const [dragKey, setDragKey] = useState<string | null>(null), [overKey, setOverKey] = useState<string | null>(null);
  useEffect(() => { setOrder(settings.gallery_order ?? []); setMerge(!!settings.gallery_merge); }, [settings.gallery_order, settings.gallery_merge]);
  const saveLayout = async (o: string[], m: boolean) => {
    setOrder(o); setMerge(m);
    try { await api.saveSettings({ ...settings, gallery_order: o, gallery_merge: m }); await refresh(); } catch (e) { toast(errText(e), "err"); }
  };
  // the panel beside (or below) the big picture: comments, or a chat with a character about what is on screen
  const lsGet = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
  const lsPut = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* not remembered */ } };
  const [panel, setPanelState] = useState<"comments" | "chat">(lsGet("dorms.gallery.panel") === "chat" ? "chat" : "comments");
  const [layout, setLayoutState] = useState<"side" | "below">(lsGet("dorms.gallery.layout") === "below" ? "below" : "side");
  const setPanel = (p: "comments" | "chat") => { setPanelState(p); lsPut("dorms.gallery.panel", p); };
  const setLayout = (l: "side" | "below") => { setLayoutState(l); lsPut("dorms.gallery.layout", l); };
  const [menu, setMenu] = useState(false), [dialog, setDialog] = useState<null | "new" | "link">(null);
  useEffect(() => {
    if (!menu) return;
    const close = (e: Event) => { if (!(e.target as HTMLElement | null)?.closest?.("[data-gal-menu]")) setMenu(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setMenu(false); };
    window.addEventListener("mousedown", close); window.addEventListener("keydown", esc);
    return () => { window.removeEventListener("mousedown", close); window.removeEventListener("keydown", esc); };
  }, [menu]);

  const sorted = useMemo(() => [...characters].sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9) || displayName(a).localeCompare(displayName(b))), [characters]);
  const shown = sorted.filter((c) => (!onlyGalleries || (c.gallery?.length ?? 0) > 0)
    && (!q.trim() || `${displayName(c)} ${c.card.tags.join(" ")}`.toLowerCase().includes(q.trim().toLowerCase())));
  const total = characters.reduce((n, c) => n + picCount(c), 0);

  /** Adds a picture (from a link or the clipboard) to a character's own gallery, the same as adding it in the character's editor. */
  const addToGallery = async (c: Character, f: File) => {
    try { await api.addGalleryImage(c.id, f); await refresh(); toast(`Added to ${displayName(c)}'s gallery.`, "ok"); }
    catch (e) { toast(`${f.name}: ${errText(e)}`, "err"); }
  };

  const scan = useCallback(async (f: ViewFolder) => {
    if (!f.exists) { setScans((s) => ({ ...s, [f.id]: "error" })); return; }
    try { const r = await api.scanViewFolder(f.id); setScans((s) => ({ ...s, [f.id]: r })); } catch { setScans((s) => ({ ...s, [f.id]: "error" })); }
  }, []);
  const loadDisk = useCallback(async () => {
    try { const l = await api.listViewFolders(); setDisk(l); l.forEach((f) => void scan(f)); } catch { setDisk([]); }
  }, [scan]);
  useEffect(() => { void loadDisk(); }, [loadDisk]);

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
    const sc = scans[f.id], n = sc && sc !== "error" ? sc.root.total : 0;
    if (!window.confirm(f.own
      ? `Delete the gallery folder "${f.name}"${n ? ` and its ${plural(n, "picture")}` : ""}? This can't be undone.`
      : `Take "${f.name}" off the Gallery? Nothing on your computer is changed or deleted; it just isn't listed here any more.`)) return;
    try { await api.removeViewFolder(f.id); setDisk((d) => d.filter((x) => x.id !== f.id)); setScans((s) => { const n = { ...s }; delete n[f.id]; return n; }); if (at?.kind === "disk" && at.id === f.id) setAt(null); }
    catch (e) { toast(errText(e), "err"); }
  };

  const afterAdd = (f: ViewFolder) => { setDisk((d) => (d.some((x) => x.id === f.id) ? d : [...d, f])); void scan(f); };
  const makeFolder = async (name: string) => { const f = await api.createGalleryFolder(name); afterAdd(f); return f; };
  const addFiles = async (f: ViewFolder, files: FileList | File[]) => {
    let n = 0;
    for (const file of Array.from(files)) { try { await api.addFolderPicture(f.id, file); n++; } catch (e) { toast(`${file.name}: ${errText(e)}`, "err"); } }
    if (n) { void scan(f); toast(`Added ${plural(n, "picture")} to "${f.name}".`, "ok"); }
  };
  const removePic = async (f: ViewFolder, t: Tile) => {
    if (!window.confirm(`Delete "${t.title}" from "${f.name}"? This can't be undone.`)) return;
    try { await api.removeFolderPicture(f.id, t.id); setView(null); void scan(f); } catch (e) { toast(errText(e), "err"); }
  };

  // the big viewer: arrows move between the pictures of the folder that is open, Escape closes
  const viewRef = useRef(view); viewRef.current = view;
  useEffect(() => {
    if (!view) return;
    const k = (e: KeyboardEvent) => {
      const v = viewRef.current; if (!v) return;
      if ((e.target as HTMLElement | null)?.closest?.("input, textarea")) return;   // typing a comment: the keys are for the text
      if (e.key === "Escape") { if (document.fullscreenElement) return; setView(null); }
      else if (e.shiftKey) return;
      else if (e.key === "ArrowRight") setView({ ...v, at: (v.at + 1) % v.list.length });
      else if (e.key === "ArrowLeft") setView({ ...v, at: (v.at - 1 + v.list.length) % v.list.length });
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [!!view]);   // eslint-disable-line react-hooks/exhaustive-deps

  const tileGrid = (list: Tile[], removable?: (t: Tile) => void) => (
    <div className="gal-grid" data-testid="gallery-tiles">
      {list.map((t, i) => (
        <button key={t.id} type="button" className="gal-tile" data-gallery-tile={t.id} title={t.kind === "video" || !t.who ? t.title : t.note} onClick={() => setView({ list, at: i })}>
          <Pic t={t} />
          {t.kind === "video" ? <span className="gal-badge">▶ clip</span> : t.kind === "gif" ? <span className="gal-badge">GIF</span> : null}
          {counts[t.key] ? <span className="gal-badge left" data-testid="comment-count">💬 {counts[t.key]}</span> : null}
          {!t.who ? <span className="gal-cap">{t.title}</span> : null}
          {removable ? <span role="button" tabIndex={0} className="gal-del" data-testid="gallery-delete-pic" aria-label={`Delete ${t.title}`} title="Delete this picture" onClick={(e) => { e.stopPropagation(); removable(t); }} onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); removable(t); } }}>✕</span> : null}
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
        <div className={`gal-vbody${layout === "below" ? " below" : ""}`} data-layout={layout}>
        <div className="gal-vmain">
          {v.list.length > 1 && <button className="gal-nav left" aria-label="Previous picture" data-testid="gallery-prev" onClick={() => setView({ ...v, at: (v.at - 1 + v.list.length) % v.list.length })}>‹</button>}
          <div className="gal-vpic" data-testid="gallery-big"><GalleryStage key={t.id} t={t} /></div>
          {v.list.length > 1 && <button className="gal-nav right" aria-label="Next picture" data-testid="gallery-next" onClick={() => setView({ ...v, at: (v.at + 1) % v.list.length })}>›</button>}
        </div>
        <aside className="gal-comments" aria-label={panel === "chat" ? "Chat about this picture" : "Comments on this picture"} data-testid="gallery-panel">
          <div className="gal-panelbar">
            <span className="gal-seg" role="tablist" aria-label="What to show beside the picture">
              <button type="button" role="tab" aria-selected={panel === "comments"} className={`btn sm${panel === "comments" ? " primary" : ""}`} data-testid="gallery-tab-comments" onClick={() => setPanel("comments")}>💬 Comments</button>
              <button type="button" role="tab" aria-selected={panel === "chat"} className={`btn sm${panel === "chat" ? " primary" : ""}`} data-testid="gallery-tab-chat" onClick={() => setPanel("chat")}>🧑 Talk to a character</button>
            </span>
            <button type="button" className="btn sm" data-testid="gallery-flip" aria-label={layout === "side" ? "Move this panel below the picture" : "Move this panel beside the picture"} title={layout === "side" ? "Put this panel below the picture (a wider box to type in)" : "Put this panel beside the picture"} onClick={() => setLayout(layout === "side" ? "below" : "side")}>{layout === "side" ? "⬇ Below" : "➡ Side"}</button>
          </div>
          {panel === "chat"
            ? <PictureChat key={t.key} pic={{ key: t.key, title: t.title, note: t.note, kind: t.kind }} />
            : <PictureComments picKey={t.key} author={me.name} onCount={(n) => setCount(t.key, n)} />}
        </aside>
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
      <div className="page" data-testid="gallery-folder" onPaste={(e) => { if ((e.target as HTMLElement).closest("input, textarea")) return; const f = pastedPicture(e); if (f) { e.preventDefault(); void addToGallery(who, f); } }}>
        <div className="page-head">
          <div>
            {crumbs([{ label: "🖼️ Gallery", go: () => setAt(null) }, at.sub ? { label: `📁 ${displayName(who)}`, go: () => setAt({ ...at, sub: false }) } : { label: `📁 ${displayName(who)}` }, ...(at.sub ? [{ label: "Gallery" }] : [])])}
            <h1 style={{ marginTop: 6 }}>{displayName(who)}</h1>
            <div className="sub">{at.sub ? `${gal.length} in their gallery` : plural(picCount(who), "picture")}</div>
          </div>
          <div className="row"><button className="btn" onClick={() => go({ page: "editor", id: who.id })}>Open character</button></div>
        </div>
        <div style={{ maxWidth: 520, marginBottom: 14 }} data-testid="gallery-add-here">
          <PictureLinkBox testid="gallery-folder-link" onFile={(f) => addToGallery(who, f)} placeholder="Add a picture to their gallery: paste a link (https://…)" />
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
            <div className="sub">{plural(here.total, "picture")}{here.dirs.length ? ` · ${plural(here.dirs.length, "folder")} inside` : ""} · {f.own ? <span>kept by the app</span> : <span title={f.path}>from your computer</span>}{sc && sc !== "error" && sc.truncated && at.path.length === 0 ? " · only the first pictures are shown" : ""}</div>
          </div>
        </div>
        {f.own && at.path.length === 0 ? (
          <div className="card" data-testid="gallery-own-add" style={{ display: "grid", gap: 8, marginBottom: 16 }}>
            <b>Add pictures to this folder</b>
            <PictureLinkBox testid="gallery-own-link" onFile={async (file) => { await addFiles(f, [file]); }} />
            <label className="btn" style={{ justifySelf: "start", cursor: "pointer" }}>Add from my computer…
              <input type="file" multiple accept="image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm" data-testid="gallery-own-files" style={{ display: "none" }} onChange={(e) => { if (e.target.files?.length) void addFiles(f, e.target.files); e.target.value = ""; }} />
            </label>
          </div>
        ) : null}
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
        {tiles.length ? tileGrid(tiles, f.own && at.path.length === 0 ? (t) => void removePic(f, t) : undefined) : !here.dirs.length ? <p className="hint">{f.own ? "Nothing here yet. Add a picture from a link or from your computer." : "No pictures in this folder."}</p> : null}
        {view && viewer(view)}
      </div>
    );
  }

  // ---- everything: the characters' folders, and the folders the person added ----
  const rank = (k: string) => { const i = order.indexOf(k); return i < 0 ? Infinity : i; };
  const byOrder = <T,>(items: T[], k: (x: T) => string) => items.map((x, i) => ({ x, i })).sort((a, b) => rank(k(a.x)) - rank(k(b.x)) || a.i - b.i).map((e) => e.x);
  const canArrange = !q.trim() && !onlyGalleries;
  const diskShown = disk.filter((f) => !q.trim() || f.name.toLowerCase().includes(q.trim().toLowerCase()));
  const charCard = (c: Character) => {
    const prof = profileTile(c), n = picCount(c), g = c.gallery?.length ?? 0;
    return (
      <button type="button" className="gal-folder" data-gallery-folder={displayName(c)} onClick={() => setAt({ kind: "char", id: c.id, sub: false })}>
        <span className="gal-cover">
          {prof ? <Pic t={prof} /> : <span className="gal-none">{c.media?.kind === "vrm" ? "3D" : displayName(c).slice(0, 1).toUpperCase()}</span>}
        </span>
        <b>📁 {displayName(c)}</b>
        <small>{n ? plural(n, "picture") : c.media?.kind === "vrm" ? "3D model" : "no pictures yet"}{g ? ` · gallery of ${g}` : ""}</small>
      </button>
    );
  };
  const diskCard = (f: ViewFolder) => {
    const sc = scans[f.id], root = sc && sc !== "error" ? sc.root : null, cover = root ? firstPic(root) : null;
    return (
      <div className="gal-folder-wrap">
        <button type="button" className="gal-folder" data-gallery-disk-folder={f.name} data-gallery-own={f.own ? "1" : undefined} disabled={!f.exists} onClick={() => setAt({ kind: "disk", id: f.id, path: [] })} title={f.own ? "A gallery folder kept by the app" : f.path}>
          <span className="gal-cover">{cover ? <Pic t={cover} /> : <span className="gal-none">{f.exists ? (f.own ? "＋" : "…") : "?"}</span>}</span>
          <b>{f.own ? "🗂️" : "📁"} {f.name}</b>
          <small>{!f.exists || sc === "error" ? "moved or deleted" : root ? `${plural(root.total, "picture")}${root.dirs.length ? ` · ${plural(root.dirs.length, "folder")}` : ""}${sc?.truncated ? " (first ones)" : ""}` : "looking…"}</small>
        </button>
        <button type="button" className="btn ghost sm gal-remove" data-testid="gallery-remove-folder" aria-label={f.own ? `Delete the gallery folder ${f.name}` : `Take ${f.name} off the Gallery`} title={f.own ? "Delete this folder and its pictures" : "Take it off the Gallery (nothing on your computer is touched)"} onClick={() => void removeFolder(f)}>✕</button>
      </div>
    );
  };
  const move = (visible: string[], from: string, to: string, after: boolean) => {
    const keys = visible.filter((k) => k !== from), i = keys.indexOf(to);
    if (i < 0) return;
    keys.splice(after ? i + 1 : i, 0, from);
    void saveLayout([...keys, ...order.filter((k) => !keys.includes(k))], merge);
  };
  /** One folder in a grid: it can be dragged to a new place (or moved with Alt and the arrow keys, or the arrows shown in Arrange mode). */
  const slot = (k: string, visible: string[], node: ReactNode) => {
    const i = visible.indexOf(k);
    return (
      <div key={k} className={`gal-slot${dragKey === k ? " dragging" : ""}${overKey === k && dragKey && dragKey !== k ? " over" : ""}`} data-gal-key={k} data-testid="gallery-slot"
        draggable={canArrange}
        onDragStart={(e) => { setDragKey(k); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", k); }}
        onDragOver={(e) => { if (dragKey && visible.includes(dragKey)) { e.preventDefault(); if (overKey !== k) setOverKey(k); } }}
        onDragLeave={() => setOverKey((o) => (o === k ? null : o))}
        onDrop={(e) => { e.preventDefault(); const from = dragKey; setDragKey(null); setOverKey(null); if (from && from !== k && visible.includes(from)) move(visible, from, k, visible.indexOf(from) < i); }}
        onDragEnd={() => { setDragKey(null); setOverKey(null); }}
        onKeyDown={(e) => {
          if (!canArrange || !e.altKey) return;
          if (e.key === "ArrowLeft" && i > 0) { e.preventDefault(); move(visible, k, visible[i - 1], false); }
          else if (e.key === "ArrowRight" && i < visible.length - 1) { e.preventDefault(); move(visible, k, visible[i + 1], true); }
        }}>
        {node}
        {arrange && canArrange ? (
          <span className="gal-arrange">
            <button type="button" className="btn sm" data-testid="gallery-move-earlier" aria-label="Move earlier" disabled={i <= 0} onClick={() => move(visible, k, visible[i - 1], false)}>◀</button>
            <button type="button" className="btn sm" data-testid="gallery-move-later" aria-label="Move later" disabled={i >= visible.length - 1} onClick={() => move(visible, k, visible[i + 1], true)}>▶</button>
          </span>
        ) : null}
      </div>
    );
  };
  const charList = byOrder(shown, (c) => `char:${c.id}`), diskList = byOrder(diskShown, (f) => `disk:${f.id}`);
  const mergedList = byOrder([...charList.map((c) => ({ k: `char:${c.id}`, c, f: null as ViewFolder | null })), ...diskList.map((f) => ({ k: `disk:${f.id}`, c: null as Character | null, f }))], (e) => e.k);
  const charKeys = charList.map((c) => `char:${c.id}`), diskKeys = diskList.map((f) => `disk:${f.id}`), mergedKeys = mergedList.map((e) => e.k);
  const ownFolders = disk.filter((f) => f.own);
  const folderCount = characters.length + disk.length;
  return (
    <div className="page" data-testid="gallery-page">
      <div className="page-head">
        <div>
          <h1>Gallery</h1>
          <div className="sub">{plural(characters.length, "character folder")} · {plural(total, "picture")}{disk.length ? ` · ${plural(disk.length, "other folder")}` : ""} · a quick look at the art</div>
        </div>
        <div className="row" data-gal-menu style={{ position: "relative" }}>
          <button className="btn" data-testid="gallery-add-folder" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((m) => !m)}>📁 Add folder ▾</button>
          {menu ? (
            <div className="ctx-menu" role="menu" data-testid="gallery-add-menu" style={{ position: "absolute", right: 0, top: "100%", marginTop: 4 }}>
              {canAddFolders ? <button role="menuitem" data-testid="gallery-add-desktop" onClick={() => { setMenu(false); void addFolder(); }}>🖥️ Pick from desktop</button> : null}
              <button role="menuitem" data-testid="gallery-add-link" onClick={() => { setMenu(false); setDialog("link"); }}>🔗 Copy from a link…</button>
              <button role="menuitem" data-testid="gallery-add-new" onClick={() => { setMenu(false); setDialog("new"); }}>✨ New gallery folder…</button>
            </div>
          ) : null}
        </div>
      </div>
      <div className="row" style={{ marginBottom: 14, flexWrap: "wrap", gap: 14 }}>
        <input type="search" placeholder="Search names and tags…" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 380 }} aria-label="Search the gallery" />
        <label className="check" style={{ display: "flex", gap: 6, alignItems: "center" }}><input type="checkbox" checked={onlyGalleries} onChange={(e) => setOnlyGalleries(e.target.checked)} data-testid="gallery-only" /> Only characters with a gallery</label>
        <label className="check" style={{ display: "flex", gap: 6, alignItems: "center" }} title="Off: character folders and your other folders are in separate sections. On: everything is in one place."><input type="checkbox" checked={merge} onChange={(e) => void saveLayout(order, e.target.checked)} data-testid="gallery-merge" /> All folders in one place</label>
        {folderCount > 1 ? <button className={`btn sm${arrange ? " primary" : ""}`} aria-pressed={arrange} data-testid="gallery-arrange" disabled={!canArrange} title={canArrange ? "Show arrows on each folder to move it (you can also drag folders, or press Alt and an arrow key on one)" : "Clear the search and the filter to arrange folders"} onClick={() => setArrange((a) => !a)}>↔ Arrange</button> : null}
      </div>
      {canArrange && folderCount > 1 ? <div className="hint" style={{ marginBottom: 10 }}>Drag a folder to put it where you like.</div> : null}

      {merge ? (
        !mergedList.length ? <p className="hint">{characters.length || disk.length ? "No folders match." : <>No folders yet. Add some on the <button className="link" onClick={() => go({ page: "library" })}>Characters</button> page, or use <b>Add folder</b>.</>}</p> : (
          <div className="gal-folders" data-testid="gallery-folders">
            {mergedList.map((e) => slot(e.k, mergedKeys, e.c ? charCard(e.c) : diskCard(e.f!)))}
          </div>
        )
      ) : (
        <>
          {!characters.length ? (
            <p className="hint" data-testid="gallery-empty">No characters yet. Add some on the <button className="link" onClick={() => go({ page: "library" })}>Characters</button> page and their pictures will show up here.</p>
          ) : !shown.length ? (
            <p className="hint">No folders match.</p>
          ) : (
            <div className="gal-folders" data-testid="gallery-folders">
              {charList.map((c) => slot(`char:${c.id}`, charKeys, charCard(c)))}
            </div>
          )}
          <section style={{ marginTop: 28 }} data-testid="gallery-disk">
            <h2 className="sect" style={{ borderTop: 0, marginTop: 0 }}>My folders</h2>
            <p className="sub" style={{ marginTop: 0 }}>Folders that aren't part of any character: ones you made here (kept by the app, 🗂️) and ones from this computer{canAddFolders ? "" : " (a phone can't pick those)"} that are only looked at. Nothing from your computer is copied, changed or deleted.</p>
            {!disk.length ? <p className="hint" data-testid="gallery-disk-empty">No folders added yet. Press <b>Add folder</b> to pick one from your computer, copy a picture from a link, or make a new folder.</p> : !diskList.length ? <p className="hint">No folders match.</p> : (
              <div className="gal-folders" data-testid="gallery-disk-folders">
                {diskList.map((f) => slot(`disk:${f.id}`, diskKeys, diskCard(f)))}
              </div>
            )}
          </section>
        </>
      )}
      {dialog === "new" ? <NewFolderDialog make={makeFolder} onClose={() => setDialog(null)} /> : null}
      {dialog === "link" ? <LinkDialog own={ownFolders} make={makeFolder} added={(f) => { void scan(f); }} onClose={() => setDialog(null)} /> : null}
    </div>
  );
}

export default function Gallery() { return <GalleryGuard><GalleryPage /></GalleryGuard>; }
