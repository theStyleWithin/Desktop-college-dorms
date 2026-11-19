import { useEffect, useState } from "react";
import { api, type Lorebook, type Room } from "../api";
import { errText } from "../lib/util";
import { useStore } from "../store";
import { useToast } from "./ui";

export type WorldSel = "all" | "none" | number;

/**
 * Worlds: folders of connected rooms, kept apart from each other. A bar to pick one (or all rooms, or the rooms in no world), and for the
 * world picked its name, what it is like, the lorebooks attached to it (they apply to every chat in any of its rooms) and a way to make
 * another room in it.
 */
export default function WorldsBar({ rooms, sel, onSelect }: { rooms: Room[]; sel: WorldSel; onSelect: (s: WorldSel) => void }) {
  const { worlds, refresh, go } = useStore();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [books, setBooks] = useState<Lorebook[]>([]);
  const world = typeof sel === "number" ? worlds.find((w) => w.id === sel) : undefined;
  const [name, setName] = useState(world?.name ?? ""), [desc, setDesc] = useState(world?.description ?? "");
  useEffect(() => { setName(world?.name ?? ""); setDesc(world?.description ?? ""); }, [world?.id, world?.name, world?.description]);
  useEffect(() => { api.listLorebooks().then(setBooks).catch(() => {}); }, [sel]);
  const unfiled = rooms.filter((r) => r.world_id == null).length;

  const create = async () => {
    try { const w = await api.createWorld(newName, ""); await refresh(); setNewName(""); setAdding(false); onSelect(w.id); toast(`Made the world "${w.name}".`, "ok"); }
    catch (e) { toast(errText(e), "err"); }
  };
  const save = async (patch: { name?: string; description?: string; lorebooks?: string[] }) => {
    if (!world) return;
    try { await api.updateWorld(world.id, patch.name ?? name, patch.description ?? desc, patch.lorebooks ?? world.lorebooks); await refresh(); }
    catch (e) { toast(errText(e), "err"); setName(world.name); }
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
            <button className="btn primary" data-testid="world-make-room" onClick={() => go({ page: "rooms", edit: "new", world: world.id })}>＋ Make a room in this world</button>
            <button className="btn danger" data-testid="world-delete" onClick={() => void remove()}>Delete world</button>
          </div>
          <label className="field"><span>What this world is like</span>
            <textarea rows={3} value={desc} maxLength={4000} data-testid="world-desc" placeholder="Told to the characters in every chat in this world: its history, its feel, its rules." onChange={(e) => setDesc(e.target.value)} onBlur={() => desc !== world.description && void save({ description: desc })} /></label>
          <div className="field"><span>Lorebooks that apply to this world</span>
            {books.length === 0 ? <div className="hint">No lorebooks yet. Make some on the Lorebooks page, then attach them here.</div> : (
              <div className="chips" data-testid="world-books">
                {books.map((b) => { const on = world.lorebooks.includes(b.id); return <button key={b.id} type="button" className={`chip${on ? " on" : ""}`} aria-pressed={on} data-world-book={b.name} onClick={() => void save({ lorebooks: on ? world.lorebooks.filter((x) => x !== b.id) : [...world.lorebooks, b.id] })}>📚 {b.name}</button>; })}
              </div>
            )}
            <div className="hint">Attached lorebooks work in every chat in any room of this world, together with the ones on each character.</div>
          </div>
        </div>
      )}
    </div>
  );
}
