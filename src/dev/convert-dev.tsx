// Dev-only harness (not part of the production build): runs the FBX -> .glb conversion used for Unity packages in a plain
// browser page, against files served over HTTP, and reports what came out. Usage: /convert-dev.html?base=http://127.0.0.1:8099
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import * as THREE from "three";
import { fbxToGlb } from "../lib/unityPackage";

(async () => {
  const q = new URLSearchParams(location.search);
  const base = q.get("base") ?? "";
  const out = document.getElementById("out")!;
  try {
    const info = {
      model: `${base}/test.fbx`, model_ext: "fbx", model_name: "Test Room.fbx", notes: [],
      materials: [{ name: "Wall", tex: q.get("tex") === "0" ? null : `${base}/wall.png`, tex_ext: "png", color: [1, 0.5, 0.25] as [number, number, number] }],
    };
    const file = await fbxToGlb(info, undefined, (p) => p);
    const gltf = await new GLTFLoader().parseAsync(await file.arrayBuffer(), "");
    let meshes = 0, mapped = 0, tris = 0; const colors: string[] = [];
    gltf.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      meshes++; tris += (m.geometry.index ? m.geometry.index.count : m.geometry.getAttribute("position").count) / 3;
      const mat = m.material as THREE.MeshStandardMaterial;
      if (mat.map) mapped++;
      colors.push(mat.color.getHexString());
    });
    const res = { ok: true, name: file.name, bytes: file.size, meshes, mapped, tris, colors, mapW: (gltf.scene as THREE.Object3D) ? 1 : 0 };
    (window as unknown as { __result: unknown }).__result = res;
    out.textContent = JSON.stringify(res);
  } catch (e) {
    (window as unknown as { __result: unknown }).__result = { ok: false, error: String(e) };
    out.textContent = "FAILED " + String(e);
  }
})();
