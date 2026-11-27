// Dev-only harness (not part of the production build): the Decorations tab, the side bar's profile button and the characters list with sample data and no backend.
// Usage: /deco-dev.html?plate=bubbletea&bg=boba&wreath=bobacup
const svgOf = (w: number, h: number, body: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}">${body}</svg>`;
/** Two of "my decorations", so the picker can be seen with some (what the app keeps when someone adds their own). */
const SAMPLE_CUSTOM = [
  { did: "cp_a7508af2b5", dkind: "plate", mode: "svg", name: "Candy bar", blurb: "", art: svgOf(960, 176, '<rect width="960" height="176" fill="#f4a"/>'), still: "", moves: false, author: "", license: "", pack: "", cols: 0, rows: 0, frames: 0, dur: 0, src: "" },
  { did: "cw_9dd18e09d4", dkind: "wreath", mode: "svg", name: "Gold ring", blurb: "", art: svgOf(576, 576, '<circle cx="288" cy="288" r="262" fill="none" stroke="gold" stroke-width="26"/>'), still: "", moves: false, author: "", license: "", pack: "", cols: 0, rows: 0, frames: 0, dur: 0, src: "" },
];
(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
  invoke: async (cmd: string) => (cmd === "list_custom_deco" ? SAMPLE_CUSTOM : cmd === "list_char_deco" ? [] : cmd === "list_statuses" ? [] : cmd === "provider_health" ? { state: "ok", detail: "", model: "demo", checked_at: Date.now() } : null),
  convertFileSrc: (p: string) => p,
};
import { useState } from "react";
import { createRoot } from "react-dom/client";
import "../styles.css";
import { DEFAULT_DECO, type Settings } from "../api";
import { StoreCtx, type Store } from "../store";
import { ToastProvider } from "../components/ui";
import DecoTab from "../components/DecoTab";
import { MembersList } from "../components/MembersPanel";
import { TagChip, Wreathed, plateProps, setDecoMotion } from "../lib/deco";
import { ProfileAvatar } from "../components/ProfileForms";
import { reloadCustomDeco } from "../lib/decoCustom";
import { P, portrait } from "./portraits";

const q = new URLSearchParams(location.search);
const chars = P.slice(0, 4).map(([name, h, hair, skin], i) => ({ id: "c" + i, card: { name, tags: [], description: "" } as never, media: { kind: "image", file: "x" }, media_path: portrait(h, hair, skin, i), frame: null, favorite: false, gallery: [], gallery_mode: "", created_at: 1, updated_at: 1, last_used: 1, trusted: true }));
const LOOKS = [["bubbletea", "boba", "bobacup"], ["lanternglow", "lantern", "redlantern"], ["sparkleanime", "animenight", "magicgirl"], ["embers", "", "catears"]];

function App() {
  const [settings, setS] = useState({ deco: { ...DEFAULT_DECO, plate: q.get("plate") ?? "bubbletea", bg: q.get("bg") ?? "boba", wreath: q.get("wreath") ?? "bobacup", tag: "KOI", tag_glyph: "★" } } as unknown as Settings);
  setDecoMotion(settings.deco.animate);
  const store = { characters: chars, settings, setSettings: async (n: Settings) => { setS(n); return n; }, session: { profile: { handle: "Alex" }, signed_in: true, guest: false, profiles: [] }, go: () => {}, refresh: async () => {} } as unknown as Store;
  const dz = settings.deco, pl = plateProps(dz.plate, dz.animate);
  return (
    <ToastProvider><StoreCtx.Provider value={store}>
      <div style={{ display: "grid", gridTemplateColumns: "230px 1fr 290px", height: "100vh" }}>
        <nav className="side" style={{ display: "flex", flexDirection: "column", padding: 10 }}>
          <div className="grow" />
          <button className={`nav me-row ${pl.className}`} {...(pl["data-plate"] ? { "data-plate": pl["data-plate"], "data-anim": pl["data-anim"] } : {})} style={{ gap: 8 }}>
            <Wreathed wreath={dz.wreath} size="sm"><ProfileAvatar name="Alex" size={26} src={null} /></Wreathed>
            <span className="m-name">Alex</span><TagChip tag={dz.tag} color={dz.tag_color} glyph={dz.tag_glyph} />
          </button>
        </nav>
        <main className="main" style={{ overflow: "auto" }}><div className="page"><DecoTab /></div></main>
        <MembersList presence="ok" modelLabel="demo" total={4} animate
          rows={chars.map((c, i) => ({ id: c.id, name: (c.card as { name: string }).name, avatar: c.media_path as unknown as string, status: ["Kettle's on.", "Studying hard.", "On air till 3.", "Office hours: knock twice."][i], plate: LOOKS[i][0], wreath: LOOKS[i][2] }))} />
      </div>
    </StoreCtx.Provider></ToastProvider>
  );
}
void reloadCustomDeco();
createRoot(document.getElementById("root")!).render(<App />);
