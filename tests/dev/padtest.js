// fake controller: node padtest.js <id string>
const { chromium } = require("playwright");
(async () => {
  const id = process.argv[2];
  const b = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--enable-webgl"] });
  const p = await b.newPage({ viewport: { width: 1100, height: 700 } });
  const errs = []; p.on("pageerror", (e) => errs.push(String(e)));
  await p.addInitScript((id) => {
    const pad = { id, index: 0, connected: true, mapping: "standard", axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })) };
    window.__pad = pad;
    window.__press = (i, on) => { pad.buttons[i] = { pressed: !!on, value: on ? 1 : 0 }; };
    navigator.getGamepads = () => [pad];
  }, id);
  await p.goto("http://localhost:5199/viewer-dev.html?src=" + encodeURIComponent("http://127.0.0.1:8099/m.vrm"));
  await p.waitForSelector(".vrm-box[data-ready='1']", { timeout: 90000 });
  await p.click("[aria-label=Lively]"); await p.waitForTimeout(800);
  await p.evaluate(() => { const ev = new Event("gamepadconnected"); ev.gamepad = window.__pad; window.dispatchEvent(ev); });
  await p.waitForTimeout(600);
  const ds = () => p.evaluate(() => { const d = document.querySelector(".vrm-box").dataset; return JSON.stringify({ hands: d.hands, point: d.pointing, pinch: d.pinching, carry: d.carry, carryY: d.carryY, poke: d.poke, pokes: d.pokes, tickle: d.tickle }); });
  const hint = () => p.evaluate(() => document.querySelector(".vrm-hint")?.textContent);
  const tap = async (i, ms = 700) => { await p.evaluate((i) => window.__press(i, true), i); await p.waitForTimeout(ms); await p.evaluate((i) => window.__press(i, false), i); await p.waitForTimeout(700); };
  console.log("connected:", await ds()); console.log("hint:", await hint());
  await tap(12); console.log("dpad up -> point:", await ds()); console.log("hint:", await hint());
  await tap(15); console.log("dpad right -> pinch:", await ds()); console.log("hint:", await hint());
  await tap(14); console.log("dpad left -> pet:", await ds());
  await tap(3); console.log("top button cycles -> point:", await ds());
  await tap(3); console.log("again -> pinch:", await ds());
  // move the right hand over her head with the right stick, then pinch (hold the bottom button)
  await p.evaluate(() => new Promise((res) => { let n = 0; window.__pad.axes[2] = -1; const f = () => { if (++n >= 8) { window.__pad.axes[2] = 0; res(); } else requestAnimationFrame(f); }; requestAnimationFrame(f); }));
  await p.waitForTimeout(500); await p.screenshot({ path: process.env.OUT + "/pad-hover.png" });
  await p.evaluate(() => window.__press(0, true)); await p.waitForTimeout(900);
  console.log("holding bottom button:", await ds());
  await p.evaluate(() => new Promise((res) => { let n = 0; window.__pad.axes[3] = -1; const f = () => { if (++n >= 12) { window.__pad.axes[3] = 0; res(); } else requestAnimationFrame(f); }; requestAnimationFrame(f); }));
  await p.waitForTimeout(500); await p.screenshot({ path: process.env.OUT + "/pad-carry.png" });
  console.log("lifted with stick:", await ds());
  await p.evaluate(() => window.__press(0, false)); await p.waitForTimeout(900);
  console.log("released:", await ds());
  console.log("errors:", errs.slice(0, 3));
  await b.close();
})();
