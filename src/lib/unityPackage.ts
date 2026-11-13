import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { TGALoader } from "three/examples/jsm/loaders/TGALoader.js";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { convertFileSrc } from "@tauri-apps/api/core";
import { api, type PackageExtract, type PackageModel } from "../api";
import { fmtBytes } from "./util";

const MAX_PACKAGE = 4 * 1024 ** 3;
const MAX_TEXTURE = 2048;

type Mat = PackageExtract["materials"][number];

/** A picture from the package, scaled down to at most 2048 px (a room does not need more, and it keeps the saved room small). */
async function loadTexture(url: string, ext: string): Promise<THREE.Texture | null> {
  try {
    const buf = await (await fetch(url)).arrayBuffer();
    let w = 0, h = 0, draw: (g: CanvasRenderingContext2D, tw: number, th: number) => void;
    if (ext === "tga") {
      const t = new TGALoader().parse(buf) as unknown as { width: number; height: number; data: Uint8Array | Uint8ClampedArray; flipY?: boolean };
      w = t.width; h = t.height;
      const src = document.createElement("canvas"); src.width = w; src.height = h;
      src.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(t.data), w, h), 0, 0);
      draw = (g, tw, th) => { if (t.flipY) { g.translate(0, th); g.scale(1, -1); } g.drawImage(src, 0, 0, tw, th); };
    } else {
      const bmp = await createImageBitmap(new Blob([buf]));
      w = bmp.width; h = bmp.height;
      draw = (g, tw, th) => g.drawImage(bmp, 0, 0, tw, th);
    }
    const k = Math.min(1, MAX_TEXTURE / Math.max(w, h));
    const tw = Math.max(1, Math.round(w * k)), th = Math.max(1, Math.round(h * k));
    const c = document.createElement("canvas"); c.width = tw; c.height = th;
    draw(c.getContext("2d")!, tw, th);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace; tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    return tex;
  } catch (err) {
    console.warn("a picture in the package couldn't be read", err);
    return null;
  }
}

/** Turn the unpacked FBX (with the pictures and colours from the Unity materials put back on it) into one .glb file. */
export async function fbxToGlb(info: PackageExtract, onStep?: (m: string) => void, toUrl: (path: string) => string = convertFileSrc): Promise<File> {
  const buf = await (await fetch(toUrl(info.model))).arrayBuffer();
  const obj = new FBXLoader().parse(buf, "");
  const byName = new Map<string, Mat>(info.materials.map((m) => [m.name.toLowerCase(), m]));
  const cache = new Map<string, Promise<THREE.Texture | null>>();
  const meshes: THREE.Mesh[] = [];
  obj.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh); });
  let n = 0;
  for (const m of meshes) {
    const list = Array.isArray(m.material) ? m.material : [m.material];
    const out: THREE.Material[] = [];
    for (const old of list as THREE.MeshPhongMaterial[]) {
      onStep?.(`Putting the pictures on the room… ${++n}`);
      const entry = byName.get((old.name || "").toLowerCase());
      const std = new THREE.MeshStandardMaterial({ name: old.name, roughness: 0.9, metalness: 0, side: old.side, transparent: old.transparent, opacity: old.opacity });
      if (old.color) std.color.copy(old.color);
      if (old.map) std.map = old.map;
      if (entry?.color) std.color.setRGB(entry.color[0], entry.color[1], entry.color[2], THREE.SRGBColorSpace);
      if (entry?.tex && entry.tex_ext) {
        const key = entry.tex;
        if (!cache.has(key)) cache.set(key, loadTexture(toUrl(entry.tex), entry.tex_ext));
        const tex = await cache.get(key)!;
        if (tex) { std.map = tex; if (!entry.color) std.color.set(0xffffff); }
      }
      out.push(std);
    }
    m.material = Array.isArray(m.material) ? out : out[0];
  }
  onStep?.("Saving it as one 3D room file…");
  const glb = (await new GLTFExporter().parseAsync(obj, { binary: true, onlyVisible: true, maxTextureSize: MAX_TEXTURE })) as ArrayBuffer;
  const base = info.model_name.replace(/\.[^.]+$/, "") || "room";
  return new File([glb], `${base}.glb`, { type: "model/gltf-binary" });
}

/**
 * Open a Unity package and produce the room file the app can import (a .glb). Refuses, with a plain reason, packages that are too big or
 * have nothing usable in them. `choose` is asked when the package offers several models.
 */
export async function importUnityPackage(file: File, onStep: (message: string) => void, choose: (models: PackageModel[]) => Promise<PackageModel | null>): Promise<File | null> {
  if (file.size > MAX_PACKAGE) throw new Error(`That package is ${fmtBytes(file.size)}, which is too big (4 GB at most).`);
  // unpacking and converting need room beside the package itself: ask for about three times its size
  const token = await api.uploadRoomFile(file, (f) => onStep(`Sending the package to the app… ${Math.round(f * 100)}%`), 3);
  try {
    onStep("Looking inside the package…");
    const report = await api.roomPackageScan(token);
    const model = report.models.length === 1 ? report.models[0] : await choose(report.models);
    if (!model) return null;
    onStep(`Unpacking ${model.name}…`);
    const info = await api.roomPackageExtract(token, model.guid);
    if (info.model_ext === "glb") {
      const buf = await (await fetch(convertFileSrc(info.model))).arrayBuffer();
      return new File([buf], info.model_name, { type: "model/gltf-binary" });
    }
    onStep("Converting it to a 3D room…");
    return await fbxToGlb(info, onStep);
  } finally {
    await api.roomPackageCleanup(token).catch(() => {});
  }
}
