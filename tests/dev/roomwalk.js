const { chromium } = require("playwright");
(async () => {
  const b = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--enable-webgl"] });
  const p = await b.newPage({ viewport: { width: 700, height: 500 }, deviceScaleFactor: 1 });
  await p.goto("http://localhost:5199/viewer-dev.html?src=" + encodeURIComponent("http://127.0.0.1:8099/m.vrm") + "&room=" + encodeURIComponent("http://127.0.0.1:8099/room.glb"));
  await p.waitForSelector(".vrm-box[data-ready='1']", { timeout: 120000 });
  const pts = []; const plans = new Set();
  const T = +(process.env.SECS || 90);
  for (let i = 0; i < T * 4; i++) { if (i % 60 === 0) await p.evaluate(() => document.querySelector('.vrm-box').dispatchEvent(new CustomEvent('npc', { detail: 'wander' }))); await p.waitForTimeout(250); const d = await p.evaluate(() => { const x = document.querySelector(".vrm-box").dataset; return [+x.npcx / 100, +x.npcz / 100, x.plan]; }); pts.push(d); plans.add(d[2]); }
  const inRect = (x, z, [a, c, e, f]) => x > a && x < e && z > c && z < f;
  const table = [-2.2, -1.45, -0.8, -0.55], bed = [1.6, -2.75, 3.6, -1.45];
  const bad = pts.filter(([x, z]) => inRect(x, z, table) || inRect(x, z, bed));
  const xs = pts.map((q) => q[0]), zs = pts.map((q) => q[1]);
  console.log("samples", pts.length, "plans", [...plans].join(","), "x", Math.min(...xs).toFixed(2), Math.max(...xs).toFixed(2), "z", Math.min(...zs).toFixed(2), Math.max(...zs).toFixed(2), "inside furniture:", bad.length);
  await b.close();
})();
