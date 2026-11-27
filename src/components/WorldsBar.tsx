import { useEffect, useState } from "react";
import { api, type Lorebook, type Playbook, type Room, type SavedPrompt } from "../api";
import TokenatorHelper from "./TokenatorHelper";
import { errText } from "../lib/util";
import { useStore } from "../store";
import { useToast } from "./ui";
import WorldOverview from "./WorldOverview";

export type WorldSel = "all" | "none" | number;

/**
 * Worlds: folders of connected rooms, kept apart from each other. A bar to pick one (or all rooms, or the rooms in no world), and for the
 * world picked its name, what it is like, the lorebooks attached to it (they apply to every chat in any of its rooms) and a way to make
 * another room in it.
 */
type WorldDraft = { name: string; description: string; lore: string; rooms: { name: string; kind: string; description: string }[]; links: [string, string][] };

export default function WorldsBar({ rooms, sel, onSelect, onStart, onEdit, onMap }: { rooms: Room[]; sel: WorldSel; onSelect: (s: WorldSel) => void; onStart: (r: Room) => void; onEdit: (r: Room) => void; onMap: () => void }) {
  const { worlds, refresh, go, personas } = useStore();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [books, setBooks] = useState<Lorebook[]>([]);
  const world = typeof sel === "number" ? worlds.find((w) => w.id === sel) : undefined;
  const [name, setName] = useState(world?.name ?? ""), [desc, setDesc] = useState(world?.description ?? ""), [lore, setLore] = useState(world?.lore ?? "");
  const [reading, setReading] = useState(false);
  const [pbs, setPbs] = useState<Playbook[]>([]);
  const [instr, setInstr] = useState(world?.instructions ?? "");
  useEffect(() => { setInstr(world?.instructions ?? ""); }, [world?.id, world?.instructions]);
  useEffect(() => { api.listPlaybooks().then(setPbs).catch(() => {}); }, [sel]);
  const [shelfAll, setShelfAll] = useState<SavedPrompt[]>([]);
  useEffect(() => { api.listPrompts().then(setShelfAll).catch(() => {}); }, [sel]);
  const saveSetup = async (patch: { persona?: string; playbook?: string; instructions?: string; prompts?: string[] }) => {
    if (!world) return;
    try { await api.setWorldSetup(world.id, patch.persona ?? world.persona, patch.playbook ?? world.playbook, patch.instructions ?? instr, patch.prompts ?? world.prompts); await refresh(); }
    catch (e) { toast(errText(e), "err"); }
  };
  useEffect(() => { setName(world?.name ?? ""); setDesc(world?.description ?? ""); setLore(world?.lore ?? ""); }, [world?.id, world?.name, world?.description, world?.lore]);
  useEffect(() => { api.listLorebooks().then(setBooks).catch(() => {}); }, [sel]);
  const unfiled = rooms.filter((r) => r.world_id == null).length;

  const create = async () => {
    try { const w = await api.createWorld(newName, ""); await refresh(); setNewName(""); setAdding(false); onSelect(w.id); toast(`Made the world "${w.name}".`, "ok"); }
    catch (e) { toast(errText(e), "err"); }
  };
  const save = async (patch: { name?: string; description?: string; lore?: string; lorebooks?: string[] }) => {
    if (!world) return;
    try { await api.updateWorld(world.id, patch.name ?? name, patch.description ?? desc, patch.lore ?? lore, patch.lorebooks ?? world.lorebooks); await refresh(); }
    catch (e) { toast(errText(e), "err"); setName(world.name); }
  };
  /** Adds what Tokenator drafted: the world's text is filled in or added to, new rooms are made in this world (a room with the same name is left alone), and the rooms are joined (at most three exits each). */
  const applyDraft = async (r: WorldDraft) => {
    if (!world) return;
    const inWorld = rooms.filter((x) => x.world_id === world.id);
    const byName = new Map<string, Room>(inWorld.map((x) => [x.name.toLowerCase(), x]));
    let made = 0;
    for (const rm of r.rooms) {
      if (byName.has(rm.name.toLowerCase())) continue;
      const room = await api.createRoom({ name: rm.name, kind: rm.kind as Room["kind"], description: rm.description, owner_kind: "self", character_id: null, backdrop: "", world_id: world.id });
      byName.set(rm.name.toLowerCase(), room); made++;
    }
    const links = new Map<number, Set<number>>(), changed = new Set<number>();
    const linksOf = (x: Room) => { if (!links.has(x.id)) links.set(x.id, new Set(x.links ?? [])); return links.get(x.id)!; };
    for (const [a, b] of r.links) {
      const ra = byName.get(a.toLowerCase()), rb = byName.get(b.toLowerCase());
      if (!ra || !rb || ra.id === rb.id) continue;
      const la = linksOf(ra), lb = linksOf(rb);
      if (la.has(rb.id) || la.size >= 3 || lb.size >= 3) continue;
      la.add(rb.id); lb.add(ra.id); changed.add(ra.id); changed.add(rb.id);
    }
    for (const id of changed) await api.setRoomLinks(id, [...(links.get(id) ?? [])]);
    const lore2 = r.lore.trim() ? (lore.trim() ? `${lore.trimEnd()}\n\n${r.lore.trim()}` : r.lore.trim()) : lore;
    await api.updateWorld(world.id, world.name, desc.trim() ? desc : r.description, lore2, world.lorebooks);
    await refresh();
    toast(`Added ${made} room${made === 1 ? "" : "s"} and ${changed.size ? "joined them up" : "no new links"}${r.lore.trim() ? ", and added to the world's lore" : ""}.`, "ok");
  };
  const remove = async () => {
    if (!world) return;
    const n = rooms.filter((r) => r.world_id === world.id).length;
    if (!window.confirm(`Delete the world "${world.name}"? Its ${n} room${n === 1 ? "" : "s"} are not deleted: they just aren't in a world any more.`)) return;
    try { await api.deleteWorld(world.id); await refresh(); onSelect("all"); } catch (e) { toast(errText(e), "err"); }
  };
  const chip = (label: string, on: boolean, fn: () => void, testid?: string) => <button key={label} type="button" className={`chip${on ? " on" : ""}`} aria-pressed={on} data-testid={testid} onClick={fn}>{label}</button>;

  return (
    <div className="worlds-bar" data-testid="worlds-bar">
      <div className="chips" role="group" aria-label="Worlds">
        {chip(`All rooms · ${rooms.length}`, sel === "all", () => onSelect("all"), "world-all")}
        {worlds.map((w) => chip(`🌍 ${w.name} · ${rooms.filter((r) => r.world_id === w.id).length}`, sel === w.id, () => onSelect(w.id), `world-chip-${w.id}`))}
        {worlds.length > 0 && unfiled > 0 && chip(`Not in a world · ${unfiled}`, sel === "none", () => onSelect("none"), "world-none")}
        {adding ? (
          <span className="row" style={{ gap: 6 }}>
            <input autoFocus type="text" value={newName} maxLength={60} placeholder="Name the world" aria-label="New world name" data-testid="new-world-name" onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && newName.trim()) void create(); if (e.key === "Escape") setAdding(false); }} />
            <button className="btn primary sm" disabled={!newName.trim()} data-testid="new-world-create" onClick={() => void create()}>Make it</button>
            <button className="btn sm" onClick={() => setAdding(false)}>Cancel</button>
          </span>
        ) : <button type="button" className="chip" data-testid="new-world" onClick={() => setAdding(true)}>＋ New world</button>}
      </div>
      {worlds.length === 0 && !adding && <p className="hint" style={{ margin: "4px 0 0" }}>A <b>world</b> is a folder of connected rooms, kept apart from your other worlds, with lorebooks that shape how characters roleplay anywhere in it.</p>}
      {world && (
        <div className="world-panel card" data-testid="world-panel">
          <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
            <input className="grow" type="text" value={name} maxLength={60} aria-label="World name" data-testid="world-name" onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && name !== world.name && void save({ name })} style={{ fontWeight: 700, maxWidth: 360 }} />
            <button className="btn" data-testid="world-read" onClick={() => setReading(true)}>📖 Read about this world</button>
            <button className="btn primary" data-testid="world-make-room" onClick={() => go({ page: "rooms", edit: "new", world: world.id })}>＋ Make a room in this world</button>
            <button className="btn danger" data-testid="world-delete" onClick={() => void remove()}>Delete world</button>
          </div>
          <label className="field"><span>What this world is like</span>
            <textarea rows={3} value={desc} maxLength={4000} data-testid="world-desc" placeholder="Told to the characters in every chat in this world: its history, its feel, its rules." onChange={(e) => setDesc(e.target.value)} onBlur={() => desc !== world.description && void save({ description: desc })} /></label>
          <label className="field"><span>World lore <small className="muted">(for reading: its history, its places, its people)</small></span>
            <textarea rows={8} value={lore} maxLength={20000} data-testid="world-lore" placeholder={"Write the world's background here. Blank lines make paragraphs; start a line with # for a heading, or - for a list.\n\nThis is yours to read before diving in. It is not sent to the model: the description above and the lorebooks below are what shape the roleplay."} onChange={(e) => setLore(e.target.value)} onBlur={() => lore !== world.lore && void save({ lore })} />
            <div className="hint">{lore.length.toLocaleString()} of 20,000 characters. Kept when you click away.</div></label>
          <div className="field"><span>Lorebooks that apply to this world</span>
            {books.length === 0 ? <div className="hint">No lorebooks yet. Make some on the Lorebooks page, then attach them here.</div> : (
              <div className="chips" data-testid="world-books">
                {books.map((b) => { const on = world.lorebooks.includes(b.id); return <button key={b.id} type="button" className={`chip${on ? " on" : ""}`} aria-pressed={on} data-world-book={b.name} onClick={() => void save({ lorebooks: on ? world.lorebooks.filter((x) => x !== b.id) : [...world.lorebooks, b.id] })}>📚 {b.name}</button>; })}
              </div>
            )}
            <div className="hint">Attached lorebooks work in every chat in any room of this world, together with the ones on each character.</div>
          </div>
          <div className="field" data-testid="world-setup"><span>What this world brings along</span>
            <div className="hint">These only add to what a character already has. A character's own playbook and instructions come first.</div>
            <label className="field"><span>Persona <small className="muted">(stands in for yours only while a chat is in this world)</small></span>
              <select aria-label="Persona for this world" data-testid="world-persona" value={world.persona} onChange={(e) => void saveSetup({ persona: e.target.value })}>
                <option value="">Keep my own</option>
                {personas.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select></label>
            <label className="field"><span>Playbook <small className="muted">(used when the chat and its characters don't choose one)</small></span>
              <select aria-label="Playbook for this world" data-testid="world-playbook" value={world.playbook} onChange={(e) => void saveSetup({ playbook: e.target.value })}>
                <option value="">None</option>
                {pbs.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select></label>
            <label className="field"><span>Standing instructions <small className="muted">(told to the characters in every chat here, after their own instructions)</small></span>
              <textarea rows={3} value={instr} maxLength={4000} data-testid="world-instructions" placeholder="e.g. Keep scenes grounded in the harbour town. Nobody here has magic." onChange={(e) => setInstr(e.target.value)} onBlur={() => instr !== world.instructions && void saveSetup({ instructions: instr })} /></label>
            <div className="field"><span>Prompt shelf <small className="muted">(these sit first in the Prompts menu while you are in a chat in this world)</small></span>
              {shelfAll.length === 0 ? <div className="hint">No prompts yet. Add some in the Prompts menu, then pick them here.</div> : (
                <div className="chips" data-testid="world-shelf">
                  {shelfAll.map((p) => { const on = world.prompts.includes(p.id); return <button key={p.id} type="button" className={`chip${on ? " on" : ""}`} aria-pressed={on} data-world-prompt={p.title} onClick={() => void saveSetup({ prompts: on ? world.prompts.filter((x) => x !== p.id) : [...world.prompts, p.id] })}>{p.title}</button>; })}
                </div>
              )}
            </div>
          </div>
          <TokenatorHelper<WorldDraft> kind="world" label="Tokenator: help me map out this world"
            intro="Describe the world in your own words. Tokenator drafts some background, a few rooms, and which rooms connect. Rooms and text are only added (nothing you already have is changed or removed), and only after you accept. You can edit all of it afterwards."
            placeholder="e.g. a lantern-lit tea district built along an old canal, with a rooftop garden, a library that closes at dusk and a crowded tea house"
            context={() => [`World: ${world.name}.`, desc ? `About it: ${desc}` : "", rooms.some((x) => x.world_id === world.id) ? `Rooms it already has, which must not be repeated: ${rooms.filter((x) => x.world_id === world.id).map((x) => x.name).join(", ")}.` : ""].filter(Boolean).join(" ")}
            preview={(r) => (
              <div className="card" style={{ background: "var(--panel2)", display: "grid", gap: 6 }} data-testid="tokenator-world-preview">
                {r.description && <div><b>About:</b> {r.description}</div>}
                {r.lore && <div><b>Lore:</b> <span style={{ whiteSpace: "pre-wrap" }}>{r.lore.length > 400 ? `${r.lore.slice(0, 400)}…` : r.lore}</span></div>}
                <div className="hint">{r.rooms.length} room{r.rooms.length === 1 ? "" : "s"} will be made in this world</div>
                {r.rooms.map((x) => <div key={x.name}>• <b>{x.name}</b> <span className="chip">{x.kind.replace("_", " ")}</span> {x.description}</div>)}
                {r.links.length > 0 && <div className="hint">Joined: {r.links.map(([a, b]) => `${a} ↔ ${b}`).join(", ")}</div>}
              </div>
            )}
            onAccept={applyDraft} />
        </div>
      )}
      {reading && world && <WorldOverview world={world} rooms={rooms} onClose={() => setReading(false)} onStart={onStart} onEdit={onEdit} onMap={onMap} />}
    </div>
  );
}
