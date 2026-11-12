// usage: node ptest.js '<json steps: [{name, act:[...], wait}]>'  act items: {click:"aria"} {move:[x,y]} {down:true}{up:true} {ev:["poke",{...}]} {key:"p"}
const { chromium } = require("playwright");
(async () => {
  const steps = JSON.parse(process.argv[2]); const dir = process.env.OUT || ".";
  const b = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--enable-webgl"] });
  const p = await b.newPage({ viewport: { width: 1100, height: 700 } });
  const errs = []; p.on("pageerror", (e) => errs.push(String(e))); p.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
  await p.goto("http://localhost:5199/viewer-dev.html?src=" + encodeURIComponent("http://127.0.0.1:8099/m.vrm"));
  await p.waitForSelector(".vrm-box[data-ready='1']", { timeout: 90000 });
  await p.click("[aria-label=Lively]"); await p.waitForTimeout(1200);   // stand still in the middle
  for (const st of steps) {
    for (const a of st.act ?? []) {
      if (a.click) await p.click(`[aria-label="${a.click}"]`);
      if (a.move) await p.mouse.move(a.move[0], a.move[1], { steps: 4 });
      if (a.down) await p.mouse.down({ button: a.down === true ? "left" : a.down });
      if (a.up) await p.mouse.up({ button: a.up === true ? "left" : a.up });
      if (a.key) await p.keyboard.press(a.key); if (a.keydown) await p.keyboard.down(a.keydown); if (a.keyup) await p.keyboard.up(a.keyup);
      if (a.ev) await p.evaluate(([n, d]) => document.querySelector(".vrm-box").dispatchEvent(new CustomEvent(n, { detail: d })), a.ev);
      if (a.wait) await p.waitForTimeout(a.wait);
    }
    await p.waitForTimeout(st.wait ?? 600);
    if (st.name) await p.screenshot({ path: `${dir}/pk-${st.name}.png` });
    console.log(st.name ?? "-", await p.evaluate(() => { const d = document.querySelector(".vrm-box").dataset; return JSON.stringify({ poke: d.poke, pokes: d.pokes, tickle: d.tickle, tickles: d.tickles, pointing: d.pointing, pinching: d.pinching, hand: d.hand, cam: d.cam, base: d.base, dbg: d.camdbg, roam: d.roam, carry: d.carry, carryY: d.carryY, panic: d.panic, calm: d.calm, hands: d.hands, plan: d.plan }); }));
  }
  console.log("errors:", errs.slice(0, 5));
  await b.close();
})();
