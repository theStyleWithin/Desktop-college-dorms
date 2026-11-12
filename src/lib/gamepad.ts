/**
 * Controllers. Browsers (and so this app) describe nearly every pad on a PC through the same "standard" layout, whatever
 * it is: Xbox, PlayStation (DualShock 4, DualSense), Nintendo (Switch Pro, Joy-Con), Steam Controller and Steam Deck (through
 * Steam Input), 8BitDo and the rest. Buttons are numbered by *position* (0 is the bottom face button), so the button the hand
 * gestures use is the same place on every pad, while its name on the pad differs: A, Cross or B. This file knows those names,
 * the default bindings, and keeps the person's own bindings.
 */
export type PadKind = "xbox" | "playstation" | "nintendo" | "steam" | "generic";

export const KIND_NAME: Record<PadKind, string> = { xbox: "Xbox", playstation: "PlayStation", nintendo: "Nintendo", steam: "Steam", generic: "Generic" };

const DPAD = ["D-pad up", "D-pad down", "D-pad left", "D-pad right"];
export const LABELS: Record<PadKind, string[]> = {
  xbox: ["A", "B", "X", "Y", "LB", "RB", "LT", "RT", "View", "Menu", "L3", "R3", ...DPAD, "Xbox"],
  playstation: ["Cross ✕", "Circle ○", "Square □", "Triangle △", "L1", "R1", "L2", "R2", "Create", "Options", "L3", "R3", ...DPAD, "PS", "Touchpad"],
  nintendo: ["B", "A", "Y", "X", "L", "R", "ZL", "ZR", "−", "+", "L stick", "R stick", ...DPAD, "Home", "Capture"],
  steam: ["A", "B", "X", "Y", "L1", "R1", "L2", "R2", "View", "Menu", "L3", "R3", ...DPAD, "Steam"],
  generic: [],
};

/** What kind of controller is this, from the name the system gives it (it carries the maker's vendor id). */
export function padKind(id: string): PadKind {
  const s = id.toLowerCase();
  if (/28de|steam|valve/.test(s)) return "steam";
  if (/054c|playstation|dualshock|dualsense|ps4|ps5|ps3|sony|wireless controller/.test(s)) return "playstation";
  if (/057e|nintendo|pro controller|joy-?con|switch/.test(s)) return "nintendo";
  if (/045e|xbox|xinput|microsoft|x-box/.test(s)) return "xbox";
  return "generic";
}

export const buttonName = (kind: PadKind, i: number): string => LABELS[kind][i] ?? `Button ${i}`;

export interface Bindings {
  /** change what the hands do, one step at a time: open hands, point, pinch */
  cycle: number[];
  /** go straight to open hands / pointing / pinching */
  pet: number[]; point: number[]; pinch: number[]; tickle: number[];
  /** the action button of each hand: poke (tap), tickle (hold), pinch (hold), grip (open hands) */
  right: number[]; left: number[];
}

export const DEFAULT_BINDINGS: Bindings = {
  cycle: [3],            // top face button: Y, Triangle, X
  pet: [14],             // D-pad left
  point: [12],           // D-pad up
  pinch: [15],           // D-pad right
  tickle: [13],          // D-pad down
  right: [0, 11],        // bottom face button (A, Cross, B), or click the right stick
  left: [2, 10],         // left face button (X, Square, Y), or click the left stick
};

export const ACTIONS: { key: keyof Bindings; label: string; help: string }[] = [
  { key: "right", label: "Right hand: action", help: "Tap to poke, hold to tickle or pinch (and grip with open hands)" },
  { key: "left", label: "Left hand: action", help: "The same, with the left hand" },
  { key: "cycle", label: "Next hand gesture", help: "Open hands → pointing finger → pinch → open hands" },
  { key: "pet", label: "Open hands", help: "Go straight to open hands (petting)" },
  { key: "point", label: "Pointing finger", help: "Go straight to the pointing finger (poke and tickle)" },
  { key: "pinch", label: "Pinch", help: "Go straight to the pinch (pick her up)" },
  { key: "tickle", label: "Tickle", help: "Go straight to tickling fingers (hold the action button to tickle)" },
];

const KEY = "dorms.pad.bindings";
let cache: Bindings | null = null;
const clean = (v: unknown, d: number[]): number[] => (Array.isArray(v) ? v.filter((n) => Number.isInteger(n) && n >= 0 && n < 32).slice(0, 3) : d);
export function getBindings(): Bindings {
  if (cache) return cache;
  let raw: Partial<Bindings> = {};
  try { raw = JSON.parse(localStorage.getItem(KEY) || "{}"); } catch { /* storage unavailable */ }
  cache = {
    cycle: clean(raw.cycle, DEFAULT_BINDINGS.cycle), pet: clean(raw.pet, DEFAULT_BINDINGS.pet), point: clean(raw.point, DEFAULT_BINDINGS.point),
    pinch: clean(raw.pinch, DEFAULT_BINDINGS.pinch), tickle: clean(raw.tickle, DEFAULT_BINDINGS.tickle), right: clean(raw.right, DEFAULT_BINDINGS.right), left: clean(raw.left, DEFAULT_BINDINGS.left),
  };
  return cache;
}
export function setBindings(b: Bindings) {
  cache = b;
  try { localStorage.setItem(KEY, JSON.stringify(b)); } catch { /* storage unavailable */ }
  window.dispatchEvent(new Event("dorms-pad-bindings"));
}
export const resetBindings = () => setBindings({ ...DEFAULT_BINDINGS, cycle: [...DEFAULT_BINDINGS.cycle], pet: [...DEFAULT_BINDINGS.pet], point: [...DEFAULT_BINDINGS.point], pinch: [...DEFAULT_BINDINGS.pinch], tickle: [...DEFAULT_BINDINGS.tickle], right: [...DEFAULT_BINDINGS.right], left: [...DEFAULT_BINDINGS.left] });

export const activePad = (): Gamepad | null => { const g = navigator.getGamepads?.() ?? []; for (const p of g) if (p && p.connected) return p; return null; };
export const isStandard = (p: Gamepad) => p.mapping === "standard";

/** "A / Right stick click", for a hint. */
export const bindingText = (kind: PadKind, list: number[]) => list.map((i) => buttonName(kind, i)).join(" or ");
