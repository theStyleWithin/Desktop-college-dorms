import * as THREE from "three";

/**
 * Accessories the wardrobe can switch on and off: animal ears and tails (cat, dog, fox, raccoon, bunny, wolf),
 * glasses, hats, hair accessories, bags and shoes. They are found by the names VRoid Studio and similar tools give the
 * materials (for example `Accessory_CatEar_01_CLOTH`). Outfits (tops, bottoms and so on) are swapped by loading
 * another model file instead, never switched off one by one.
 */
export interface Accessory {
  key: string;
  label: string;
  /** every material that belongs to it (a material and its outline pass) */
  materials: THREE.Material[];
}

const SPECIES: [string, string[]][] = [
  ["Cat", ["cat", "neko", "kitty", "kitten"]],
  ["Dog", ["dog", "puppy", "inu"]],
  ["Fox", ["fox", "kitsune"]],
  ["Raccoon", ["raccoon", "tanuki"]],
  ["Bunny", ["bunny", "rabbit", "usagi"]],
  ["Wolf", ["wolf", "ookami"]],
];
const NOT_A_TAIL = ["hair", "pony", "ponytail", "twin", "twintail", "side", "sidetail"];

/** Splits `Accessory_CatEar_01_CLOTH (Instance)` into lower-case words: accessory, cat, ear, 01, cloth. */
const words = (name: string) =>
  name.replace(/\s*\((Instance|Outline)\)\s*$/i, "").replace(/([a-z])([A-Z])/g, "$1 $2").split(/[^A-Za-z0-9]+/).filter(Boolean).map((w) => w.toLowerCase());

/** Turns a material name into an accessory (or null if it isn't one we offer). Exported for tests. */
export function classify(name: string): { key: string; label: string } | null {
  const w = words(name);
  const joined = w.join("");
  const has = (...xs: string[]) => w.some((x) => xs.includes(x));
  // animal ears and tails: by words ("Cat Ear"), or run together ("catear")
  const species = SPECIES.find(([, ks]) => has(...ks) || ks.some((k) => joined.includes(k + "ear") || joined.includes(k + "tail")))?.[0];
  const isTail = (has("tail") || (species && /tail/.test(joined))) && !has(...NOT_A_TAIL);
  const isEar = has("ear", "ears") || (!!species && /(cat|neko|dog|fox|raccoon|tanuki|bunny|rabbit|wolf)ears?/.test(joined));
  if (isEar || isTail) {
    const part = isTail && !isEar ? "tail" : "ears";
    return { key: `${(species ?? "animal").toLowerCase()}-${part}`, label: species ? `${species} ${part}` : part === "tail" ? "Tail" : "Ears" };
  }
  if (has("glasses", "eyewear", "spectacles", "sunglasses")) return { key: "glasses", label: "Glasses" };
  if (has("hat", "cap", "beret", "beanie", "hood", "helmet", "crown", "tiara", "headwear", "headband")) return { key: "headwear", label: "Hat / headwear" };
  if (has("ribbon", "hairpin", "hairclip", "clip", "hairband", "scrunchie", "barrette")) return { key: "hair-accessory", label: "Hair accessories" };
  if (has("bag", "backpack", "purse")) return { key: "bag", label: "Bag" };
  if (has("shoes", "shoe", "boots", "boot", "sneakers", "sneaker")) return { key: "shoes", label: "Shoes" };
  // any other VRoid "Accessory_<Name>_NN_CLOTH"
  const m = name.replace(/\s*\((Instance|Outline)\)\s*$/i, "").match(/Accessory_([A-Za-z0-9]+?)(?:_\d+)?(?:_CLOTH|_ACCESSORY)?$/i);
  if (m) return { key: `acc-${m[1].toLowerCase()}`, label: m[1].replace(/([a-z])([A-Z])/g, "$1 $2") };
  return null;
}

/** Finds the switchable accessories of a loaded model. */
export function findAccessories(scene: THREE.Object3D): Accessory[] {
  const found = new Map<string, Accessory>();
  const seen = new Set<THREE.Material>();
  scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    for (const mat of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      if (seen.has(mat)) continue;
      seen.add(mat);
      const c = classify(mat.name || "");
      if (!c) continue;
      const a = found.get(c.key) ?? { key: c.key, label: c.label, materials: [] };
      a.materials.push(mat);
      found.set(c.key, a);
    }
  });
  return [...found.values()].sort((a, b) => a.label.localeCompare(b.label));
}

export function setAccessoryVisible(a: Accessory, visible: boolean) {
  for (const m of a.materials) m.visible = visible;
}

const storeKey = (model: string) => `dorms.vrm.hidden:${model.replace(/[?#].*$/, "")}`;
export function loadHidden(model: string): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(storeKey(model)) ?? "[]") as string[]); } catch { return new Set(); }
}
export function saveHidden(model: string, hidden: Set<string>) {
  try { localStorage.setItem(storeKey(model), JSON.stringify([...hidden])); } catch { /* storage unavailable */ }
}
