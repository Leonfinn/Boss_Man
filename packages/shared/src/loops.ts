// Loop detection helpers (R49, R50): reduce a failure or a review finding to a signature that
// stays the same when the same problem comes back with different numbers, ids or timings.

/** cyrb53: a small, fast, non-cryptographic hash. Plain JS, so this also works in the browser. */
function hash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}

/** Strips what changes from run to run: ids, hashes, numbers, temp paths and whitespace. */
export function normaliseFailure(text: string): string {
  return text
    .slice(-2000)
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<id>")
    .replace(/\b[0-9a-f]{7,40}\b/g, "<hash>")
    .replace(/\/tmp\/[^\s:'"]+/g, "<tmp>")
    .replace(/\d+(\.\d+)?/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(-500);
}

export const failureSignature = (text: string) => hash(normaliseFailure(text));

/** A review finding is "the same" when it's on the same file and says the same thing. */
export function findingFingerprint(c: { path: string; body: string }): string {
  const body = c.body.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  return hash(`${c.path}\n${body}`);
}
