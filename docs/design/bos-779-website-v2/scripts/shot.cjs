// Usage: DEMO_PASSWORD=<as seeded> node shot.cjs <hash-route> <out.png> [width] [height] [scale]
// Optional: EL=<selector> (element shot), CLIP=x,y,w,h (region), FULL=1 (full page), PORT (default 3779).
const { chromium } = require(process.env.PLAYWRIGHT_PATH || "/usr/local/lib/node_modules/playwright");
(async () => {
  const [route, out, w = "1440", h = "900", s = "2"] = process.argv.slice(2);
  const browser = await chromium.launch({ headless: true, executablePath: "/usr/bin/chromium" });
  const ctx = await browser.newContext({ viewport: { width: +w, height: +h }, deviceScaleFactor: +s });
  const page = await ctx.newPage();
  const base = `http://127.0.0.1:${process.env.PORT || 3779}`;
  const r = await page.request.post(base + "/api/login", { data: { username: "demo", password: process.env.DEMO_PASSWORD } });
  if (!r.ok()) throw new Error("login " + r.status());
  await page.goto(base + "/" + route);
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1500);
  if (process.env.DUMP) console.log((await page.locator("body").innerText()).slice(0, 3000));
  if (process.env.EL) await page.locator(process.env.EL).first().screenshot({ path: out });
  else if (process.env.CLIP) { const [x, y, cw, ch] = process.env.CLIP.split(",").map(Number); await page.screenshot({ path: out, clip: { x, y, width: cw, height: ch } }); }
  else await page.screenshot({ path: out, fullPage: process.env.FULL === "1" });
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
