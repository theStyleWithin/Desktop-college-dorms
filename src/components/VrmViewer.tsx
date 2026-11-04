import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { VRMLoaderPlugin, VRMUtils, type VRM } from "@pixiv/three-vrm";

/** Live VRM/VRoid model viewer with a relaxed idle pose, blinking, and drag-to-turn. */
export default function VrmViewer({ url }: { url: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [err, setErr] = useState("");

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let disposed = false;
    let raf = 0;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      setState("error");
      setErr("3D preview isn't available on this device (WebGL is off).");
      return;
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
    };
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
  }, [url]);

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <div ref={host} className="vrm-box" />
      {state !== "ready" && (
        <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", padding: 16, textAlign: "center", color: "var(--muted)" }}>
          {state === "loading" ? "Loading model…" : err}
        </div>
      )}
    </div>
  );
}
