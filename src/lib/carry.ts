import * as THREE from "three";
import type { VRM } from "@pixiv/three-vrm";
import { FLOOR, OBSTACLES } from "./room";

/**
 * Pick-up: a pinch on her scruff lifts her into the air, a cartoon way. She dangles from the fingertips like a kitten:
 * the body swings like a pendulum as you move the hand about, she kicks and flails and yells when she panics (or hangs limp
 * and sulks when she doesn't), and when you let go she drops, squashes on the floor, sees stars, and carries on from wherever
 * you put her in the room. Silly on purpose.
 */
type Emote = (text: string, color?: string, life?: number, angry?: boolean) => void;
type Mode = "none" | "held" | "fall" | "dizzy";

export function createCarry(opts: {
  vrm: VRM;
  idle: { bones: Record<string, THREE.Object3D | null>; mood: { happy: number; angry: number; sad: number; surprised: number; closed: number; mouth: number }; m: number };
  scale: number;
  emote: Emote;
  npc: { carry: (v: boolean) => void; teleport: (x: number, z: number) => void };
}) {
  const { vrm, idle, scale: s, emote, npc } = opts;
  const B = idle.bones;
  const scene = vrm.scene;
  const tmp = new THREE.Vector3();
  // how high her scruff (the back of the neck) is above her feet when she stands
  const neckW = new THREE.Vector3();
  (B.neck ?? B.head)?.getWorldPosition(neckW);
  const neckH = Math.max(0.3, neckW.y - scene.position.y) || 1.3 * s;
  const L = Math.max(0.28, neckH * 0.42);          // from the scruff to where most of her weight is

  let mode: Mode = "none";
  const A = new THREE.Vector3(), As = new THREE.Vector3(), prevAs = new THREE.Vector3(), vel = new THREE.Vector3(), prevVel = new THREE.Vector3(), acc = new THREE.Vector3();
  const phi = { x: 0, z: 0 }, omega = { x: 0, z: 0 };
  const yawQ = new THREE.Quaternion();
  const rootPos = new THREE.Vector3(), rootQ = new THREE.Quaternion(), qa = new THREE.Quaternion(), qb = new THREE.Quaternion();
  const eul = new THREE.Euler();
  let calm = false, panic = 0, heldFor = 0, nextLine = 0, startle = 0, now = 0;
  // falling
  const fv = new THREE.Vector3();
  let bounced = false, squash = 0, dizzy = 0, landX = 0, landZ = 0, impact = 0;

  const add = (n: THREE.Object3D | null, x: number, y: number, z: number) => { if (n) n.quaternion.multiply(qa.setFromEuler(eul.set(x * idle.m, y, z * idle.m))); };
  const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
  const pick1 = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];

  /** Pinch her up by the scruff. `point` is where the fingertips are. */
  const grab = (point: THREE.Vector3) => {
    if (mode !== "none") return;
    mode = "held"; heldFor = 0; startle = 0.5; panic = 0.3;
    calm = Math.random() < 0.4;                                       // some pick-ups she takes with a pout
    npc.carry(true);
    yawQ.copy(scene.quaternion);
    // she starts from where her scruff is now and is whisked up to the fingertips
    A.copy(point); (B.neck ?? B.head)?.getWorldPosition(As); prevAs.copy(As); vel.set(0, 0, 0); prevVel.set(0, 0, 0); acc.set(0, 0, 0);
    phi.x = phi.z = omega.x = omega.z = 0;
    nextLine = now + 0.35;
    emote("!?", "#9a3fc0", 1.2);
  };

  /** The fingertips moved to `point` (call every frame while holding). */
  const move = (point: THREE.Vector3) => { if (mode === "held") A.copy(point); };

  const drop = () => {
    if (mode !== "held") return;
    mode = "fall"; bounced = false; squash = 0;
    fv.copy(vel).multiplyScalar(0.6); fv.y = Math.min(vel.y * 0.4, 1.5);
    emote(panic > 0.5 ? "AAAAH!" : "...!", "#9a3fc0", 1.2);
  };

  /** Where she may land: on the floor of the room, not inside the furniture. */
  const landSpot = (x: number, z: number): [number, number] => {
    let rx = clamp(x / s, FLOOR.x0 + 0.4, FLOOR.x1 - 0.4), rz = clamp(z / s, FLOOR.z0 + 0.4, FLOOR.z1 - 0.4);
    for (const [x0, z0, x1, z1] of OBSTACLES) {
      const m = 0.3;
      if (rx > x0 - m && rx < x1 + m && rz > z0 - m && rz < z1 + m) {      // inside: slide out through the nearest side
        const d = [rx - (x0 - m), x1 + m - rx, rz - (z0 - m), z1 + m - rz];
        const k = d.indexOf(Math.min(...d));
        if (k === 0) rx = x0 - m; else if (k === 1) rx = x1 + m; else if (k === 2) rz = z0 - m; else rz = z1 + m;
      }
    }
    return [rx * s, rz * s];
  };

  const lines = {
    panic: ["AAAAH!", "put me down!!", "eeek!!", "help!!", "WAAAH!", "NOO!!", "let go!!"],
    calm: ["...", "put me down.", "hmph.", "(._.)", "so rude.", "..."],
  };

  /** After the NPC and poke poses: places her in the air, swings her, flails her, drops her. */
  const apply = (t: number, dt: number) => {
    now = t;
    if (mode === "none") { if (squash > 0.001) { squash *= Math.exp(-dt * 8); scene.scale.set(1, 1, 1); } return; }
    dt = Math.min(dt, 0.05);
    const md = idle.mood;

    if (mode === "held") {
      heldFor += dt; startle = Math.max(0, startle - dt);
      // the scruff follows the fingertips a little behind them
      As.lerp(A, Math.min(1, dt * 16));
      vel.copy(As).sub(prevAs).divideScalar(Math.max(dt, 1e-3)); prevAs.copy(As);
      acc.copy(vel).sub(prevVel).divideScalar(Math.max(dt, 1e-3)).clampLength(0, 40); prevVel.copy(vel);
      // pendulum: she lags behind when the hand speeds up, and swings back
      const g = 9.8, k = g / L, c = calm ? 1.1 : 0.55 + 0.6 * (1 - panic);
      const kick = panic * 0.7 * (Math.sin(t * 7.3) + Math.sin(t * 11.1));              // her own thrashing sets the swing off
      omega.x += (-k * phi.x - c * omega.x + acc.z / L + kick * 0.5) * dt;
      omega.z += (-k * phi.z - c * omega.z - acc.x / L + kick * 0.35) * dt;
      phi.x = clamp(phi.x + omega.x * dt, -1.25, 1.25); phi.z = clamp(phi.z + omega.z * dt, -1.25, 1.25);
      qa.setFromAxisAngle(tmp.set(1, 0, 0), phi.x); qb.setFromAxisAngle(tmp.set(0, 0, 1), phi.z);
      rootQ.copy(qb).multiply(qa);                                                          // tilt about the scruff
      tmp.set(0, neckH, 0).applyQuaternion(rootQ);
      rootPos.copy(As).sub(tmp);
      rootQ.multiply(yawQ);
      const lift = Math.max(0, rootPos.y);
      if (rootPos.y < 0) { rootPos.y = 0; phi.x *= 0.92; phi.z *= 0.92; }
      const air = clamp(lift / (0.55 * s), 0, 1);
      // panic or pout: it depends on how high she is and how roughly she is swung (and how long she has been dangling)
      const swing = Math.hypot(omega.x, omega.z);
      if (calm && (swing > 3.2 || heldFor > 7 || air > 0.95 && heldFor > 3)) { calm = false; emote("WAAAH!", "#c2253f", 1.6, true); }
      const goal = calm ? 0.08 + 0.15 * air : clamp(0.55 + 0.3 * air + swing * 0.06, 0, 1);
      panic += (goal - panic) * Math.min(1, dt * 3);
      if (t > nextLine && lift > 0.05 * s) {
        nextLine = t + (calm ? 2.6 : 1.1) + Math.random() * 0.7;
        emote(pick1(calm ? lines.calm : lines.panic), calm ? "#4a5fa0" : "#c2253f", 1.3, !calm);
      }
      scene.position.copy(rootPos); scene.quaternion.copy(rootQ); scene.scale.set(1, 1, 1);
      npc.teleport(rootPos.x, rootPos.z);

      // her body language
      const p = panic, ph = t * (9 + 5 * p), w1 = 0.5 + 0.5 * Math.sin(ph), w2 = 0.5 + 0.5 * Math.sin(ph * 1.3 + 1);
      if (calm) {      // limp like a kitten, arms hanging, a pout
        add(B.lArm, 0.1, 0, 0.5 + 0.1 * Math.sin(t * 1.7)); add(B.rArm, 0.1, 0, -0.5 - 0.1 * Math.sin(t * 1.7 + 1));
        add(B.lLeg, 0.2 + phi.x * 0.4, 0, -0.1); add(B.rLeg, 0.2 + phi.x * 0.4, 0, 0.1);
        add(B.head, 0.3, 0, phi.z * 0.3); add(B.spine, 0.12, 0, 0);
        md.sad = Math.max(md.sad, 0.55); md.angry = Math.max(md.angry, 0.3); md.closed = Math.max(md.closed, 0.3 + 0.2 * Math.sin(t * 0.8));
      } else {         // all arms and legs
        add(B.lArm, 0.7 * Math.sin(ph * 0.8) * p, 0, 1.15 * p * w1); add(B.rArm, 0.7 * Math.sin(ph * 0.8 + 2) * p, 0, -1.15 * p * w2);
        add(B.lFore, 0, -0.9 * p * w2, 0); add(B.rFore, 0, 0.9 * p * w1, 0);
        add(B.lLeg, 0.9 * p * Math.sin(ph), 0, -0.15 * p); add(B.rLeg, 0.9 * p * Math.sin(ph + Math.PI), 0, 0.15 * p);
        add(B.lShin, 0.9 * p * Math.max(0, Math.sin(ph + 0.6)), 0, 0); add(B.rShin, 0.9 * p * Math.max(0, Math.sin(ph + Math.PI + 0.6)), 0, 0);
        add(B.head, 0.25 * Math.sin(ph * 1.7) * p, 0.45 * Math.sin(ph) * p, 0.25 * Math.cos(ph * 1.1) * p);
        add(B.spine, -0.08 * p * Math.sin(ph * 0.9), 0.12 * p * Math.sin(ph), 0);
        md.surprised = Math.max(md.surprised, 0.9 * p); md.mouth = Math.max(md.mouth, p * (0.55 + 0.35 * Math.sin(t * 17)));
        md.angry = Math.max(md.angry, 0.5 * p * w1); md.closed = Math.max(md.closed, 0.35 * p * (1 - w2));
      }
      if (startle > 0) md.surprised = Math.max(md.surprised, startle * 2);
      return;
    }

    if (mode === "fall") {
      fv.y -= 18 * dt;                                                    // cartoon gravity
      rootPos.addScaledVector(fv, dt);
      fv.x *= Math.exp(-dt * 0.8); fv.z *= Math.exp(-dt * 0.8);
      // straighten up while she falls
      omega.x *= Math.exp(-dt * 3); omega.z *= Math.exp(-dt * 3);
      phi.x += (0 - phi.x) * Math.min(1, dt * 6); phi.z += (0 - phi.z) * Math.min(1, dt * 6);
      qa.setFromAxisAngle(tmp.set(1, 0, 0), phi.x); qb.setFromAxisAngle(tmp.set(0, 0, 1), phi.z);
      rootQ.copy(qb).multiply(qa).multiply(yawQ);
      if (rootPos.y <= 0) {
        rootPos.y = 0;
        impact = clamp(-fv.y / 6, 0.2, 1.4);
        if (!bounced && impact > 0.45) { bounced = true; fv.y = -fv.y * 0.28; squash = impact; }
        else {
          [landX, landZ] = landSpot(rootPos.x, rootPos.z);
          rootPos.x = landX; rootPos.z = landZ;
          mode = "dizzy"; dizzy = 2.2; squash = Math.max(squash, impact);
          npc.teleport(landX, landZ);
          emote(panic > 0.5 ? "oof!" : "hmph.", "#c2253f", 1.6, true);
          setTimeout(() => emote("@_@", "#9a3fc0", 2), 500);
        }
      }
      scene.position.copy(rootPos); scene.quaternion.copy(rootQ);
      const sq = squash * (rootPos.y <= 0 ? 1 : 0.4);
      scene.scale.set(1 + 0.25 * sq, 1 - 0.3 * sq, 1 + 0.25 * sq);
      // arms and legs still flail on the way down
      const p = Math.max(panic, 0.5), ph = t * 12;
      add(B.lArm, 0, 0, 1.2 * p * (0.5 + 0.5 * Math.sin(ph))); add(B.rArm, 0, 0, -1.2 * p * (0.5 + 0.5 * Math.sin(ph + 1)));
      add(B.lLeg, 0.6 * Math.sin(ph), 0, 0); add(B.rLeg, -0.6 * Math.sin(ph), 0, 0);
      md.surprised = Math.max(md.surprised, 0.9); md.mouth = Math.max(md.mouth, 0.8);
      return;
    }

    // dizzy: she stands where she landed and wobbles, then carries on with her day
    dizzy -= dt;
    squash *= Math.exp(-dt * 5);
    scene.scale.set(1 + 0.25 * squash, 1 - 0.3 * squash, 1 + 0.25 * squash);
    const k = Math.max(0, dizzy) / 2.2;
    add(B.head, 0.08 * Math.sin(t * 6) * k, 0, 0.3 * Math.sin(t * 4.5) * k); add(B.spine, 0, 0, 0.1 * Math.sin(t * 4.5 + 1) * k);
    md.closed = Math.max(md.closed, 0.5 * k * (0.5 + 0.5 * Math.sin(t * 5)));
    if (dizzy <= 0) { mode = "none"; panic = 0; scene.scale.set(1, 1, 1); npc.carry(false); }
  };

  return {
    grab, move, drop, apply,
    get mode() { return mode; },
    get held() { return mode === "held"; },
    get busy() { return mode !== "none"; },
    get panic() { return panic; },
    get calm() { return calm; },
    get height() { return mode === "held" || mode === "fall" ? rootPos.y : 0; },
    get pos() { return rootPos; },
    /** Make her panic (true) or sulk (false) for the current pick-up (tests). */
    setCalm(v: boolean) { calm = v; },
    dispose() { scene.scale.set(1, 1, 1); },
  };
}
