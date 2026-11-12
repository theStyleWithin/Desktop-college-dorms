const { chromium } = require("playwright");
(async () => {
  const out = process.argv[2]; const q = process.argv[3] || "";
  const b = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--enable-webgl"] });
  const p = await b.newPage({ viewport: { width: 1100, height: 700 }, deviceScaleFactor: 1 });
  const errs = []; p.on("pageerror", (e) => errs.push(String(e))); p.on("console", (m) => { if (m.type() === "warning" || m.type() === "error") errs.push(m.text().slice(0, 200)); });
  await p.goto("http://localhost:5199/viewer-dev.html?src=" + encodeURIComponent("http://127.0.0.1:8099/m.vrm") + "&room=" + encodeURIComponent("http://127.0.0.1:8099/room.glb") + q);
  await p.waitForSelector(".vrm-box[data-ready='1']", { timeout: 120000 });
  await p.click("[aria-label=Lively]"); await p.waitForTimeout(+(process.env.WAIT || 6000));
  const ds = await p.evaluate(() => { const d = document.querySelector(".vrm-box").dataset; return { scene: d.scene, walk: d.walk, floor: d.floorFound, npc: d.npcx + "," + d.npcz, plan: d.plan }; });
  console.log(JSON.stringify(ds));
  await p.screenshot({ path: out });
  console.log("errors:", errs.slice(0, 4));
  await b.close();
})();
