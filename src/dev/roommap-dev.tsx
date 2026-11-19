// Dev-only harness (not part of the production build): the room map with sample rooms and no backend. Usage: /roommap-dev.html
const mem: { rooms: Record<string, unknown>[] } = { rooms: [] };
(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
  invoke: async (cmd: string, args: { id: number; links: number[] }) => {
    if (cmd === "set_room_links") {
      const sym = (a: number) => mem.rooms.find((r) => r.id === a) as { links: number[] };
      const was = sym(args.id).links;
      for (const o of was) if (!args.links.includes(o)) sym(o).links = sym(o).links.filter((l) => l !== args.id);
      sym(args.id).links = args.links;
      for (const o of args.links) if (!sym(o).links.includes(args.id)) sym(o).links.push(args.id);
      return sym(args.id);
    }
    return null;
  },
  convertFileSrc: (p: string) => p,
};
import { useState } from "react";
import { createRoot } from "react-dom/client";
import "../styles.css";
import { StoreCtx, type Store } from "../store";
import { ToastProvider } from "../components/ui";
import RoomMap from "../components/RoomMap";

const names = ["Our house", "Kitchen", "Living room", "Attic", "Garden gate", "Corner shop"];
mem.rooms = names.map((name, i) => ({ id: i + 1, name, kind: ["other", "kitchen", "living_room", "bedroom", "garden", "other"][i], description: "", owner_kind: "self", character_id: null, backdrop: ["preset:lamplight", "preset:morning", "preset:paper", "preset:night-window", "preset:garden", "preset:neon"][i], created_at: 0, parent_id: i > 0 && i < 4 ? 1 : null, links: i === 4 ? [2] : i === 1 ? [5] : [] }));

function App() {
  const [, bump] = useState(0);
  const store = { refresh: async () => bump((n) => n + 1) } as unknown as Store;
  return (
    <ToastProvider><StoreCtx.Provider value={store}>
      <div className="page" style={{ padding: 20 }}>
        <h1>Rooms</h1>
        <RoomMap rooms={mem.rooms.map((r) => ({ ...r, links: [...(r.links as number[])] })) as never} onEdit={() => {}} onStart={() => {}} />
      </div>
    </StoreCtx.Provider></ToastProvider>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
(window as unknown as { __rooms: () => unknown }).__rooms = () => JSON.stringify(mem.rooms.map((r) => [r.name, r.links]));
