import * as THREE from "three";
import type { VRM } from "@pixiv/three-vrm";

/**
 * A relaxed standing idle for any VRM (0.x or 1.0). The humanoid is posed out of its T-pose (arms down, elbows
 * softly bent, fingers loosely curled) and then moved a little every frame: breathing, a slow weight shift,
 * small head movements, eyes that follow the camera, and natural blinking.
 */
type Bone = THREE.Object3D | null;

export function createIdle(vrm: VRM, camera: THREE.Camera) {
  const bone = (n: string): Bone => {
    try { return (vrm.humanoid.getNormalizedBoneNode(n as never) as Bone) ?? null; } catch { return null; }
  };
  const B = {
    hips: bone("hips"), spine: bone("spine"), chest: bone("chest"), upperChest: bone("upperChest"), neck: bone("neck"), head: bone("head"),
    lShoulder: bone("leftShoulder"), rShoulder: bone("rightShoulder"),
    lArm: bone("leftUpperArm"), rArm: bone("rightUpperArm"),
    lFore: bone("leftLowerArm"), rFore: bone("rightLowerArm"),
    lHand: bone("leftHand"), rHand: bone("rightHand"),
    lLeg: bone("leftUpperLeg"), rLeg: bone("rightUpperLeg"),
    lShin: bone("leftLowerLeg"), rShin: bone("rightLowerLeg"),
    lFoot: bone("leftFoot"), rFoot: bone("rightFoot"),
  };
  // how far each finger segment curls when she grips something (a mug handle, the edge of a phone)
  const GRIP = [[0.95, 1.25, 0.9], [1.1, 1.35, 0.95], [1.2, 1.35, 0.95], [1.25, 1.3, 0.9]];
  const fingers = (side: "left" | "right") =>
    ["Index", "Middle", "Ring", "Little"].flatMap((f, fi) =>
      ["Proximal", "Intermediate", "Distal"].map((seg, i) => ({ node: bone(`${side}${f}${seg}`), curl: [0.28, 0.42, 0.26][i], target: GRIP[fi][i] })));
  /** 0..1 how tightly each hand is closed around something it holds (the NPC drives this), and how tight a fist that is. */
  const grip = { l: 0, r: 0, tightL: 1, tightR: 1 };
  // the thumb tucks in against the held thing: how far each thumb bone turns (x, y, z) at full grip
  const thumbs = (side: "left" | "right") => ["Metacarpal", "Proximal", "Distal"].map((seg) => bone(`${side}Thumb${seg}`));
  const lThumb = thumbs("left"), rThumb = thumbs("right");
  const THUMB = { pose: [[0, 0, 0], [0, 0, 0], [0, 0, 0]] as [number, number, number][] };
  const lFingers = fingers("left");
  const rFingers = fingers("right");

  // eyes look at the camera, which reads as the character noticing you
  if (vrm.lookAt) vrm.lookAt.target = camera;

  // VRM 0.x models are authored facing the opposite way, and three-vrm keeps their bone axes as authored. Compared
  // with VRM 1.0 that mirrors rotations about X and Z (turning about the vertical Y axis is unchanged), so the
  // same pose needs those two signs flipped or the arms swing up instead of down.
  const m = vrm.meta?.metaVersion === "0" ? -1 : 1;
  const hipsBase = B.hips ? B.hips.position.clone() : new THREE.Vector3();
  let nextBlink = 1.5;
  const eul = new THREE.Euler();
  const set = (n: Bone, x: number, y: number, z: number) => { if (n) n.quaternion.setFromEuler(eul.set(x * m, y, z * m)); };

  // Soft-body physics. The model's own spring bones (hair, skirt, sleeves, ears, and chest/bust bones when it has
  // them) are simulated by three-vrm; here we only retune the *chest* joints per mode and leave the rest as authored.
  // "natural" loosens them a little from the VRoid defaults (which are stiff), "bouncy" a lot, "off" freezes all.
  type Physics = "off" | "natural" | "bouncy";
  const joints = [...(vrm.springBoneManager?.joints ?? [])].map((j) => ({
    j, stiff: j.settings.stiffness, drag: j.settings.dragForce,
    soft: /bust|breast|oppai|mune|chichi|boob/i.test(j.bone.name),
  }));
  const setPhysics = (mode: Physics) => {
    for (const { j, stiff, drag, soft } of joints) {
      if (mode === "off") { j.settings.stiffness = 8; j.settings.dragForce = 1; }
      else if (soft && mode === "natural") { j.settings.stiffness = stiff * 0.55; j.settings.dragForce = Math.max(drag * 0.7, 0.03); }
      else if (soft && mode === "bouncy") { j.settings.stiffness = stiff * 0.28; j.settings.dragForce = Math.max(drag * 0.5, 0.02); }
      else { j.settings.stiffness = stiff; j.settings.dragForce = drag; }
    }
  };
  setPhysics("natural");

  // how far the chest spring bones have swung from rest, in milliradians (tests and bug reports read this)
  const bust = joints.filter((x) => x.soft).map((x) => ({ n: x.j.bone, rest: x.j.bone.quaternion.clone(), peak: 0 }));
  const resetPeak = () => bust.forEach((b) => { b.peak = 0; });

  // a little hop (two bounces, the second smaller): moves the whole body, which is what sets the springs off
  const sceneY = vrm.scene.position.y;
  let hopStart = -1;
  const hop = (t: number) => { hopStart = t; };
  let nextDeepBreath = 6;

  // expression levels other systems (the NPC behavior) can ask for; idle blends them with its own blinking
  const mood = { happy: 0, angry: 0, sad: 0, surprised: 0, closed: 0, mouth: 0 };
  const read = (n: Bone): [number, number, number] => {
    if (!n) return [0, 0, 0];
    eul.setFromQuaternion(n.quaternion, "XYZ");
    return [eul.x * m, eul.y, eul.z * m];
  };
  const state = { hopY: 0, sceneY };

  return {
    mood, read, set, m, state, grip, THUMB,
    setPhysics,
    hop,
    resetPeak,
    jiggle: () => Math.round(Math.max(0, ...bust.map((b) => b.peak)) * 1000),
    update(t: number, dt: number, pet?: { amount: number; lx: number; ly: number; stroke: number; near?: number }, after?: (t: number, dt: number) => void) {
      const pa = pet?.amount ?? 0, plx = pet?.lx ?? 0, ply = pet?.ly ?? 0, pst = pet?.stroke ?? 0;
      let breath = Math.sin(t * 1.55);                   // ~ 15 breaths a minute
      // now and then a deeper breath, which gently heaves the chest
      if (t > nextDeepBreath) { if (t > nextDeepBreath + 2.2) nextDeepBreath = t + 6 + Math.random() * 6; else breath = breath * 0.4 + Math.sin(((t - nextDeepBreath) / 2.2) * Math.PI) * 1.6; }
      const sway = Math.sin(t * 0.42);                   // slow weight shift
      const look = Math.sin(t * 0.37);

      let hopY = 0;
      if (hopStart >= 0) {
        const p = (t - hopStart) / 0.9;
        if (p >= 1) hopStart = -1;
        else { const q = p < 0.55 ? p / 0.55 : (p - 0.55) / 0.45; hopY = (p < 0.55 ? 0.075 : 0.035) * 4 * q * (1 - q); }
      }
      state.hopY = hopY;
      vrm.scene.position.y = sceneY + hopY;

      if (B.hips) B.hips.position.set(hipsBase.x + m * sway * 0.012, hipsBase.y + breath * 0.0012, hipsBase.z);
      set(B.hips, 0, sway * 0.018, -sway * 0.012);
      set(B.spine, 0.012 + breath * 0.006, -sway * 0.012, sway * 0.014);
      set(B.chest, 0.01 + breath * 0.014, 0, 0);
      set(B.upperChest, breath * 0.01, 0, 0);
      set(B.neck, -0.01 + look * 0.012, Math.sin(t * 0.5) * 0.04, 0);
      // being petted: the head leans into the hand, tips down a little, and the stroking rocks it so hair and ears swish
      const rock = Math.sin(t * 7.5) * 0.03 * pst * pa;
      set(B.head, 0.015 + Math.sin(t * 0.9) * 0.012 + pa * (0.1 - ply * 0.08), Math.sin(t * 0.5 + 1) * 0.05 * (1 - pa) + plx * 0.12 * pa, -sway * 0.012 * (1 - pa) - plx * 0.3 * pa + rock);
      if (pa > 0.01) set(B.neck, -0.01 + look * 0.012 + pa * 0.05, Math.sin(t * 0.5) * 0.04 * (1 - pa) + plx * 0.05 * pa, -plx * 0.1 * pa);

      // arms down out of the T-pose, elbows softly bent
      const armDrop = 1.18 + breath * 0.012;
      set(B.lShoulder, 0, 0, -0.04 - breath * 0.01); set(B.rShoulder, 0, 0, 0.04 + breath * 0.01);
      set(B.lArm, 0.06, 0.05, -armDrop); set(B.rArm, 0.06, -0.05, armDrop);
      set(B.lFore, 0, -0.22, -0.04); set(B.rFore, 0, 0.22, 0.04);
      set(B.lHand, 0, 0, -0.06); set(B.rHand, 0, 0, 0.06);
      for (const f of lFingers) set(f.node, 0, 0, -(f.curl + grip.l * (f.target * grip.tightL - f.curl)));
      for (const f of rFingers) set(f.node, 0, 0, f.curl + grip.r * (f.target * grip.tightR - f.curl));
      // the thumbs (a gripping thumb folds over the held thing; left is the mirror of right)
      THUMB.pose.forEach(([x, y, z], i) => { if (grip.r > 0.01) set(rThumb[i], x * grip.r, y * grip.r, z * grip.r); if (grip.l > 0.01) set(lThumb[i], x * grip.l, -y * grip.l, -z * grip.l); });

      // a relaxed stance: feet a little apart
      set(B.lLeg, 0, 0, -0.035 + sway * 0.006); set(B.rLeg, 0, 0, 0.035 + sway * 0.006);
      set(B.lShin, 0.01, 0, 0); set(B.rShin, 0.01, 0, 0);

      after?.(t, dt);
      const em = vrm.expressionManager;
      if (em) {
        const ph = t - nextBlink;
        em.setValue("blink", Math.max(ph > 0 && ph < 0.17 ? Math.sin((ph / 0.17) * Math.PI) : 0, pa * 0.7, mood.closed));
        em.setValue("happy", Math.max(pa * 0.85, mood.happy));
        em.setValue("angry", mood.angry);
        em.setValue("sad", mood.sad);
        em.setValue("surprised", mood.surprised);
        em.setValue("aa", mood.mouth);
        if (ph >= 0.17) nextBlink = t + 2.4 + Math.random() * 3.6;
      }
      vrm.update(dt);
      for (const b of bust) b.peak = Math.max(b.peak, b.n.quaternion.angleTo(b.rest));
    },
    bones: B,
  };
}
