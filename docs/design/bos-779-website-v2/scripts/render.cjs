// Usage: node render.cjs <file.html> <outprefix>  -> <outprefix>-1440.png, -840.png, -390.png (full page)
// PHONE_SCALE=1 makes a phone render short enough for Penpot (it refused a 23,000 px tall image).
const { chromium } = require(process.env.PLAYWRIGHT_PATH || "/usr/local/lib/node_modules/playwright");
(async () => {
  const [file, out, only] = process.argv.slice(2);
  const browser = await chromium.launch({ headless: true, executablePath: "/usr/bin/chromium" });
  for (const [w, h, s] of [[1440, 900, 1], [840, 900, 1], [390, 844, +(process.env.PHONE_SCALE || 2)]]) {
    if (only && +only !== w) continue;
    const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: s });
    await page.goto("file://" + file);
    await page.waitForLoadState("networkidle");
    await page.evaluate(() => document.fonts.ready);
    const sw = await page.evaluate(() => document.documentElement.scrollWidth);
    if (sw > w) console.log(`warning: ${w}px page scrolls sideways (${sw})`);
    await page.screenshot({ path: `${out}-${w}.png`, fullPage: true });
    await page.close();
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
