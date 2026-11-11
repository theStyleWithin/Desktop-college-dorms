import * as THREE from "three";
import type { VRM } from "@pixiv/three-vrm";
import { BED, DESK, FLOOR, OBSTACLES } from "./room";
import type { createIdle } from "./idle";

/**
 * NPC behaviour: when nobody is talking to her, the character lives in her room. She wanders, scrolls her phone (and
 * sometimes gets annoyed or amused by what she reads), drinks coffee at the desk, sits on the bed and goes to sleep.
 * No AI is involved: a small planner picks activities (with the time of day nudging the odds), a grid pathfinder walks
 * her around the furniture, and every pose is built by blending a few procedural layers over the idle animation.
 *
 * All positions in this file are in "room units" (metres for a 1.6 m character) and are multiplied by `s` for the world.
 */

type V3 = [number, number, number];
type Idle = ReturnType<typeof createIdle>;
type Mode = "none" | "phone" | "mug" | "wave" | "stretch" | "angry";
const TAU = Math.PI * 2;
const clamp = THREE.MathUtils.clamp;
const approach = (cur: number, target: number, rate: number, dt: number) => cur + (target - cur) * (1 - Math.exp(-rate * dt));
const angDiff = (a: number, b: number) => { let d = (b - a) % TAU; if (d > Math.PI) d -= TAU; if (d < -Math.PI) d += TAU; return d; };
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T,>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];

// ---------------------------------------------------------------- path finding
const CELL = 0.2;
const NX = Math.ceil((FLOOR.x1 - FLOOR.x0) / CELL), NZ = Math.ceil((FLOOR.z1 - FLOOR.z0) / CELL);
const PAD = 0.24; // body radius
const blocked = new Uint8Array(NX * NZ);
const inObstacle = (x: number, z: number, pad: number) => OBSTACLES.some(([x0, z0, x1, z1]) => x > x0 - pad && x < x1 + pad && z > z0 - pad && z < z1 + pad);
for (let i = 0; i < NX; i++) for (let j = 0; j < NZ; j++) {
  const x = FLOOR.x0 + (i + 0.5) * CELL, z = FLOOR.z0 + (j + 0.5) * CELL;
  blocked[i * NZ + j] = x < FLOOR.x0 + 0.25 || x > FLOOR.x1 - 0.25 || z < FLOOR.z0 + 0.25 || z > FLOOR.z1 - 0.1 || inObstacle(x, z, PAD) ? 1 : 0;
}
const cellOf = (x: number, z: number): [number, number] => [clamp(Math.floor((x - FLOOR.x0) / CELL), 0, NX - 1), clamp(Math.floor((z - FLOOR.z0) / CELL), 0, NZ - 1)];
const free = (x: number, z: number) => { const [i, j] = cellOf(x, z); return !blocked[i * NZ + j]; };
const clearLine = (a: [number, number], b: [number, number]) => {
  const n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.08);
  for (let k = 0; k <= n; k++) if (!free(a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n)) return false;
  return true;
};
function nearestFree(x: number, z: number): [number, number] {
  if (free(x, z)) return [x, z];
  const [ci, cj] = cellOf(x, z);
  for (let r = 1; r < 30; r++) for (let di = -r; di <= r; di++) for (let dj = -r; dj <= r; dj++) {
    if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
    const i = ci + di, j = cj + dj;
    if (i < 0 || j < 0 || i >= NX || j >= NZ || blocked[i * NZ + j]) continue;
    return [FLOOR.x0 + (i + 0.5) * CELL, FLOOR.z0 + (j + 0.5) * CELL];
  }
  return [0, 0];
}
export function findPath(from: [number, number], to: [number, number]): [number, number][] {
  const dest = nearestFree(to[0], to[1]);
  const start = nearestFree(from[0], from[1]);
  if (clearLine(start, dest)) return [dest];
  const [si, sj] = cellOf(start[0], start[1]), [ti, tj] = cellOf(dest[0], dest[1]);
  const g = new Float32Array(NX * NZ).fill(Infinity), prev = new Int32Array(NX * NZ).fill(-1), done = new Uint8Array(NX * NZ);
  const open = new Set<number>([si * NZ + sj]);
  g[si * NZ + sj] = 0;
  const h = (i: number, j: number) => Math.hypot(i - ti, j - tj);
  while (open.size) {
    let cur = -1, best = Infinity;
    for (const k of open) { const f = g[k] + h(Math.floor(k / NZ), k % NZ); if (f < best) { best = f; cur = k; } }
    open.delete(cur); done[cur] = 1;
    const ci = Math.floor(cur / NZ), cj = cur % NZ;
    if (ci === ti && cj === tj) break;
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
      if (!di && !dj) continue;
      const i = ci + di, j = cj + dj;
      if (i < 0 || j < 0 || i >= NX || j >= NZ) continue;
      const k = i * NZ + j;
      if (blocked[k] || done[k]) continue;
      if (di && dj && (blocked[(ci + di) * NZ + cj] || blocked[ci * NZ + cj + dj])) continue;
      const ng = g[cur] + Math.hypot(di, dj);
      if (ng < g[k]) { g[k] = ng; prev[k] = cur; open.add(k); }
    }
  }
  const cells: [number, number][] = [];
  for (let k = ti * NZ + tj; k !== -1 && k !== si * NZ + sj; k = prev[k]) cells.push([FLOOR.x0 + (Math.floor(k / NZ) + 0.5) * CELL, FLOOR.z0 + ((k % NZ) + 0.5) * CELL]);
  cells.reverse();
  if (!cells.length) return [dest];
  // string pulling: drop waypoints that are in plain sight
  const out: [number, number][] = [];
  let anchor = start, idx = 0;
  while (idx < cells.length) {
    let far = idx;
    for (let k = cells.length - 1; k > idx; k--) if (clearLine(anchor, cells[k])) { far = k; break; }
    out.push(cells[far]); anchor = cells[far]; idx = far + 1;
  }
  out[out.length - 1] = dest;
  return out;
}

// ---------------------------------------------------------------- speech-bubble emotes
const emoteTex = new Map<string, THREE.CanvasTexture>();
function emoteTexture(text: string, color: string, angry: boolean) {
  const key = text + color + angry;
  let t = emoteTex.get(key);
  if (t) return t;
  const c = document.createElement("canvas");
  c.width = 256; c.height = 128;
  const g = c.getContext("2d")!;
  g.fillStyle = "rgba(255,255,255,0.94)";
  g.strokeStyle = "rgba(40,30,60,0.55)"; g.lineWidth = 5;
  g.beginPath(); g.roundRect(14, 10, 228, 84, 36); g.fill(); g.stroke();
  g.beginPath(); g.moveTo(104, 92); g.lineTo(122, 122); g.lineTo(140, 92); g.closePath(); g.fillStyle = "rgba(255,255,255,0.94)"; g.fill();
  g.fillStyle = color; g.font = "bold 54px system-ui, sans-serif"; g.textAlign = "center"; g.textBaseline = "middle";
  g.fillText(text, 128, 54);
  if (angry) { // the little "anger vein" mark, drawn rather than typed so it never depends on an emoji font
    g.strokeStyle = "#e0334a"; g.lineWidth = 6; g.lineCap = "round";
    for (const [cx, cy, a] of [[206, 28, 0], [206, 28, Math.PI / 2]] as const) {
      for (const sgn of [1, -1]) { g.beginPath(); g.arc(cx + sgn * 8 * Math.cos(a) , cy + sgn * 8 * Math.sin(a), 7, 0, Math.PI); g.stroke(); }
    }
  }
  t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  emoteTex.set(key, t);
  return t;
}

// ---------------------------------------------------------------- the NPC
export type Reaction = "angry" | "laugh" | "sad" | "shock";
export type PlanName = "wander" | "phone" | "phoneBed" | "coffee" | "sit" | "sleep" | "window" | "stretch" | "greet" | "home" | `react-${Reaction}`;
export const PLAN_NAMES: PlanName[] = ["wander", "phone", "phoneBed", "coffee", "sit", "sleep", "window", "stretch", "greet", "home", "react-angry", "react-laugh", "react-sad", "react-shock"];

export function createNpc(opts: { vrm: VRM; idle: Idle; camera: THREE.Camera; scene: THREE.Scene; scale: number }) {
  const { vrm, idle, camera, scene } = opts;
  const s = opts.scale;
  const B = idle.bones;
  const root = vrm.scene;
  const sceneY = idle.state.sceneY;
  const mood = idle.mood;
  // VRM 0.x scenes are turned half a circle by `rotateVRM0` to face +z; keep that when we set the heading
  const baseYaw = vrm.meta?.metaVersion === "0" ? Math.PI : 0;

  root.updateMatrixWorld(true);
  const hipsHw = B.hips ? B.hips.getWorldPosition(new THREE.Vector3()).y - sceneY : 0.9 * s;

  // ---- eyes follow a gaze target we steer (the camera by default)
  const gaze = new THREE.Object3D();
  scene.add(gaze);
  gaze.position.copy(camera.position);
  if (vrm.lookAt) vrm.lookAt.target = gaze;
  const gazeGoal = new THREE.Vector3();
  let gazeMode: "camera" | "hands" | "window" | "ahead" | "bed" = "camera";

  // ---- props
  const propGroup = new THREE.Group();
  scene.add(propGroup);
  const disposables: { dispose(): void }[] = [];
  const mat = (c: string, rough = 0.6) => { const m = new THREE.MeshStandardMaterial({ color: c, roughness: rough }); disposables.push(m); return m; };

  // phone: dark slab with a glowing, scrolling "feed"
  const feed = document.createElement("canvas");
  feed.width = 64; feed.height = 256;
  {
    const g = feed.getContext("2d")!;
    for (let y = 0; y < 256; y += 32) {
      g.fillStyle = `hsl(${(y * 7) % 360} 55% ${35 + ((y / 32) % 3) * 12}%)`; g.fillRect(0, y, 64, 22);
      g.fillStyle = "#e8e8f4"; g.fillRect(4, y + 24, 38 + ((y / 32) % 4) * 6, 4);
    }
  }
  const feedTex = new THREE.CanvasTexture(feed);
  feedTex.wrapS = feedTex.wrapT = THREE.RepeatWrapping; feedTex.colorSpace = THREE.SRGBColorSpace; feedTex.repeat.set(1, 0.5);
  disposables.push(feedTex);
  const phone = new THREE.Group();
  {
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.07 * s, 0.0085 * s, 0.145 * s), mat("#17171f", 0.35));
    const scr = new THREE.Mesh(new THREE.PlaneGeometry(0.063 * s, 0.133 * s), new THREE.MeshBasicMaterial({ map: feedTex }));
    scr.rotation.x = -Math.PI / 2; scr.position.y = 0.0044 * s + 0.0003;   // faces +y; the hand puts the palm side down
    phone.add(body, scr);
    disposables.push(body.geometry, scr.geometry, scr.material as THREE.Material);
  }
  phone.visible = false;
  scene.add(phone);

  // mug: white cup, handle, coffee, and a few wisps of steam
  const mug = new THREE.Group();
  const steam: THREE.Sprite[] = [];
  {
    const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.036 * s, 0.03 * s, 0.085 * s, 18), mat("#f4efe6", 0.4));
    cup.position.y = 0.0425 * s;
    const handle = new THREE.Mesh(new THREE.TorusGeometry(0.02 * s, 0.006 * s, 8, 14), mat("#f4efe6", 0.4));
    handle.position.set(0.04 * s, 0.045 * s, 0);
    const coffee = new THREE.Mesh(new THREE.CircleGeometry(0.031 * s, 18), mat("#3a2316", 0.3));
    coffee.rotation.x = -Math.PI / 2; coffee.position.y = 0.081 * s;
    mug.add(cup, handle, coffee);
    disposables.push(cup.geometry, handle.geometry, coffee.geometry);
    const c = document.createElement("canvas"); c.width = c.height = 32;
    const g = c.getContext("2d")!; const gr = g.createRadialGradient(16, 16, 1, 16, 16, 15);
    gr.addColorStop(0, "rgba(255,255,255,0.7)"); gr.addColorStop(1, "rgba(255,255,255,0)"); g.fillStyle = gr; g.fillRect(0, 0, 32, 32);
    const st = new THREE.CanvasTexture(c); disposables.push(st);
    for (let i = 0; i < 4; i++) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: st, transparent: true, depthWrite: false, opacity: 0 }));
      sp.scale.setScalar(0.05 * s); mug.add(sp); steam.push(sp); disposables.push(sp.material);
    }
  }
  scene.add(mug);
  const mugHome = new THREE.Vector3((DESK.x + 0.55) * s, DESK.top * s, (DESK.z + 0.2) * s);
  mug.position.copy(mugHome);
  let mugHeld = false;
  const attach = (obj: THREE.Object3D, bone: THREE.Object3D | null, pos: V3, rot: V3) => {
    if (!bone) return;
    bone.add(obj);
    obj.position.set(pos[0] * s, pos[1] * s, pos[2] * s);
    obj.rotation.set(...rot);
  };
  const detach = (obj: THREE.Object3D) => { obj.removeFromParent(); scene.add(obj); };
  const holdPhone = (on: boolean) => {
    if (on) { attach(phone, B.rHand, PHONE_OFF.pos, PHONE_OFF.rot); phone.visible = true; }
    else { phone.removeFromParent(); phone.visible = false; }
  };
  const holdMug = (on: boolean) => {
    mugHeld = on;
    if (on) attach(mug, B.rHand, MUG_OFF.pos, MUG_OFF.rot);
    else { detach(mug); mug.position.copy(mugHome); mug.rotation.set(0, 0, 0); }
  };

  // ---- emotes
  const bubbles: { sp: THREE.Sprite; t: number; life: number }[] = [];
  const headW = new THREE.Vector3();
  const emote = (text: string, color = "#3a2d5c", life = 2.4, angry = false) => {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: emoteTexture(text, color, angry), transparent: true, depthTest: false }));
    sp.scale.set(0.3 * s, 0.15 * s, 1); sp.renderOrder = 10;
    scene.add(sp); bubbles.push({ sp, t: 0, life });
  };

  // ---- locomotion state (room units)
  const me = { x: 0, z: 0, yaw: 0 };
  let path: [number, number][] = [];
  let walking = false;
  let walkPhase = 0;
  const SPEED = 0.95;
  // weights that blend the layers in and out
  const W = { walk: 0, sit: 0, lie: 0, none: 0, phone: 0, mug: 0, wave: 0, stretch: 0, angry: 0, look: 1 };
  let armMode: Mode = "none";
  let sitTarget = 0, lieTarget = 0;
  let sip = 0, sipTarget = 0, reach = 0, reachTarget = 0;
  const sitSpot = { x: 3.15, z: -3.12 };
  const lieSpot = { x: 3.4, z: -3.9 };
  let label = "idle";
  let shakeHead = 0, bounce = 0, yawnAmt = 0, pace = 0;
  let sleeping = false;
  let enabled = false; // the viewer turns it on once she is set up

  // ---- plans are generators that yield "wait until" predicates
  type Wait = (dt: number) => boolean;
  function* wait(sec: number): Generator<Wait> { let t = 0; yield (dt) => (t += dt) >= sec; }
  function* walkTo(x: number, z: number, face?: number): Generator<Wait> {
    path = findPath([me.x, me.z], [x, z]);
    yield () => path.length === 0;
    if (face !== undefined) { faceYaw = face; yield () => Math.abs(angDiff(me.yaw, face)) < 0.06; }
    faceYaw = null;
  }
  let faceYaw: number | null = null;
  function* slideTo(x: number, z: number, yaw: number, sec: number): Generator<Wait> {
    // move without walking (scooting onto the bed, sitting down): ease the root to a spot
    const x0 = me.x, z0 = me.z, y0 = me.yaw; let t = 0;
    yield (dt) => {
      t = Math.min(1, t + dt / sec);
      const e = t * t * (3 - 2 * t);
      me.x = x0 + (x - x0) * e; me.z = z0 + (z - z0) * e; me.yaw = y0 + angDiff(y0, yaw) * e;
      return t >= 1;
    };
  }
  const arms = (m: Mode) => { armMode = m; };
  const say = (text: string, color?: string, life?: number, angry?: boolean) => emote(text, color, life, angry);

  const toCamera = () => Math.atan2(camera.position.x - me.x * s, camera.position.z - me.z * s);

  function* scroll(sec: number, reactions: boolean): Generator<Wait> {
    // looking at the phone; sometimes what she reads gets a reaction
    gazeMode = "hands"; arms("phone"); holdPhone(true);
    let left = sec;
    while (left > 0) {
      const chunk = Math.min(left, rand(3, 6)); left -= chunk;
      yield* wait(chunk);
      if (reactions && Math.random() < 0.55) yield* react();
    }
    arms("none"); holdPhone(false); gazeMode = "camera";
  }
  function* react(forced?: Reaction): Generator<Wait> {
    const r = forced ?? pick<Reaction>(["angry", "angry", "laugh", "sad", "shock"]);
    if (r === "angry") {
      say("tch!", "#c2253f", 2.6, true); mood.angry = 0.001; moodGoal.angry = 1; shakeHead = 1; label = "angry";
      arms("angry"); yield* wait(2.8); arms("phone"); moodGoal.angry = 0; shakeHead = 0;
      if (!sleeping && sitTarget === 0 && Math.random() < 0.5) { // stomps off a few steps and back
        holdPhone(false); arms("none"); pace = 1;
        const x = me.x, z = me.z;
        yield* walkTo(x + rand(-0.7, 0.7), z + rand(0.3, 0.8)); yield* wait(0.3); yield* walkTo(x, z); pace = 0;
        holdPhone(true); arms("phone");
      }
    } else if (r === "laugh") {
      say("lol", "#d4691f", 2.4); moodGoal.happy = 1; moodGoal.mouth = 0.55; bounce = 1; label = "laugh";
      yield* wait(2.4); moodGoal.happy = 0.3; moodGoal.mouth = 0; bounce = 0; yield* wait(0.6); moodGoal.happy = 0;
    } else if (r === "sad") {
      say("...", "#4a5fa0", 2.8); moodGoal.sad = 0.9; label = "sad"; yield* wait(3); moodGoal.sad = 0;
    } else {
      say("!?", "#9a3fc0", 2); moodGoal.surprised = 1; label = "shocked"; yield* wait(1.8); moodGoal.surprised = 0;
    }
    label = "phone";
  }
  const moodGoal = { happy: 0, angry: 0, sad: 0, surprised: 0, closed: 0, mouth: 0 };

  function* standUpFromBed(): Generator<Wait> {
    if (lieTarget) { lieTarget = 0; yield* slideTo(sitSpot.x, sitSpot.z, 0, 1.6); }
    if (sitTarget) { sitTarget = 0; yield* wait(0.6); yield* slideTo(sitSpot.x, sitSpot.z + 0.55, 0, 0.9); }
  }
  function* sitOnBed(): Generator<Wait> {
    if (lieTarget) { lieTarget = 0; yield* slideTo(sitSpot.x, sitSpot.z, 0, 1.6); return; }
    if (sitTarget) return;
    yield* walkTo(sitSpot.x, sitSpot.z + 0.55, 0);
    sitTarget = 1; yield* slideTo(sitSpot.x, sitSpot.z, 0, 1.2);
  }

  const plans: Record<PlanName, () => Generator<Wait>> = {
    *wander() {
      label = "wander";
      for (let n = rand(2, 4); n > 0; n--) {
        const [x, z] = [rand(-3.4, 3.2), rand(-2.2, 2.2)];
        yield* walkTo(x, z);
        if (Math.random() < 0.4) { gazeMode = "window"; yield* wait(rand(1.5, 3)); gazeMode = "camera"; }
        yield* wait(rand(1.2, 3.5));
      }
    },
    *phone() {
      label = "phone";
      yield* walkTo(rand(-2.5, 2.5), rand(-1.5, 1.8));
      yield* scroll(rand(10, 22), true);
      yield* wait(1);
    },
    *phoneBed() {
      label = "phone";
      yield* sitOnBed();
      yield* scroll(rand(14, 30), true);
      yield* standUpFromBed();
    },
    *coffee() {
      label = "coffee";
      yield* walkTo(DESK.x + 0.55, DESK.z + 0.78, Math.PI);
      gazeMode = "ahead"; arms("mug"); reachTarget = 1; yield* wait(1.1);
      holdMug(true); yield* wait(0.2); reachTarget = 0;
      // turn round, lean on the desk and enjoy it
      gazeMode = "camera"; faceYaw = toCamera() * 0.6; yield () => Math.abs(angDiff(me.yaw, faceYaw ?? 0)) < 0.08;
      for (let n = 0; n < 3; n++) {
        sipTarget = 1; yield* wait(1.3); moodGoal.happy = 0.5; yield* wait(0.9); moodGoal.happy = 0; sipTarget = 0; yield* wait(rand(1.2, 2.4));
        if (n === 1) gazeMode = "window";
        if (n === 2) gazeMode = "camera";
      }
      say("ahh~", "#9a5a2b", 2.4);
      yield* wait(1.2);
      faceYaw = Math.PI; gazeMode = "ahead"; yield () => Math.abs(angDiff(me.yaw, Math.PI)) < 0.08;
      reachTarget = 1; yield* wait(1.0);
      holdMug(false); yield* wait(0.3); reachTarget = 0; arms("none"); faceYaw = null; gazeMode = "camera"; yield* wait(0.6);
    },
    *sit() {
      label = "sit";
      yield* sitOnBed();
      for (let n = 0; n < 3; n++) { gazeMode = pick(["window", "camera", "ahead"]); yield* wait(rand(3, 6)); }
      gazeMode = "camera";
      yield* standUpFromBed();
    },
    *window() {
      label = "window";
      yield* walkTo(DESK.x + 1.1, DESK.z + 0.8, Math.PI);
      gazeMode = "window"; yield* wait(rand(8, 14)); gazeMode = "camera";
    },
    *sleep() {
      label = "sleep";
      yield* sitOnBed();
      yield* wait(1.2);
      lieTarget = 1; arms("none"); yield* slideTo(lieSpot.x, lieSpot.z, 0, 2.2);
      sleeping = true; moodGoal.closed = 1; gazeMode = "ahead";
      const total = rand(35, 80);
      let t = 0; let zz = 0;
      yield (dt) => { t += dt; zz += dt; if (zz > 3.2) { zz = 0; say("Zzz", "#3d5bb0", 3.2); } return t >= total; };
      sleeping = false; moodGoal.closed = 0;
      label = "wake";
      lieTarget = 0; yield* slideTo(sitSpot.x, sitSpot.z, 0, 1.6);
      yield* wait(0.5); arms("stretch"); yawnAmt = 1; moodGoal.mouth = 0.8; yield* wait(2.6); yawnAmt = 0; moodGoal.mouth = 0; arms("none");
      yield* wait(0.8);
      yield* standUpFromBed();
    },
    *stretch() {
      // a big stretch with a yawn, arms over her head (she is wide open to being tickled)
      label = "stretch"; gazeMode = "ahead";
      yield* wait(0.7); arms("stretch"); yawnAmt = 1; moodGoal.mouth = 0.8; moodGoal.closed = 0.5;
      yield* wait(4.2);
      yawnAmt = 0; moodGoal.mouth = 0; moodGoal.closed = 0; arms("none"); gazeMode = "camera";
      yield* wait(1);
    },
    *greet() {
      label = "greet";
      yield* standUpFromBed();
      moodGoal.closed = 0;
      yield* walkTo(0, 1.1, toCamera());
      arms("wave"); moodGoal.happy = 0.6; yield* wait(2); arms("none"); moodGoal.happy = 0.2;
      label = "attentive";
      yield () => false; // stay put until she's released
    },
    // test/demo plans: take the phone out and have this exact reaction right away
    *"react-angry"() { label = "phone"; yield* walkTo(0.4, 0.4); gazeMode = "hands"; arms("phone"); holdPhone(true); yield* wait(1); yield* react("angry"); yield* wait(1); arms("none"); holdPhone(false); },
    *"react-laugh"() { label = "phone"; yield* walkTo(0.4, 0.4); gazeMode = "hands"; arms("phone"); holdPhone(true); yield* wait(1); yield* react("laugh"); yield* wait(1); arms("none"); holdPhone(false); },
    *"react-sad"() { label = "phone"; yield* walkTo(0.4, 0.4); gazeMode = "hands"; arms("phone"); holdPhone(true); yield* wait(1); yield* react("sad"); yield* wait(1); arms("none"); holdPhone(false); },
    *"react-shock"() { label = "phone"; yield* walkTo(0.4, 0.4); gazeMode = "hands"; arms("phone"); holdPhone(true); yield* wait(1); yield* react("shock"); yield* wait(1); arms("none"); holdPhone(false); },
    *home() {
      label = "idle";
      yield* standUpFromBed(); arms("none"); holdPhone(false); if (mugHeld) holdMug(false);
      yield* walkTo(0, 0, toCamera());
      yield () => false;
    },
  };

  const hour = () => new Date().getHours();
  function nextPlan(): PlanName {
    const night = hour() >= 23 || hour() < 6, late = hour() >= 21 || hour() < 8;
    const table: [PlanName, number][] = [
      ["wander", 22], ["phone", 14], ["phoneBed", late ? 24 : 14], ["coffee", night ? 4 : 16],
      ["sit", 10], ["window", 10], ["stretch", 8], ["sleep", night ? 46 : late ? 10 : 4],
    ];
    const total = table.reduce((a, [, w]) => a + w, 0);
    let r = Math.random() * total;
    for (const [n, w] of table) { if ((r -= w) <= 0) return n; }
    return "wander";
  }

  let current: PlanName = "home";
  let gen: Generator<Wait> = plans.home();
  let waiting: Wait | null = null;
  let paused = 0;
  let attentive = false;
  let clock = 0;

  const resetTransient = () => {
    path = []; faceYaw = null; arms("none"); sipTarget = 0; reachTarget = 0; shakeHead = 0; bounce = 0; pace = 0; yawnAmt = 0;
    Object.keys(moodGoal).forEach((k) => ((moodGoal as Record<string, number>)[k] = 0));
    if (mugHeld) holdMug(false);
    holdPhone(false); gazeMode = "camera"; sleeping = false;
  };
  function start(name: PlanName) {
    // sitting/lying carry over, the plans that need them handle standing up themselves
    const keepSit = sitTarget, keepLie = lieTarget;
    resetTransient();
    sitTarget = keepSit; lieTarget = keepLie;
    current = name;
    // activities that happen on her feet start by getting up, if she was sitting or lying down
    const onBed = name === "sit" || name === "sleep" || name === "phoneBed";
    gen = (function* () { if (!onBed) yield* standUpFromBed(); yield* plans[name](); })();
    waiting = null;
  }
  const settle = (): PlanName => (sitTarget || lieTarget ? "home" : nextPlan());

  function runPlan(dt: number) {
    for (let guard = 0; guard < 8; guard++) {
      if (waiting && !waiting(dt)) return;
      dt = 0;
      const r = gen.next();
      if (r.done) {
        // a short rest between activities, then something else
        let rest = rand(1.2, 3.5);
        label = "idle";
        const nxt = settle();
        current = nxt; gen = (function* () { if (!(nxt === "sit" || nxt === "sleep" || nxt === "phoneBed")) yield* standUpFromBed(); yield* plans[nxt](); })();
        waiting = (d) => (rest -= d) <= 0;
        continue;
      }
      waiting = r.value;
    }
  }

  // ---- layers
  const names = ["hips", "spine", "chest", "upperChest", "neck", "head", "lShoulder", "rShoulder", "lArm", "rArm", "lFore", "rFore", "lHand", "rHand", "lLeg", "rLeg", "lShin", "rShin", "lFoot", "rFoot"] as const;
  type N = (typeof names)[number];
  const D = {} as Record<N, V3>;
  const mix = (n: N, t: Partial<Record<0 | 1 | 2, number>>, w: number) => {
    const d = D[n];
    for (const k of [0, 1, 2] as const) if (t[k] !== undefined) d[k] = d[k] + (t[k]! - d[k]) * w;
  };
  const q = new THREE.Quaternion(), qLie = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0)).premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2));
  const qYaw = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
  const qLieBase = qLie.clone().multiply(new THREE.Quaternion().setFromAxisAngle(up, baseYaw));

  const dbg = (window as unknown as { __pose?: Partial<Record<N, V3>> });

  const apply = (t: number, dt: number) => {
    dt = Math.min(dt, 0.05);
    if (enabled) { clock += dt; }
    for (const n of names) D[n] = idle.read(B[n as keyof typeof B] as THREE.Object3D | null);

    // --- decide: pause while she is being petted, hold still while someone is talking
    // (the viewer calls setPetting / setAttentive; planning only advances when she's free)
    if (paused <= 0) runPlan(dt);

    // --- locomotion
    let moving = false;
    if (path.length && paused <= 0) {
      const [tx, tz] = path[0];
      const dx = tx - me.x, dz = tz - me.z, dist = Math.hypot(dx, dz);
      if (dist < 0.06) path.shift();
      else {
        const want = Math.atan2(dx, dz);
        const err = Math.abs(angDiff(me.yaw, want));
        me.yaw += clamp(angDiff(me.yaw, want), -7 * dt, 7 * dt);
        const sp = SPEED * (pace ? 1.5 : 1) * clamp(1.15 - err / 1.1, 0.12, 1);
        me.x += (dx / dist) * Math.min(dist, sp * dt); me.z += (dz / dist) * Math.min(dist, sp * dt);
        walkPhase += dt * Math.PI * (sp / 0.62);
        moving = err < 1.2;
      }
    } else if (faceYaw !== null && paused <= 0) {
      const dy = angDiff(me.yaw, faceYaw);
      me.yaw += clamp(dy, -5 * dt, 5 * dt);
    }
    walking = moving;
    const wr = (k: keyof typeof W, target: number, rate = 5) => { W[k] = approach(W[k], target, rate, dt); };
    wr("walk", moving ? 1 : 0, 7);
    wr("sit", sitTarget, 4); wr("lie", lieTarget, 3);
    for (const m of ["phone", "mug", "wave", "stretch", "angry"] as const) wr(m, armMode === m ? 1 : 0, 6);
    sip = approach(sip, sipTarget, 4, dt); reach = approach(reach, reachTarget, 4, dt);
    for (const k of Object.keys(moodGoal) as (keyof typeof moodGoal)[]) {
      mood[k] = approach(mood[k], moodGoal[k], 5, dt);
    }

    // --- walk layer
    const sw = Math.sin(walkPhase), cw = Math.cos(walkPhase), ww = W.walk * (1 - W.sit) * (1 - W.lie);
    mix("lLeg", { 0: -0.5 * sw }, ww); mix("rLeg", { 0: 0.5 * sw }, ww);
    mix("lShin", { 0: 0.12 + 0.85 * Math.max(0, cw) }, ww); mix("rShin", { 0: 0.12 + 0.85 * Math.max(0, -cw) }, ww);
    mix("lFoot", { 0: 0.15 * sw }, ww); mix("rFoot", { 0: -0.15 * sw }, ww);
    const busyR = Math.min(1, W.phone + W.mug + W.wave + W.stretch + W.angry), busyL = Math.min(1, W.stretch + W.angry);
    mix("lArm", { 0: 0.06 + 0.38 * sw }, ww * (1 - busyL)); mix("rArm", { 0: 0.06 - 0.38 * sw }, ww * (1 - busyR));
    mix("hips", { 1: 0.09 * sw }, ww); mix("spine", { 1: -0.07 * sw }, ww);

    // --- sit layer: thighs forward, knees bent, a little slouch; feet swing gently
    const ws = W.sit * (1 - W.lie);
    const kick = Math.sin(t * 1.7) * 0.18 * W.sit;
    mix("lLeg", { 0: -1.5, 2: -0.1 }, ws); mix("rLeg", { 0: -1.5, 2: 0.1 }, ws);
    mix("lShin", { 0: 1.5 + kick }, ws); mix("rShin", { 0: 1.5 - kick }, ws);
    mix("spine", { 0: 0.05 }, ws); mix("lFoot", { 0: 0.1 }, ws); mix("rFoot", { 0: 0.1 }, ws);

    // --- lie layer: arms by the sides, legs straight, head turned slightly
    mix("lLeg", { 0: 0, 2: -0.06 }, W.lie); mix("rLeg", { 0: 0, 2: 0.06 }, W.lie);
    mix("lShin", { 0: 0.02 }, W.lie); mix("rShin", { 0: 0.02 }, W.lie);
    mix("lArm", { 0: 0.02, 2: -1.3 }, W.lie); mix("rArm", { 0: 0.02, 2: 1.3 }, W.lie);
    mix("head", { 1: 0.18, 2: 0.08 }, W.lie);

    // --- arm tasks
    const R = (a: V3, f: V3, h: V3, w: number) => { mix("rArm", { 0: a[0], 1: a[1], 2: a[2] }, w); mix("rFore", { 0: f[0], 1: f[1], 2: f[2] }, w); mix("rHand", { 0: h[0], 1: h[1], 2: h[2] }, w); };
    const L = (a: V3, f: V3, h: V3, w: number) => { mix("lArm", { 0: a[0], 1: a[1], 2: a[2] }, w); mix("lFore", { 0: f[0], 1: f[1], 2: f[2] }, w); mix("lHand", { 0: h[0], 1: h[1], 2: h[2] }, w); };
    const tap = Math.sin(t * 5.2) * 0.05;
    R(POSE.phoneR.arm, [POSE.phoneR.fore[0], POSE.phoneR.fore[1] + tap * 0.4, POSE.phoneR.fore[2]], POSE.phoneR.hand, W.phone);
        const lv = (x: V3, y: V3, k: number): V3 => [lerpA(x[0], y[0], k), lerpA(x[1], y[1], k), lerpA(x[2], y[2], k)];
    const mugBaseArm = mugHeld ? lv(POSE.mugHold.arm, POSE.mugSip.arm, sip) : POSE.mugHold.arm;
    const mugBaseFore = mugHeld ? lv(POSE.mugHold.fore, POSE.mugSip.fore, sip) : POSE.mugHold.fore;
    R(lv(mugBaseArm, POSE.mugReach.arm, reach), lv(mugBaseFore, POSE.mugReach.fore, reach), POSE.mugSip.hand, W.mug);
    R(POSE.wave.arm, [POSE.wave.fore[0], POSE.wave.fore[1] + Math.sin(t * 9) * 0.35, POSE.wave.fore[2]], POSE.wave.hand, W.wave);
    L(POSE.stretchL.arm, POSE.stretchL.fore, POSE.stretchL.hand, W.stretch);
    R(POSE.stretchR.arm, POSE.stretchR.fore, POSE.stretchR.hand, W.stretch);
    mix("spine", { 0: -0.12 }, W.stretch * yawnAmt); mix("head", { 0: -0.3 }, W.stretch * yawnAmt);
    R(POSE.fistR.arm, POSE.fistR.fore, POSE.fistR.hand, W.angry);
    L(POSE.fistL.arm, POSE.fistL.fore, POSE.fistL.hand, W.angry);
    mix("lShoulder", { 2: -0.2 }, W.angry); mix("rShoulder", { 2: 0.2 }, W.angry);

    // --- head & gaze
    switch (gazeMode) {
      case "hands": if (B.rHand) B.rHand.getWorldPosition(gazeGoal); mix("head", { 0: 0.42 }, W.phone); mix("neck", { 0: 0.18 }, W.phone); break;
      case "window": gazeGoal.set(-1.6 * s, 1.9 * s, -4.4 * s); break;
      case "ahead": gazeGoal.set(me.x * s + Math.sin(me.yaw) * 2, 1.4 * s, me.z * s + Math.cos(me.yaw) * 2); break;
      default: gazeGoal.copy(camera.position);
    }
    gaze.position.lerp(gazeGoal, 1 - Math.exp(-6 * dt));
    if (gazeMode === "window" || gazeMode === "ahead") { mix("head", { 0: gazeMode === "window" ? -0.12 : 0.0 }, 0.8); }
    if (shakeHead) { mix("head", { 1: Math.sin(t * 13) * 0.22 }, shakeHead * 0.8); mix("head", { 0: 0.15 }, shakeHead * 0.5); }
    if (bounce) { mix("chest", { 0: 0.02 + Math.sin(t * 17) * 0.05 }, bounce); mix("hips", { 0: Math.sin(t * 17) * 0.02 }, bounce); }

    // --- debug overrides (dev harness only)
    if (dbg.__pose) for (const n of names) { const v = dbg.__pose[n]; if (v) D[n] = v; }

    for (const n of names) { const b = B[n as keyof typeof B] as THREE.Object3D | null; if (b) idle.set(b, ...D[n]); }

    // --- the root: position, heading, sitting/lying height
    const standY = sceneY + idle.state.hopY;
    const sitY = (BED.top + 0.09) * s - hipsHw + sceneY;
    const lieY = (BED.top + 0.1) * s + sceneY;
    let y = standY + (sitY - standY) * W.sit;
    if (moving) y += Math.abs(Math.sin(walkPhase)) * 0.018 * s * ww;
    y = y + (lieY - y) * W.lie;
    qYaw.setFromAxisAngle(up, me.yaw + baseYaw);
    q.copy(qYaw).slerp(qLieBase, W.lie);
    root.quaternion.copy(q);
    // the lying body is rotated about the feet, so shift the root so the hips land on the mattress
    root.position.set(me.x * s + hipsHw * W.lie, y, me.z * s);
    root.updateMatrixWorld(true);

    // --- props follow
    feedTex.offset.y = (feedTex.offset.y + dt * 0.45) % 1;
    if (!mugHeld) mug.position.copy(mugHome);
    steam.forEach((sp, i) => {
      const k = ((t * 0.5 + i / steam.length) % 1);
      sp.position.set(Math.sin(t * 2 + i * 2) * 0.01 * s, (0.1 + k * 0.1) * s, 0);
      (sp.material as THREE.SpriteMaterial).opacity = (1 - k) * 0.5;
    });
    if (B.head) B.head.getWorldPosition(headW);
    for (let i = bubbles.length - 1; i >= 0; i--) {
      const b = bubbles[i]; b.t += dt;
      const f = b.t / b.life;
      b.sp.position.set(headW.x, headW.y + (0.26 + 0.03 * Math.sin(b.t * 3) + 0.04 * f) * s, headW.z);
      (b.sp.material as THREE.SpriteMaterial).opacity = f < 0.1 ? f * 10 : f > 0.75 ? Math.max(0, (1 - f) * 4) : 1;
      if (f >= 1) { b.sp.removeFromParent(); (b.sp.material as THREE.Material).dispose(); bubbles.splice(i, 1); }
    }
  };

  const lerpA = (a: number, b: number, k: number) => a + (b - a) * k;

  return {
    apply,
    get label() { return label; },
    get plan() { return current; },
    get walking() { return walking; },
    get sleeping() { return W.lie > 0.6; },
    get sleepAmount() { return W.lie; },
    /** Where she is, in world units (the camera follows this). */
    position: (out: THREE.Vector3) => out.set(me.x * s, 0, me.z * s),
    /** Make her do something right now (also used by tests). */
    force(name: PlanName) { start(name); },
    set enabled(v: boolean) {
      if (v === enabled) return; enabled = v;
      if (!v) { start("home"); return; }
      start(sitTarget || lieTarget ? "home" : nextPlan());
      let settle = 2.5; waiting = (d) => (settle -= d) <= 0;   // she takes a moment to settle in before doing anything
    },
    get enabled() { return enabled; },
    /** Someone is talking to her: stop whatever she's doing and pay attention. */
    setAttentive(v: boolean) {
      if (v === attentive) return; attentive = v;
      if (v) start("greet"); else { start("home"); gen = (function* () { yield* wait(5); yield* plans.home(); })(); }
    },
    /** Being carried in someone's hand: no planning or walking, standing posture (the carry module places her). */
    carry(v: boolean) {
      if (v) { sitTarget = 0; lieTarget = 0; sleeping = false; start("home"); paused = 1e9; }
      else { paused = 0; start("home"); }
    },
    /** Put her somewhere (world units); used when she is set down. */
    teleport(x: number, z: number) { me.x = x / s; me.z = z / s; path = []; },
    get yaw() { return me.yaw; },
    /** Arms up in a big stretch (and a yawn): the worst moment to be tickled. */
    get stretching() { return W.stretch > 0.4; },
    /** Drop whatever she is doing and stand there (a stretch ends at once). */
    interrupt() { start("home"); },
    /** She just said something short (an emote bubble above her head). */
    say,
    /** She was poked: stop for a moment, and wake her if she was asleep. Returns whether she was asleep. */
    disturb(): boolean {
      paused = Math.max(paused, 1.6);
      if (W.lie > 0.5 && sleeping) { sleeping = false; moodGoal.closed = 0; start("home"); return true; }
      return false;
    },
    /** While her head is being petted she stays where she is (and wakes up, if asleep). */
    setPetting(amount: number, dt: number) {
      if (amount > 0.12) { paused = 0.8; if (W.lie > 0.5 && sleeping) { sleeping = false; moodGoal.closed = 0; start("home"); } }
      else if (paused > 0) paused -= dt;
    },
    dispose() {
      propGroup.removeFromParent(); phone.removeFromParent(); mug.removeFromParent(); gaze.removeFromParent();
      bubbles.forEach((b) => { b.sp.removeFromParent(); (b.sp.material as THREE.Material).dispose(); });
      disposables.forEach((d) => d.dispose());
      if (vrm.lookAt) vrm.lookAt.target = camera as THREE.Object3D;
    },
  };
}

// ---------------------------------------------------------------- tuned poses (x, y, z Euler per bone, VRM 1.0 axes)
// These were tuned by eye on VRoid models; `idle.set` mirrors them for VRM 0.x. The phone and mug offsets are in the
// hand bone's local frame (palm faces -y, fingers point away from the body along -x for the right hand).
const PHONE_OFF = { pos: [-0.035, -0.03, 0.02] as V3, rot: [0, 0.3, 0] as V3 };
const MUG_OFF = { pos: [-0.04, -0.02, 0.0] as V3, rot: [0, 0, 0] as V3 };
const POSE = {
  phoneR: { arm: [-0.15, 0.6, 0.95] as V3, fore: [0, 2.15, 0] as V3, hand: [0, 0, 0] as V3 },
  phoneL: { arm: [0.1, -0.5, -1.0] as V3, fore: [0, -1.7, 0] as V3, hand: [0, 0, 0] as V3 },
  mugHold: { arm: [0.2, 0.5, 0.95] as V3, fore: [0, 0.9, 0] as V3, hand: [0, 0, 0] as V3 },
  mugReach: { arm: [0, 1.1, 0.6] as V3, fore: [0, 0.45, 0] as V3, hand: [0, 0, 0] as V3 },
  mugSip: { arm: [-0.3, 0.55, 1.0] as V3, fore: [0, 2.7, 0] as V3, hand: [0, 0, 0] as V3 },
  wave: { arm: [0, 0.15, -0.9] as V3, fore: [0, 1.2, 0] as V3, hand: [0, 0, 0] as V3 },
  stretchL: { arm: [0, 0, 1.5] as V3, fore: [0, -0.2, 0] as V3, hand: [0, 0, 0] as V3 },
  stretchR: { arm: [0, 0, -1.5] as V3, fore: [0, 0.2, 0] as V3, hand: [0, 0, 0] as V3 },
  fistR: { arm: [0.1, 0.35, 0.85] as V3, fore: [0, 1.6, 0] as V3, hand: [0, 0, 0] as V3 },
  fistL: { arm: [0.1, -0.35, -0.85] as V3, fore: [0, -1.6, 0] as V3, hand: [0, 0, 0] as V3 },
};
