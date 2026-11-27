import { useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { displayName, mediaUrl, type Character } from "../api";
import { useStore } from "../store";

/**
 * Gallery: a quick look at every character's pictures, for when you just want to look at the art and not chat. Each character is an art
 * folder holding their profile picture; if they have a gallery of their own it is a sub folder inside. Nothing here changes anything.
 */
type Tile = { id: string; url: string; kind: "image" | "gif" | "video"; title: string; note?: string };

const profileTile = (c: Character): Tile | null => {
  const url = mediaUrl(c);
  if (!url || !c.media || c.media.kind === "vrm") return null;
  return { id: `${c.id}:profile`, url, kind: c.media.kind, title: displayName(c), note: "Profile picture" };
};
const galleryTiles = (c: Character): Tile[] =>
  (c.gallery ?? []).flatMap((g) => {
    const p = c.gallery_paths?.find((x) => x.id === g.id)?.path;
    return p ? [{ id: `${c.id}:${g.id}`, url: convertFileSrc(p), kind: g.kind, title: displayName(c), note: g.moods.length ? g.moods.join(", ") : "Gallery" } as Tile] : [];
  });
const picCount = (c: Character) => (profileTile(c) ? 1 : 0) + galleryTiles(c).length;

/** One picture, a picture file or a short clip (a clip shows its first frame and plays while the pointer is on it). */
function Pic({ t, fit = "cover", big }: { t: Tile; fit?: "cover" | "contain"; big?: boolean }) {
  if (t.kind === "video") {
    return <video src={t.url} muted={!big} loop playsInline preload="metadata" controls={big} autoPlay={big} style={{ objectFit: fit }}
      onMouseEnter={(e) => { if (!big) void e.currentTarget.play().catch(() => {}); }} onMouseLeave={(e) => { if (!big) { e.currentTarget.pause(); e.currentTarget.currentTime = 0; } }} />;
  }
  return <img src={t.url} alt={t.note ? `${t.title}: ${t.note}` : t.title} loading="lazy" draggable={false} style={{ objectFit: fit }} />;
}

export default function Gallery() {
  const { characters, go } = useStore();
  const [q, setQ] = useState("");
  const [onlyGalleries, setOnlyGalleries] = useState(false);
  const [open, setOpen] = useState<string | null>(null);      // the character whose folder is open
  const [sub, setSub] = useState<"gallery" | null>(null);      // the sub folder that is open inside it
  const [view, setView] = useState<{ list: Tile[]; at: number; who: Character } | null>(null);

  const sorted = useMemo(() => [...characters].sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9) || displayName(a).localeCompare(displayName(b))), [characters]);
  const shown = sorted.filter((c) => (!onlyGalleries || (c.gallery?.length ?? 0) > 0)
    && (!q.trim() || `${displayName(c)} ${c.card.tags.join(" ")}`.toLowerCase().includes(q.trim().toLowerCase())));
  const who = open ? characters.find((c) => c.id === open) ?? null : null;
  useEffect(() => { if (open && !who) { setOpen(null); setSub(null); } }, [open, who]);

  const total = characters.reduce((n, c) => n + picCount(c), 0);

  // the big viewer: arrows move between the pictures of the folder that is open, Escape closes
  const viewRef = useRef(view); viewRef.current = view;
  useEffect(() => {
    if (!view) return;
    const k = (e: KeyboardEvent) => {
      const v = viewRef.current; if (!v) return;
      if (e.key === "Escape") setView(null);
      else if (e.key === "ArrowRight") setView({ ...v, at: (v.at + 1) % v.list.length });
      else if (e.key === "ArrowLeft") setView({ ...v, at: (v.at - 1 + v.list.length) % v.list.length });
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [!!view]);   // eslint-disable-line react-hooks/exhaustive-deps

  const tileGrid = (list: Tile[], c: Character) => (
    <div className="gal-grid" data-testid="gallery-tiles">
      {list.map((t, i) => (
        <button key={t.id} type="button" className="gal-tile" data-gallery-tile={t.id} title={t.note} onClick={() => setView({ list, at: i, who: c })}>
          <Pic t={t} />
          {t.kind === "video" ? <span className="gal-badge">▶ clip</span> : t.kind === "gif" ? <span className="gal-badge">GIF</span> : null}
        </button>
      ))}
    </div>
  );

  // ---- a character's folder (or its gallery sub folder) ----
  if (who) {
    const prof = profileTile(who), gal = galleryTiles(who);
    const crumb = (
      <div className="gal-crumbs" data-testid="gallery-crumbs">
        <button type="button" className="btn ghost sm" onClick={() => { setOpen(null); setSub(null); }}>🖼️ Gallery</button>
        <span aria-hidden>›</span>
        {sub ? <button type="button" className="btn ghost sm" onClick={() => setSub(null)}>📁 {displayName(who)}</button> : <b>📁 {displayName(who)}</b>}
        {sub ? <><span aria-hidden>›</span><b>Gallery</b></> : null}
      </div>
    );
    return (
      <div className="page" data-testid="gallery-folder">
        <div className="page-head">
          <div>{crumb}<h1 style={{ marginTop: 6 }}>{displayName(who)}</h1><div className="sub">{sub ? `${gal.length} in their gallery` : `${picCount(who)} picture${picCount(who) === 1 ? "" : "s"}`}</div></div>
          <div className="row"><button className="btn" onClick={() => go({ page: "editor", id: who.id })}>Open character</button></div>
        </div>
        {sub ? tileGrid(gal, who) : (
          <>
            <div className="gal-grid" data-testid="gallery-contents">
              {prof ? (
                <button type="button" className="gal-tile" data-gallery-tile={prof.id} onClick={() => setView({ list: [prof, ...gal], at: 0, who })}>
                  <Pic t={prof} />
                  <span className="gal-cap">Profile picture</span>
                </button>
              ) : null}
              {gal.length ? (
                <button type="button" className="gal-folder sub" data-gallery-sub="gallery" onClick={() => setSub("gallery")}>
                  <span className="gal-stack">{gal.slice(0, 3).map((t) => <span key={t.id}><Pic t={{ ...t, kind: t.kind === "video" ? "image" : t.kind, url: t.url }} /></span>)}</span>
                  <b>📁 Gallery</b><small>{gal.length} picture{gal.length === 1 ? "" : "s"}</small>
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

  function viewer(v: { list: Tile[]; at: number; who: Character }) {
    const t = v.list[v.at];
    return (
      <div className="gal-viewer" role="dialog" aria-label="Picture viewer" data-testid="gallery-viewer" onMouseDown={(e) => { if (e.target === e.currentTarget) setView(null); }}>
        <div className="gal-vbar">
          <span><b>{t.title}</b>{t.note ? <small> · {t.note}</small> : null} <small>({v.at + 1} of {v.list.length})</small></span>
          <span className="row" style={{ gap: 8 }}>
            <button className="btn sm" onClick={() => { setView(null); go({ page: "editor", id: v.who.id }); }}>Open character</button>
            <button className="btn sm" data-testid="gallery-close" onClick={() => setView(null)} aria-label="Close">✕</button>
          </span>
        </div>
        <div className="gal-vmain">
          {v.list.length > 1 && <button className="gal-nav left" aria-label="Previous picture" data-testid="gallery-prev" onClick={() => setView({ ...v, at: (v.at - 1 + v.list.length) % v.list.length })}>‹</button>}
          <div className="gal-vpic" data-testid="gallery-big"><Pic key={t.id} t={t} fit="contain" big /></div>
          {v.list.length > 1 && <button className="gal-nav right" aria-label="Next picture" data-testid="gallery-next" onClick={() => setView({ ...v, at: (v.at + 1) % v.list.length })}>›</button>}
        </div>
      </div>
    );
  }

  // ---- every character's folder ----
  return (
    <div className="page" data-testid="gallery-page">
      <div className="page-head">
        <div>
          <h1>Gallery</h1>
          <div className="sub">{characters.length} character folder{characters.length === 1 ? "" : "s"} · {total} picture{total === 1 ? "" : "s"} · a quick look at the art, nothing here changes anything</div>
        </div>
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
              <button key={c.id} type="button" className="gal-folder" data-gallery-folder={displayName(c)} onClick={() => { setOpen(c.id); setSub(null); }}>
                <span className="gal-cover">
                  {prof ? <Pic t={prof} /> : <span className="gal-none">{c.media?.kind === "vrm" ? "3D" : displayName(c).slice(0, 1).toUpperCase()}</span>}
                </span>
                <b>📁 {displayName(c)}</b>
                <small>{n ? `${n} picture${n === 1 ? "" : "s"}` : c.media?.kind === "vrm" ? "3D model" : "no pictures yet"}{g ? ` · gallery of ${g}` : ""}</small>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
