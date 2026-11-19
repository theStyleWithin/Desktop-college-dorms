// Dev-only harness (not part of the production build): the side bar with its extras (recent chats, favorites, most used, the picture
// frame), with sample data and no backend, so the look can be iterated on in a plain browser page. Usage: /sidebar-dev.html
(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
  invoke: async (cmd: string) => (cmd === "character_usage" ? USAGE : cmd === "list_prompts" ? [] : null),
  convertFileSrc: (p: string) => p,
};
import { createRoot } from "react-dom/client";
import "../styles.css";
import { StoreCtx, type Store } from "../store";
import { ToastProvider } from "../components/ui";
import SideWidgets from "../components/SideWidgets";
import PromptsMenu from "../components/PromptsMenu";
import { P, portrait } from "./portraits";

const now = Date.now();
const chars = P.map(([name, h, hair, skin], i) => ({
  id: "c" + i, card: { name, tags: [], description: "" } as never, media: { kind: "image", file: "x" }, media_path: portrait(h, hair, skin, i), frame: null, favorite: [0, 1, 2, 4, 6, 7, 9, 10, 12, 13, 15].includes(i),
  gallery: [], gallery_mode: "", created_at: 1, updated_at: 1, last_used: 1, trusted: true,
}));
const chats = [
  { id: 1, name: "Rooftop tea", ch: [0], t: 4 * 60_000 }, { id: 2, name: "Study group", ch: [1, 8], t: 50 * 60_000 }, { id: 3, name: "Night shift", ch: [3], t: 3 * 3600_000 },
  { id: 4, name: "Lore night", ch: [7], t: 26 * 3600_000 }, { id: 5, name: "Cat nap", ch: [4], t: 2 * 86400_000 }, { id: 6, name: "Harbor", ch: [5], t: 3 * 86400_000 }, { id: 7, name: "Midnight", ch: [10], t: 5 * 86400_000 },
].map((c) => ({ id: c.id, dorm_id: null, name: c.name, kind: c.ch.length > 1 ? "group" : "dm", character_ids: c.ch.map((i) => "c" + i), auto_chat: false, auto_interval_s: 20, turn_mode: "round_robin", max_auto_turns: 6, created_at: 1, updated_at: now - c.t }));
const USAGE = [{ character_id: "c0", messages: 1204 }, { character_id: "c1", messages: 877 }, { character_id: "c3", messages: 340 }, { character_id: "c7", messages: 122 }, { character_id: "c10", messages: 61 }];
const store = { characters: chars, chats, go: () => {}, refresh: async () => {} } as unknown as Store;
const nav = [["🏠", "Home"], ["🧑‍🎤", "Characters"], ["🛋️", "Rooms"], ["🪴", "Decorations"], ["💬", "Dorms"], ["📚", "Lorebooks"], ["📝", "Notes"], ["⚙️", "Settings"]];
createRoot(document.getElementById("root")!).render(
  <ToastProvider><StoreCtx.Provider value={store}>
    <div className="shell" style={{ height: "100vh" }}>
      <nav className="side" aria-label="Main">
        <div className="brand"><span>Dorms</span></div>
        {nav.map(([i, l]) => <button key={l} className={`nav ${l === "Dorms" ? "on" : ""}`}><span aria-hidden>{i}</span>{l}</button>)}
        <PromptsMenu />
        <SideWidgets />
        <div className="grow" /><small>v0.10.0</small>
      </nav>
      <main className="main"><div className="page"><h1>Dorms</h1><div className="sub">The side bar on the left has room for more now.</div></div></main>
    </div>
  </StoreCtx.Provider></ToastProvider>,
);
