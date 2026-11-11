import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { VRMLoaderPlugin, VRMUtils, type VRM } from "@pixiv/three-vrm";
import { api } from "../api";
import { createIdle } from "../lib/idle";
import { buildRoom } from "../lib/room";
import { createHands } from "../lib/hands";
import { createNpc, type PlanName } from "../lib/npc";

// One verdict per app run, shared by every viewer (see the crash guard in the backend).
let verdict: Promise<boolean> | null = null;
const glAllowed = () => (verdict ??= api.vrmGuardBegin().catch(() => true));
const glConfirmed = () => { api.vrmGuardEnd().catch(() => {}); };
const glReset = async () => { await api.vrmGuardEnd().catch(() => {}); verdict = null; };

interface Props {
  url: string;
  /** Wider framing that shows off the room (the big viewer); the small panels frame the character. */
  large?: boolean;
  /** Someone is talking to her (typing or waiting for a reply): she stops her routine and pays attention. */
  attentive?: boolean;
  /** Shows an expand button that opens the big viewer. */
  onExpand?: () => void;
}

/**
 * A 3D viewer for VRM / VRoid models: the character stands idle in a furnished room, with soft shadows, orbit
 * camera controls (drag to turn, scroll or pinch to zoom, double-click to reset) and eyes that follow the camera.
 */
export default function VrmViewer({ url, large, attentive, onExpand }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const resetView = useRef<() => void>(() => {});
  const idleRef = useRef<ReturnType<typeof createIdle> | null>(null);
  const simClock = useRef(0);
  const [frozen, setFrozen] = useState(false);
  const frozenRef = useRef(false);
  frozenRef.current = frozen;
  const [physics, setPhysicsMode] = useState<"off" | "natural" | "bouncy">(() => {
    try { const v = localStorage.getItem("dorms.vrm.physics"); if (v === "off" || v === "bouncy" || v === "natural") return v; } catch { /* storage unavailable */ }
    return "natural";
  });
  const npcRef = useRef<ReturnType<typeof createNpc> | null>(null);
  const [lively, setLively] = useState<boolean>(() => {
    try { return localStorage.getItem("dorms.vrm.lively") !== "0"; } catch { return true; }
  });
  const livelyRef = useRef(lively);
  livelyRef.current = lively;
  const attentiveRef = useRef(!!attentive);
  attentiveRef.current = !!attentive;
  const handsRef = useRef<ReturnType<typeof createHands> | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const [handsOn, setHandsOn] = useState(false);
  const [pad, setPad] = useState(false);
  const physicsRef = useRef(physics);
  physicsRef.current = physics;
  const [state, setState] = useState<"loading" | "ready" | "error" | "blocked">("loading");
  const [err, setErr] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let disposed = false;
    let cleanup = () => {};
    setState("loading");
    glAllowed().then((ok) => {
      if (disposed) return;
      if (!ok) { setState("blocked"); return; }
      cleanup = start(el);
    });
    return () => { disposed = true; cleanup(); };

    function start(el: HTMLDivElement): () => void {
      let raf = 0;
      let renderer: THREE.WebGLRenderer;
      try {
        renderer = new THREE.WebGLRenderer({ antialias: true });
      } catch {
        glConfirmed(); // no crash: WebGL simply isn't available
        setState("error");
        setErr("3D preview isn't available on this device (WebGL is off).");
        return () => {};
      }
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      el.appendChild(renderer.domElement);

      const scene = new THREE.Scene();
      const bg = new THREE.Color("#171329");
      scene.background = bg;
      scene.fog = new THREE.Fog(bg, 9, 20);
      const camera = new THREE.PerspectiveCamera(32, 1, 0.05, 60);

      // lighting: soft sky/ground fill, a warm key light that casts shadows, a cool light from the window side
      const hemi = new THREE.HemisphereLight(0xdfe4ff, 0x4a3b45, 1.15);
      scene.add(hemi);
      const key = new THREE.DirectionalLight(0xfff0dd, 2.4);
      key.position.set(2.6, 4.2, 3.2);
      key.castShadow = true;
      key.shadow.mapSize.set(1024, 1024);
      key.shadow.camera.left = -3; key.shadow.camera.right = 3; key.shadow.camera.top = 3.5; key.shadow.camera.bottom = -2;
      key.shadow.camera.near = 0.5; key.shadow.camera.far = 14;
      key.shadow.bias = -0.0004; key.shadow.normalBias = 0.02; key.shadow.radius = 4;
      scene.add(key, key.target);
      const cool = new THREE.DirectionalLight(0x8fa8ff, 0.9);
      cool.position.set(-3.5, 2.5, 1.5);
      scene.add(cool);
      const keyBase = new THREE.Vector3();

      const room = buildRoom();
      scene.add(room.group);

      const controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.dampingFactor = 0.08;
      controls.enablePan = false;
      controls.rotateSpeed = 0.75;
      controls.zoomSpeed = 0.8;
      controls.minPolarAngle = 0.35;
      controls.maxPolarAngle = Math.PI / 2 - 0.03;  // never below the floor
      controls.minAzimuthAngle = -Math.PI * 0.6;    // stay inside the room's open side
      controls.maxAzimuthAngle = Math.PI * 0.6;
      controls.maxDistance = 4.6;
      controlsRef.current = controls;

      const resize = () => {
        const w = Math.max(el.clientWidth, 1), h = Math.max(el.clientHeight, 1);
        renderer.setSize(w, h);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
      };
      const ro = new ResizeObserver(resize);
      ro.observe(el);
      resize();

      let vrm: VRM | undefined;
      let idle: ReturnType<typeof createIdle> | undefined;
      let hands: ReturnType<typeof createHands> | undefined;
      let npc: ReturnType<typeof createNpc> | undefined;
      const onNpc = (e: Event) => { const n = (e as CustomEvent<PlanName>).detail; if (npc && n) npc.force(n); };
      el.addEventListener("npc", onNpc);
      const headPos = new THREE.Vector3();
      // plugging in a controller turns the hands on (in the big viewer, where there's room to play)
      const onPad = () => { setPad(true); if (large) setHandsOn(true); };
      const onPadGone = () => { if (!navigator.getGamepads?.().some((g) => g)) setPad(false); };
      window.addEventListener("gamepadconnected", onPad);
      window.addEventListener("gamepaddisconnected", onPadGone);
      if (navigator.getGamepads?.().some((g) => g)) setPad(true);
      const home = { pos: new THREE.Vector3(0, 1.4, 3.4), target: new THREE.Vector3(0, 0.95, 0) };
      // the camera follows her around the room: `follow` is how far she is from the middle, and it moves the whole rig
      const follow = new THREE.Vector3(), lastFollow = new THREE.Vector3(), npcPos = new THREE.Vector3();
      resetView.current = () => { camera.position.copy(home.pos).add(follow); controls.target.copy(home.target).add(follow); lastFollow.copy(follow); controls.update(); };
      const onDbl = () => resetView.current();
      renderer.domElement.addEventListener("dblclick", onDbl);

      const loader = new GLTFLoader();
      loader.register((p) => new VRMLoaderPlugin(p));
      loader
        .loadAsync(url)
        .then((gltf) => {
          if (disposed) return;
          const v = gltf.userData.vrm as VRM | undefined;
          if (!v) throw new Error("This file isn't a VRM model.");
          VRMUtils.removeUnnecessaryVertices(gltf.scene);
          // VRM 0.x models (what VRoid Studio exports) face the other way; this turns them to face the camera.
          VRMUtils.rotateVRM0(v);
          vrm = v;
          v.scene.traverse((o) => {
            const m = o as THREE.Mesh;
            if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; m.frustumCulled = false; }
          });
          scene.add(v.scene);
          // stand on the floor, at the centre of the rug
          const box = new THREE.Box3().setFromObject(v.scene);
          v.scene.position.y -= box.min.y;
          const H = Math.max(box.getSize(new THREE.Vector3()).y, 0.5);
          // scale the room to the character, so a child-sized or giant model still feels at home in it
          room.group.scale.setScalar(H / 1.6);
          key.position.multiplyScalar(H / 1.6);
          idle = createIdle(v, camera);
          idle.setPhysics(physicsRef.current);
          idleRef.current = idle;
          keyBase.copy(key.position);
          npc = createNpc({ vrm: v, idle, camera, scene, scale: H / 1.6 });
          npc.enabled = livelyRef.current;
          if (attentiveRef.current) npc.setAttentive(true);
          npcRef.current = npc;
          hands = createHands({ scene, camera, dom: renderer.domElement, head: headPos, scale: H / 1.6 });
          handsRef.current = hands;
          const fov = (camera.fov * Math.PI) / 180;
          const fit = (H * (large ? 1.55 : 1.18)) / 2 / Math.tan(fov / 2);
          const dist = Math.max(fit, 1.2);
          home.target.set(0, H * (large ? 0.52 : 0.5), 0);
          home.pos.set(0, H * (large ? 0.78 : 0.62), dist);
          controls.minDistance = Math.max(H * 0.5, 0.6);
          controls.maxDistance = Math.max(4.6 * (H / 1.6), dist * 1.6);
          controls.target.copy(home.target);
          camera.position.copy(home.pos);
          controls.update();
          el.dataset.vrm = v.meta?.metaVersion ?? "?";
          setState("ready");
        })
        .catch((e) => {
          if (disposed) return;
          glConfirmed(); // the file was bad, but the graphics stack didn't crash
          setState("error");
          setErr(e instanceof Error ? e.message : String(e));
        });

      const clock = new THREE.Clock();
      let simT = 0;
      const pw = new THREE.Vector3();
      let confirmed = false;
      let framesWithModel = 0;
      let tLoaded = Infinity;
      const tick = () => {
        raf = requestAnimationFrame(tick);
        const dtReal = Math.min(clock.getDelta(), 0.1);
        // "stop time" freezes her completely (pose, walking, breathing, blinking, physics, eyes); the camera and hands still move
        const isFrozen = frozenRef.current;
        const dt = isFrozen ? 0 : dtReal;
        simT += dt; simClock.current = simT;
        const t = simT;
        if (vrm && idle) {
          if (tLoaded === Infinity) tLoaded = performance.now();
          const hb = idle.bones.head;
          if (hb && hands) hb.getWorldPosition(headPos).y += 0.07 * room.group.scale.x; // the head joint sits at the neck; aim at the middle of the head
          if (hands) { hands.update(dtReal); el.dataset.petting = String(Math.round(hands.pet.amount * 100)); el.dataset.near = String(Math.round(hands.pet.near * 100)); }
          if (!isFrozen) {
          if (npc) npc.setPetting(hands?.pet.amount ?? 0, dt);
          idle.update(t, dt, hands?.pet, npc ? npc.apply : undefined);
          if (npc) {
            npc.position(npcPos);
            // follow her around the room (smoothly); lights and shadows come with her, and the room dims while she sleeps
            const k = 1 - Math.exp(-2.2 * dt);
            follow.x += (npcPos.x - follow.x) * k; follow.z += (npcPos.z - follow.z) * k;
            const dx = follow.x - lastFollow.x, dz = follow.z - lastFollow.z;
            camera.position.x += dx; camera.position.z += dz; controls.target.x += dx; controls.target.z += dz;
            lastFollow.copy(follow);
            key.position.copy(keyBase).add(follow); key.target.position.copy(follow); key.target.updateMatrixWorld();
            if (hands) hands.center.set(follow.x, 0, follow.z);
            const sl = npc.sleepAmount;
            hemi.intensity = 1.15 - 0.6 * sl; key.intensity = 2.4 - 1.5 * sl; cool.intensity = 0.9 - 0.5 * sl;
            el.dataset.npc = npc.label; el.dataset.plan = npc.plan; el.dataset.npcx = String(Math.round(npcPos.x * 100)); el.dataset.npcz = String(Math.round(npcPos.z * 100));
          }
          }
          // exposes what the viewer sees, so tests (and bug reports) can check the model faces us with arms down
          if (framesWithModel === 6 && idle.bones.lArm && idle.bones.rArm && idle.bones.lHand) {
            vrm.scene.updateMatrixWorld(true);
            const lx = idle.bones.lArm.getWorldPosition(pw).x;
            const ly = pw.y;
            const rx = idle.bones.rArm.getWorldPosition(pw).x;
            const hy = idle.bones.lHand.getWorldPosition(pw).y;
            el.dataset.facing = lx > rx ? "front" : "back";
            el.dataset.pose = hy < ly - 0.12 ? "relaxed" : "raised";
            el.dataset.ready = "1";
          }
          if (framesWithModel > 6) el.dataset.jiggle = String(idle.jiggle());
        }
        controls.update();
        renderer.render(scene, camera);
        // The guard stays armed until the *model* has rendered for a while: an empty scene can look fine
        // on drivers that crash as soon as real meshes and textures reach the GPU.
        if (vrm) framesWithModel++;
        if (vrm && !confirmed && framesWithModel >= 3 && performance.now() - tLoaded > 1200) { confirmed = true; glConfirmed(); }
      };
      tick();

      return () => {
        disposed = true;
        cancelAnimationFrame(raf);
        ro.disconnect();
        renderer.domElement.removeEventListener("dblclick", onDbl);
        window.removeEventListener("gamepadconnected", onPad);
        window.removeEventListener("gamepaddisconnected", onPadGone);
        el.removeEventListener("npc", onNpc);
        npc?.dispose(); npcRef.current = null;
        hands?.dispose(); handsRef.current = null; controlsRef.current = null;
        controls.dispose();
        if (vrm) VRMUtils.deepDispose(vrm.scene);
        room.dispose();
        renderer.dispose();
        renderer.domElement.remove();
        idleRef.current = null;
        delete el.dataset.npc; delete el.dataset.npcx; delete el.dataset.npcz; delete el.dataset.frozen; delete el.dataset.plan; delete el.dataset.petting; delete el.dataset.near; delete el.dataset.hands; delete el.dataset.ready; delete el.dataset.facing; delete el.dataset.pose; delete el.dataset.vrm;
      };
    }
  }, [url, attempt, large]);

  useEffect(() => {
    idleRef.current?.setPhysics(physics);
    idleRef.current?.resetPeak();
    try { localStorage.setItem("dorms.vrm.physics", physics); } catch { /* storage unavailable */ }
  }, [physics]);
  useEffect(() => {
    const h = handsRef.current, c = controlsRef.current;
    if (h) h.enabled = handsOn;
    if (c) c.enabled = !handsOn;     // the pointer drives the hand instead of the camera while hands are on
    const el = host.current;
    if (el) { if (handsOn) el.dataset.hands = "1"; else delete el.dataset.hands; }
  }, [handsOn, state]);
  useEffect(() => { if (npcRef.current) npcRef.current.enabled = lively; try { localStorage.setItem("dorms.vrm.lively", lively ? "1" : "0"); } catch { /* storage unavailable */ } }, [lively]);
  useEffect(() => { npcRef.current?.setAttentive(!!attentive); }, [attentive]);
  // Space pauses and plays, like a video (not while typing, and only in the big viewer so a page scroll isn't hijacked)
  useEffect(() => {
    if (!large) return;
    const k = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.code !== "Space" || e.repeat || (t && /^(input|textarea|select|button)$/i.test(t.tagName)) || t?.isContentEditable) return;
      e.preventDefault(); setFrozen((v) => !v);
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [large]);
  useEffect(() => {
    const el = host.current;
    if (el) { if (frozen) el.dataset.frozen = "1"; else delete el.dataset.frozen; }
  }, [frozen, state]);
  const nextPhysics = { natural: "bouncy", bouncy: "off", off: "natural" } as const;
  const physicsLabel = { natural: "Natural", bouncy: "Bouncy", off: "Off" }[physics];

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <div ref={host} className="vrm-box" />
      {state === "ready" && (
        <div className="vrm-tools">
          <button className={`iconbtn${frozen ? " on" : ""}`} title={frozen ? "Play: time moves again (Space)" : "Pause: freezes her in place, you can still look around (Space)"} aria-label={frozen ? "Play" : "Pause"} data-paused={frozen ? "1" : "0"}
            onClick={() => setFrozen((v) => !v)}>
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" fill="currentColor">{frozen ? <path d="M3 1.5v11l9-5.5z" /> : <><rect x="2.5" y="1.5" width="3.2" height="11" rx="0.8" /><rect x="8.3" y="1.5" width="3.2" height="11" rx="0.8" /></>}</svg>
          </button>
          <button className={`iconbtn${lively ? " on" : ""}`} title="Lively: she goes about her day when you are not talking to her (click to turn on or off)" aria-label="Lively" aria-pressed={lively}
            onClick={() => setLively((v) => !v)}>🎭</button>
          <button className={`iconbtn${handsOn ? " on" : ""}`} title="Your hands: pet her with a controller, or with the mouse or touch (click to turn on or off)" aria-label="Hands" aria-pressed={handsOn}
            onClick={() => setHandsOn((v) => !v)}>🖐</button>
          <button className="iconbtn" title={`Soft-body physics: ${physicsLabel} (click to change)`} aria-label={`Physics ${physicsLabel}`} data-physics={physics}
            onClick={() => setPhysicsMode(nextPhysics[physics])}>〰</button>
          <button className="iconbtn" title="Hop (shows the physics)" aria-label="Hop"
            onClick={() => idleRef.current?.hop(simClock.current)}>⤒</button>
          <button className="iconbtn" title="Reset the view (or double-click)" aria-label="Reset view" onClick={() => resetView.current()}>⟲</button>
          {onExpand && <button className="iconbtn" title="Open the big 3D viewer" aria-label="Open big viewer" onClick={onExpand}>⛶</button>}
        </div>
      )}
      {state === "ready" && frozen && <div className="vrm-frozen" aria-live="polite"><svg width="10" height="10" viewBox="0 0 14 14" aria-hidden="true" fill="currentColor"><rect x="2" y="1" width="3.6" height="12" rx="1" /><rect x="8.4" y="1" width="3.6" height="12" rx="1" /></svg> Paused</div>}
      {state === "ready" && large && (
        <div className="vrm-hint">
          {handsOn
            ? pad
              ? "Sticks move your hands · triggers reach in · bumpers pull back · A grips · stroke her head"
              : "Move to reach · press and hold to touch · stroke her head or ears · 🖐 to turn off"
            : "Drag to turn · scroll or pinch to zoom · double-click to reset · 🖐 for your hands"}
        </div>
      )}
      {state !== "ready" && (
        <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", padding: 16, textAlign: "center", color: "var(--muted)", gap: 8, alignContent: "center" }}>
          {state === "loading" && "Loading model…"}
          {state === "error" && err}
          {state === "blocked" && (
            <>
              <div>3D preview is off because it crashed the window last time. Your graphics drivers may not support WebGL.</div>
              <button className="btn sm" onClick={async () => { await glReset(); setAttempt((a) => a + 1); }}>Try again</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
