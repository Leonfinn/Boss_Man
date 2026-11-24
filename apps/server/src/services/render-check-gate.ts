// BOS-2511 (DR-075): a branch that changes a screen's layout reaches review only with a real-browser render test and
// seeded before/after screenshots, or the author's noVisualChange reason. From Brains' 24 Nov 14:45 cock-ups answer:
// BOS-2400 and BOS-2496 merged layout faults the owner then found on the board, and both reviews were code reads.
//
// Pure: the caller reads the branch diff, the candidate test files and the ticket's images. Design choices:
// - The trigger reads the changed lines, not just paths, so a handler-only edit to a page doesn't need the way out.
//   A truncated diff falls back to the path alone (fail closed: an unread hunk might be layout).
// - A render test counts on its whole file at the branch head: it loads styles.css, drives a real browser
//   (playwright/chromium) and measures geometry. Added lines alone won't do: jsdom answers getBoundingClientRect with
//   zeros, so a jsdom test with one geometry call measures nothing (BOS-2496's failure), and a new case in an existing
//   browser test would be refused for a helper it already has.
// - Screenshots count only with the PNG marker scripts/screenshot.mjs writes for --api fixtures (scripts/png-marker.mjs),
//   attached by an agent since the ticket first went to In progress. That keeps out the HTML mock-up path; it is not a
//   signature. The reviewer still opens them (RENDER_CHECK_REVIEW_GUIDANCE).
import type { WorkspaceDiff } from "@boss-man/shared";

export const NO_VISUAL_CHANGE_MIN = 10;
export const NO_VISUAL_CHANGE_MAX = 300;
/** Same strings as scripts/png-marker.mjs; test/render-check-gate.test.ts runs that writer through this reader. */
export const SCREENSHOT_MARKER_KEY = "bossman-screenshot";
export const SCREENSHOT_MARKER_SEEDED = "api=seeded";
/** How much of each picture the caller reads: the marker sits right after IHDR, in the first hundred bytes or so. */
export const MARKER_PREFIX_BYTES = 4096;

const BY_PATH = new Set(["apps/web/src/styles.css", "apps/web/src/App.tsx"]);
const SCREEN_TSX = /^apps\/web\/src\/(?:pages|components)\/.+\.tsx$/;
const RENDER_TEST = /^apps\/web\/test\/(?:.+\/)?[^/]+-render\.test\.tsx?$/;
/** A JSX tag (opening, closing or fragment) where an expression can start, or a className/style prop. `useState<string>` doesn't match: a letter comes before its `<`. */
const JSX_LINE = /(?:^|[\s({>?:,=]|&&|\|\|)<\/?(?:[A-Za-z]|>)|\bclassName\s*=|\bstyle\s*=\s*\{/;
/** Calls that measure layout in a browser: bounding boxes, overflow, size. */
const GEOMETRY = /\b(?:getBoundingClientRect|getClientRects|boundingBox|scrollWidth|scrollHeight|clientWidth|clientHeight|offsetWidth|offsetHeight)\b/;

type Diff = Pick<WorkspaceDiff, "files" | "diff" | "truncated">;
export type ShotFacts = { name: string; caption: string | null; byAgent: boolean; seeded: boolean; sinceStart: boolean };

/** Each file's changed lines (+ and -, without the marker), by its new path (and old path for a rename). */
export function changedLinesByFile(diff: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const line of diff.split("\n")) {
    const head = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (head) {
      current = [];
      out.set(head[2]!, current);
      if (head[1] !== head[2]) out.set(head[1]!, current);
      continue;
    }
    if (!current || line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+") || line.startsWith("-")) current.push(line.slice(1));
  }
  return out;
}

/** The branch's files that change a screen's layout: styles.css, App.tsx, or page/component .tsx whose changed lines hold JSX. */
export function layoutFiles(d: Diff): string[] {
  const byFile = changedLinesByFile(d.diff);
  return d.files
    .map((f) => f.path)
    .filter((p) => {
      if (BY_PATH.has(p)) return true;
      if (!SCREEN_TSX.test(p)) return false;
      const lines = byFile.get(p);
      if (!lines) return d.truncated || !d.diff; // not in the text we have: can't tell, so it counts
      return lines.some((l) => JSX_LINE.test(l));
    });
}

/** Changed or added render tests (a pure deletion has nothing to read). */
export function renderTestCandidates(d: Diff): string[] {
  return d.files.filter((f) => RENDER_TEST.test(f.path) && f.added > 0).map((f) => f.path);
}

/** A whole test file that loads the real stylesheet, drives a real browser and measures geometry. */
export function isBrowserRenderTest(text: string): boolean {
  return /styles\.css/.test(text) && /\b(?:playwright|chromium)\b/i.test(text) && GEOMETRY.test(text);
}

/** True when the PNG's chunks before the image data carry the seeded-screenshot marker. */
export function hasSeededMarker(bytes: Uint8Array): boolean {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b.length < 8 || b.readUInt32BE(0) !== 0x89504e47 || b.readUInt32BE(4) !== 0x0d0a1a0a) return false;
  for (let at = 8; at + 8 <= b.length; ) {
    const len = b.readUInt32BE(at);
    const type = b.toString("latin1", at + 4, at + 8);
    if (type === "IDAT" || type === "IEND") return false;
    const end = at + 8 + len;
    if (end > b.length) return false;
    if (type === "tEXt") {
      const data = b.subarray(at + 8, end);
      const nul = data.indexOf(0);
      if (nul > 0 && data.toString("latin1", 0, nul) === SCREENSHOT_MARKER_KEY && data.toString("latin1", nul + 1) === SCREENSHOT_MARKER_SEEDED) return true;
    }
    at = end + 4;
  }
  return false;
}

/** Two counting pictures, one named "before" and another "after" (caption or file name). */
export function hasBeforeAfterShots(images: ShotFacts[]): boolean {
  const ok = images.filter((i) => i.byAgent && i.seeded && i.sinceStart);
  const label = (i: ShotFacts) => `${i.caption ?? ""} ${i.name}`;
  const before = ok.filter((i) => /\bbefore\b/i.test(label(i)));
  const after = ok.filter((i) => /\bafter\b/i.test(label(i)));
  return before.length > 0 && after.length > 0 && new Set([...before, ...after]).size >= 2;
}

export function noVisualChangeProblem(why: string): string | null {
  const t = why.trim();
  if (t.length < NO_VISUAL_CHANGE_MIN) return `noVisualChange needs a reason of at least ${NO_VISUAL_CHANGE_MIN} characters: say why the layout doesn't change (e.g. "only the click handler changed").`;
  if (/[\r\n]/.test(t)) return "noVisualChange must be one line.";
  return null;
}

/**
 * The refusal for a move to review, or null when the rule is met. `layout` is layoutFiles(diff) (non-empty, or the
 * caller wouldn't ask); `tests` holds each renderTestCandidates path with its text at the head, or null if unreadable.
 */
export function renderCheckRefusal(input: { layout: string[]; tests: Array<{ path: string; text: string | null }>; images: ShotFacts[] }): string | null {
  if (!input.layout.length) return null;
  const test = input.tests.some((t) => t.text !== null && isBrowserRenderTest(t.text));
  const unread = input.tests.filter((t) => t.text === null).map((t) => t.path);
  const shots = hasBeforeAfterShots(input.images);
  if (test && shots) return null;
  const notCounted = input.tests.filter((t) => t.text !== null).map((t) => t.path);
  const otherShots = input.images.filter((i) => i.byAgent && !(i.seeded && i.sinceStart)).length;
  const missing = [
    ...(test
      ? []
      : [
          `a render test (apps/web/test/<name>-render.test.tsx) that reads styles.css, drives playwright/chromium and measures geometry${notCounted.length ? ` (${notCounted.join(", ")} doesn't: a jsdom test measures zeros)` : ""}${unread.length ? ` (couldn't read ${unread.join(", ")} from the branch: commit it and try again)` : ""}`,
        ]),
    ...(shots
      ? []
      : [
          `"before" and "after" screenshots from scripts/screenshot.mjs --api attached to the ticket since it went to In progress${otherShots ? ` (${otherShots} picture${otherShots === 1 ? "" : "s"} attached don't count: no seeded-data mark from screenshot.mjs --api, or added before the ticket started)` : ""}`,
        ]),
  ];
  const named = input.layout.slice(0, 5).join(", ") + (input.layout.length > 5 ? ` and ${input.layout.length - 5} more` : "");
  return [
    `This branch changes a screen's layout (${named}), so it needs a real-browser check before review (BOS-2511, DR-075). Missing: ${missing.join("; ")}.`,
    "The render test follows apps/web/test/merge-queue-held-render.test.tsx (BOS-1078): the real component and styles.css in a headless browser, at the widths the devices tool gives plus a 390 px phone, with the new state (an age, a long name, many items). It asserts geometry (boxes don't overlap, a line stays one line tall, nothing runs off its container), not that classes exist.",
    'The screenshots come from scripts/screenshot.mjs with seeded --api data (that marks the PNG), "before" on origin/main and "after" on your branch at the same widths, attached with attach_image and captions naming before and after. HTML mock-ups don\'t count. See docs/28-browser-checks.md.',
    'If the change truly doesn\'t alter the layout (a handler, a label\'s wording), move to review again with noVisualChange: "<why>"; the reviewer must agree with it.',
  ].join("\n");
}

/** For the review wake: what a reviewer checks on a branch the rule covers. */
export const RENDER_CHECK_REVIEW_GUIDANCE =
  'Screen changes (BOS-2511): if the branch changes apps/web/src/styles.css, App.tsx or the JSX of a page or component, open the ticket\'s "before" and "after" screenshots (open_attachment) and say in your verdict what you checked and at which widths, and confirm its *-render.test measures geometry in a real browser (overlap, one line tall, nothing running off), not class names. If the state note says "No visual change", say whether you agree. Not opening the screenshots means request changes.';
