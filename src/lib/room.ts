import * as THREE from "three";

/**
 * A cozy dorm room built from simple shapes and canvas-drawn textures, so the 3D viewer works fully offline
 * and ships no image files. Units are metres: a 8 x 7 m floor with a back wall, a night-sky window, string
 * lights, a rug, a lamp, a bed and a bookshelf. The front is left open so the camera can sit inside the room.
 */

/** Where things are, in room units (metres at the 1.6 m character scale): used by the NPC behavior to walk, sit and sleep. */
export const DESK = { x: -2.3, z: -4.05, top: 0.74 };
export const BED = { x0: 2.35, x1: 4.45, z0: -4.3, z1: -2.9, top: 0.56 };
/** Things she must walk around: [x0, z0, x1, z1] rectangles. */
export const OBSTACLES: [number, number, number, number][] = [
  [BED.x0 - 0.15, BED.z0 - 0.2, BED.x1 + 0.2, BED.z1 + 0.05],
  [DESK.x - 1.15, DESK.z - 0.45, DESK.x + 1.15, DESK.z + 0.42],
  [4.05, -0.7, 5.1, 0.3],       // bookshelf
  [-4.65, -4.2, -3.55, -3.2],   // plant
  [-4.7, -2.65, -3.95, -1.75],  // floor lamp
];
export const FLOOR = { x0: -4.5, x1: 4.5, z0: -4.1, z1: 2.9 };

function canvasTex(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void, repeat?: [number, number]) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  draw(c.getContext("2d")!);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(...repeat); }
  return t;
}

const rnd = (() => { let s = 7; return () => ((s = (s * 16807) % 2147483647) / 2147483647); })();

const planks = () => canvasTex(512, 512, (g) => {
  const n = 8, h = 512 / n;
  for (let i = 0; i < n; i++) {
    const l = 38 + rnd() * 10;
    g.fillStyle = `hsl(28 ${32 + rnd() * 10}% ${l}%)`;
    g.fillRect(0, i * h, 512, h);
    g.strokeStyle = "rgba(0,0,0,.28)"; g.lineWidth = 2;
    g.beginPath(); g.moveTo(0, i * h); g.lineTo(512, i * h); g.stroke();
    const cut = rnd() * 512;
    g.beginPath(); g.moveTo(cut, i * h); g.lineTo(cut, (i + 1) * h); g.stroke();
    g.strokeStyle = "rgba(60,30,10,.12)"; g.lineWidth = 1;
    for (let k = 0; k < 5; k++) { const y = i * h + rnd() * h; g.beginPath(); g.moveTo(0, y); g.lineTo(512, y + (rnd() - .5) * 6); g.stroke(); }
  }
}, [4, 3]);

const wallpaper = () => canvasTex(256, 256, (g) => {
  g.fillStyle = "#4a4377"; g.fillRect(0, 0, 256, 256);
  g.fillStyle = "rgba(255,255,255,.045)";
  for (let x = 0; x < 256; x += 32) g.fillRect(x, 0, 16, 256);
  g.fillStyle = "rgba(255,220,170,.10)";
  for (let y = 16; y < 256; y += 64) for (let x = 16; x < 256; x += 64) { g.beginPath(); g.arc(x, y, 3, 0, 7); g.fill(); }
}, [5, 1.6]);

const nightSky = () => canvasTex(256, 192, (g) => {
  const gr = g.createLinearGradient(0, 0, 0, 192);
  gr.addColorStop(0, "#0e1330"); gr.addColorStop(1, "#3a2f66");
  g.fillStyle = gr; g.fillRect(0, 0, 256, 192);
  g.fillStyle = "#fff";
  for (let i = 0; i < 60; i++) { g.globalAlpha = .3 + rnd() * .7; g.fillRect(rnd() * 256, rnd() * 130, 1.5, 1.5); }
  g.globalAlpha = 1; g.fillStyle = "#fdf3c8"; g.beginPath(); g.arc(188, 52, 17, 0, 7); g.fill();
  g.fillStyle = "#3a2f66"; g.beginPath(); g.arc(197, 47, 15, 0, 7); g.fill();
});

const std = (color: number | string, rough = 0.85, extra: THREE.MeshStandardMaterialParameters = {}) =>
  new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0, ...extra });

export interface Room {
  group: THREE.Group;
  lamps: THREE.PointLight[];
  dispose: () => void;
}

export function buildRoom(): Room {
  const g = new THREE.Group();
  const disposables: { dispose: () => void }[] = [];
  const add = <T extends THREE.Mesh>(m: T, cast = false, receive = true) => {
    m.castShadow = cast; m.receiveShadow = receive;
    disposables.push(m.geometry, m.material as THREE.Material);
    g.add(m);
    return m;
  };
  const box = (w: number, h: number, d: number, mat: THREE.Material, x: number, y: number, z: number, cast = true) => {
    const m = add(new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat), cast);
    m.position.set(x, y, z);
    return m;
  };

  // floor, back wall, right wall
  const floorTex = planks(); disposables.push(floorTex);
  const floor = add(new THREE.Mesh(new THREE.PlaneGeometry(10, 8), std(0xffffff, 0.7, { map: floorTex })));
  floor.rotation.x = -Math.PI / 2; floor.position.set(0, 0, -0.5);
  const wpTex = wallpaper(); disposables.push(wpTex);
  const back = add(new THREE.Mesh(new THREE.PlaneGeometry(10, 3.4), std(0xffffff, 0.95, { map: wpTex })));
  back.position.set(0, 1.7, -4.5);
  const rightWall = add(new THREE.Mesh(new THREE.PlaneGeometry(8, 3.4), std(0xffffff, 0.95, { map: wpTex.clone() })));
  rightWall.rotation.y = -Math.PI / 2; rightWall.position.set(5, 1.7, -0.5);
  box(10, 0.12, 0.06, std("#2a2347", 0.6), 0, 0.06, -4.47, false);

  // window with a night sky, frame, curtains
  const skyTex = nightSky(); disposables.push(skyTex);
  const sky = add(new THREE.Mesh(new THREE.PlaneGeometry(2.2, 1.6), new THREE.MeshBasicMaterial({ map: skyTex })), false, false);
  sky.position.set(-1.6, 1.85, -4.47);
  const frame = std("#e8dcc8", 0.6);
  box(2.4, 0.1, 0.12, frame, -1.6, 2.68, -4.45, false); box(2.4, 0.1, 0.12, frame, -1.6, 1.02, -4.45, false);
  box(0.1, 1.76, 0.12, frame, -2.75, 1.85, -4.45, false); box(0.1, 1.76, 0.12, frame, -0.45, 1.85, -4.45, false);
  box(0.06, 1.6, 0.1, frame, -1.6, 1.85, -4.45, false); box(2.2, 0.06, 0.1, frame, -1.6, 1.85, -4.45, false);
  const curtain = std("#8a5fa8", 0.95);
  box(0.55, 2.3, 0.14, curtain, -3.05, 1.7, -4.38, false); box(0.55, 2.3, 0.14, curtain, -0.15, 1.7, -4.38, false);
  box(3.6, 0.06, 0.06, std("#d6c9a8", 0.4), -1.6, 2.95, -4.38, false);

  // rug
  const rug = add(new THREE.Mesh(new THREE.CircleGeometry(1.9, 48), std("#6b4a7a", 1)), false, true);
  rug.rotation.x = -Math.PI / 2; rug.position.set(0, 0.006, 0);
  const ring = add(new THREE.Mesh(new THREE.RingGeometry(1.45, 1.6, 48), std("#e9b872", 1)), false, true);
  ring.rotation.x = -Math.PI / 2; ring.position.set(0, 0.008, 0);

  // string lights along the top of the back wall
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= 8; i++) { const x = -4.6 + i * 1.15; pts.push(new THREE.Vector3(x, 3.05 - 0.28 * Math.sin((i / 8) * Math.PI * 3.0 % Math.PI), -4.4)); }
  const curve = new THREE.CatmullRomCurve3(pts);
  const cord = add(new THREE.Mesh(new THREE.TubeGeometry(curve, 60, 0.008, 5), new THREE.MeshBasicMaterial({ color: 0x120e22 })), false, false);
  void cord;
  const bulbColors = [0xff788c, 0xffd36e, 0x82dcff, 0xbe96ff, 0x8cf0aa];
  for (let i = 0; i < 26; i++) {
    const p = curve.getPoint(i / 25);
    const b = add(new THREE.Mesh(new THREE.SphereGeometry(0.045, 10, 8), new THREE.MeshBasicMaterial({ color: bulbColors[i % 5] })), false, false);
    b.position.set(p.x, p.y - 0.05, p.z + 0.02);
  }

  // bed, bookshelf, plant, floor lamp
  box(2.2, 0.34, 1.5, std("#35305a", 0.9), 3.4, 0.17, -3.6);        // frame
  box(2.1, 0.22, 1.4, std("#e9e2f4", 0.95), 3.4, 0.45, -3.6);       // mattress
  box(2.2, 0.9, 0.1, std("#2a2347", 0.8), 3.4, 0.75, -4.4);          // headboard
  box(0.7, 0.14, 0.4, std("#ffd9a8", 0.95), 2.8, 0.62, -3.9);        // pillow
  box(1.3, 0.1, 0.55, std("#ff9db3", 0.95), 3.8, 0.57, -3.25);       // blanket (folded at the foot, so there is room to lie down)
  // desk under the window
  const wood = std("#8a5d3b", 0.65);
  box(2.1, 0.06, 0.65, wood, DESK.x, DESK.top - 0.03, DESK.z);
  for (const [dx, dz] of [[-0.95, -0.27], [0.95, -0.27], [-0.95, 0.27], [0.95, 0.27]]) box(0.06, DESK.top - 0.06, 0.06, wood, DESK.x + dx, (DESK.top - 0.06) / 2, DESK.z + dz);
  box(0.42, 0.02, 0.3, std("#2b2b3a", 0.4), DESK.x - 0.55, DESK.top + 0.01, DESK.z + 0.02);   // laptop, closed
  box(0.42, 0.02, 0.3, std("#3a3a52", 0.4), DESK.x - 0.55, DESK.top + 0.03, DESK.z + 0.02);
  const shelf = std("#5b3d2b", 0.7);
  box(0.12, 2.0, 0.45, shelf, 4.2, 1.0, -0.2); box(0.12, 2.0, 0.45, shelf, 4.9, 1.0, -0.2);
  for (let i = 0; i < 4; i++) {
    box(0.82, 0.05, 0.45, shelf, 4.55, 0.35 + i * 0.5, -0.2);
    for (let k = 0; k < 6; k++) box(0.08, 0.3 + rnd() * 0.08, 0.28, std(`hsl(${rnd() * 360} 45% 55%)`, 0.8), 4.25 + k * 0.1, 0.55 + i * 0.5, -0.2, false);
  }
  const pot = add(new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.12, 0.28, 14), std("#c9714d", 0.8)), true);
  pot.position.set(-4.1, 0.14, -3.7);
  for (let i = 0; i < 7; i++) {
    const leaf = add(new THREE.Mesh(new THREE.SphereGeometry(0.17, 10, 8), std("#4e9a5e", 0.8)), true);
    leaf.scale.set(1, 1.5, 0.45); leaf.rotation.set(0, (i / 7) * 6.28, 0.5); leaf.position.set(-4.1 + Math.cos(i) * 0.14, 0.52, -3.7 + Math.sin(i) * 0.14);
  }
  const pole = add(new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 1.55, 8), std("#222", 0.4)), true);
  pole.position.set(-4.3, 0.78, -2.2);
  const shade = add(new THREE.Mesh(new THREE.ConeGeometry(0.28, 0.34, 20, 1, true), new THREE.MeshBasicMaterial({ color: 0xffd9a0, side: THREE.DoubleSide })), false, false);
  shade.position.set(-4.3, 1.62, -2.2);
  const lamp = new THREE.PointLight(0xffc27a, 9, 9, 2);
  lamp.position.set(-4.3, 1.5, -2.0);
  g.add(lamp);

  return {
    group: g,
    lamps: [lamp],
    dispose: () => disposables.forEach((d) => d.dispose()),
  };
}
