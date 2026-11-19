import { applyTextScale } from "./lib/textScale";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type AppInfo, type Character, type Chat, type Dorm, type Folder, type Persona, type Room, type SessionState, type Settings } from "./api";
import { StoreCtx, type Route, type Store } from "./store";
import { Logo, ToastProvider, useToast } from "./components/ui";
import { ProfileAvatar } from "./components/ProfileForms";
import { DEFAULT_DECO, personaAvatar, profileAvatar } from "./api";
import { TagChip, Wreathed, plateProps, setDecoMotion } from "./lib/deco";
import Welcome from "./pages/Welcome";
import Home from "./pages/Home";
import Library from "./pages/Library";
import Rooms from "./pages/Rooms";
import Notes from "./pages/Notes";
import Lorebooks from "./pages/Lorebooks";
import Decor from "./pages/Decor";
import PromptsMenu from "./components/PromptsMenu";
import SideWidgets from "./components/SideWidgets";
import MembersRail from "./components/MembersRail";
import PanelResizer from "./components/PanelResizer";
import Editor from "./pages/Editor";
import ChatPage from "./pages/Chat";
import SettingsPage from "./pages/Settings";
import { errText } from "./lib/util";

const DEFAULTS: Settings = {
  provider: "local", profiles: [], user_name: "You", user_description: "", context_tokens: 4096, max_tokens: 512,
  temperature: 0.8, top_p: 0.95, local_model: "", local_gpu: true, openai_base_url: "https://api.openai.com/v1",
  openai_model: "gpt-4o-mini", anthropic_model: "claude-haiku-5-5", use_card_system_prompt: true,
  default_system: "", theme: "dusk",
  stt_url: "https://api.openai.com/v1", stt_model: "whisper-1", stt_language: "", stt_auto_send: true, active_persona: "", deco: DEFAULT_DECO,
};

const SIDE_DEF = 220, SIDE_MIN = 160, SIDE_MAX = 420;
const MEMBERS_DEF = 264, MEMBERS_MIN = 200, MEMBERS_MAX = 480;

const NAV_KEY = "dorms.nav.order";
const NAV_DRAG = "application/x-dorms-nav";
const NAV: { page: Route["page"]; label: string; icon: string }[] = [
  { page: "home", label: "Home", icon: "🏠" },
  { page: "library", label: "Characters", icon: "🧑‍🎤" },
  { page: "rooms", label: "Rooms", icon: "🛋️" },
  { page: "decor", label: "Decorations", icon: "🪴" },
  { page: "chat", label: "Dorms", icon: "💬" },
  { page: "lorebooks", label: "Lorebooks", icon: "📚" },
  { page: "notes", label: "Notes", icon: "📝" },
  { page: "settings", label: "Settings", icon: "⚙️" },
];

/** The side bar's order as the user left it (this device): unknown or missing pages are dealt with, so a new page just appears at the end. */
function loadNavOrder(): Route["page"][] {
  const known = NAV.map((n) => n.page);
  try {
    const a = JSON.parse(localStorage.getItem(NAV_KEY) || "[]");
    if (Array.isArray(a)) {
      const kept = a.filter((p, i) => known.includes(p) && a.indexOf(p) === i) as Route["page"][];
      return [...kept, ...known.filter((p) => !kept.includes(p))];
    }
  } catch { /* storage unavailable or damaged: the normal order */ }
  return known;
}

function Shell({ session, setSession }: { session: SessionState; setSession: (s: SessionState) => void }) {
  const toast = useToast();
  const [route, setRoute] = useState<Route>({ page: "home" });
  // every walk to a chat (from the side bar, say) starts the chat page fresh, even when a chat is already open
  const [chatNav, setChatNav] = useState(0);
  const go = useCallback((r: Route) => { if (r.page === "chat") setChatNav((n) => n + 1); setRoute(r); }, []);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [chats, setChats] = useState<Chat[]>([]);
  const [dorms, setDorms] = useState<Dorm[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [settings, setSettingsState] = useState<Settings>(DEFAULTS);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [modelCount, setModelCount] = useState(0);
  const [ready, setReady] = useState(false);

  // the panels on either side of the middle: how wide each is (drag the wall between them), and whether the characters list is shown
  const num = (k: string, d: number) => { try { const v = Number(localStorage.getItem(k)); return v > 0 ? v : d; } catch { return d; } };
  const [sideW, setSideW] = useState(() => num("dorms.panel.side", SIDE_DEF));
  const [membersW, setMembersW] = useState(() => num("dorms.panel.members", MEMBERS_DEF));
  const [membersOpen, setMembersOpen] = useState(() => { try { const v = localStorage.getItem("dorms.members.open"); return v === null ? window.innerWidth >= 1500 : v === "1"; } catch { return false; } });
  const remember = (k: string, v: number | boolean) => { try { localStorage.setItem(k, typeof v === "boolean" ? (v ? "1" : "0") : String(v)); } catch { /* storage unavailable */ } };
  // the side bar's order: hold an item and drag it (Alt + the up and down arrows work too); Prompts stays at the bottom
  const [navOrder, setNavOrder] = useState<Route["page"][]>(loadNavOrder);
  const [navDrag, setNavDrag] = useState<Route["page"] | null>(null);
  const [navDrop, setNavDrop] = useState<{ page: Route["page"]; after: boolean } | null>(null);
  useEffect(() => { const f = () => setNavOrder(loadNavOrder()); window.addEventListener("dorms-nav-order", f); return () => window.removeEventListener("dorms-nav-order", f); }, []);
  const moveNav = (page: Route["page"], target: Route["page"], after: boolean) => {
    if (page === target) return;
    const rest = navOrder.filter((p) => p !== page);
    const at = rest.indexOf(target) + (after ? 1 : 0);
    const next = [...rest.slice(0, at), page, ...rest.slice(at)];
    setNavOrder(next);
    try { localStorage.setItem(NAV_KEY, JSON.stringify(next)); } catch { /* storage unavailable */ }
  };
  const [winW, setWinW] = useState(window.innerWidth);
  useEffect(() => { setDecoMotion(settings.deco?.animate !== false); }, [settings.deco?.animate]);
  useEffect(() => { const f = () => setWinW(window.innerWidth); window.addEventListener("resize", f); return () => window.removeEventListener("resize", f); }, []);
  const showMembers = membersOpen && winW > 1100;
  const MIN_MAIN = 480;
  const sideMax = Math.min(SIDE_MAX, winW - (showMembers ? membersW : 0) - MIN_MAIN);
  const membersMax = Math.min(MEMBERS_MAX, winW - sideW - MIN_MAIN);

  const refresh = useCallback(async () => {
    try {
      const [c, ch, d, s, m, rm, fo, pe] = await Promise.all([
        api.listCharacters(), api.listChats(), api.listDorms(), api.getSettings(), api.listModels(), api.listRooms(), api.listFolders(), api.listPersonas(),
      ]);
      setCharacters(c); setChats(ch); setDorms(d); setRooms(rm); setFolders(fo); setPersonas(pe); setSettingsState(s); setModelCount(m.length);
    } catch (e) {
      toast(`Could not load your data: ${errText(e)}`, "err");
    } finally {
      setReady(true);
    }
  }, [toast]);

  useEffect(() => { refresh(); api.appInfo().then(setInfo).catch(() => {}); }, [refresh]);
  useEffect(() => { document.documentElement.dataset.theme = settings.theme; }, [settings.theme]);
  useEffect(() => { applyTextScale(); }, []);

  const setSettings = useCallback(async (s: Settings) => {
    setSettingsState(await api.saveSettings(s));
  }, []);

  const me = useMemo<Store["me"]>(() => {
    const p = personas.find((x) => x.id === settings.active_persona) ?? null;
    if (p) return { name: p.name, avatar: personaAvatar(p), frame: p.frame, persona: p };
    return { name: settings.user_name, avatar: profileAvatar(session.profile), frame: session.profile?.avatar_frame ?? null, persona: null };
  }, [personas, settings.active_persona, settings.user_name, session.profile]);

  const store: Store = useMemo(
    () => ({ characters, chats, dorms, rooms, folders, personas, me, settings, info, modelCount, go, refresh, setSettings, session, setSession }),
    [characters, chats, dorms, rooms, folders, personas, me, settings, info, modelCount, go, refresh, setSettings, session, setSession],
  );

  return (
    <StoreCtx.Provider value={store}>
      <div className={`shell${showMembers ? " with-members" : ""}`} style={{ "--side-w": `${sideW}px`, "--members-w": `${membersW}px` } as React.CSSProperties}>
        <nav className="side" aria-label="Main">
          <div className="brand"><Logo /><span>Dorms</span></div>
          {navOrder.map((page) => NAV.find((n) => n.page === page)!).map((n) => (
            <button key={n.page} draggable data-nav={n.page}
              className={`nav ${route.page === n.page || (n.page === "library" && route.page === "editor") ? "on" : ""}${navDrag === n.page ? " nav-dragging" : ""}${navDrop?.page === n.page ? (navDrop.after ? " nav-drop-after" : " nav-drop-before") : ""}`}
              onClick={() => setRoute({ page: n.page } as Route)}
              title="Click to open · hold and drag to move it (Alt + ↑ ↓ also moves it)"
              onDragStart={(e) => { e.dataTransfer.setData(NAV_DRAG, n.page); e.dataTransfer.effectAllowed = "move"; setNavDrag(n.page); }}
              onDragEnd={() => { setNavDrag(null); setNavDrop(null); }}
              onDragOver={(e) => {
                if (!navDrag || navDrag === n.page || !Array.from(e.dataTransfer.types).includes(NAV_DRAG)) return;
                e.preventDefault(); e.dataTransfer.dropEffect = "move";
                const r = e.currentTarget.getBoundingClientRect();
                const horizontal = window.innerWidth <= 820;
                setNavDrop({ page: n.page, after: horizontal ? e.clientX > r.left + r.width / 2 : e.clientY > r.top + r.height / 2 });
              }}
              onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setNavDrop((d) => (d?.page === n.page ? null : d)); }}
              onDrop={(e) => {
                const dragged = e.dataTransfer.getData(NAV_DRAG) as Route["page"];
                if (!dragged || !NAV.some((x) => x.page === dragged)) return;
                e.preventDefault();
                const r = e.currentTarget.getBoundingClientRect();
                const horizontal = window.innerWidth <= 820;
                moveNav(dragged, n.page, horizontal ? e.clientX > r.left + r.width / 2 : e.clientY > r.top + r.height / 2);
                setNavDrag(null); setNavDrop(null);
              }}
              onKeyDown={(e) => {
                if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
                e.preventDefault();
                const i = navOrder.indexOf(n.page), j = i + (e.key === "ArrowUp" ? -1 : 1);
                if (j < 0 || j >= navOrder.length) return;
                moveNav(n.page, navOrder[j], e.key === "ArrowDown");
              }}>
              <span aria-hidden>{n.icon}</span>{n.label}
            </button>
          ))}
          <PromptsMenu />
          <SideWidgets />
          <div className="grow" />
          {(() => {
            // the user's own decorations: nameplate behind the row, wreath around the picture, name tag beside the name
            const dz = settings.deco ?? DEFAULT_DECO, pl = plateProps(dz.plate, dz.animate);
            return (
              <button className={`nav me-row ${pl.className}`} {...(pl["data-plate"] ? { "data-plate": pl["data-plate"], "data-anim": pl["data-anim"] } : {})} data-testid="me-row" style={{ gap: 8 }} onClick={() => setRoute({ page: "settings", tab: "profile" })} title="Profile settings">
                <Wreathed wreath={dz.wreath} size="sm"><ProfileAvatar name={session.profile?.handle ?? "Guest"} size={26} src={profileAvatar(session.profile)} frame={session.profile?.avatar_frame} /></Wreathed>
                <span className="m-name" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{session.profile?.handle ?? "Guest"}</span>
                <TagChip tag={dz.tag} color={dz.tag_color} glyph={dz.tag_glyph} />
              </button>
            );
          })()}
          <small>v{info?.version ?? "…"}{info?.portable ? " · portable" : ""}</small>
        </nav>
        <main className={route.page === "chat" ? "main" : "main"} style={route.page === "chat" ? { overflow: "hidden" } : undefined}>
          {!ready ? <div className="page sub">Loading…</div> : (
            <>
              {route.page === "home" && <Home />}
              {route.page === "library" && <Library />}
              {route.page === "notes" && <Notes />}
              {route.page === "decor" && <Decor />}
              {route.page === "lorebooks" && <Lorebooks />}
              {route.page === "rooms" && <Rooms key={String(route.edit ?? "list")} edit={route.edit} />}
              {route.page === "editor" && <Editor key={route.id ?? "new"} id={route.id} />}
              {route.page === "chat" && <ChatPage key={chatNav} initialChatId={route.chatId} />}
              {route.page === "settings" && <SettingsPage initialTab={route.tab} />}
            </>
          )}
        </main>
        {showMembers && ready && <MembersRail onCollapse={() => { setMembersOpen(false); remember("dorms.members.open", false); }} />}
        <PanelResizer side="left" width={sideW} min={SIDE_MIN} max={sideMax} def={SIDE_DEF} label="Resize the side bar" onResize={setSideW} onCommit={(w) => remember("dorms.panel.side", w)} />
        {showMembers && <PanelResizer side="right" width={membersW} min={MEMBERS_MIN} max={membersMax} def={MEMBERS_DEF} label="Resize the characters list" onResize={setMembersW} onCommit={(w) => remember("dorms.panel.members", w)} />}
        {!membersOpen && winW > 1100 && <button className="members-tab" aria-label="Show the characters list" title="Show the characters list" onClick={() => { setMembersOpen(true); remember("dorms.members.open", true); }}>👥</button>}
      </div>
    </StoreCtx.Provider>
  );
}

export default function App() {
  const [session, setSession] = useState<SessionState | null>(null);
  const [failed, setFailed] = useState("");
  useEffect(() => { api.session().then(setSession).catch((e) => setFailed(String(e))); }, []);
  return (
    <ToastProvider>
      {failed ? <div className="page">Couldn't start: {failed}</div>
        : !session ? <div className="page sub">Loading…</div>
        : !session.signed_in ? <Welcome session={session} onSession={setSession} />
        : <Shell key={session.profile?.id ?? "guest"} session={session} setSession={setSession} />}
    </ToastProvider>
  );
}
