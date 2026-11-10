// Usage: node dehalo.cjs <in image> <out.png> [lightness 0-255, default 200]
// Removes the white sticker halo round a cut-out drawing: every light pixel joined to the
// transparent outside (through other light pixels) becomes transparent, so the drawing's own
// dark outline becomes its edge. The light parts inside the outline are untouched.
const { chromium } = require("/usr/local/lib/node_modules/playwright");
const fs = require("fs");
(async () => {
  const [inp, out, lim = "200"] = process.argv.slice(2);
  const b = await chromium.launch({ executablePath: "/usr/bin/chromium" });
  const p = await b.newPage();
  const ext = inp.split(".").pop().replace("jpg", "jpeg");
  const src = `data:image/${ext};base64,` + fs.readFileSync(inp).toString("base64");
  const url = await p.evaluate(async ({ src, lim }) => {
    const img = new Image(); img.src = src; await img.decode();
    const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
    const x = c.getContext("2d"); x.drawImage(img, 0, 0);
    const d = x.getImageData(0, 0, c.width, c.height); const a = d.data; const W = c.width, H = c.height;
    const light = (i) => a[i * 4 + 3] < 40 || (a[i * 4] > lim && a[i * 4 + 1] > lim && a[i * 4 + 2] > lim);
    const seen = new Uint8Array(W * H); const st = [];
    for (let i = 0; i < W; i++) st.push(i, (H - 1) * W + i);
    for (let j = 0; j < H; j++) st.push(j * W, j * W + W - 1);
    while (st.length) {
      const i = st.pop(); if (seen[i] || !light(i)) continue; seen[i] = 1;
      const px = i % W, py = (i / W) | 0;
      if (px > 0) st.push(i - 1); if (px < W - 1) st.push(i + 1); if (py > 0) st.push(i - W); if (py < H - 1) st.push(i + W);
    }
    // Clear the halo, and soften the outline pixels next to it so the edge is not jagged.
    for (let i = 0; i < W * H; i++) if (seen[i]) a[i * 4 + 3] = 0;
    for (let i = 0; i < W * H; i++) {
      if (seen[i]) continue; const px = i % W, py = (i / W) | 0;
      const n = (px > 0 && seen[i - 1]) + (px < W - 1 && seen[i + 1]) + (py > 0 && seen[i - W]) + (py < H - 1 && seen[i + W]);
      if (n) a[i * 4 + 3] = Math.min(a[i * 4 + 3], 255 - n * 40);
    }
    x.putImageData(d, 0, 0); return c.toDataURL("image/png");
  }, { src, lim: +lim });
  fs.writeFileSync(out, Buffer.from(url.split(",")[1], "base64"));
  await b.close();
})().catch((e) => { console.error(e); process.exit(1); });
