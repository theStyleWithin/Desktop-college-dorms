import * as THREE from "three";
import type { VRM } from "@pixiv/three-vrm";

/**
 * Poking. Your pointing finger finds a place on her (face, ears, shoulders, arms, hands, back) and she reacts to
 * where you poked: a giggle for a cheek, an annoyed "hey!" for the forehead, a squeal for an ear, a startle from behind.
 * Poke her again and again and she gets annoyed; leave her alone and she forgets. Only these ordinary, non-intimate
 * places react; anywhere else she only gives a puzzled "?".
 *
 * Where you poked comes from simple body proxies (spheres along her skeleton) rather than the model's own mesh, so it works
 * the same for any model, any hair or outfit, and costs nothing per frame.
 */
export type Region = "nose" | "forehead" | "cheek" | "ear" | "head" | "shoulder" | "arm" | "hand" | "back" | "other";
export const REGIONS: Region[] = ["nose", "forehead", "cheek", "ear", "head", "shoulder", "arm", "hand", "back", "other"];

export interface PokeHit { region: Region; /** -1 = her right side, 1 = her left side, 0 = middle */ side: number; point: THREE.Vector3; dist: number }

interface Sphere { c: THREE.Vector3; r: number; kind: "head" | "shoulder" | "arm" | "hand" | "torso"; side: number }

type Emote = (text: string, color?: string, life?: number, angry?: boolean) => void;

export function createPoker(opts: {
  vrm: VRM;
  idle: { bones: Record<string, THREE.Object3D | null>; mood: { happy: number; angry: number; sad: number; surprised: number; closed: number; mouth: number }; m: number; hop: (t: number) => void };
  scale: number;
  scene: THREE.Scene;
  camera: THREE.Camera;
  emote: Emote;
  /** She was poked: stop what she is doing for a moment (and wake her, if asleep). Returns whether she was asleep. */
  disturb: () => boolean;
  /** Is she in the middle of a big stretch, arms up? (The worst moment to be tickled.) */
  offGuard?: () => boolean;
  /** End whatever she is doing (a stretch) at once. */
  interrupt?: () => void;
}) {
  const { idle, scale: s, scene, camera, emote } = opts;
  const B = idle.bones;
  const world = (n: THREE.Object3D | null | undefined, out: THREE.Vector3) => (n ? n.getWorldPosition(out) : out.set(0, 0, 0));
  const v = {
    hips: new THREE.Vector3(), neck: new THREE.Vector3(), head: new THREE.Vector3(), chest: new THREE.Vector3(),
    lArm: new THREE.Vector3(), rArm: new THREE.Vector3(), lFore: new THREE.Vector3(), rFore: new THREE.Vector3(), lHand: new THREE.Vector3(), rHand: new THREE.Vector3(),
  };
  const fwd = new THREE.Vector3(), right = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);

  /** Her body in world space right now: the spheres a finger can touch, and which way she faces. */
  const body = (): { spheres: Sphere[]; hc: THREE.Vector3 } => {
    world(B.hips, v.hips); world(B.neck, v.neck); world(B.head, v.head); world(B.upperChest ?? B.chest ?? B.spine, v.chest);
    world(B.lArm, v.lArm); world(B.rArm, v.rArm); world(B.lFore, v.lFore); world(B.rFore, v.rFore); world(B.lHand, v.lHand); world(B.rHand, v.rHand);
    // her left is +x when she faces +z, so facing = left x up
    const left = new THREE.Vector3().subVectors(v.lArm, v.rArm); left.y = 0;
    if (left.lengthSq() < 1e-8) left.set(1, 0, 0);
    left.normalize();
    fwd.crossVectors(left, up).normalize();
    right.copy(left).negate();
    const hc = v.head.clone(); hc.y += 0.07 * s;
    const spheres: Sphere[] = [];
    const chain = (a: THREE.Vector3, b: THREE.Vector3, r: number, kind: Sphere["kind"], side: number, n = 5) => {
      for (let i = 0; i <= n; i++) spheres.push({ c: a.clone().lerp(b, i / n), r, kind, side });
    };
    spheres.push({ c: hc, r: 0.125 * s, kind: "head", side: 0 });
    chain(v.hips, v.neck, 0.105 * s, "torso", 0, 8);
    spheres.push({ c: v.lArm, r: 0.055 * s, kind: "shoulder", side: 1 }, { c: v.rArm, r: 0.055 * s, kind: "shoulder", side: -1 });
    chain(v.lArm, v.lFore, 0.055 * s, "arm", 1); chain(v.rArm, v.rFore, 0.055 * s, "arm", -1);
    chain(v.lFore, v.lHand, 0.048 * s, "arm", 1, 3); chain(v.rFore, v.rHand, 0.048 * s, "arm", -1, 3);
    spheres.push({ c: v.lHand, r: 0.05 * s, kind: "hand", side: 1 }, { c: v.rHand, r: 0.05 * s, kind: "hand", side: -1 });
    return { spheres, hc };
  };

  const hitSphere = (o: THREE.Vector3, d: THREE.Vector3, sp: Sphere): number | null => {
    const oc = new THREE.Vector3().subVectors(o, sp.c);
    const b = oc.dot(d), c = oc.lengthSq() - sp.r * sp.r;
    const disc = b * b - c;
    if (disc < 0) return null;
    const t = -b - Math.sqrt(disc);
    if (t >= 0) return t;
    return -b + Math.sqrt(disc) >= 0 ? 0 : null;   // the ray starts inside it: the surface is right here
  };

  /** Which place on her does a ray from `origin` along `dir` (unit length) meet first within `max`? */
  const pick = (origin: THREE.Vector3, dir: THREE.Vector3, max = 5): PokeHit | null => {
    const { spheres, hc } = body();
    let best: { t: number; sp: Sphere } | null = null;
    for (const sp of spheres) {
      const t = hitSphere(origin, dir, sp);
      if (t !== null && t <= max) {
        // a sphere of the head wins ties: it is what you aim at when you aim at her face
        const better = !best || t < best.t - 1e-4 * s || (Math.abs(t - best.t) < 1e-4 * s && sp.kind === "head");
        if (better) best = { t, sp };
      }
    }
    if (!best) return null;
    const point = origin.clone().addScaledVector(dir, best.t);
    const sp = best.sp;
    const rel = point.clone().sub(hc);
    const fr = rel.dot(fwd) / s, rr = -rel.dot(right) / s, ur = rel.dot(up) / s;   // rr > 0 = her left
    let region: Region = "other"; let side = sp.side;
    switch (sp.kind) {
      case "head": {
        side = Math.abs(rr) < 0.03 ? 0 : Math.sign(rr);
        if (fr < -0.03) region = "head";                                         // the back of her head
        else if (ur > 0.085) region = "head";                                     // the top (and whatever sits there, ears included)
        else if (Math.abs(rr) > 0.085 && fr < 0.06) region = "ear";               // beside the head
        else if (fr > 0.02 && Math.abs(rr) < 0.028 && ur > -0.045 && ur < 0.025) region = "nose";
        else if (fr > 0.02 && ur >= 0.03) region = "forehead";
        else if (fr > 0.0) region = "cheek";
        else region = "head";
        break;
      }
      case "shoulder": region = "shoulder"; break;
      case "arm": region = "arm"; break;
      case "hand": region = "hand"; break;
      case "torso": {
        // behind the middle of her back: a poke from behind. In front, or lower down, she is just puzzled.
        const rel2 = point.clone().sub(v.chest);
        region = rel2.dot(fwd) < -0.02 * s && point.y > v.hips.y + 0.08 * s ? "back" : "other";
        side = 0;
        break;
      }
    }
    return { region, side, point, dist: best.t };
  };

  // ---- the rings that show where you poked ----
  const rings: { m: THREE.Mesh; t: number }[] = [];
  const ringGeo = new THREE.RingGeometry(0.7, 1, 28);
  const ring = (p: THREE.Vector3) => {
    const m = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthTest: false, side: THREE.DoubleSide }));
    m.position.copy(p); m.renderOrder = 999; m.scale.setScalar(0.02 * s);
    scene.add(m); rings.push({ m, t: 0 });
  };

  // ---- the shrink ray: the smaller you are, the more she looks down at you ----
  let shrink = 0, shrinkTier = 0;
  /** How tiny the user is, 0 (normal size) .. 1 (the size of a lollipop). She notices, looks down, and comments. */
  const setShrink = (v: number) => {
    shrink = Math.min(1, Math.max(0, v));
    const tier = shrink > 0.75 ? 3 : shrink > 0.45 ? 2 : shrink > 0.12 ? 1 : 0;
    if (tier !== shrinkTier) {
      if (tier > shrinkTier) emote(tier === 3 ? "you're TINY!!" : tier === 2 ? "huh? where...?" : "hm?", "#9a3fc0", 2.2);
      else if (tier === 0) emote("welcome back!", "#d4691f", 2);
      shrinkTier = tier;
    }
  };

  // ---- reactions ----
  type Cur = { region: Region; side: number; t0: number; dur: number; annoyed: boolean; woke: boolean };
  let cur: Cur | null = null;
  let recent: number[] = [];
  let sulkUntil = 0;
  let count = 0;
  let lastRegion: Region | "" = "";
  let now = 0;
  const eul = new THREE.Euler(), q = new THREE.Quaternion();
  const add = (n: THREE.Object3D | null, x: number, y: number, z: number) => { if (n) n.quaternion.multiply(q.setFromEuler(eul.set(x * idle.m, y, z * idle.m))); };
  const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
  const rise = (u: number, a: number) => clamp01(u / a);                       // 0 -> 1 over the first `a` of the reaction
  const decay = (u: number, from: number) => 1 - clamp01((u - from) / (1 - from)); // 1 -> 0 from `from` to the end
  const bump = (u: number, a: number, b: number) => rise(u, a) * decay(u, b);   // quick up, hold, down
  const pick1 = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];

  /** She reacts to a poke at `region`. Called with a real hit, or by tests. */
  const react = (region: Region, side = 0) => {
    if (cur && now - cur.t0 < 0.25) return;                                   // one poke at a time
    count++; lastRegion = region;
    const woke = opts.disturb();
    recent = recent.filter((t) => now - t < 4.5); recent.push(now);
    const sulking = now < sulkUntil;
    const annoyed = woke || sulking || recent.length >= 3;
    if (recent.length >= 6) sulkUntil = now + 6;
    cur = { region, side, t0: now, dur: woke ? 2.4 : annoyed ? 2.2 : region === "back" ? 2.2 : 1.8, annoyed, woke };
    // the first thing she says
    if (woke) emote("...!", "#c2253f", 2, true);
    else if (annoyed) emote(sulking ? "hmph!" : pick1(["hey!", "stop it!", "quit that!"]), "#c2253f", 2.2, true);
    else switch (region) {
      case "nose": emote("mmph!", "#d4691f", 1.6); break;
      case "forehead": emote("hey!", "#c2253f", 1.8, true); break;
      case "cheek": emote("hehe ♪", "#d4691f", 1.8); break;
      case "ear": emote("eep!", "#9a3fc0", 1.6); break;
      case "head": emote("?", "#9a3fc0", 1.4); break;
      case "shoulder": emote("hm?", "#4a5fa0", 1.6); break;
      case "arm": emote("hehe!", "#d4691f", 1.6); break;
      case "hand": emote("♪", "#d4691f", 1.6); break;
      case "back": emote("!!", "#9a3fc0", 1.6); idle.hop(now); break;
      default: emote("?", "#4a5fa0", 1.4);
    }
    if (annoyed && region === "back") idle.hop(now);
  };

  /** Called after the idle and NPC poses are set for this frame: adds the reaction on top. */
  const apply = (t: number, dt: number) => {
    now = t;
    if (shrink > 0.03) {         // looking down at someone small: chin down, eyes on you, a smile once she can see how small you are
      const md = idle.mood;
      add(B.head, 0.34 * shrink, 0, 0); add(B.neck, 0.12 * shrink, 0, 0); add(B.spine, 0.1 * shrink, 0, 0);
      md.happy = Math.max(md.happy, 0.65 * Math.max(0, shrink - 0.4));
      if (shrinkTier >= 2) md.surprised = Math.max(md.surprised, 0.25 * (0.5 + 0.5 * Math.sin(t * 2.5)));
    }
    if (forced && t < forced.until) { tk.touching = true; tk.region = forced.region; tk.side = forced.side; tk.any = 0.12; tk.strength = 1; }   // tests
    // tickling: the laugh builds while a finger tickles somewhere ticklish, and fades when it stops
    const f = tk.touching && tk.any > 0 ? (TICKLISH[tk.region] ?? 0.1) : 0;
    if (tk.any > 0) tk.any -= dt;
    if (tk.grace > 0) tk.grace -= dt;
    if (f > 0.3) tk.gap = 0; else tk.gap += dt;
    if (f > 0.3) {
      if (tk.fresh) {                                // the first moment of a tickle
        tk.fresh = false; tickleCount++; tk.time = 0;
        opts.disturb();
        if (opts.offGuard?.()) {                     // caught mid-stretch: arms slam down and she bursts out laughing
          opts.interrupt?.(); tk.caught = 3.5; tk.level = 1; idle.hop(t);
          emote("HAHAHA!", "#d4691f", 2.6); tk.nextLine = t + 1.6;
        } else tk.nextLine = t + 0.7;
      }
      tk.time += dt;
      const goal = Math.min(1, f * (0.45 + 0.55 * tk.strength) * (0.55 + tk.time * 0.45));
      tk.level += (goal - tk.level) * Math.min(1, dt * 3.5);
      if (tk.caught > 0) tk.level = Math.max(tk.level, 0.9);
      if (t > tk.nextLine && tk.level > 0.35) {
        tk.nextLine = t + 1.05 + Math.random() * 0.5;
        emote(tk.time > 6 ? pick1(["mercy!!", "can't... breathe...", "stooop!!"]) : pick1(["hahaha!", "ahaha!", "hehehe~", "stop—haha!", "p-please! haha", "nooo haha"]), "#d4691f", 1.5);
      }
      if (tk.time > 1 && tk.level < 0.3 && f < 0.5) { emote("hm?", "#4a5fa0", 1.4); tk.time = 0; }
    } else {
      if (tk.gap > 0.6) tk.fresh = true;
      tk.level += (0 - tk.level) * Math.min(1, dt * (tk.caught > 0 ? 0.7 : 1.6));
      if (tk.level < 0.01) tk.level = 0;
    }
    if (tk.caught > 0) tk.caught -= dt;
    if (tk.level > 0.02) {
      const L = tk.level, sdk = tk.side || 1, md = idle.mood;
      const sh = Math.sin(t * 13), sh2 = Math.sin(t * 9 + 1.3);
      md.happy = Math.max(md.happy, L); md.closed = Math.max(md.closed, 0.65 * L);
      md.mouth = Math.max(md.mouth, L * (0.45 + 0.4 * Math.sin(t * 15)));
      add(B.head, 0.05 * L + sh2 * 0.03 * L, 0, sdk * 0.12 * L + sh * 0.06 * L);
      add(B.spine, 0.2 * L + sh * 0.02 * L, 0, 0); add(B.chest, 0.1 * L, 0, 0);
      add(B.lShoulder, 0, 0, sh * 0.09 * L + 0.08 * L); add(B.rShoulder, 0, 0, -sh * 0.09 * L - 0.08 * L);
      add(B.lArm, 0, 0, -0.18 * L); add(B.rArm, 0, 0, 0.18 * L);      // arms pulled in against her sides
      opts.vrm.scene.position.y += Math.abs(sh) * 0.006 * s * L;       // little bounces
    }

    for (let i = rings.length - 1; i >= 0; i--) {
      const r = rings[i]; r.t += dt;
      const f = r.t / 0.45;
      r.m.scale.setScalar((0.02 + 0.07 * f) * s); r.m.quaternion.copy(camera.quaternion);
      (r.m.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - f);
      if (f >= 1) { r.m.removeFromParent(); (r.m.material as THREE.Material).dispose(); rings.splice(i, 1); }
    }
    if (!cur) return;
    const u = (t - cur.t0) / cur.dur;
    if (u >= 1) { cur = null; return; }
    const { region, side, annoyed, woke } = cur;
    const md = idle.mood;
    const sd = side || 1;
    const wiggle = (hz: number, amp: number, a = 0.1, b = 0.7) => Math.sin(t * hz * 6.283) * amp * rise(u, a) * decay(u, b);
    const mx = (k: keyof typeof md, v2: number) => { md[k] = Math.max(md[k], v2); };

    if (woke) {            // poked awake: eyes crack open, scowl, and a grumpy shake of the head
      mx("angry", 0.8 * bump(u, 0.1, 0.7)); mx("closed", 0.5 * decay(u, 0.05));
      add(B.head, 0.05 * bump(u, 0.15, 0.8), wiggle(2.2, 0.14), 0);
      return;
    }
    if (annoyed) {         // had enough: scowl, head turned away from the finger, shoulders hunched
      const turn = (region === "back" ? 0.9 : 0.55) * sd * bump(u, 0.12, 0.75);
      mx("angry", 0.95 * bump(u, 0.08, 0.8)); mx("closed", 0.25 * bump(u, 0.1, 0.5));
      add(B.head, 0.08 * bump(u, 0.12, 0.8), turn, 0); add(B.neck, 0, turn * 0.4, 0);
      add(B.lShoulder, 0, 0, 0.1 * bump(u, 0.1, 0.8)); add(B.rShoulder, 0, 0, -0.1 * bump(u, 0.1, 0.8));
      return;
    }
    switch (region) {
      case "nose":         // boop: head snaps back, eyes scrunch, then a giggle
        add(B.head, -0.2 * bump(u, 0.07, 0.35) + wiggle(9, 0.02, 0.3, 0.9), wiggle(8, 0.04, 0.3, 0.9), 0);
        mx("closed", bump(u, 0.05, 0.3)); mx("happy", 0.85 * rise(u, 0.4) * decay(u, 0.75)); mx("mouth", 0.2 * bump(u, 0.3, 0.7));
        break;
      case "forehead":     // flicked: recoil and an annoyed glare
        add(B.head, -0.24 * bump(u, 0.06, 0.3) + 0.07 * bump(u, 0.4, 0.85), 0, 0);
        mx("angry", 0.85 * rise(u, 0.12) * decay(u, 0.78)); mx("closed", 0.45 * bump(u, 0.05, 0.25));
        break;
      case "cheek":        // a ticklish giggle: head tips toward the finger, shoulders bounce
        add(B.head, 0.04, 0, sd * 0.2 * bump(u, 0.1, 0.8) + wiggle(10, 0.035, 0.2, 0.85));
        add(B.lShoulder, 0, 0, wiggle(10, 0.05, 0.2, 0.85)); add(B.rShoulder, 0, 0, -wiggle(10, 0.05, 0.2, 0.85));
        mx("happy", bump(u, 0.12, 0.8)); mx("closed", 0.55 * bump(u, 0.1, 0.75)); mx("mouth", 0.25 * bump(u, 0.2, 0.7));
        break;
      case "ear":          // ears are ticklish: squeal, shrug the shoulder up and lean away
        add(B.head, 0, 0, -sd * 0.32 * bump(u, 0.08, 0.7) + wiggle(14, 0.04, 0.1, 0.6));
        add(sd > 0 ? B.lShoulder : B.rShoulder, 0, 0, sd * 0.2 * bump(u, 0.06, 0.7));
        mx("surprised", 0.7 * bump(u, 0.06, 0.3)); mx("happy", 0.8 * rise(u, 0.3) * decay(u, 0.8)); mx("closed", 0.6 * rise(u, 0.25) * decay(u, 0.8));
        break;
      case "head":         // looks up to see who it is
        add(B.head, -0.22 * bump(u, 0.15, 0.7), wiggle(2.5, 0.05, 0.2, 0.8), 0);
        mx("surprised", 0.35 * bump(u, 0.1, 0.5)); mx("happy", 0.4 * rise(u, 0.5) * decay(u, 0.85));
        break;
      case "shoulder":     // turns her head to see
        add(B.head, 0.02, sd * 0.55 * bump(u, 0.18, 0.7), sd * 0.05); add(B.neck, 0, sd * 0.2 * bump(u, 0.18, 0.7), 0);
        mx("surprised", 0.4 * bump(u, 0.1, 0.4)); mx("happy", 0.55 * rise(u, 0.45) * decay(u, 0.85));
        break;
      case "arm":          // tickled: the arm tucks in and she giggles
        add(sd > 0 ? B.lArm : B.rArm, 0, 0, -sd * 0.12 * bump(u, 0.08, 0.7) + wiggle(11, 0.03, 0.15, 0.8) * sd);
        add(B.head, 0, 0, sd * 0.1 * bump(u, 0.1, 0.8) + wiggle(10, 0.03, 0.2, 0.8));
        mx("happy", 0.95 * bump(u, 0.12, 0.8)); mx("closed", 0.5 * bump(u, 0.1, 0.7));
        break;
      case "hand":         // pokes back: a playful wiggle of the hand, with a smile
        add(sd > 0 ? B.lHand : B.rHand, 0, 0, sd * wiggle(7, 0.5, 0.1, 0.85));
        add(sd > 0 ? B.lFore : B.rFore, 0, 0, sd * 0.1 * bump(u, 0.1, 0.8));
        add(B.head, 0.03, sd * 0.2 * bump(u, 0.15, 0.7), sd * 0.1 * bump(u, 0.15, 0.7));
        mx("happy", 0.8 * bump(u, 0.15, 0.8));
        break;
      case "back":         // a startle from behind, then looking over her shoulder
        add(B.spine, -0.1 * bump(u, 0.05, 0.3), 0, 0); add(B.chest, -0.08 * bump(u, 0.05, 0.3), 0, 0);
        add(B.head, 0.03, 0.85 * bump(u, 0.2, 0.75), 0); add(B.neck, 0, 0.35 * bump(u, 0.2, 0.75), 0);
        add(B.lShoulder, 0, 0, 0.2 * bump(u, 0.05, 0.35)); add(B.rShoulder, 0, 0, -0.2 * bump(u, 0.05, 0.35));
        mx("surprised", bump(u, 0.04, 0.4)); mx("happy", 0.3 * rise(u, 0.6) * decay(u, 0.85));
        break;
      default:             // poked somewhere dull: a puzzled head tilt
        add(B.head, 0, 0, 0.16 * bump(u, 0.15, 0.75)); mx("surprised", 0.2 * bump(u, 0.1, 0.4));
    }
  };

  // ---- tickling: fingers wiggling on her. The laugh builds the longer it goes on, and a tickle while she is stretching catches her off guard.
  const TICKLISH: Partial<Record<Region, number>> = { ear: 1, arm: 1, back: 1, hand: 0.9, shoulder: 0.8, cheek: 0.55 };
  const tk = { level: 0, time: 0, touching: false, region: "other" as Region, side: 0, strength: 1, caught: 0, nextLine: 0, fresh: true, any: 0, grace: 0, gap: 0 };
  let tickleCount = 0;
  let forced: { region: Region; side: number; until: number } | null = null;
  /** One frame of a tickling finger at `origin` pointing along `dir`. */
  const tickle = (origin: THREE.Vector3, dir: THREE.Vector3, strength = 1): PokeHit | null => {
    const h = pick(origin, dir, 0.3 * s);
    tk.any = 0.12;                                   // the finger is down (this frame), whether or not it touches her
    tk.strength = strength;
    if (!h) { if (tk.grace <= 0) tk.touching = false; return null; }   // a finger that slips off for a moment keeps tickling
    tk.touching = true; tk.region = h.region; tk.side = h.side; tk.grace = 0.35;
    return h;
  };

  /** A finger jabbed at `origin` along `dir`: find what it hit and react. Returns the hit (or null when it met nothing). */
  const poke = (origin: THREE.Vector3, dir: THREE.Vector3): PokeHit | null => {
    const h = pick(origin, dir, 0.3 * s);
    if (!h) return null;
    ring(h.point);
    react(h.region, h.side);
    return h;
  };

  return {
    pick, poke, react, apply,
    tickle,
    setShrink,
    /** Tickle `region` for `seconds` without a finger (tests). */
    forceTickle(region: Region, seconds = 3, side = 0) { forced = { region, side, until: now + seconds }; },
    get tickling() { return tk.level; },
    get tickles() { return tickleCount; },
    get last() { return lastRegion; },
    get count() { return count; },
    get active() { return !!cur; },
    dispose() {
      rings.forEach((r) => { r.m.removeFromParent(); (r.m.material as THREE.Material).dispose(); });
      ringGeo.dispose();
    },
  };
}
