import { roomBackdrop, roomModelUrl, type Room, type RoomKind } from "../api";
import type { SceneCfg } from "./roomModel";

export const ROOM_KINDS: { id: RoomKind; label: string }[] = [
  { id: "living_room", label: "Living Room" }, { id: "bedroom", label: "Bedroom" }, { id: "kitchen", label: "Kitchen" },
  { id: "bathroom", label: "Bathroom" }, { id: "dining_room", label: "Dining Room" }, { id: "games_room", label: "Games Room" },
  { id: "office", label: "Office" }, { id: "garage", label: "Garage" }, { id: "garden", label: "Garden" },
  { id: "balcony", label: "Balcony" }, { id: "basement", label: "Basement" }, { id: "rooftop", label: "Rooftop" },
  { id: "other", label: "Something else…" },
];

/** Built-in backdrops: no files needed. Each is a painted-gradient scene; `shelf` says which kinds of room list it first. */
export const PRESETS: { key: string; label: string; css: string; shelf: RoomKind[] }[] = [
  { key: "lamplight", label: "Lamplight", shelf: ["living_room", "bedroom", "office", "other"],
    css: "radial-gradient(60% 50% at 70% 25%, #ffcf8a66, transparent 70%), linear-gradient(180deg, #2b2140 0%, #3a2a4d 55%, #5a3b3f 100%)" },
  { key: "night-window", label: "Night window", shelf: ["bedroom", "living_room", "balcony", "other"],
    css: "radial-gradient(40% 30% at 78% 22%, #cfd8ff55, transparent 70%), linear-gradient(180deg, #0c1230 0%, #1b2150 60%, #2a2147 100%)" },
  { key: "sunset", label: "Sunset", shelf: ["balcony", "rooftop", "garden", "other"],
    css: "linear-gradient(180deg, #3b2a6b 0%, #b5527a 50%, #f0a15d 100%)" },
  { key: "morning", label: "Morning kitchen", shelf: ["kitchen", "dining_room", "other"],
    css: "radial-gradient(70% 60% at 30% 10%, #fff4cf88, transparent 70%), linear-gradient(180deg, #e8d9b8 0%, #cdb48a 100%)" },
  { key: "garden", label: "Garden", shelf: ["garden", "balcony", "rooftop", "other"],
    css: "radial-gradient(60% 40% at 50% 0%, #e6ffd966, transparent 70%), linear-gradient(180deg, #7fb6c9 0%, #5f9b6b 60%, #35633f 100%)" },
  { key: "neon", label: "Neon arcade", shelf: ["games_room", "garage", "basement", "other"],
    css: "radial-gradient(40% 40% at 20% 30%, #ff3d9a66, transparent 70%), radial-gradient(40% 40% at 80% 60%, #3de3ff55, transparent 70%), linear-gradient(180deg, #0d0b1e 0%, #1a1038 100%)" },
  { key: "tile", label: "Clean tile", shelf: ["bathroom", "kitchen", "other"],
    css: "repeating-linear-gradient(0deg, #dfeef0 0 38px, #cfe0e4 38px 40px), repeating-linear-gradient(90deg, transparent 0 38px, #cfe0e4 38px 40px)" },
  { key: "basement", label: "Basement", shelf: ["basement", "garage", "games_room", "other"],
    css: "radial-gradient(50% 40% at 50% 0%, #ffe9b055, transparent 70%), linear-gradient(180deg, #2a2a33 0%, #1a1a22 100%)" },
  { key: "paper", label: "Quiet paper", shelf: ["office", "living_room", "other"],
    css: "linear-gradient(180deg, #efe7d6 0%, #d8cdb6 100%)" },
];

export const presetFor = (key: string) => PRESETS.find((p) => `preset:${p.key}` === key);

/** CSS `background` for a room: its uploaded image, its preset scene, or nothing. */
export function roomBackground(r?: Room | null): string | undefined {
  if (!r) return undefined;
  const up = roomBackdrop(r);
  if (up) return `center / cover no-repeat url("${up}")`;
  return presetFor(r.backdrop)?.css;
}

export const kindLabel = (k: string) => ROOM_KINDS.find((x) => x.id === k)?.label ?? "Room";

/** Cuts a reply written as texting into separate bubbles (blank lines separate messages). */
export function textBubbles(t: string): string[] {
  return t.split(/\n\s*\n/).map((x) => x.replace(/\*[^*\n]+\*/g, "").replace(/\s+/g, " ").trim()).filter(Boolean);
}

/** Hides the model's hidden `[variable: add 3]` lines while a reply is still being written. */
export function hideDirectives(t: string): string {
  return t.replace(/\[[A-Za-z0-9_.-]+:\s*(?:set|add|subtract|sub|push|append|remove|delete|unset)\b[^\]]*\]?/g, "").replace(/\[[A-Za-z0-9_.-]+:\s*(?:s|se|a|ad|su|sub|subt|p|pu|pus|r|re|rem|d|de|del)?$/, "");
}

/** The imported 3D scene of a room, as the viewer wants it (null when the room has none: the built-in room is used). */
export function roomScene(r?: Room | null): SceneCfg | null {
  const url = r ? roomModelUrl(r) : null;
  if (!r || !r.model || !url) return null;
  const ext = r.model.split(".").pop()?.toLowerCase() ?? "glb";
  return { url, ext, scale: r.model_scale ?? 1, rot: r.model_rot ?? 0, y: r.model_y ?? 0 };
}

/** The most exits (one-way pathways out) a room can have. */
export const MAX_EXITS = 3;

/** The rooms `cur` leads to by its own exits (one-way pathways the user drew). */
export function roomExits(rooms: Room[], cur: Room | null): Room[] {
  if (!cur) return [];
  return (cur.links ?? []).map((id) => rooms.find((r) => r.id === id)).filter((r): r is Room => !!r && r.id !== cur.id);
}

/** The rooms around `cur` by the place it is part of: that place, the rooms inside it, and its neighbours there. */
export function nearbyRooms(rooms: Room[], cur: Room | null): Room[] {
  if (!cur) return [];
  const exits = new Set(roomExits(rooms, cur).map((r) => r.id));
  return rooms.filter((r) => r.id !== cur.id && !exits.has(r.id) && (r.id === cur.parent_id || r.parent_id === cur.id || (cur.parent_id != null && r.parent_id === cur.parent_id)));
}

/** Whether room `x` sits somewhere inside room `anc` (so `anc` can't be put inside it). */
export function isInside(rooms: Room[], x: number, anc: number | null): boolean {
  if (anc == null) return false;
  let cur = rooms.find((r) => r.id === x)?.parent_id ?? null;
  for (let i = 0; cur != null && i < 200; i++) { if (cur === anc) return true; cur = rooms.find((r) => r.id === cur)?.parent_id ?? null; }
  return false;
}

/** "Our house › Kitchen" */
export function pathName(rooms: Room[], id: number): string {
  const names: string[] = [];
  let cur: number | null | undefined = id;
  for (let i = 0; cur != null && i < 200; i++) { const r = rooms.find((x) => x.id === cur); if (!r) break; names.unshift(r.name); cur = r.parent_id; }
  return names.join(" › ");
}

/** Every room joined to this one by "part of" links or exits, in either direction (the room itself included): what moves along with it into a world. */
export function connectedRooms(rooms: Room[], id: number): number[] {
  const seen = new Set<number>([id]);
  const queue = [id];
  while (queue.length) {
    const cur = queue.pop()!, room = rooms.find((r) => r.id === cur);
    if (!room) continue;
    const next = [
      ...(room.parent_id != null ? [room.parent_id] : []),
      ...(room.links ?? []),
      ...rooms.filter((r) => r.parent_id === cur || (r.links ?? []).includes(cur)).map((r) => r.id),
    ];
    for (const n of next) if (!seen.has(n)) { seen.add(n); queue.push(n); }
  }
  return [...seen];
}
