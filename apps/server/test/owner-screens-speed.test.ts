import { OWNER_FIELDS } from "@boss-man/shared";
import { describe, expect, it } from "vitest";
import { fieldMentions, screenFindings } from "../src/services/owner-screens.js";

// BOS-2124: on 20 Nov the go-live retry re-linted one ticket's long setup steps every minute, and each pass froze the
// server for 1-2 s, 1.0-1.4 s of it in fieldMentions. Its cost grew with (fields x matches x text length): every match
// of a short label ("To", "Name", "From") ran end-anchored regexes over the whole text before it. These tests pin the
// growth, not a time, and pin that the faster version finds exactly what the old one did.

/** Setup steps as an agent writes them: paths, presses, fields to fill, the common short words that are also labels. */
const PARAGRAPH = [
  "Open Settings → Secrets and press Add secret. Set Variable name to `SMOKE_LOGIN` and paste the password you saved in step 2 into the Value field, then press Save.",
  "Go to Projects → Development → Config, set **Before merging, Boss Man will** to Run the quick check and set For high-risk work, also to Run the full check. Press Save.",
  "Open Notifications, tick Send to my phone, fill in the \"Topic\" box with the name from your ntfy app and set the Time zone to the one you live in, from 22:00 until 07:00.",
  "On the Board, open the ticket, set Risk to medium and Assigned to to the CEO; leave Title and Description as they are. Then go to Decisions and choose the Model you want to pay from.",
  "If the name or the value is wrong, go back to the Secrets page and change it; the company name, the project name and the kind of funding source don't matter here.",
].join("\n");

const text = (paragraphs: number) => Array.from({ length: paragraphs }, (_, i) => PARAGRAPH.replace("step 2", `step ${i + 2}`)).join("\n\n");

/** fieldMentions as it was before BOS-2124, kept here as the reference the fast version must agree with. */
const OLD_PATTERNS = (() => {
  const seen = new Set<string>();
  const out: Array<{ label: string; words: number; re: RegExp; exact: RegExp }> = [];
  for (const labels of Object.values(OWNER_FIELDS) as ReadonlyArray<readonly string[]>) {
    for (const l of labels) {
      const base = l.replace(/\s*…$/, "");
      for (const form of new Set([base, base.replace(/\s*\([^)]*\)$/, "")])) {
        const words = form.split(/[^\p{L}\p{N}']+/u).filter(Boolean);
        const key = words.join(" ").toLowerCase();
        if (!words.length || seen.has(key)) continue;
        seen.add(key);
        const body = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(String.raw`[^\p{L}\p{N}']+`);
        const src = String.raw`(?<![\p{L}\p{N}])${body}(?![\p{L}\p{N}])`;
        out.push({ label: form, words: words.length, re: new RegExp(src, "giu"), exact: new RegExp(`^${src}$`, "u") });
      }
    }
  }
  return out.sort((a, b) => b.label.length - a.label.length);
})();
const OLD_FILL = String.raw`fill(?:\s+in|\s+out)?|enter|type|put|paste|set|choose|pick|select|change|complete|write`;
function oldFieldMentions(prose: string) {
  const out: Array<{ label: string; start: number; end: number }> = [];
  for (const f of OLD_PATTERNS) {
    for (const m of prose.matchAll(f.re)) {
      const start = m.index;
      const end = start + m[0].length;
      if (out.some((o) => start < o.end && end > o.start)) continue;
      const before = prose.slice(0, start);
      const after = prose.slice(end);
      const quoted = /(?:\*\*|["“`'])$/.test(before) && /^…?(?:\*\*|["”`'])/.test(after);
      const fieldWord = /^[\s*"”`'…]*(?:field|box|drop-?down|menu|setting|check ?box|tick ?box)\b/i.test(after);
      const asWritten = f.exact.test(m[0]) && /^\p{Lu}/u.test(m[0]);
      const afterFill = new RegExp(String.raw`\b(?:${OLD_FILL})\s+(?:the\s+${f.words > 1 ? "|a\\s+|an\\s+|your\\s+" : ""})?$`, "i").test(before);
      if (/\b(?:press|click|tap|hit)\s+(?:on\s+)?(?:the\s+)?[*"“`']*$/i.test(before)) continue;
      if (quoted || fieldWord || (asWritten && f.words > 1) || (afterFill && (asWritten || f.words > 1))) out.push({ label: f.label, start, end });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

describe("fieldMentions speed (BOS-2124)", () => {
  it("finds exactly what the old version found", () => {
    const cases = [
      text(1),
      text(6),
      // The tail it reads must reach past long runs of spaces and quote marks between the verb and the field.
      `Then set${" ".repeat(300)}the${"\n".repeat(50)}Variable name to X. Press   on    the ${"*".repeat(40)}"Name" button. Fill out    your\t\t\tProject name.`,
      `Click${" ".repeat(200)}${"`".repeat(30)}Value and type ${"'".repeat(80)}Kind ${"“".repeat(10)}Name”.`,
      // A verb glued to a word before it is not a verb ("reset", "unpress"): the cut keeps the character before the tail.
      `${"x".repeat(5)}reset Variable name; unpress the Value; preset the Name; ${"word ".repeat(40)}set the Kind`,
      // Case folding: the Kelvin sign and the long s fold to k and s under the "iu" flags, so a prefilter must too.
      "set the \u212Aind to X and the Proje\u017Fct name to Y, then Set Variable Name to `Z`",
      "",
      "Name",
      "**Name**",
    ];
    for (const prose of cases) expect(fieldMentions(prose), prose.slice(0, 80)).toEqual(oldFieldMentions(prose));
  });

  it("remembers a step's findings, and a caller can't change what the next one gets", () => {
    // The go-live retry re-lints unchanged steps every minute while a setup fix is open: the second read is remembered.
    const prose = "Open Settings and set Before merging, Boss Man will to Run the quick check, then fill in the Topic.";
    const first = screenFindings(prose, [{ label: "save", at: 90 }]);
    expect(first.r8.length + first.r13.length).toBeGreaterThan(0);
    const again = screenFindings(prose, [{ label: "save", at: 90 }]);
    expect(again).toEqual(first);
    first.r8.push("added by a caller");
    first.r13.length = 0;
    expect(screenFindings(prose, [{ label: "save", at: 90 }])).toEqual(again);
    // A different list of pressed buttons is a different key, not the remembered answer.
    expect(screenFindings(prose, [{ label: "config", at: 0 }])).not.toBe(again);
  });

  it("grows about linearly with the text, where it used to grow with its square", () => {
    // Baseline: the same function on a quarter of the text, timed in turn on the same machine, so the ratio holds on a
    // slow GitHub runner as on a dev box. Linear work gives about 4; the old code gave 12 or more on these texts (the
    // matches grow with the text and each one re-read the text before it). The limit of 8 still catches that.
    const small = text(10);
    const big = text(40);
    // A different text each time, so no run reuses work from another (the step lint remembers whole steps).
    const time = (s: string, i: number) => {
      const fresh = `${s}\n${i}`;
      const t = performance.now();
      fieldMentions(fresh);
      return performance.now() - t;
    };
    let smallMs = Infinity;
    let bigMs = Infinity;
    for (let i = 0; i < 5; i++) {
      smallMs = Math.min(smallMs, time(small, i));
      bigMs = Math.min(bigMs, time(big, i));
    }
    const growth = bigMs / Math.max(smallMs, 0.05); // the floor keeps a timer-resolution baseline from inflating the ratio
    expect(growth, `baseline ${smallMs.toFixed(1)} ms for ${small.length} chars, ${bigMs.toFixed(1)} ms for ${big.length}`).toBeLessThan(8);
  });
});
