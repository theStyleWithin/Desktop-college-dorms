// Dev-only harness (not part of the production build): shows the characters list on the right of the app, with sample data,
// so the look can be iterated on in a plain browser page. Usage: /members-dev.html?state=ok|local|down|warn|checking&open=Kai%20Tanaka
import { createRoot } from "react-dom/client";
import { useState } from "react";
import "../styles.css";
import { MembersList, type MemberRow, type Presence } from "../components/MembersPanel";

/** a simple drawn portrait, so the round avatars look like pictures (the real ones are the characters' own images) */
const portrait = (h: number, hair: string, skin: string, kind: number) => {
  const bg = `hsl(${h} 45% 38%)`, bg2 = `hsl(${(h + 50) % 360} 50% 24%)`;
  const hairShape = kind % 3 === 0 ? `<path d="M22 52c0-24 12-34 28-34s28 10 28 34c-6-14-14-20-28-20s-22 6-28 20z" fill="${hair}"/>`
    : kind % 3 === 1 ? `<path d="M20 70c-4-30 6-52 30-52s34 22 30 52c-2-18-8-30-30-30s-28 12-30 30z" fill="${hair}"/>`
    : `<path d="M24 46c2-18 14-26 26-26s24 8 26 26c-8-8-16-10-26-10s-18 2-26 10z" fill="${hair}"/><circle cx="26" cy="30" r="9" fill="${hair}"/><circle cx="74" cy="30" r="9" fill="${hair}"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${bg}"/><stop offset="1" stop-color="${bg2}"/></linearGradient></defs><rect width="100" height="100" fill="url(#g)"/>${kind % 3 === 1 ? hairShape : ""}<ellipse cx="50" cy="60" rx="22" ry="26" fill="${skin}"/>${kind % 3 !== 1 ? hairShape : ""}<circle cx="41" cy="60" r="2.6" fill="#2b2233"/><circle cx="59" cy="60" r="2.6" fill="#2b2233"/><path d="M43 72q7 6 14 0" stroke="#7a3e48" stroke-width="2.4" fill="none" stroke-linecap="round"/><path d="M14 100c4-16 18-22 36-22s32 6 36 22z" fill="hsl(${(h + 150) % 360} 35% 45%)"/></svg>`;
  return "data:image/svg+xml;utf8," + encodeURIComponent(svg);
};
const P: [string, number, string, string, string | undefined][] = [
  ["Mira Okafor", 330, "#3a2418", "#f1c9a5", "brewing tea and pretending not to wait for your message ☕"],
  ["Kai Tanaka", 200, "#1d1d2b", "#e9bf9d", "arguing with the vending machine. again."],
  ["Seraphina Vale", 275, "#d8c8f0", "#f7d9c4", "reading by candlelight. do not disturb (but do)"],
  ["Dr. Voss", 150, "#8f8f9a", "#dcae8c", "the experiment is going… mostly fine."],
  ["Luna", 40, "#f2e6c9", "#f4cfae", "nap. snack. nap."],
  ["Captain Reyes", 10, "#2a1a14", "#c98f68", "charting a course for somewhere warm"],
  ["Juniper", 120, "#5b3a22", "#f0c8a4", undefined],
  ["Ash Vale", 235, "#c9ccd6", "#e2b896", "who needs sleep when there's lore to write"],
  ["Professor Elm", 90, "#6f4a2c", "#efc19a", "grading papers and sighing dramatically"],
  ["Rowan", 20, "#a8431f", "#f3d0b0", "found a lost umbrella. it's mine now."],
  ["Vesper", 300, "#0f0b1a", "#e4b9a0", "midnight thoughts, loud"],
  ["Theo", 180, "#3b2b1c", "#e7bb97", undefined],
  ["Naomi", 345, "#241522", "#d9a782", "new playlist, who dis"],
  ["Bishop", 60, "#4a4a52", "#dcb08a", "keeping watch. someone has to."],
  ["Willow", 135, "#7ac7a0", "#f6d6bf", "touching grass (briefly)"],
  ["Ezra", 215, "#26324a", "#d8a982", "debugging my feelings"],
];
const rows: MemberRow[] = P.map(([name, h, hair, skin, status], i) => ({ id: name, name, avatar: portrait(h, hair, skin, i), status }));

function Mock() {
  const q = new URLSearchParams(location.search);
  const state = (q.get("state") ?? "ok") as Presence;
  const [open, setOpen] = useState<string | null>(q.get("open"));
  const nav = [["🏠", "Home"], ["🧑‍🎤", "Characters"], ["🛋️", "Rooms"], ["🪴", "Decorations"], ["💬", "Dorms"], ["📚", "Lorebooks"], ["📝", "Notes"], ["⚙️", "Settings"], ["📜", "Prompts"]];
  const detail = state === "down" ? "Could not reach the server: connection refused" : state === "warn" ? "The server is up but refused the API key." : undefined;
  return (
    <div className="shell with-members" style={{ height: "100vh" }}>
      <nav className="side" aria-label="Main">
        <div className="brand"><span>Dorms</span></div>
        {nav.map(([i, l]) => <button key={l} className={`nav ${l === "Characters" ? "on" : ""}`}><span aria-hidden>{i}</span>{l}</button>)}
        <div className="grow" /><small>v0.9.0</small>
      </nav>
      <main className="main">
        <div className="page">
          <div className="page-head"><div><h1>Characters</h1><div className="sub">80 in your library · 18 folders · everything stays on this device</div></div>
            <div className="row"><button className="btn">⇪ Import cards</button><button className="btn">📁 New folder</button><button className="btn primary">＋ New character</button></div></div>
          <div className="row" style={{ marginBottom: 12 }}><input type="search" placeholder="Search names, tags, descriptions…" style={{ maxWidth: 380 }} /><select style={{ width: "auto" }}><option>My order</option></select><button className="chip">★ Favorites</button></div>
          <div className="chips" style={{ marginBottom: 18 }}>{["Female · 44", "Roleplay · 40", "Fantasy · 19", "Dominant · 19", "sexy · 18", "switch · 17", "Fantasy World · 16"].map((t) => <button key={t} className="chip">{t}</button>)}</div>
          <div className="ftiles"><div className="ftile"><div className="fcover" style={{ background: "linear-gradient(135deg, hsl(300 40% 32%), hsl(350 45% 20%))" }}><span className="fglyph">📁</span></div><div className="fname"><b>Characters</b><span className="hint">80 characters · 2 folders</span></div></div></div>
        </div>
      </main>
      <MembersList rows={rows} total={80} presence={state} detail={detail} modelLabel="gpt-4o" expandedId={open} onToggle={(id) => setOpen(open === id ? null : id)}
        autoStatus onAutoStatus={() => {}} onCollapse={() => {}}
        expanded={() => (<><button className="btn">💬 Chat</button><button className="btn">✎ Edit</button><button className="btn">↻ New status</button><button className="btn">✏ Write status</button></>)} />
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Mock />);
