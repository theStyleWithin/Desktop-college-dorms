import { useCallback, useEffect, useMemo, useState } from "react";
import { api, displayName, galleryUrl, mediaUrl, type Character, type Chat, type MediaKind } from "../api";
import { useStore } from "../store";
import { errText, timeAgo } from "../lib/util";
import Art from "./Art";
import { ProfileAvatar } from "./ProfileForms";
import { Modal, useToast } from "./ui";

/**
 * What you set up for the side bar (the names of its sections, which are shown, which are folded, the picture frames) belongs to the profile you are in,
 * so each profile (and the guest space) has its own, kept on this device. The settings from before this was so are given to the first profile that
 * opens the app afterwards (once), instead of to every profile.
 */
let scope = "guest";
const lsKey = (base: string) => `${base}.${scope}`;
const lsGet = (base: string): string | null => {
  try {
    const k = lsKey(base); let v = localStorage.getItem(k);
    if (v === null) { const old = localStorage.getItem(base); if (old !== null) { localStorage.setItem(k, old); localStorage.removeItem(base); v = old; } }
    return v;
  } catch { return null; }
};
const lsSet = (base: string, v: string) => localStorage.setItem(lsKey(base), v);
const lsDel = (base: string) => localStorage.removeItem(lsKey(base));
/** The profile the side bar is for (read first by everything below, so that what it loads is that profile's own). */
function useSideScope(): string {
  const { session } = useStore();
  const id = session?.profile?.id ?? "guest";
  scope = id;
  return id;
}

/** Which of the side bar's extras are shown (this device). */
export type WidgetId = "recent" | "favorites" | "usage" | "frame";
export const WIDGETS: { id: WidgetId; label: string }[] = [
  { id: "recent", label: "Recent chats" }, { id: "favorites", label: "Favorite characters" }, { id: "usage", label: "Most used characters" }, { id: "frame", label: "Picture frame" },
];
const PREFS_KEY = "dorms.side.widgets";
const NAMES_KEY = "dorms.side.names";
/** What each section is called until you name it yourself. */
export const DEFAULT_NAMES: Record<WidgetId, string> = { recent: "Recent chats", favorites: "Favorites", usage: "Most used", frame: "Picture frame" };
/** The names you gave the side bar's sections (kept on this device); an empty name means the default. */
export function useWidgetNames(): [Record<WidgetId, string>, (id: WidgetId, name: string) => void, () => void] {
  const scopeId = useSideScope();
  const read = (): Record<WidgetId, string> => {
    let saved: Partial<Record<WidgetId, string>> = {};
    try { saved = JSON.parse(lsGet(NAMES_KEY) || "{}") ?? {}; } catch { /* the default names */ }
    const out = { ...DEFAULT_NAMES };
    (Object.keys(DEFAULT_NAMES) as WidgetId[]).forEach((k) => { const v = typeof saved[k] === "string" ? saved[k]!.trim().slice(0, 24) : ""; if (v) out[k] = v; });
    return out;
  };
  const [names, setNames] = useState(read);
  useEffect(() => { setNames(read()); }, [scopeId]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const f = () => setNames(read()); window.addEventListener("dorms-side-names", f); return () => window.removeEventListener("dorms-side-names", f); }, []);
  const store = (obj: Partial<Record<WidgetId, string>>) => {
    try { if (Object.keys(obj).length) lsSet(NAMES_KEY, JSON.stringify(obj)); else lsDel(NAMES_KEY); } catch { /* storage unavailable: it still applies until the app is closed */ }
    window.dispatchEvent(new Event("dorms-side-names"));
  };
  const set = (id: WidgetId, name: string) => {
    let saved: Partial<Record<WidgetId, string>> = {};
    try { saved = JSON.parse(lsGet(NAMES_KEY) || "{}") ?? {}; } catch { /* start again */ }
    const clean = name.replace(/\s+/g, " ").trim().slice(0, 24);
    if (clean && clean !== DEFAULT_NAMES[id]) saved[id] = clean; else delete saved[id];
    store(saved);
  };
  return [names, set, () => store({})];
}
const FOLD_KEY = "dorms.side.folded";

const load = <T,>(k: string, d: T): T => { try { const v = lsGet(k); return v ? { ...d, ...JSON.parse(v) } : d; } catch { return d; } };
export function useWidgetPrefs(): [Record<WidgetId, boolean>, (id: WidgetId, on: boolean) => void] {
  const scopeId = useSideScope();
  const [p, setP] = useState(() => load<Record<WidgetId, boolean>>(PREFS_KEY, { recent: true, favorites: true, usage: true, frame: true }));
  useEffect(() => { const f = () => setP(load(PREFS_KEY, { recent: true, favorites: true, usage: true, frame: true })); window.addEventListener("dorms-side-widgets", f); return () => window.removeEventListener("dorms-side-widgets", f); }, []);
  useEffect(() => { setP(load(PREFS_KEY, { recent: true, favorites: true, usage: true, frame: true })); }, [scopeId]);
  const set = (id: WidgetId, on: boolean) => {
    const n = { ...p, [id]: on }; setP(n);
    try { lsSet(PREFS_KEY, JSON.stringify(n)); } catch { /* storage unavailable */ }
    window.dispatchEvent(new Event("dorms-side-widgets"));
  };
  return [p, set];
}

/** The character the user chose to hang in the picture frame (this device); nobody chosen = whoever they talked to last. */
const FRAME_KEY = "dorms.side.frame";
const readFramed = (): string | null => { try { return lsGet(FRAME_KEY) || null; } catch { return null; } };
/** Several frames can hang side by side, with arrows to flip between them; each holds its own character (null = whoever you talked to last). */
const FRAMES_KEY = "dorms.side.frames";
export const MAX_FRAMES = 12;
interface FrameSet { list: (string | null)[]; at: number }
const readFrames = (): FrameSet => {
  try {
    const v = JSON.parse(lsGet(FRAMES_KEY) || "null");
    if (v && Array.isArray(v.list) && v.list.length) {
      const list = v.list.slice(0, MAX_FRAMES).map((x: unknown) => (typeof x === "string" && x ? x : null));
      return { list, at: Math.min(Math.max(0, Number(v.at) || 0), list.length - 1) };
    }
  } catch { /* the one frame from before */ }
  return { list: [readFramed()], at: 0 };
};
const writeFrames = (fs: FrameSet) => {
  try { lsSet(FRAMES_KEY, JSON.stringify(fs)); if (fs.list.length === 1) { if (fs.list[0]) lsSet(FRAME_KEY, fs.list[0]); else lsDel(FRAME_KEY); } } catch { /* storage unavailable */ }
  window.dispatchEvent(new Event("dorms-side-frame"));
};
/** Who hangs in the frame being shown. */
const writeFramed = (id: string | null) => { const f = readFrames(); const list = [...f.list]; list[f.at] = id; writeFrames({ list, at: f.at }); };
/** Flip to the next or previous frame; past the last (or before the first) a new, empty frame is made. Returns true when it made one. */
const flipFrame = (dir: -1 | 1): boolean => {
  const f = readFrames(); const j = f.at + dir;
  if (j >= 0 && j < f.list.length) { writeFrames({ list: f.list, at: j }); return false; }
  if (f.list.length >= MAX_FRAMES) return false;
  if (dir < 0) writeFrames({ list: [null, ...f.list], at: 0 }); else writeFrames({ list: [...f.list, null], at: f.list.length });
  return true;
};
const removeFrame = () => {
  const f = readFrames(); if (f.list.length < 2) return;
  const list = f.list.filter((_, i) => i !== f.at);
  writeFrames({ list, at: Math.min(f.at, list.length - 1) });
};

const stillOf = (c: Character): string | null => (c.media?.kind === "image" || c.media?.kind === "gif" ? mediaUrl(c) : null);

/** A small section of the side bar that can be folded away. */
function Section({ id, title, count, action, children }: { id: WidgetId; title: string; count?: number; action?: React.ReactNode; children: React.ReactNode }) {
  const scopeId = useSideScope();
  const [folded, setFolded] = useState(() => !!load<Record<string, boolean>>(FOLD_KEY, {})[id]);
  useEffect(() => { setFolded(!!load<Record<string, boolean>>(FOLD_KEY, {})[id]); }, [scopeId, id]);
  const [names, setName] = useWidgetNames();
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");
  const shown = names[id] ?? title;
  const startRename = () => { setDraft(shown); setRenaming(true); };
  const finish = (save: boolean) => { if (save) setName(id, draft); setRenaming(false); };
  const toggle = () => { const n = !folded; setFolded(n); try { lsSet(FOLD_KEY, JSON.stringify({ ...load<Record<string, boolean>>(FOLD_KEY, {}), [id]: n })); } catch { /* storage unavailable */ } };
  return (
    <section className="sw" data-testid={`side-${id}`}>
      <div className="sw-head">
        {renaming
          ? <input className="sw-rename" autoFocus value={draft} maxLength={24} aria-label={`Name for ${DEFAULT_NAMES[id].toLowerCase()}`} data-testid={`side-${id}-name`} placeholder={DEFAULT_NAMES[id]}
              onChange={(e) => setDraft(e.target.value)} onBlur={() => finish(true)} onKeyDown={(e) => { if (e.key === "Enter") finish(true); else if (e.key === "Escape") { e.stopPropagation(); finish(false); } }} />
          : <button className="sw-title" aria-expanded={!folded} onClick={toggle} onDoubleClick={startRename} title="Double-click to rename"><span className="caret" aria-hidden>{folded ? "▸" : "▾"}</span>{shown}{count != null && <span className="m-count">{count}</span>}</button>}
        {!renaming && <button className="iconbtn sw-edit" aria-label={`Rename ${shown}`} title="Rename this section" data-testid={`side-${id}-rename`} onClick={startRename}>✎</button>}
        {action}
      </div>
      {!folded && <div className="sw-body">{children}</div>}
    </section>
  );
}

/** Extras for the empty part of the side bar: recent chats, favorites (as many as you like), most used, and a picture frame. */
export default function SideWidgets() {
  const { characters, chats, go, refresh } = useStore();
  const toast = useToast();
  const [prefs] = useWidgetPrefs();
  const [usage, setUsage] = useState<{ character_id: string; messages: number }[]>([]);
  const [picker, setPicker] = useState(false);
  const [more, setMore] = useState(false);
  const [framePicker, setFramePicker] = useState(false);
  const scopeId = useSideScope();
  const [frames, setFrames] = useState<FrameSet>(readFrames);
  useEffect(() => { setFrames(readFrames()); }, [scopeId]);
  const framedId = frames.list[frames.at] ?? null;
  useEffect(() => { const f = () => setFrames(readFrames()); window.addEventListener("dorms-side-frame", f); return () => window.removeEventListener("dorms-side-frame", f); }, []);
  const [, bump] = useState(0);
  const byId = useMemo(() => new Map(characters.map((c) => [c.id, c])), [characters]);
  const recent = useMemo(() => [...chats].sort((a, b) => b.updated_at - a.updated_at), [chats]);
  const newest = recent[0]?.updated_at ?? 0;

  useEffect(() => { if (prefs.usage) api.characterUsage().then(setUsage).catch(() => {}); }, [prefs.usage, chats.length, newest]);
  useEffect(() => { const f = () => bump((n) => n + 1); window.addEventListener("dorms-gal-pick", f); return () => window.removeEventListener("dorms-gal-pick", f); }, []);

  /** Open the latest chat with a character (a one-to-one chat first), or start one. */
  const openWith = useCallback(async (id: string) => {
    const mine = recent.filter((c) => c.character_ids.includes(id));
    const hit = mine.find((c) => c.kind === "dm") ?? mine[0];
    if (hit) { go({ page: "chat", chatId: hit.id }); return; }
    const c = byId.get(id); if (!c) return;
    try { const ch = await api.createChat(null, displayName(c), "dm", [c.id]); await refresh(); go({ page: "chat", chatId: ch.id }); } catch (e) { toast(errText(e), "err"); }
  }, [recent, byId, go, refresh, toast]);

  const avatar = (c: Character | undefined, name: string, size = 30) => <ProfileAvatar name={name} size={size} src={c ? stillOf(c) : null} frame={c?.frame} />;
  const chatFace = (ch: Chat) => { const c = byId.get(ch.character_ids[0]); return { c, name: c ? displayName(c) : ch.name }; };

  const favorites = characters.filter((c) => c.favorite).sort((a, b) => displayName(a).localeCompare(displayName(b)));
  const top = usage.map((u) => ({ c: byId.get(u.character_id), n: u.messages })).filter((x): x is { c: Character; n: number } => !!x.c).slice(0, 5);
  const shownRecent = recent.slice(0, more ? 10 : 5);
  // the character hanging in the frame: the one chosen (until changed), else whoever was talked to last
  const chosen = framedId ? byId.get(framedId) : undefined;
  const frameChat = chosen ? recent.find((ch) => ch.character_ids.includes(chosen.id)) : recent.find((ch) => byId.has(ch.character_ids[0]));
  if (!WIDGETS.some((w) => prefs[w.id])) return null;

  // the picture in the frame: the one the character is showing in that chat (a gallery picture), else their main picture
  let frameArt: { kind: MediaKind | null; url: string | null } = { kind: null, url: null };
  let frameChar: Character | undefined = chosen;
  if (frameChat || chosen) {
    if (!frameChar && frameChat) frameChar = byId.get(frameChat.character_ids[0]);
    if (frameChar) {
      let pickId: string | null = null;
      if (frameChat) try { pickId = (JSON.parse(localStorage.getItem(`dorms.gal.${frameChat.id}`) || "{}") as Record<string, string | null>)[frameChar.id] ?? null; } catch { /* nothing remembered */ }
      const it = pickId && (frameChar.gallery_mode === "random" || frameChar.gallery_mode === "mood") ? frameChar.gallery?.find((g) => g.id === pickId) : undefined;
      const gurl = it ? galleryUrl(frameChar, it.id) : null;
      frameArt = gurl && it ? { kind: it.kind, url: gurl } : { kind: frameChar.media?.kind === "vrm" ? null : frameChar.media?.kind ?? null, url: frameChar.media?.kind === "vrm" ? null : mediaUrl(frameChar) };
    }
  }

  return (
    <div className="side-widgets" data-testid="side-widgets">
      {prefs.recent && (
        <Section id="recent" title="Recent chats">
          {shownRecent.length === 0 ? <div className="hint">No chats yet.</div> : shownRecent.map((ch) => { const f = chatFace(ch); return (
            <button key={ch.id} className="sw-row" data-chat={ch.id} onClick={() => go({ page: "chat", chatId: ch.id })} title={`${ch.name} · ${timeAgo(ch.updated_at)}`}>
              {avatar(f.c, f.name)}<span className="sw-text"><b>{ch.name}</b><small>{f.name === ch.name ? timeAgo(ch.updated_at) : `${f.name} · ${timeAgo(ch.updated_at)}`}</small></span>
            </button>); })}
          {recent.length > 5 && <button className="sw-more" onClick={() => setMore((m) => !m)}>{more ? "Show fewer" : "Show more"}</button>}
        </Section>
      )}
      {prefs.favorites && (
        <Section id="favorites" title="Favorites" count={favorites.length} action={<button className="iconbtn" aria-label="Choose favorite characters" title="Choose favorites" onClick={() => setPicker(true)}>＋</button>}>
          {favorites.length === 0 ? <div className="hint">Press ＋ to pick your favorites, or star a character. There's no limit.</div> : (
            <div className="sw-faves">{favorites.map((c) => <button key={c.id} className="sw-fave" data-fave={displayName(c)} title={displayName(c)} aria-label={`Chat with ${displayName(c)}`} onClick={() => void openWith(c.id)}>{avatar(c, displayName(c), 36)}</button>)}</div>
          )}
        </Section>
      )}
      {prefs.usage && (
        <Section id="usage" title="Most used">
          {top.length === 0 ? <div className="hint">Characters you talk to most will show up here.</div> : top.map(({ c, n }) => (
            <button key={c.id} className="sw-row" data-used={displayName(c)} onClick={() => void openWith(c.id)} title={`${displayName(c)}: ${n} message${n === 1 ? "" : "s"}`}>
              {avatar(c, displayName(c))}<span className="sw-text"><b>{displayName(c)}</b><small>{n.toLocaleString()} message{n === 1 ? "" : "s"}</small></span>
            </button>))}
        </Section>
      )}
      {prefs.frame && (
        <Section id="frame" title="Picture frame" action={<button className="iconbtn" aria-label="Choose who hangs in the picture frame" title="Choose who hangs in the frame" onClick={() => setFramePicker(true)}>✎</button>}>
          {frameChar ? (
            <div className="sw-wallrow" data-frames={frames.list.length} data-frame-at={frames.at + 1}>
            <button className="sw-arrow left" data-testid="frame-left" aria-label={frames.at === 0 ? "Open another frame on the left" : "Previous frame"} title={frames.at === 0 ? "Another frame" : "Previous frame"} onClick={() => { if (flipFrame(-1)) setFramePicker(true); }}>◀</button>
            <button className="sw-wall" data-testid="side-frame-link" data-frame={displayName(frameChar)} data-framed={chosen ? "chosen" : "auto"} onClick={() => (frameChat ? go({ page: "chat", chatId: frameChat.id }) : void openWith(frameChar!.id))} title={`Open your chat with ${displayName(frameChar)}`}>
              <span className="sw-frame"><span className="sw-pic"><Art kind={frameArt.kind} url={frameArt.url} name={displayName(frameChar)} frame={frameArt.url === mediaUrl(frameChar) ? frameChar.frame : null} /></span></span>
              <span className="sw-plaque">{displayName(frameChar)}</span>
              {frames.list.length > 1 && <span className="sw-count" data-testid="frame-count">{frames.at + 1} of {frames.list.length}</span>}
            </button>
            <button className="sw-arrow right" data-testid="frame-right" aria-label={frames.at === frames.list.length - 1 ? "Open another frame on the right" : "Next frame"} title={frames.at === frames.list.length - 1 ? "Another frame" : "Next frame"} onClick={() => { if (flipFrame(1)) setFramePicker(true); }}>▶</button>
            </div>
          ) : <div className="hint">Choose who hangs here with the pencil, or start a chat and the character you talked to last will hang here. Click it to go back.</div>}
        </Section>
      )}
      {framePicker && <FramePicker characters={characters} current={chosen?.id ?? null} frameNo={frames.at + 1} frameCount={frames.list.length} onClose={() => setFramePicker(false)} />}
      {picker && <FavoritesPicker characters={characters} onClose={() => setPicker(false)} onChanged={refresh} />}
    </div>
  );
}

/** Tick any characters to make them favorites (no limit). */
function FavoritesPicker({ characters, onClose, onChanged }: { characters: Character[]; onClose: () => void; onChanged: () => Promise<void> }) {
  const toast = useToast();
  const [q, setQ] = useState("");
  const [local, setLocal] = useState<Record<string, boolean>>({});
  const list = characters.filter((c) => !q.trim() || displayName(c).toLowerCase().includes(q.trim().toLowerCase())).sort((a, b) => displayName(a).localeCompare(displayName(b)));
  const isFav = (c: Character) => local[c.id] ?? c.favorite;
  const toggle = async (c: Character) => {
    const on = !isFav(c); setLocal((m) => ({ ...m, [c.id]: on }));
    try { await api.setFavorite(c.id, on); await onChanged(); } catch (e) { setLocal((m) => ({ ...m, [c.id]: !on })); toast(errText(e), "err"); }
  };
  return (
    <Modal title="Your favorites" onClose={onClose}>
      <p className="hint" style={{ marginTop: 0 }}>Tick as many as you like. They show in the side bar.</p>
      <input type="search" placeholder="Search characters…" aria-label="Search characters" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="who-list" style={{ maxHeight: 360, overflow: "auto", marginTop: 8 }}>
        {list.map((c) => (
          <label key={c.id} className="row" data-pickfav={displayName(c)} style={{ gap: 10, padding: "5px 8px", cursor: "pointer" }}>
            <input type="checkbox" checked={isFav(c)} onChange={() => void toggle(c)} />
            <ProfileAvatar name={displayName(c)} size={28} src={stillOf(c)} frame={c.frame} /><span className="grow">{displayName(c)}</span>
          </label>
        ))}
        {list.length === 0 && <div className="hint">Nobody matches.</div>}
      </div>
      <div className="row" style={{ marginTop: 10 }}><button className="btn primary" onClick={onClose}>Done</button></div>
    </Modal>
  );
}

/** Choose who hangs in the picture frame: one character, kept until changed, or whoever was talked to last. */
function FramePicker({ characters, current, frameNo, frameCount, onClose }: { characters: Character[]; current: string | null; frameNo: number; frameCount: number; onClose: () => void }) {
  const [q, setQ] = useState("");
  const list = characters.filter((c) => !q.trim() || displayName(c).toLowerCase().includes(q.trim().toLowerCase())).sort((a, b) => displayName(a).localeCompare(displayName(b)));
  const pick = (id: string | null) => { writeFramed(id); onClose(); };
  return (
    <Modal title={frameCount > 1 ? `Who hangs in frame ${frameNo} of ${frameCount}?` : "Who hangs in the frame?"} onClose={onClose}>
      <p className="hint" style={{ marginTop: 0 }}>Your choice stays there until you change it. Click the frame any time to open your chat with them.</p>
      <input type="search" placeholder="Search characters…" aria-label="Search characters" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="who-list" style={{ maxHeight: 360, overflow: "auto", marginTop: 8 }}>
        <label className="row" data-pickframe="auto" style={{ gap: 10, padding: "5px 8px", cursor: "pointer" }}>
          <input type="radio" name="framed" checked={current == null} onChange={() => pick(null)} /><span className="grow">Whoever I talked to last</span>
        </label>
        {list.map((c) => (
          <label key={c.id} className="row" data-pickframe={displayName(c)} style={{ gap: 10, padding: "5px 8px", cursor: "pointer" }}>
            <input type="radio" name="framed" checked={current === c.id} onChange={() => pick(c.id)} />
            <ProfileAvatar name={displayName(c)} size={28} src={stillOf(c)} frame={c.frame} /><span className="grow">{displayName(c)}</span>
          </label>
        ))}
        {list.length === 0 && <div className="hint">Nobody matches.</div>}
      </div>
      <div className="row" style={{ marginTop: 10, gap: 8 }}><button className="btn" onClick={onClose}>Cancel</button>{frameCount > 1 && <button className="btn danger" data-testid="frame-remove" onClick={() => { removeFrame(); onClose(); }}>Take this frame down</button>}</div>
    </Modal>
  );
}
