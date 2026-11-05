import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type AppInfo, type Character, type Chat, type Dorm, type Settings } from "./api";
import { StoreCtx, type Route, type Store } from "./store";
import { Logo, ToastProvider, useToast } from "./components/ui";
import Home from "./pages/Home";
import Library from "./pages/Library";
import Editor from "./pages/Editor";
import ChatPage from "./pages/Chat";
import SettingsPage from "./pages/Settings";
import { errText } from "./lib/util";

const DEFAULTS: Settings = {
  provider: "local", profiles: [], user_name: "You", user_description: "", context_tokens: 4096, max_tokens: 512,
  temperature: 0.8, top_p: 0.95, local_model: "", local_gpu: true, openai_base_url: "https://api.openai.com/v1",
  openai_model: "gpt-4o-mini", anthropic_model: "claude-haiku-5-5", use_card_system_prompt: true,
  default_system: "", theme: "dusk",
};

const NAV: { page: Route["page"]; label: string; icon: string }[] = [
  { page: "home", label: "Home", icon: "🏠" },
  { page: "library", label: "Characters", icon: "🧑‍🎤" },
  { page: "chat", label: "Dorms", icon: "💬" },
  { page: "settings", label: "Settings", icon: "⚙️" },
];

function Shell() {
  const toast = useToast();
  const [route, setRoute] = useState<Route>({ page: "home" });
  const [characters, setCharacters] = useState<Character[]>([]);
  const [chats, setChats] = useState<Chat[]>([]);
  const [dorms, setDorms] = useState<Dorm[]>([]);
  const [settings, setSettingsState] = useState<Settings>(DEFAULTS);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [modelCount, setModelCount] = useState(0);
  const [ready, setReady] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [c, ch, d, s, m] = await Promise.all([
        api.listCharacters(), api.listChats(), api.listDorms(), api.getSettings(), api.listModels(),
      ]);
      setCharacters(c); setChats(ch); setDorms(d); setSettingsState(s); setModelCount(m.length);
    } catch (e) {
      toast(`Could not load your data: ${errText(e)}`, "err");
    } finally {
      setReady(true);
    }
  }, [toast]);

  useEffect(() => { refresh(); api.appInfo().then(setInfo).catch(() => {}); }, [refresh]);
  useEffect(() => { document.documentElement.dataset.theme = settings.theme; }, [settings.theme]);

  const setSettings = useCallback(async (s: Settings) => {
    setSettingsState(await api.saveSettings(s));
  }, []);

  const store: Store = useMemo(
    () => ({ characters, chats, dorms, settings, info, modelCount, go: setRoute, refresh, setSettings }),
    [characters, chats, dorms, settings, info, modelCount, refresh, setSettings],
  );

  return (
    <StoreCtx.Provider value={store}>
      <div className="shell">
        <nav className="side" aria-label="Main">
          <div className="brand"><Logo /><span>Dorms</span></div>
          {NAV.map((n) => (
            <button key={n.page} className={`nav ${route.page === n.page || (n.page === "library" && route.page === "editor") ? "on" : ""}`}
              onClick={() => setRoute({ page: n.page } as Route)}>
              <span aria-hidden>{n.icon}</span>{n.label}
            </button>
          ))}
          <div className="grow" />
          <small>v{info?.version ?? "…"}{info?.portable ? " · portable" : ""}</small>
        </nav>
        <main className={route.page === "chat" ? "main" : "main"} style={route.page === "chat" ? { overflow: "hidden" } : undefined}>
          {!ready ? <div className="page sub">Loading…</div> : (
            <>
              {route.page === "home" && <Home />}
              {route.page === "library" && <Library />}
              {route.page === "editor" && <Editor key={route.id ?? "new"} id={route.id} />}
              {route.page === "chat" && <ChatPage initialChatId={route.chatId} />}
              {route.page === "settings" && <SettingsPage initialTab={route.tab} />}
            </>
          )}
        </main>
      </div>
    </StoreCtx.Provider>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <Shell />
    </ToastProvider>
  );
}
