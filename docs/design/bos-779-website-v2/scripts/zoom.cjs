// Usage: node zoom.cjs <file.html> <out.png> <width> <selector> [scale]: a close-up of one element at a page width.
const { chromium } = require("/usr/local/lib/node_modules/playwright");
(async () => {
  const [file, out, w, sel, s = "2"] = process.argv.slice(2);
  const b = await chromium.launch({ executablePath: "/usr/bin/chromium" });
  const p = await b.newPage({ viewport: { width: +w, height: 900 }, deviceScaleFactor: +s });
  await p.goto("file://" + file); await p.waitForLoadState("networkidle"); await p.evaluate(() => document.fonts.ready);
  await p.locator(sel).first().screenshot({ path: out });
  await b.close();
})().catch((e) => { console.error(e); process.exit(1); });
