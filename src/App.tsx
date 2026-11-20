import { applyTextScale } from "./lib/textScale";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type AppInfo, type Character, type Chat, type Dorm, type Folder, type Persona, type Room, type SessionState, type Settings, type World } from "./api";
import { listen } from "@tauri-apps/api/event";
import { StoreCtx, type Route, type Store } from "./store";
import { Logo, ToastProvider, useToast } from "./components/ui";
import { ProfileAvatar } from "./components/ProfileForms";
import { DEFAULT_DECO, personaAvatar, profileAvatar } from "./api";
import { TagChip, Wreathed, pauseDecoWhenAway, plateProps, setDecoMotion } from "./lib/deco";
import Welcome from "./pages/Welcome";
import Home from "./pages/Home";
import Library from "./pages/Library";
import Rooms from "./pages/Rooms";
import Notes from "./pages/Notes";
import Lorebooks from "./pages/Lorebooks";
import Playbooks from "./pages/Playbooks";
import Decor from "./pages/Decor";
import PromptsMenu from "./components/PromptsMenu";
import { ProfileMenu, QuickSettings, useProfileHidden } from "./components/ProfileMenu";
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
  stt_url: "https://api.openai.com/v1", stt_model: "whisper-1", stt_language: "", stt_auto_send: true, active_persona: "", deco: DEFAULT_DECO, novel_daily_limit: 0, novel_reserve: 5,
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
  { page: "playbooks", label: "Playbooks", icon: "🎲" },
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
  // the pages you have been to, so Left / Backspace go back and Right goes forward again
  const hist = useRef<{ stack: Route[]; i: number }>({ stack: [{ page: "home" }], i: 0 });
  const go = useCallback((r: Route) => {
    const h = hist.current;
    h.stack = [...h.stack.slice(0, h.i + 1), r].slice(-60);
    h.i = h.stack.length - 1;
    if (r.page === "chat") setChatNav((n) => n + 1);
    setRoute(r);
  }, []);
  const move = useCallback((d: -1 | 1) => {
    const h = hist.current, j = h.i + d;
    if (j < 0 || j >= h.stack.length) return false;
    h.i = j;
    const r = h.stack[j];
    if (r.page === "chat") setChatNav((n) => n + 1);
    setRoute(r);
    return true;
  }, []);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight" && e.key !== "Backspace") return;
      const t = e.target as HTMLElement | null;
      // never while you are typing or moving a slider, and not while a window or menu is open
      if (t && (["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName) || t.isContentEditable || t.closest("[role=slider],[role=separator],[role=menu],[role=listbox]"))) return;
      if (document.querySelector(".modal-back, .ctx-menu")) return;
      if (move(e.key === "ArrowRight" ? 1 : -1)) e.preventDefault();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [move]);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [chats, setChats] = useState<Chat[]>([]);
  const [dorms, setDorms] = useState<Dorm[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [worlds, setWorlds] = useState<World[]>([]);
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
  useEffect(() => pauseDecoWhenAway(), []);
  // the menu on the profile at the bottom of the side bar
  const [profileHidden, setProfileHidden] = useProfileHidden();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [quick, setQuick] = useState(false);
  const switchAccounts = async () => {
    try {
      const running = await api.novelsRunning().catch(() => [] as number[]);
      if (running.length) {
        if (!window.confirm("A novel is still being written. Switching accounts stops it after the last finished chapter; you can pick it up again later with Keep going.\n\nSwitch anyway?")) return;
        await Promise.all(running.map((id) => api.novelStop(id)));
      }
      setSession(await api.signOut());
    } catch (e) { window.alert(errText(e)); }
  };
  // closing the window while a novel is being written would stop it: offer to keep writing from the tray
  useEffect(() => {
    const u = listen("dorms://close-while-writing", async () => {
      const tray = await api.trayAvailable().catch(() => false);
      if (tray) {
        if (window.confirm("A novel is still being written.\n\nOK: keep writing in the background. The app hides in your system tray, comes back by itself when the novel is finished, and you can open or quit it from the tray icon. (Some Linux desktops don't show tray icons: then just wait for the window to come back.)\nCancel: stay here.")) {
          try { await api.hideToTray(); return; } catch (e) { window.alert(errText(e)); }
        } else return;
      }
      if (window.confirm("A novel is still being written, and this device can't keep it going once the app is closed. It stops after the last finished chapter, and you can pick it up again later with Keep going.\n\nClose anyway?")) void api.quitApp();
    });
    return () => { void u.then((f) => f()); };
  }, []);
  useEffect(() => { const f = () => setWinW(window.innerWidth); window.addEventListener("resize", f); return () => window.removeEventListener("resize", f); }, []);
  const showMembers = membersOpen && winW > 1100;
  const MIN_MAIN = 480;
  const sideMax = Math.min(SIDE_MAX, winW - (showMembers ? membersW : 0) - MIN_MAIN);
  const membersMax = Math.min(MEMBERS_MAX, winW - sideW - MIN_MAIN);

  const refresh = useCallback(async () => {
    try {
      const [c, ch, d, s, m, rm, fo, pe, wo] = await Promise.all([
        api.listCharacters(), api.listChats(), api.listDorms(), api.getSettings(), api.listModels(), api.listRooms(), api.listFolders(), api.listPersonas(), api.listWorlds(),
      ]);
      setCharacters(c); setChats(ch); setDorms(d); setRooms(rm); setWorlds(wo); setFolders(fo); setPersonas(pe); setSettingsState(s); setModelCount(m.length);
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
    () => ({ characters, chats, dorms, rooms, worlds, folders, personas, me, settings, info, modelCount, go, refresh, setSettings, session, setSession }),
    [characters, chats, dorms, rooms, worlds, folders, personas, me, settings, info, modelCount, go, refresh, setSettings, session, setSession],
  );

  return (
    <StoreCtx.Provider value={store}>
      <div className={`shell${showMembers ? " with-members" : ""}`} style={{ "--side-w": `${sideW}px`, "--members-w": `${membersW}px` } as React.CSSProperties}>
        <nav className="side" aria-label="Main">
          <div className="brand"><Logo /><span>Dorms</span></div>
          {navOrder.map((page) => NAV.find((n) => n.page === page)!).map((n) => (
            <button key={n.page} draggable data-nav={n.page}
              className={`nav ${route.page === n.page || (n.page === "library" && route.page === "editor") ? "on" : ""}${navDrag === n.page ? " nav-dragging" : ""}${navDrop?.page === n.page ? (navDrop.after ? " nav-drop-after" : " nav-drop-before") : ""}`}
              onClick={() => go({ page: n.page } as Route)}
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
            if (profileHidden) return null;
            return (
              <button className={`nav me-row ${pl.className}`} onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }); }} {...(pl["data-plate"] ? { "data-plate": pl["data-plate"], "data-anim": pl["data-anim"] } : {})} data-testid="me-row" style={{ gap: 8 }} onClick={() => go({ page: "settings", tab: "profile" })} title="Profile settings">
                <Wreathed wreath={dz.wreath} size="sm"><ProfileAvatar name={session.profile?.handle ?? "Guest"} size={26} src={profileAvatar(session.profile)} frame={session.profile?.avatar_frame} /></Wreathed>
                <span className="m-name" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{session.profile?.handle ?? "Guest"}</span>
                <TagChip tag={dz.tag} color={dz.tag_color} glyph={dz.tag_glyph} />
              </button>
            );
          })()}
          <small>v{info?.version ?? "…"}{info?.portable ? " · portable" : ""}</small>
          {menu && <ProfileMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} onQuick={() => setQuick(true)} onSwitch={() => void switchAccounts()} onHide={() => setProfileHidden(true)} />}
          {quick && <QuickSettings onClose={() => setQuick(false)} />}
        </nav>
        <main className={route.page === "chat" ? "main" : "main"} style={route.page === "chat" ? { overflow: "hidden" } : undefined}>
          {!ready ? <div className="page sub">Loading…</div> : (
            <>
              {route.page === "home" && <Home />}
              {route.page === "library" && <Library />}
              {route.page === "notes" && <Notes />}
              {route.page === "decor" && <Decor />}
              {route.page === "playbooks" && <Playbooks key={String(route.edit ?? "list")} edit={route.edit} />}
              {route.page === "lorebooks" && <Lorebooks />}
              {route.page === "rooms" && <Rooms key={String(route.edit ?? "list") + ":" + String(route.world ?? "")} edit={route.edit} world={route.world} />}
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
