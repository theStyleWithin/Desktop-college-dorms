import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import type { CustomLayout, Room as BuiltRoom } from "./room";

/** An imported 3D scene put in the room instead of the built-in one. */
export interface SceneCfg { url: string; ext: string; scale: number; rot: number; y: number }

export interface LoadedRoom extends BuiltRoom { layout: CustomLayout; stats: { triangles: number; walkable: number; floorFound: boolean } }

const CELL = 0.2;
const MAX_TRIS = 4_000_000;

/** All the triangles of an object, in the object's own world space, as a flat array of 9 numbers per triangle. */
function collectTriangles(root: THREE.Object3D): Float32Array {
  root.updateMatrixWorld(true);
  const meshes: THREE.Mesh[] = [];
  root.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh && m.geometry?.getAttribute("position") && m.visible) meshes.push(m); });
  let total = 0;
  for (const m of meshes) { const g = m.geometry; total += g.index ? g.index.count / 3 : g.getAttribute("position").count / 3; }
  const stride = Math.max(1, Math.ceil(total / MAX_TRIS)); // an enormous model is sampled, which is plenty for finding floor and furniture
  const out = new Float32Array(Math.ceil(total / stride) * 9);
  let n = 0; const v = new THREE.Vector3();
  for (const m of meshes) {
    const g = m.geometry, pos = g.getAttribute("position"), idx = g.index;
    const tris = idx ? idx.count / 3 : pos.count / 3;
    for (let t = 0; t < tris; t += stride) {
      for (let k = 0; k < 3; k++) {
        const vi = idx ? idx.getX(t * 3 + k) : t * 3 + k;
        v.fromBufferAttribute(pos, vi).applyMatrix4(m.matrixWorld);
        out[n++] = v.x; out[n++] = v.y; out[n++] = v.z;
      }
    }
  }
  return out.subarray(0, n);
}

/** Squared distance from point p to segment ab, all in 2D. */
const segD2 = (px: number, pz: number, ax: number, az: number, bx: number, bz: number) => {
  const dx = bx - ax, dz = bz - az, l = dx * dx + dz * dz;
  const t = l > 1e-12 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l)) : 0;
  const cx = ax + t * dx - px, cz = az + t * dz - pz;
  return cx * cx + cz * cz;
};
/** Is the point inside the triangle (xz projection), or within `pad` of it? */
function near2D(px: number, pz: number, t: Float32Array, o: number, pad: number): boolean {
  const ax = t[o], az = t[o + 2], bx = t[o + 3], bz = t[o + 5], cx = t[o + 6], cz = t[o + 8];
  const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
  if (Math.abs(d) > 1e-12) {
    const l1 = ((bz - cz) * (px - cx) + (cx - bx) * (pz - cz)) / d, l2 = ((cz - az) * (px - cx) + (ax - cx) * (pz - cz)) / d, l3 = 1 - l1 - l2;
    if (l1 >= 0 && l2 >= 0 && l3 >= 0) return true;
  }
  const p2 = pad * pad;
  return segD2(px, pz, ax, az, bx, bz) <= p2 || segD2(px, pz, bx, bz, cx, cz) <= p2 || segD2(px, pz, cx, cz, ax, az) <= p2;
}

/**
 * Work out where she can walk. Triangles are in room units with the floor at height 0.
 * Floor: upward-facing surfaces at about floor height. Furniture and walls: anything that stands between knee and head height.
 * Everything that is not floor, or has something standing on it, is blocked.
 */
export function analyseLayout(tris: Float32Array): { layout: CustomLayout; walkable: number; floorFound: boolean } {
  const n = tris.length / 9;
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  const isFloor = new Uint8Array(n);
  let floorTris = 0;
  for (let t = 0; t < n; t++) {
    const o = t * 9;
    const ay = tris[o + 1], by = tris[o + 4], cy = tris[o + 7];
    const ux = tris[o + 3] - tris[o], uy = by - ay, uz = tris[o + 5] - tris[o + 2];
    const vx = tris[o + 6] - tris[o], vy = cy - ay, vz = tris[o + 8] - tris[o + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    // either winding counts: the floor may be a single sheet that faces whichever way
    if (len > 1e-12 && Math.abs(ny) / len > 0.6 && Math.max(Math.abs(ay), Math.abs(by), Math.abs(cy)) < 0.12) {
      isFloor[t] = 1; floorTris++;
      for (let k = 0; k < 3; k++) { x0 = Math.min(x0, tris[o + k * 3]); x1 = Math.max(x1, tris[o + k * 3]); z0 = Math.min(z0, tris[o + k * 3 + 2]); z1 = Math.max(z1, tris[o + k * 3 + 2]); }
    }
  }
  const floorFound = floorTris > 0;
  if (!floorFound) {
    for (let t = 0; t < n; t++) for (let k = 0; k < 3; k++) { const o = t * 9 + k * 3; x0 = Math.min(x0, tris[o]); x1 = Math.max(x1, tris[o]); z0 = Math.min(z0, tris[o + 2]); z1 = Math.max(z1, tris[o + 2]); }
  }
  if (!isFinite(x0) || x1 - x0 < 1 || z1 - z0 < 1) { x0 = -4.5; x1 = 4.5; z0 = -4.1; z1 = 2.9; } // nothing usable: a default square
  const NX = Math.max(1, Math.ceil((x1 - x0) / CELL)), NZ = Math.max(1, Math.ceil((z1 - z0) / CELL));
  const floor = new Uint8Array(NX * NZ), block = new Uint8Array(NX * NZ);
  const cellsOf = (o: number, pad: number, f: (i: number, j: number) => void) => {
    let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity;
    for (let k = 0; k < 3; k++) { a = Math.min(a, tris[o + k * 3]); b = Math.max(b, tris[o + k * 3]); c = Math.min(c, tris[o + k * 3 + 2]); d = Math.max(d, tris[o + k * 3 + 2]); }
    const i0 = Math.max(0, Math.floor((a - pad - x0) / CELL)), i1 = Math.min(NX - 1, Math.floor((b + pad - x0) / CELL));
    const j0 = Math.max(0, Math.floor((c - pad - z0) / CELL)), j1 = Math.min(NZ - 1, Math.floor((d + pad - z0) / CELL));
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) if (near2D(x0 + (i + 0.5) * CELL, z0 + (j + 0.5) * CELL, tris, o, pad)) f(i, j);
  };
  for (let t = 0; t < n; t++) {
    const o = t * 9;
    const lo = Math.min(tris[o + 1], tris[o + 4], tris[o + 7]), hi = Math.max(tris[o + 1], tris[o + 4], tris[o + 7]);
    if (isFloor[t]) cellsOf(o, CELL / 2, (i, j) => { floor[i * NZ + j] = 1; });
    else if (hi > 0.22 && lo < 1.6) cellsOf(o, CELL / 2, (i, j) => { block[i * NZ + j] = 1; });
  }
  let walkable = 0;
  const ok = (k: number) => (floorFound ? floor[k] === 1 : true) && !block[k];
  for (let k = 0; k < NX * NZ; k++) if (ok(k)) walkable++;
  // a model with no usable floor (or one that is all furniture) must not leave her stuck: ignore the furniture then
  const useBlock = walkable >= 12;
  const free = (k: number) => (floorFound ? floor[k] === 1 : true) && (!useBlock || !block[k]);
  // blocked cells become rectangles (runs along a row), the form the walking code already understands
  const rects: [number, number, number, number][] = [];
  for (let i = 0; i < NX; i++) {
    let start = -1;
    for (let j = 0; j <= NZ; j++) {
      const blockedHere = j < NZ && !free(i * NZ + j);
      if (blockedHere && start < 0) start = j;
      if (!blockedHere && start >= 0) { rects.push([x0 + i * CELL, z0 + start * CELL, x0 + (i + 1) * CELL, z0 + j * CELL]); start = -1; }
    }
  }
  // start in the free cell nearest the middle of the floor
  const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
  let best = Infinity, spawn: [number, number] = [mx, mz];
  for (let i = 0; i < NX; i++) for (let j = 0; j < NZ; j++) {
    if (!free(i * NZ + j)) continue;
    // keep away from walls: all eight neighbours should be free too
    let clear = true;
    for (let di = -1; di <= 1 && clear; di++) for (let dj = -1; dj <= 1; dj++) { const a = i + di, b = j + dj; if (a < 0 || b < 0 || a >= NX || b >= NZ || !free(a * NZ + b)) { clear = false; break; } }
    if (!clear) continue;
    const x = x0 + (i + 0.5) * CELL, z = z0 + (j + 0.5) * CELL, d = Math.hypot(x - mx, z - mz);
    if (d < best) { best = d; spawn = [x, z]; }
  }
  return { layout: { floor: { x0, x1, z0, z1 }, rects, spawn }, walkable, floorFound };
}

/** The height of the lowest big floor-like surface (upward or downward facing): where the model's floor is. */
function findFloorY(tris: Float32Array): number {
  const n = tris.length / 9;
  let minY = Infinity, maxY = -Infinity;
  for (let i = 1; i < tris.length; i += 3) { minY = Math.min(minY, tris[i]); maxY = Math.max(maxY, tris[i]); }
  if (!isFinite(minY)) return 0;
  const bin = 0.05, nb = Math.min(4000, Math.ceil((maxY - minY) / bin) + 1);
  const area = new Float64Array(nb);
  for (let t = 0; t < n; t++) {
    const o = t * 9;
    const ay = tris[o + 1], by = tris[o + 4], cy = tris[o + 7];
    if (Math.max(ay, by, cy) - Math.min(ay, by, cy) > 0.02) continue; // flat surfaces only
    const ar = Math.abs((tris[o + 3] - tris[o]) * (tris[o + 8] - tris[o + 2]) - (tris[o + 5] - tris[o + 2]) * (tris[o + 6] - tris[o])) / 2;
    area[Math.min(nb - 1, Math.floor(((ay + by + cy) / 3 - minY) / bin))] += ar;
  }
  let top = 0; for (const a of area) top = Math.max(top, a);
  if (top <= 0) return minY;
  // the lowest level that has a real amount of flat surface (a rug or a stray plane far below does not count)
  for (let b = 0; b < nb; b++) if (area[b] >= top * 0.25) return minY + (b + 0.5) * bin;
  return minY;
}

/** Load a .glb, .gltf or .fbx and set it up as the room: sized, turned, with its floor at height 0 and its middle at the origin. */
export async function loadRoomModel(cfg: SceneCfg): Promise<LoadedRoom> {
  const buf = await (await fetch(cfg.url)).arrayBuffer();
  let obj: THREE.Object3D;
  if (cfg.ext === "fbx") obj = new FBXLoader().parse(buf, "");
  else obj = (await new GLTFLoader().parseAsync(buf, "")).scene;

  const inner = new THREE.Group();
  inner.add(obj);
  // an FBX is usually authored in centimetres: its units show up as a huge object, so bring plainly-too-large ones into metres
  inner.scale.setScalar(cfg.scale);
  inner.rotation.y = (cfg.rot * Math.PI) / 180;
  const g = new THREE.Group();
  g.add(inner);

  const probe = new THREE.Box3().setFromObject(inner);
  const size = probe.getSize(new THREE.Vector3());
  let auto = 1;
  if (isFinite(size.x) && Math.max(size.x, size.z) > 120) auto = 0.01; // clearly centimetres
  inner.scale.setScalar(cfg.scale * auto);

  // floor at height 0 (moved by the height the owner chose, if the floor was found wrongly), middle of the floor at the origin
  let tris = collectTriangles(inner);
  const floorY = findFloorY(tris);
  let sx = 0, sz = 0, sn = 0;
  for (let t = 0; t < tris.length / 9; t++) {
    const o = t * 9; const m = Math.max(Math.abs(tris[o + 1] - floorY), Math.abs(tris[o + 4] - floorY), Math.abs(tris[o + 7] - floorY));
    if (m < 0.12) { sx += (tris[o] + tris[o + 3] + tris[o + 6]) / 3; sz += (tris[o + 2] + tris[o + 5] + tris[o + 8]) / 3; sn++; }
  }
  if (!sn) { const b = new THREE.Box3().setFromObject(inner).getCenter(new THREE.Vector3()); sx = b.x; sz = b.z; sn = 1; }
  const dx = -sx / sn, dz = -sz / sn, dy = -floorY + cfg.y;
  inner.position.set(dx, dy, dz);
  for (let i = 0; i < tris.length; i += 3) { tris[i] += dx; tris[i + 1] += dy; tris[i + 2] += dz; }
  const triCount = tris.length / 9;
  const { layout, walkable, floorFound } = analyseLayout(tris);
  tris = new Float32Array(0);

  const disposables: { dispose: () => void }[] = [];
  inner.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    m.receiveShadow = true; m.castShadow = false; m.frustumCulled = true;
    disposables.push(m.geometry);
    for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
      disposables.push(mat);
      for (const val of Object.values(mat as unknown as Record<string, unknown>)) if (val && (val as THREE.Texture).isTexture) disposables.push(val as THREE.Texture);
    }
  });
  // soft light all round (the model's own lights, if it has any, come with it)
  const fill = new THREE.HemisphereLight(0xffffff, 0x777788, 0.9);
  g.add(fill);
  return { group: g, lamps: [], dispose: () => disposables.forEach((d) => d.dispose()), layout, stats: { triangles: triCount, walkable, floorFound } };
}
