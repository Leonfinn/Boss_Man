import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The manifest and icons are plain files in public/, served as-is (Vite copies public/ into the build),
// so a phone or Mac can install the app. They are read here exactly as the browser would get them.
const file = (name: string) => readFileSync(new URL(`../public/${name}`, import.meta.url));
const manifest = JSON.parse(file("manifest.webmanifest").toString("utf8"));
const index = readFileSync(new URL("../index.html", import.meta.url), "utf8");

describe("web app manifest", () => {
  it("names the app and opens it standalone at the root", () => {
    expect(manifest.name).toBe("Boss Man");
    expect(manifest.short_name).toBe("Boss Man");
    expect(manifest.start_url).toBe("/");
    expect(manifest.display).toBe("standalone");
    // The sidebar navy and the page ground, from styles.css (--side and --ground).
    expect(manifest.theme_color).toBe("#17202c");
    expect(manifest.background_color).toBe("#252c36");
  });

  it("offers 192 and 512 icons, plain and maskable", () => {
    const kinds = manifest.icons.map((i: { sizes: string; purpose: string }) => `${i.sizes} ${i.purpose}`);
    expect(kinds).toEqual(["192x192 any", "512x512 any", "192x192 maskable", "512x512 maskable"]);
    for (const icon of manifest.icons) expect(icon.type).toBe("image/png");
  });

  it("points every icon at a file that is really there, at the size it claims", () => {
    for (const icon of manifest.icons) {
      const png = file(icon.src.replace(/^\//, ""));
      // PNG signature, then width and height in the IHDR chunk (bytes 16-23).
      expect(png.subarray(1, 4).toString("ascii")).toBe("PNG");
      const [w, h] = [png.readUInt32BE(16), png.readUInt32BE(20)];
      expect(`${w}x${h}`).toBe(icon.sizes);
    }
  });

  it("has a maskable icon of its own, not the plain mark reused", () => {
    const srcOf = (purpose: string) => manifest.icons.filter((i: { purpose: string }) => i.purpose === purpose).map((i: { src: string }) => i.src);
    const maskable = srcOf("maskable");
    expect(maskable).toHaveLength(2);
    for (const src of maskable) expect(srcOf("any")).not.toContain(src);
  });

  it("links the manifest and iOS icon from the page, with the theme colour", () => {
    expect(index).toContain('<link rel="manifest" href="/manifest.webmanifest"');
    expect(index).toContain('<meta name="theme-color" content="#17202c"');
    expect(index).toMatch(/<link rel="apple-touch-icon" href="\/app-icons\/[^"]+\.png"/);
  });
});
