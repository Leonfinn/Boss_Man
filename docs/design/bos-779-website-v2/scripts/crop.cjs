// Usage: node crop.cjs <in.png> <out.png> <x> <y> <w> <h> [scale, default 2]
// Crops a screenshot. x, y, w and h are in CSS px of the page it was taken from; scale is its
// device pixel ratio. board-crop.png comes from board-wide.png: 264 355 1536 560 2
// (Backlog to Your review, so the close-up starts at the board's first column).
const { chromium } = require("/usr/local/lib/node_modules/playwright");
const fs = require("fs");
(async () => {
  const [inp, out, x, y, w, h, s = "2"] = process.argv.slice(2);
  const b = await chromium.launch({ executablePath: "/usr/bin/chromium" });
  const p = await b.newPage();
  const src = "data:image/png;base64," + fs.readFileSync(inp).toString("base64");
  const url = await p.evaluate(async ({ src, x, y, w, h, s }) => {
    const img = new Image(); img.src = src; await img.decode();
    const c = document.createElement("canvas"); c.width = w * s; c.height = h * s;
    c.getContext("2d").drawImage(img, x * s, y * s, w * s, h * s, 0, 0, w * s, h * s);
    return c.toDataURL("image/png");
  }, { src, x: +x, y: +y, w: +w, h: +h, s: +s });
  fs.writeFileSync(out, Buffer.from(url.split(",")[1], "base64"));
  await b.close();
})().catch((e) => { console.error(e); process.exit(1); });
