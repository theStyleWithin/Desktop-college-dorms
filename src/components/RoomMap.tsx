import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Room } from "../api";
import { MAX_EXITS, kindLabel, roomBackground } from "../lib/rooms";
import { errText } from "../lib/util";
import { useStore } from "../store";
import { useToast } from "./ui";

const KEY = "dorms.rooms.map";
const W = 240, H = 170;
type Pos = { x: number; y: number };

const loadPos = (): Record<string, Pos> => { try { return JSON.parse(localStorage.getItem(KEY) || "{}") as Record<string, Pos>; } catch { return {}; } };
const savePos = (p: Record<string, Pos>) => { try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* storage unavailable */ } };

/**
 * A map of the rooms. Each room is a card with a round handle: drag from the handle onto another room to draw an exit
 * (a one-way pathway, an arrow; a room can have up to three). Draw one back for a way home. Click the x on an arrow to remove it.
 * Drag a card to move it; the layout is kept on this device.
 */
export default function RoomMap({ rooms, onEdit, onStart }: { rooms: Room[]; onEdit: (r: Room) => void; onStart: (r: Room) => void }) {
  const { refresh } = useStore();
  const toast = useToast();
  const [pos, setPos] = useState<Record<string, Pos>>(loadPos);
  const [line, setLine] = useState<{ from: number; x: number; y: number } | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const canvas = useRef<HTMLDivElement>(null);

  // rooms that were never placed get a spot on a grid
  const at = (r: Room, i: number): Pos => pos[r.id] ?? { x: 24 + (i % 3) * (W + 70), y: 24 + Math.floor(i / 3) * (H + 80) };
  const placed = rooms.map((r, i) => ({ r, p: at(r, i) }));
  const where = (id: number) => placed.find((x) => x.r.id === id)?.p;
  const width = Math.max(720, ...placed.map((x) => x.p.x + W + 40));
  const height = Math.max(420, ...placed.map((x) => x.p.y + H + 60));

  const local = (e: { clientX: number; clientY: number }): Pos => {
    const b = canvas.current!.getBoundingClientRect();
    return { x: e.clientX - b.left, y: e.clientY - b.top };
  };

  const link = useCallback(async (a: number, b: number) => {
    const ra = rooms.find((r) => r.id === a);
    if (!ra || a === b) return;
    if ((ra.links ?? []).includes(b)) { toast("That exit is already there.", "ok"); return; }
    if ((ra.links ?? []).length >= MAX_EXITS) { toast(`${ra.name} already has ${MAX_EXITS} exits. Remove one first.`, "err"); return; }
    try { await api.setRoomLinks(a, [...(ra.links ?? []), b]); await refresh(); } catch (e) { toast(errText(e), "err"); }
  }, [rooms, refresh, toast]);

  const unlink = async (a: number, b: number) => {
    const ra = rooms.find((r) => r.id === a);
    if (!ra) return;
    try { await api.setRoomLinks(a, (ra.links ?? []).filter((l) => l !== b)); await refresh(); } catch (e) { toast(errText(e), "err"); }
  };

  // drawing a line from a room's handle
  const startLine = (e: React.PointerEvent, from: number) => {
    e.preventDefault(); e.stopPropagation();
    const fr = rooms.find((r) => r.id === from);
    if (fr && (fr.links ?? []).length >= MAX_EXITS) { toast(`${fr.name} already has ${MAX_EXITS} exits. Remove one first.`, "err"); return; }
    const first = local(e);
    setLine({ from, ...first });
    const move = (ev: PointerEvent) => {
      const p = local(ev);
      setLine({ from, ...p });
      const el = document.elementFromPoint(ev.clientX, ev.clientY)?.closest("[data-room-node]") as HTMLElement | null;
      setOver(el ? Number(el.dataset.roomNode) : null);
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up);
      const el = document.elementFromPoint(ev.clientX, ev.clientY)?.closest("[data-room-node]") as HTMLElement | null;
      setLine(null); setOver(null);
      if (el) void link(from, Number(el.dataset.roomNode));
    };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  };

  // moving a card
  const startMove = (e: React.PointerEvent, r: Room, p0: Pos) => {
    if ((e.target as HTMLElement).closest("button,[data-port]")) return;
    e.preventDefault();
    const sx = e.clientX, sy = e.clientY;
    let latest = pos;
    const move = (ev: PointerEvent) => {
      latest = { ...latest, [r.id]: { x: Math.max(0, p0.x + ev.clientX - sx), y: Math.max(0, p0.y + ev.clientY - sy) } };
      setPos(latest);
    };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); savePos(latest); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  };
  useEffect(() => { setPos((p) => p); }, [rooms.length]);

  const centre = (id: number): Pos | null => { const p = where(id); return p ? { x: p.x + W / 2, y: p.y + H / 2 } : null; };
  const port = (id: number): Pos | null => { const p = where(id); return p ? { x: p.x + W / 2, y: p.y + H + 4 } : null; };
  // where a straight line from the middle of a card towards `to` leaves the card's edge (so arrow heads show outside the cards)
  const edge = (id: number, to: Pos): Pos | null => {
    const c = centre(id); if (!c) return null;
    const dx = to.x - c.x, dy = to.y - c.y;
    if (dx === 0 && dy === 0) return c;
    const k = Math.min((W / 2 + 6) / Math.abs(dx || 1e-9), (H / 2 + 6) / Math.abs(dy || 1e-9));
    return { x: c.x + dx * k, y: c.y + dy * k };
  };
  // every exit is an arrow; two rooms leading to each other show as two arcs side by side
  const exits: { a: number; b: number }[] = [];
  for (const r of rooms) for (const l of r.links ?? []) if (rooms.some((x) => x.id === l) && l !== r.id) exits.push({ a: r.id, b: l });
  const geom = exits.flatMap(({ a, b }) => {
    const ca = centre(a), cb = centre(b); if (!ca || !cb) return [];
    const p0 = edge(a, cb)!, p1 = edge(b, ca)!;
    const dx = p1.x - p0.x, dy = p1.y - p0.y, len = Math.hypot(dx, dy) || 1;
    const bow = 26, cx = (p0.x + p1.x) / 2 - (dy / len) * bow, cy = (p0.y + p1.y) / 2 + (dx / len) * bow;
    return [{ a, b, d: `M${p0.x},${p0.y} Q${cx},${cy} ${p1.x},${p1.y}`, mx: 0.25 * p0.x + 0.5 * cx + 0.25 * p1.x, my: 0.25 * p0.y + 0.5 * cy + 0.25 * p1.y }];
  });
  const inside = rooms.filter((r) => r.parent_id != null && rooms.some((x) => x.id === r.parent_id));

  return (
    <div className="room-map-wrap" data-testid="room-map">
      <p className="hint" style={{ margin: "0 0 8px" }}>Drag from the round handle under a room onto another room to give it an exit there (an arrow, one way; up to 3 exits per room). Click the × on an arrow to remove it. Drag a room to move it. Dashed lines show which rooms are inside another room.</p>
      <div className="room-map" ref={canvas} style={{ width, height }}>
        <svg className="room-map-lines" width={width} height={height} aria-hidden="false">
          <defs><marker id="room-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="currentColor" /></marker></defs>
          {inside.map((r) => { const a = centre(r.parent_id!), b = centre(r.id); return a && b ? <line key={`in${r.id}`} className="inside" x1={a.x} y1={a.y} x2={b.x} y2={b.y} /> : null; })}
          {geom.map(({ a, b, d }) => <path key={`${a}>${b}`} className="path" data-link={`${a}-${b}`} d={d} markerEnd="url(#room-arrow)" />)}
          {line && (() => { const f = port(line.from); return f ? <line className="drawing" x1={f.x} y1={f.y} x2={line.x} y2={line.y} /> : null; })()}
        </svg>
        {placed.map(({ r, p }) => (
          <div key={r.id} className={`room-node${over === r.id && line && line.from !== r.id ? " drop" : ""}`} data-room-node={r.id} data-room-name={r.name}
            style={{ left: p.x, top: p.y, width: W, height: H }} onPointerDown={(e) => startMove(e, r, p)}>
            <div className="room-node-art" style={{ background: roomBackground(r) ?? "linear-gradient(135deg, #2a2540, #3a2f55)" }} />
            <div className="room-node-body">
              <b title={r.name}>{r.name}</b>
              <small>{kindLabel(r.kind)}</small>
              <div className="row" style={{ gap: 6, marginTop: 6 }}>
                <button className="btn primary sm" onClick={() => onStart(r)}>Start a dorm</button>
                <button className="btn sm" onClick={() => onEdit(r)}>Edit</button>
              </div>
            </div>
            <span className="room-port" data-port={r.id} role="button" aria-label={`Connect ${r.name} to another room`} title="Drag onto another room to connect them" onPointerDown={(e) => startLine(e, r.id)} />
          </div>
        ))}
        <svg className="room-map-controls" width={width} height={height}>
          {geom.map(({ a, b, mx, my }) => (
            <g key={`${a}>${b}`} className="unlink" data-unlink={`${a}-${b}`} transform={`translate(${mx},${my})`} onClick={() => void unlink(a, b)} role="button" aria-label="Remove this exit" tabIndex={0}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") void unlink(a, b); }}>
              <circle r="10" /><text textAnchor="middle" dy="4">×</text>
            </g>
          ))}
        </svg>
      </div>
    </div>
  );
}
