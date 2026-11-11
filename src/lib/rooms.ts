import { roomBackdrop, type Room, type RoomKind } from "../api";

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
