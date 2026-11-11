import * as THREE from "three";

/**
 * Virtual hands: the user's own hands, placed in the 3D room so they can reach out and pet the character.
 * Controls:
 *  - gamepad: sticks move the hands (relative to the camera), triggers push forward, bumpers pull back, A grips
 *  - mouse / touch: the pointer moves the right hand, pressing and holding reaches in to touch
 * Touching the head, ears or hair counts as petting; `state` reports how hard, for the character to react to.
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

  type H = { rig: Rig; pos: THREE.Vector3; vel: THREE.Vector3; grip: number; touch: number; prev: THREE.Vector3 };
  const mk = (rig: Rig, x: number): H => ({ rig, pos: new THREE.Vector3(x * s, 1.38 * s, 0.75 * s), vel: new THREE.Vector3(), grip: 0, touch: 0, prev: new THREE.Vector3() });
  const hl = mk(L, -0.34), hr = mk(R, 0.34);
  const lo = new THREE.Vector3(-1.3 * s, 0.15 * s, -0.25 * s), hi = new THREE.Vector3(1.3 * s, 2.1 * s, 1.7 * s);
  /** the hands may roam a box around this point (the viewer keeps it on the character, who may be walking about) */
  const center = new THREE.Vector3();
  const clampNear = (v: THREE.Vector3) => { v.sub(center).clamp(lo, hi).add(center); };

  // ---- input ----
  let enabled = false;
  const ptr = { x: 0, y: 0, down: false, active: false };
  const rect = () => dom.getBoundingClientRect();
  const onMove = (e: PointerEvent) => { const r = rect(); ptr.x = ((e.clientX - r.left) / r.width) * 2 - 1; ptr.y = -(((e.clientY - r.top) / r.height) * 2 - 1); ptr.active = true; };
  const onDown = (e: PointerEvent) => { if (!enabled) return; onMove(e); ptr.down = true; dom.setPointerCapture?.(e.pointerId); };
  const onUp = () => { ptr.down = false; };
  dom.addEventListener("pointermove", onMove);
  dom.addEventListener("pointerdown", onDown);
  dom.addEventListener("pointerup", onUp);
  dom.addEventListener("pointercancel", onUp);

  const pad = () => { const g = navigator.getGamepads?.() ?? []; for (const p of g) if (p && p.connected) return p; return null; };
  const dz = (v: number) => (Math.abs(v) < 0.14 ? 0 : (v - Math.sign(v) * 0.14) / 0.86);

  const fwd = new THREE.Vector3(), right = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  const ray = new THREE.Raycaster();
  const plane = new THREE.Plane();
  const hit = new THREE.Vector3();
  const tmp = new THREE.Vector3();

  const pet: PetState = { amount: 0, lx: 0, ly: 0, stroke: 0, near: 0 };
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
      const grip = b(0);
      reach(hl, dt, a(0), -a(1), b(6) - b(4), grip);
      reach(hr, dt, a(2), -a(3), b(7) - b(5), grip);
    }
    if (ptr.active && !p) {
      // the pointer places the right hand on a plane facing the camera, a little in front of the head; pressing reaches in
      camera.getWorldDirection(fwd);
      const depth = ptr.down ? 0.1 * s : 0.3 * s;
      plane.setFromNormalAndCoplanarPoint(fwd.clone().negate(), tmp.copy(head).addScaledVector(fwd, -depth));
      ray.setFromCamera(new THREE.Vector2(ptr.x, ptr.y), camera);
      if (ray.ray.intersectPlane(plane, hit)) {
        clampNear(hit);
        hr.pos.lerp(hit, Math.min(1, dt * 14));
      }
      hr.grip += ((ptr.down ? 0.25 : 0) - hr.grip) * Math.min(1, dt * 10);
    }

    // pose the hands: flat over the head, fingers pointing away from the camera, tilted a little toward the viewer
    let touching = 0, strokeV = 0;
    for (const h of [hl, hr]) {
      h.vel.copy(h.pos).sub(h.prev).divideScalar(Math.max(dt, 1e-3));
      h.rig.root.position.copy(h.pos);
      h.rig.root.scale.setScalar(1.3);                  // a touch larger than life, so they read at a distance
      camera.getWorldDirection(fwd);
      h.rig.root.quaternion.copy(camera.quaternion);
      h.rig.root.rotateX(-0.35);                        // fingers tilt down toward the character
      h.rig.root.rotateZ(h === hl ? 0.08 : -0.08);
      const curl = 0.18 + h.grip * 1.25;
      h.rig.fingers.forEach(([a, b], i) => { a.rotation.x = -(curl * (0.9 + 0.08 * i)); b.rotation.x = -(curl * 0.9); });
      h.rig.thumb[0].rotation.x = -curl * 0.35; h.rig.thumb[1].rotation.x = -curl * 0.5;
      // contact with the head (ears and hair included: the sphere is a little generous)
      const d = h.pos.distanceTo(head);
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
    dispose() {
      dom.removeEventListener("pointermove", onMove);
      dom.removeEventListener("pointerdown", onDown);
      dom.removeEventListener("pointerup", onUp);
      dom.removeEventListener("pointercancel", onUp);
      scene.remove(group);
      group.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) m.geometry.dispose(); });
      skin.dispose();
    },
  };
}
