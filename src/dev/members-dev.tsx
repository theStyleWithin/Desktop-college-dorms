// Dev-only harness (not part of the production build): shows the characters list on the right of the app, with sample data,
// so the look can be iterated on in a plain browser page. Usage: /members-dev.html?state=ok|local|down|warn|checking&open=Kai%20Tanaka
import { createRoot } from "react-dom/client";
import { useState } from "react";
import "../styles.css";
import { MembersList, type MemberRow, type Presence } from "../components/MembersPanel";
import { P, portrait } from "./portraits";

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
