const { chromium } = require("playwright");
(async () => {
  const b = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--enable-webgl"] });
  const p = await b.newPage();
  const errs = []; p.on("pageerror", (e) => errs.push(String(e))); p.on("console", (m) => { if (["error","warning"].includes(m.type())) errs.push(m.text().slice(0, 200)); });
  await p.goto("http://localhost:5199/convert-dev.html?base=" + encodeURIComponent("http://127.0.0.1:8099") + (process.argv[2] || ""));
  await p.waitForFunction(() => window.__result, null, { timeout: 60000 });
  console.log(JSON.stringify(await p.evaluate(() => window.__result)));
  console.log("errors:", errs.slice(0, 4));
  await b.close();
})();
