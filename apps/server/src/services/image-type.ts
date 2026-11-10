/** The three picture types Boss Man accepts, found by their first bytes (no SVG: the portal is public). */
export function logoType(b: Buffer): "image/png" | "image/jpeg" | "image/webp" | null {
  return b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ? "image/png"
    : b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff ? "image/jpeg"
    : b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP" ? "image/webp"
    : null;
}
