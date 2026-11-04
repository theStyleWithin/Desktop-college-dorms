import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { VRMLoaderPlugin, VRMUtils, type VRM } from "@pixiv/three-vrm";
import { api } from "../api";

// One verdict per app run, shared by every viewer (see the crash guard in the backend).
let verdict: Promise<boolean> | null = null;
const glAllowed = () => (verdict ??= api.vrmGuardBegin().catch(() => true));
const glConfirmed = () => { api.vrmGuardEnd().catch(() => {}); };
const glReset = async () => { await api.vrmGuardEnd().catch(() => {}); verdict = null; };

/** Live VRM/VRoid model viewer with a relaxed idle pose, blinking, and drag-to-turn. */
export default function VrmViewer({ url }: { url: string }) {
  const host = useRef<HTMLDivElement>(null);
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
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      glConfirmed(); // no crash: WebGL simply isn't available
      setState("error");
      setErr("3D preview isn't available on this device (WebGL is off).");
      return () => {};
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(30, 1, 0.05, 50);
    const key = new THREE.DirectionalLight(0xffffff, Math.PI * 0.9);
    key.position.set(1, 1.6, 2);
    scene.add(key, new THREE.AmbientLight(0xffffff, 0.7));

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
    let yaw = 0;
    let dragging = false, lastX = 0;
    const down = (e: PointerEvent) => { dragging = true; lastX = e.clientX; el.setPointerCapture(e.pointerId); };
    const move = (e: PointerEvent) => { if (dragging) { yaw += (e.clientX - lastX) * 0.01; lastX = e.clientX; } };
    const up = () => { dragging = false; };
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);

    const loader = new GLTFLoader();
    loader.register((p) => new VRMLoaderPlugin(p));
    loader
      .loadAsync(url)
      .then((gltf) => {
        if (disposed) return;
        const v = gltf.userData.vrm as VRM | undefined;
        if (!v) throw new Error("This file isn't a VRM model.");
        VRMUtils.removeUnnecessaryVertices(gltf.scene);
        VRMUtils.rotateVRM0(v);
        vrm = v;
        tLoaded = performance.now();
        scene.add(v.scene);
        // relaxed pose: arms down instead of the default T-pose
        const h = v.humanoid;
        const la = h.getNormalizedBoneNode("leftUpperArm");
        const ra = h.getNormalizedBoneNode("rightUpperArm");
        if (la) la.rotation.z = -1.2;
        if (ra) ra.rotation.z = 1.2;
        // frame the whole model
        const box = new THREE.Box3().setFromObject(v.scene);
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        const dist = (size.y / 2 / Math.tan((camera.fov * Math.PI) / 360)) * 1.25;
        camera.position.set(0, center.y, dist + size.z);
        camera.lookAt(center);
        setState("ready");
      })
      .catch((e) => {
        if (disposed) return;
        glConfirmed(); // the file was bad, but the graphics stack didn't crash
        setState("error");
        setErr(e instanceof Error ? e.message : String(e));
      });

    const clock = new THREE.Clock();
    let nextBlink = 2;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const dt = clock.getDelta();
      const t = clock.elapsedTime;
      if (vrm) {
        vrm.scene.rotation.y = yaw;
        const spine = vrm.humanoid.getNormalizedBoneNode("spine");
        const head = vrm.humanoid.getNormalizedBoneNode("head");
        if (spine) spine.rotation.x = Math.sin(t * 1.4) * 0.012;
        if (head) { head.rotation.y = Math.sin(t * 0.6) * 0.06; head.rotation.x = Math.sin(t * 0.9) * 0.02; }
        const em = vrm.expressionManager;
        if (em) {
          const phase = t - nextBlink;
          em.setValue("blink", phase > 0 && phase < 0.16 ? Math.sin((phase / 0.16) * Math.PI) : 0);
          if (phase >= 0.16) nextBlink = t + 2.5 + Math.random() * 3;
        }
        vrm.update(dt);
      }
      renderer.render(scene, camera);
      // The guard stays armed until the *model* has rendered for a while: an empty scene can look fine
      // on drivers that crash as soon as real meshes and textures reach the GPU.
      if (vrm && !confirmed && ++framesWithModel >= 3 && performance.now() - tLoaded > 1200) { confirmed = true; glConfirmed(); }
    };
    let confirmed = false;
    let framesWithModel = 0;
    let tLoaded = Infinity;
    tick();

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      if (vrm) VRMUtils.deepDispose(vrm.scene);
      renderer.dispose();
      renderer.domElement.remove();
    };
    }
  }, [url, attempt]);

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <div ref={host} className="vrm-box" />
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
