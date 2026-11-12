import * as THREE from "three";
import { getBindings } from "./gamepad";

/**
 * Virtual hands: the user's own hands, placed in the 3D room so they can reach out and pet the character.
 * Controls:
 *  - gamepad: sticks move the hands (relative to the camera), triggers push forward, bumpers pull back, A grips
 *  - mouse / touch: the pointer moves the right hand, pressing and holding reaches in to touch
 * Touching the head, ears or hair counts as petting; `state` reports how hard, for the character to react to.
 *
 * Pointing: switch a hand to its pointing gesture (button Y, the 👆 button, or the P key) and it becomes a single extended
 * finger. The mouse follows her body (the fingertip rests on whatever you aim at), and a click, tap, A (right hand) or X (left
 * hand) jabs the finger forward: that is a poke, reported through `onPoke` with where the fingertip is and which way it points.
 * Press and HOLD (about a third of a second) instead and the fingers spread and wiggle: that is tickling, reported every frame
 * through `onTickle` while the fingertip is held there.
 *
 * Pinching: the third gesture (👌): thumb and first finger pinch. Hover over her, press and hold (A or X on a controller)
 * to pinch her up by the scruff; while the pinch is held she hangs from the fingertips (`onGrab` says whether she let herself be
 * picked up, `onCarry` reports where the fingertips are every frame, `onDrop` when you let go). The scroll wheel pushes the
 * hand deeper into or out of the room while you carry her.
 */
export interface PetState {
  /** 0..1, how much the character is being petted right now (smoothed) */
  amount: number;
  /** hand position relative to the head, in camera space (x right, y up), roughly -1..1 */
  lx: number;
  ly: number;
  /** how fast the hand is moving across the head, 0..1 */
  stroke: number;
  /** raw closeness of the nearest hand to the head, 0 (out of reach) .. 1 (inside it) */
  near: number;
}

export function createHands(opts: {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  dom: HTMLElement;
  /** world position of the middle of the head (updated every frame by the caller) */
  head: THREE.Vector3;
  /** room/character scale (character height / 1.6) */
  scale: number;
  /** Where a ray from the camera meets her body (for the fingertip to rest on it while pointing with the mouse). */
  pick?: (origin: THREE.Vector3, dir: THREE.Vector3, max: number) => { point: THREE.Vector3 } | null;
  /** The finger jabbed: where the fingertip is, and the direction it points. */
  onPoke?: (origin: THREE.Vector3, dir: THREE.Vector3, hand: "left" | "right") => void;
  /** Fingers tickling right now (every frame): where the fingertip is, where it points, and how vigorously it is moving (0..1). */
  onTickle?: (origin: THREE.Vector3, dir: THREE.Vector3, hand: "left" | "right", strength: number) => void;
  /** The pinch closed on her: may she be picked up? `tip` is where the fingertips are. Return true to start carrying. */
  onGrab?: (origin: THREE.Vector3, dir: THREE.Vector3, tip: THREE.Vector3) => boolean;
  /** Every frame while carrying: where the fingertips are. */
  onCarry?: (tip: THREE.Vector3) => void;
  /** The pinch opened: put her down. */
  onDrop?: () => void;
  /** A controller button changed what the hands do. */
  onTool?: (tool: "pet" | "point" | "pinch" | "tickle") => void;
}) {
  const { scene, camera, dom, head } = opts;
  const s = opts.scale;
  const skin = new THREE.MeshStandardMaterial({ color: 0xf0c4a8, roughness: 0.6, metalness: 0, emissive: 0xa87258 });

  // ---- a simple, soft hand: palm + 4 fingers (2 joints) + thumb, built as a rig so fingers can curl ----
  type Rig = { root: THREE.Group; fingers: THREE.Object3D[][]; thumb: THREE.Object3D[] };
  const capsule = (r: number, len: number) => {
    const g = new THREE.CapsuleGeometry(r, len, 4, 10);
    g.rotateX(Math.PI / 2); // along z, so "forward" is -z
    const m = new THREE.Mesh(g, skin);
    m.castShadow = true;
    return m;
  };
  const makeHand = (left: boolean): Rig => {
    const root = new THREE.Group();
    const flip = left ? -1 : 1;
    const palm = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), skin);
    palm.scale.set(0.046 * s, 0.014 * s, 0.05 * s);
    palm.castShadow = true;
    root.add(palm);
    const fingers: THREE.Object3D[][] = [];
    const lens = [0.034, 0.04, 0.037, 0.028];
    for (let i = 0; i < 4; i++) {
      const base = new THREE.Group();
      base.position.set((-0.03 + i * 0.02) * s * flip * -1, 0, -0.045 * s);
      const a = capsule(0.0075 * s, lens[i] * s);
      a.position.z = -lens[i] * s * 0.5 - 0.004 * s;
      base.add(a);
      const tip = new THREE.Group();
      tip.position.z = -(lens[i] + 0.012) * s;
      const b = capsule(0.0068 * s, lens[i] * 0.7 * s);
      b.position.z = -lens[i] * 0.35 * s;
      tip.add(b);
      base.add(tip);
      root.add(base);
      fingers.push([base, tip]);
    }
    const tBase = new THREE.Group();
    tBase.position.set(0.04 * s * flip, 0, -0.01 * s);
    tBase.rotation.y = 0.7 * flip;
    const ta = capsule(0.0085 * s, 0.03 * s); ta.position.z = -0.02 * s; tBase.add(ta);
    const tTip = new THREE.Group(); tTip.position.z = -0.04 * s;
    const tb = capsule(0.0075 * s, 0.022 * s); tb.position.z = -0.014 * s; tTip.add(tb);
    tBase.add(tTip);
    root.add(tBase);
    return { root, fingers, thumb: [tBase, tTip] };
  };
  const L = makeHand(true);
  const R = makeHand(false);
  const group = new THREE.Group();
  group.visible = false;
  group.add(L.root, R.root);
  scene.add(group);

  type H = { rig: Rig; pos: THREE.Vector3; vel: THREE.Vector3; grip: number; touch: number; prev: THREE.Vector3; jab: number; fired: boolean; aim: THREE.Vector3; tipGoal: THREE.Vector3 | null; point: number; tick: number; ticklish: boolean; pinch: number; pinchGoal: number; grabTried: boolean };
  const mk = (rig: Rig, x: number): H => ({ rig, pos: new THREE.Vector3(x * s, 1.38 * s, 0.75 * s), vel: new THREE.Vector3(), grip: 0, touch: 0, prev: new THREE.Vector3(), jab: -1, fired: false, aim: new THREE.Vector3(0, 0, -1), tipGoal: null, point: 0, tick: 0, ticklish: false, pinch: 0, pinchGoal: 0, grabTried: false });
  const hl = mk(L, -0.34), hr = mk(R, 0.34);
  const lo = new THREE.Vector3(-1.3 * s, 0.15 * s, -0.25 * s), hi = new THREE.Vector3(1.3 * s, 2.1 * s, 1.7 * s);
  /** the hands may roam a box around this point (the viewer keeps it on the character, who may be walking about) */
  const center = new THREE.Vector3();
  const clampNear = (v: THREE.Vector3) => { v.sub(center).clamp(lo, hi).add(center); };

  // ---- input ----
  let enabled = false;
  let handScale = 1;
  let pointing = false;                // pointing fingers for poking (and tickling)
  let tickleOnly = false;              // the tickle gesture: the pointing fingers tickle at once when pressed, no poking
  type Tool = "pet" | "point" | "pinch" | "tickle";
  const TOOLS: Tool[] = ["pet", "point", "pinch", "tickle"];
  const curTool = (): Tool => (pinching ? "pinch" : pointing ? (tickleOnly ? "tickle" : "point") : "pet");
  const setTool = (t: Tool) => { pointing = t === "point" || t === "tickle"; tickleOnly = t === "tickle"; pinching = t === "pinch"; };
  const nextTool = (d: number) => TOOLS[(TOOLS.indexOf(curTool()) + d + TOOLS.length) % TOOLS.length];
  let pinching = false;                // thumb and finger pinch, for picking her up
  const hold: { hand: H | null; depth: number } = { hand: null, depth: 3 };
  const ptr = { x: 0, y: 0, down: false, active: false, buttons: 0 };
  const rect = () => dom.getBoundingClientRect();
  const onMove = (e: PointerEvent) => { ptr.buttons = e.buttons; const r = rect(); ptr.x = ((e.clientX - r.left) / r.width) * 2 - 1; ptr.y = -(((e.clientY - r.top) / r.height) * 2 - 1); ptr.active = true; };
  const startJab = (h: H) => { if (h.jab < 0) h.jab = 0; };
  const HOLD = 320;                    // ms: a press shorter than this is a poke (on release), longer is tickling
  let downAt = 0;
  let chordSaved: { pointing: boolean; pinching: boolean } | null = null;
  let shiftHeld = false, rightDown = false, mouseHand: "left" | "right" = "right", downHand: H | null = null;
  // left + right button together is a pinch (for lifting her), whatever the hands were doing; the right hand does it
  const chord = () => (ptr.buttons & 3) === 3;
  const leftWanted = () => shiftHeld || (rightDown && !chord());
  const onDown = (e: PointerEvent) => {
    if (!enabled) return;
    // the other mouse buttons change gesture: middle or forward = the next one, back = the previous one
    if (e.button === 1 || e.button === 3 || e.button === 4) { e.preventDefault(); setTool(nextTool(e.button === 3 ? -1 : 1)); opts.onTool?.(curTool()); return; }
    onMove(e); if (e.button === 2) rightDown = true; ptr.down = true; downAt = performance.now(); downHand = hold.hand ?? (leftWanted() ? hl : hr); dom.setPointerCapture?.(e.pointerId); };
  const onUp = () => { ptr.down = false; rightDown = false; ptr.buttons = 0; };
  const onKey = (e: KeyboardEvent) => { if (e.key === "Shift") shiftHeld = e.type === "keydown"; };
  const onMenu = (e: Event) => { if (enabled) e.preventDefault(); };
  window.addEventListener("keydown", onKey); window.addEventListener("keyup", onKey); dom.addEventListener("contextmenu", onMenu);
  const onWheel = (e: WheelEvent) => { if (!hold.hand) return; e.preventDefault(); hold.depth = Math.min(9 * s, Math.max(1.2 * s, hold.depth * (e.deltaY < 0 ? 0.93 : 1.07))); };
  const onRelease = (e: PointerEvent) => { if (enabled && pointing && ptr.down && (e.button === 0 || e.button === 2) && !tickleOnly && performance.now() - downAt < HOLD) startJab(downHand ?? hr); onUp(); };
  dom.addEventListener("pointermove", onMove);
  dom.addEventListener("pointerdown", onDown);
  dom.addEventListener("pointerup", onRelease);
  dom.addEventListener("wheel", onWheel, { passive: false });
  dom.addEventListener("pointercancel", onUp);

  const pad = () => { const g = navigator.getGamepads?.() ?? []; for (const p of g) if (p && p.connected) return p; return null; };
  const dz = (v: number) => (Math.abs(v) < 0.14 ? 0 : (v - Math.sign(v) * 0.14) / 0.86);

  const fwd = new THREE.Vector3(), right = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  const ray = new THREE.Raycaster();
  const plane = new THREE.Plane();
  const hit = new THREE.Vector3();
  const tmp = new THREE.Vector3();

  const pet: PetState = { amount: 0, lx: 0, ly: 0, stroke: 0, near: 0 };
  const padPrev: number[] = [];   // (keyed by action name)
  const padHold: (number | null)[] = [null, null];
  const bdown = (p: Gamepad, i: number) => (p.buttons[i]?.value ?? 0) > 0.5;
  const anyDown = (p: Gamepad, l: number[]) => l.some((i) => bdown(p, i));
  /** true once when any of these buttons goes down */
  const edgeOf = (p: Gamepad, key: string, l: number[]) => { const v = anyDown(p, l) ? 1 : 0; const was = padPrev[key as unknown as number] ?? 0; padPrev[key as unknown as number] = v; return !!v && !was; };
  const lookM = new THREE.Matrix4(), zero = new THREE.Vector3(), vis = new THREE.Vector3(), camRight = new THREE.Vector3(), camUp = new THREE.Vector3();
  const tipW = new THREE.Vector3(), tipL = new THREE.Vector3(0, 0, -0.03 * s), qa = new THREE.Quaternion();
  const JAB = 0.32;                  // seconds for a jab out and back; the poke lands at the far end of the stab
  let rumbleAt = 0;
  let padActive = false;

  const reach = (h: H, dt: number, dx: number, dy: number, push: number, grip: number) => {
    camera.getWorldDirection(fwd); fwd.y = 0; if (fwd.lengthSq() < 1e-4) fwd.set(0, 0, -1); fwd.normalize();
    right.crossVectors(fwd, up).normalize();
    const sp = 0.95 * s;
    h.pos.addScaledVector(right, dx * sp * dt).addScaledVector(up, dy * sp * dt).addScaledVector(fwd, push * sp * dt);
    clampNear(h.pos);
    h.grip += (grip - h.grip) * Math.min(1, dt * 12);
  };

  const update = (dt: number) => {
    group.visible = enabled;
    if (!enabled) { pet.amount += (0 - pet.amount) * Math.min(1, dt * 6); return; }
    dt = Math.min(dt, 0.05);
    const p = pad();
    padActive = !!p;
    hl.prev.copy(hl.pos); hr.prev.copy(hr.pos);
    if (p) {
      const b = (i: number) => p.buttons[i]?.value ?? 0;
      const a = (i: number) => dz(p.axes[i] ?? 0);
      // the buttons come from the person's own bindings (any controller: the layout is by position, see gamepad.ts)
      const bind = getBindings();
      const before = curTool();
      if (edgeOf(p, "cycle", bind.cycle)) setTool(nextTool(1));
      if (edgeOf(p, "pet", bind.pet)) setTool("pet");
      if (edgeOf(p, "point", bind.point)) setTool("point");
      if (edgeOf(p, "pinch", bind.pinch)) setTool("pinch");
      if (edgeOf(p, "tickle", bind.tickle)) setTool("tickle");
      const after = curTool();
      if (after !== before) opts.onTool?.(after);
      // the action buttons: a tap pokes, holding tickles (or pinches)
      const nowMs = performance.now();
      for (const [list, h, k] of [[bind.right, hr, 0], [bind.left, hl, 1]] as const) {
        const down = anyDown(p, list);
        if (pinching) { h.pinchGoal = down ? 1 : 0; continue; }
        if (!pointing) { padHold[k] = null; h.ticklish = false; h.pinchGoal = 0; continue; }
        if (tickleOnly) { h.ticklish = down; padHold[k] = null; continue; }
        if (down && padHold[k] === null) padHold[k] = nowMs;
        if (!down && padHold[k] !== null) { if (nowMs - padHold[k]! < HOLD) startJab(h); padHold[k] = null; }
        h.ticklish = down && padHold[k] !== null && nowMs - padHold[k]! >= HOLD;
      }
      const grip = pointing || pinching ? 0 : Math.max(0, ...bind.right.map((i) => b(i)));
      reach(hl, dt, a(0), -a(1), b(6) - b(4), grip);
      reach(hr, dt, a(2), -a(3), b(7) - b(5), grip);
    }
    // where the fingers point: along the camera, unless the mouse is aiming at her body
    camera.getWorldDirection(fwd);
    hl.aim.copy(fwd); hr.aim.copy(fwd); hl.tipGoal = null; hr.tipGoal = null;
    // the mouse IS a hand: the right hand by default, the left while Shift or the right button is held (and whichever one is carrying her)
    // the chord: both mouse buttons at once pinch her, then lift; letting go of either puts the previous gesture back
    const chordNow = !p && enabled && ptr.active && ptr.down && chord();
    if (chordNow && !chordSaved) { chordSaved = { pointing, pinching }; pointing = false; pinching = true; }
    else if (!chordNow && chordSaved) { pointing = chordSaved.pointing; pinching = chordSaved.pinching; chordSaved = null; }
    const mh = hold.hand ?? (leftWanted() ? hl : hr);
    mouseHand = mh === hl ? "left" : "right";
    if (!p) {
      hl.ticklish = false; hr.ticklish = false; hl.pinchGoal = 0; hr.pinchGoal = 0;
      mh.ticklish = pointing && ptr.active && ptr.down && (tickleOnly || performance.now() - downAt >= HOLD);
      mh.pinchGoal = pinching && ptr.active && ptr.down ? 1 : 0;
    }
    if (ptr.active && !p) {
      camera.getWorldDirection(fwd);
      ray.setFromCamera(new THREE.Vector2(ptr.x, ptr.y), camera);
      if (pinching && hold.hand === mh) {
        // carrying: the fingertips follow the pointer on a plane facing the camera, at the depth she was picked up
        plane.setFromNormalAndCoplanarPoint(fwd.clone().negate(), tmp.copy(camera.position).addScaledVector(fwd, hold.depth));
        if (ray.ray.intersectPlane(plane, hit)) mh.tipGoal = hit.clone();
        mh.aim.copy(ray.ray.direction);
        mh.grip += (0 - mh.grip) * Math.min(1, dt * 10);
      } else if (pointing || pinching) {
        // pointing: the fingertip rests on whatever you aim at (her body), a hair above it
        const hitBody = opts.pick?.(ray.ray.origin, ray.ray.direction, 50);
        mh.aim.copy(ray.ray.direction);
        if (hitBody) mh.tipGoal = hitBody.point.clone().addScaledVector(ray.ray.direction, -0.04 * s);
        else {
          plane.setFromNormalAndCoplanarPoint(fwd.clone().negate(), tmp.copy(head).addScaledVector(fwd, -0.3 * s));
          if (ray.ray.intersectPlane(plane, hit)) { clampNear(hit); mh.tipGoal = hit.clone(); }
        }
        mh.grip += (0 - mh.grip) * Math.min(1, dt * 10);
      } else {
        // open hand: the palm hovers right over whatever the pointer is on (her head, her shoulder...), and pressing lays it on her
        const hitBody = opts.pick?.(ray.ray.origin, ray.ray.direction, 50);
        if (hitBody) {
          hit.copy(hitBody.point).addScaledVector(ray.ray.direction, -(ptr.down ? 0.012 : 0.075) * s);
          clampNear(hit);
          mh.pos.lerp(hit, Math.min(1, dt * 16));
        } else {
          plane.setFromNormalAndCoplanarPoint(fwd.clone().negate(), tmp.copy(head).addScaledVector(fwd, -0.3 * s));
          if (ray.ray.intersectPlane(plane, hit)) { clampNear(hit); mh.pos.lerp(hit, Math.min(1, dt * 14)); }
        }
        mh.grip += ((ptr.down ? 0.25 : 0) - mh.grip) * Math.min(1, dt * 10);
      }
    }

    // pose the hands: flat over the head, fingers pointing away from the camera, tilted a little toward the viewer
    let touching = 0, strokeV = 0;
    for (const h of [hl, hr]) {
      h.vel.copy(h.pos).sub(h.prev).divideScalar(Math.max(dt, 1e-3));
      const root = h.rig.root;
      h.point += ((pointing || pinching ? 1 : 0) - h.point) * Math.min(1, dt * 12);
      h.pinch += ((pinching ? h.pinchGoal : 0) - h.pinch) * Math.min(1, dt * 14);
      root.position.copy(h.pos);
      root.scale.setScalar(1.3 * handScale);            // a touch larger than life, so they read at a distance (and tiny when you have shrunk)
      root.quaternion.copy(camera.quaternion);
      root.rotateX(-0.35);                              // fingers tilt down toward the character
      root.rotateZ(h === hl ? 0.08 : -0.08);
      // the hand comes in from below and to the side (so the pointing finger reads from the camera), the fingertip still on the aim
      vis.copy(h.aim).applyAxisAngle(camRight.set(1, 0, 0).applyQuaternion(camera.quaternion), pinching ? -0.7 : 0.5)
        .applyAxisAngle(camUp.set(0, 1, 0).applyQuaternion(camera.quaternion), h === hl ? -0.4 : 0.4);
      if (h.point > 0.01) {                             // the pointing gesture: the hand turns to aim along the finger
        lookM.lookAt(zero, vis, up); qa.setFromRotationMatrix(lookM);
        root.quaternion.slerp(qa, h.point);
      }
      const curl = 0.18 + h.grip * 1.25, pt = h.point;
      h.tick += ((pointing && h.ticklish ? 1 : 0) - h.tick) * Math.min(1, dt * 14);
      const wig = performance.now() / 1000 * 16;
      h.rig.fingers.forEach(([a, b], i) => {
        const open = -(curl * (0.9 + 0.08 * i)), openTip = -(curl * 0.9);
        let goA = i === 0 ? -0.02 : -1.45, goB = i === 0 ? -0.02 : -1.2;   // index straight, the others curled into the palm
        if (pinching && i === 0) { goA = -(0.3 + 0.55 * h.pinch); goB = -(0.25 + 0.55 * h.pinch); }   // index curls round to meet the thumb
        // tickling: every finger out and wiggling
        goA += (-0.12 + Math.sin(wig + i * 1.4) * 0.5 - goA) * h.tick; goB += (-0.1 + Math.sin(wig + i * 1.4 + 0.8) * 0.45 - goB) * h.tick;
        a.rotation.x = open + (goA - open) * pt; b.rotation.x = openTip + (goB - openTip) * pt;
      });
      h.rig.thumb[0].rotation.x = -curl * 0.35 + (-0.7 + curl * 0.35) * pt; h.rig.thumb[1].rotation.x = -curl * 0.5 + (-0.7 + curl * 0.5) * pt;
      if (pinching) {                                  // the thumb comes round to meet the index finger
        const fl = h === hl ? -1 : 1;
        h.rig.thumb[0].rotation.x = -0.15 - 0.3 * h.pinch; h.rig.thumb[0].rotation.y = (0.7 + 0.55 * h.pinch) * fl; h.rig.thumb[1].rotation.x = -(0.2 + 0.35 * h.pinch);
      } else { h.rig.thumb[0].rotation.y = 0.7 * (h === hl ? -1 : 1); }
      if ((pointing || pinching) && h.tipGoal) {        // rest the fingertip on the goal: move the hand so the tip lands there
        root.updateMatrixWorld(true);
        tipW.copy(tipL).applyMatrix4(h.rig.fingers[0][1].matrixWorld);
        h.pos.lerp(tmp.copy(h.tipGoal).sub(tipW).add(h.pos), Math.min(1, dt * 14));
        root.position.copy(h.pos);
      }
      if (h.jab >= 0) {                                 // a jab: the finger stabs forward and comes back; the poke lands at the far end
        h.jab += dt;
        const u = h.jab / JAB, peak = 0.45;
        const k = u < peak ? u / peak : 1 - (u - peak) / (1 - peak);
        root.position.addScaledVector(vis, 0.06 * s * Math.max(0, k));
        if (!h.fired && u >= peak) {
          h.fired = true;
          root.updateMatrixWorld(true);
          tipW.copy(tipL).applyMatrix4(h.rig.fingers[0][1].matrixWorld);
          opts.onPoke?.(tipW.clone().addScaledVector(h.aim, -0.06 * s), h.aim.clone(), h === hl ? "left" : "right");
        }
        if (u >= 1) { h.jab = -1; h.fired = false; }
      }
      if (!pointing && h.jab >= 0) { h.jab = -1; h.fired = false; }
      if (pointing && h.ticklish && h.jab < 0) {       // tickling: report the fingertip every frame
        root.updateMatrixWorld(true);
        tipW.copy(tipL).applyMatrix4(h.rig.fingers[0][1].matrixWorld);
        opts.onTickle?.(tipW.clone().addScaledVector(h.aim, -0.04 * s), h.aim.clone(), h === hl ? "left" : "right", Math.min(1, 0.45 + h.vel.length() / (0.9 * s)));
      }
      // contact with the head (ears and hair included: the sphere is a little generous)
      // pinching: the pinch closing on her picks her up; opening it puts her down
      if (pinching) {
        root.updateMatrixWorld(true);
        tipW.copy(tipL).applyMatrix4(h.rig.fingers[0][1].matrixWorld);
        if (h.pinchGoal === 0) { h.grabTried = false; if (hold.hand === h) { hold.hand = null; opts.onDrop?.(); } }
        else if (h.pinch > 0.85 && !hold.hand && !h.grabTried) {
          h.grabTried = true;
          if (opts.onGrab?.(tipW.clone().addScaledVector(h.aim, -0.05 * s), h.aim.clone(), tipW.clone())) {
            hold.hand = h; camera.getWorldDirection(tmp); hold.depth = tipW.clone().sub(camera.position).dot(tmp);
          }
        }
        if (hold.hand === h) opts.onCarry?.(tipW.clone());
      } else if (hold.hand === h) { hold.hand = null; opts.onDrop?.(); }
      const d = pointing || pinching ? 1e9 : h.pos.distanceTo(head);
      const reachR = 0.15 * s + 0.045 * s;
      const t = THREE.MathUtils.clamp(1 - d / reachR, 0, 1);
      h.touch += (t - h.touch) * Math.min(1, dt * 14);
      if (h.touch > touching) {
        touching = h.touch;
        tmp.copy(h.pos).sub(head).applyQuaternion(camera.quaternion.clone().invert());
        pet.lx = THREE.MathUtils.clamp(tmp.x / (0.15 * s), -1, 1);
        pet.ly = THREE.MathUtils.clamp(tmp.y / (0.15 * s), -1, 1);
        strokeV = Math.min(1, h.vel.length() / (0.5 * s));
      }
    }
    // stroking (moving while touching) is what makes her purr; resting a hand there counts a little
    pet.near = touching;
    const target = touching > 0.12 ? Math.min(1, 0.45 * touching + 0.9 * touching * strokeV + 0.2) : 0;
    pet.amount += (target - pet.amount) * Math.min(1, dt * (target > pet.amount ? 5 : 2.2));
    pet.stroke += (strokeV - pet.stroke) * Math.min(1, dt * 6);

    // a gentle rumble on the controller while petting
    const now = performance.now();
    if (p && pet.amount > 0.15 && now - rumbleAt > 120) {
      rumbleAt = now;
      (p as unknown as { vibrationActuator?: { playEffect: (t: string, o: object) => Promise<unknown> } }).vibrationActuator
        ?.playEffect("dual-rumble", { duration: 110, weakMagnitude: 0.12 + 0.2 * pet.stroke, strongMagnitude: 0.04 })?.catch?.(() => {});
    }
  };

  return {
    pet,
    center,
    update,
    get enabled() { return enabled; },
    set enabled(v: boolean) { enabled = v; if (!v) { ptr.active = false; ptr.down = false; } },
    get usingGamepad() { return padActive; },
    /** pointing fingers (poke) or open hands (pet) */
    get pointing() { return pointing; },
    set pointing(v: boolean) { pointing = v; tickleOnly = false; if (v) pinching = false; },
    /** open hands (pet), pointing fingers (poke and tickle), or a pinch (pick her up) */
    get tool(): Tool { return curTool(); },
    set tool(v: Tool) { setTool(v); },
    get holding() { return !!hold.hand; },
    /** 1 = normal; the hands shrink with you */
    set size(v: number) { handScale = Math.min(1, Math.max(0.1, v)); },
    /** which hand the mouse is moving right now */
    get hand() { return mouseHand; },
    /** Jab a finger now (tests, and the on-screen button). */
    jab(hand: "left" | "right" = "right") { if (pointing) startJab(hand === "left" ? hl : hr); },
    dispose() {
      dom.removeEventListener("pointermove", onMove);
      dom.removeEventListener("pointerdown", onDown);
      dom.removeEventListener("pointerup", onRelease);
      dom.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKey); window.removeEventListener("keyup", onKey); dom.removeEventListener("contextmenu", onMenu);
      dom.removeEventListener("pointercancel", onUp);
      scene.remove(group);
      group.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) m.geometry.dispose(); });
      skin.dispose();
    },
  };
}
