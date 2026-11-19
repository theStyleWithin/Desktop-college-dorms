import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Room } from "../api";
import { kindLabel, roomBackground } from "../lib/rooms";
import { errText } from "../lib/util";
import { useStore } from "../store";
import { useToast } from "./ui";

const KEY = "dorms.rooms.map";
const W = 240, H = 170;
type Pos = { x: number; y: number };

const loadPos = (): Record<string, Pos> => { try { return JSON.parse(localStorage.getItem(KEY) || "{}") as Record<string, Pos>; } catch { return {}; } };
const savePos = (p: Record<string, Pos>) => { try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* storage unavailable */ } };

/**
 * A map of the rooms. Each room is a card with a round handle: drag from the handle onto another room to draw a
 * pathway between them (the story can then walk from one to the other, both ways). Click the x on a line to remove it.
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
    if ((ra.links ?? []).includes(b)) { toast("Those rooms are already connected.", "ok"); return; }
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
  const pairs: [number, number][] = [];
  for (const r of rooms) for (const l of r.links ?? []) if (r.id < l && rooms.some((x) => x.id === l)) pairs.push([r.id, l]);
  const inside = rooms.filter((r) => r.parent_id != null && rooms.some((x) => x.id === r.parent_id));

  return (
    <div className="room-map-wrap" data-testid="room-map">
      <p className="hint" style={{ margin: "0 0 8px" }}>Drag from the round handle under a room onto another room to connect them. Click the × on a line to remove it. Drag a room to move it. Dashed lines show which rooms are inside another room.</p>
      <div className="room-map" ref={canvas} style={{ width, height }}>
        <svg className="room-map-lines" width={width} height={height} aria-hidden="false">
          {inside.map((r) => { const a = centre(r.parent_id!), b = centre(r.id); return a && b ? <line key={`in${r.id}`} className="inside" x1={a.x} y1={a.y} x2={b.x} y2={b.y} /> : null; })}
          {pairs.map(([a, b]) => {
            const pa = centre(a), pb = centre(b); if (!pa || !pb) return null;
            const mx = (pa.x + pb.x) / 2, my = (pa.y + pb.y) / 2;
            return (
              <g key={`${a}-${b}`} data-link={`${a}-${b}`}>
                <line className="path" x1={pa.x} y1={pa.y} x2={pb.x} y2={pb.y} />
                <g className="unlink" transform={`translate(${mx},${my})`} onClick={() => void unlink(a, b)} role="button" aria-label="Remove this pathway" tabIndex={0}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") void unlink(a, b); }}>
                  <circle r="10" /><text textAnchor="middle" dy="4">×</text>
                </g>
              </g>
            );
          })}
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
      </div>
    </div>
  );
}
