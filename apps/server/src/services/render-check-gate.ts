// BOS-2511: a branch that changes a screen's layout reaches review only with a real-browser render test and before/after
// screenshots, or the author's noVisualChange reason. Brains' rule from the 24 Nov 14:45 cock-ups answer (BOS-2400 and
// BOS-2496 merged layout faults the owner then found on the board; both reviews were code reads).
//
// Pure: the caller gives the branch diff and the ticket's images. Design choices:
// - The trigger reads the changed lines, not just paths, so a handler-only edit to a page doesn't need the way out.
//   A truncated diff falls back to the path alone (fail closed: an unread hunk might be layout).
// - A render test counts when its added lines measure geometry. A test that only checks classes exist (BOS-2496's)
//   doesn't, which is the gap this closes. A truncated diff that never reaches the test's hunk counts it on its path:
//   the reviewer reads the test anyway, and refusing a real test for our own truncation would teach agents to game it.
// - "Screenshots attached" can't prove the pictures came from scripts/screenshot.mjs rather than a mock-up; the review
//   guidance (RENDER_CHECK_REVIEW_GUIDANCE) makes the reviewer open them and say what they checked.
import type { WorkspaceDiff } from "@boss-man/shared";

export const NO_VISUAL_CHANGE_MIN = 10;
export const NO_VISUAL_CHANGE_MAX = 300;

const STYLES = "apps/web/src/styles.css";
const SCREEN_TSX = /^apps\/web\/src\/(?:pages|components)\/.+\.tsx$/;
const RENDER_TEST = /^apps\/web\/test\/(?:.+\/)?[^/]+-render\.test\.tsx?$/;
/** A JSX tag (opening, closing or fragment) where an expression can start, or a className/style prop. `useState<string>` doesn't match: a letter comes before its `<`. */
const JSX_LINE = /(?:^|[\s({>?:,=]|&&|\|\|)<\/?(?:[A-Za-z]|>)|\bclassName\s*=|\bstyle\s*=\s*\{/;
/** Calls that measure layout in a browser: bounding boxes, overflow, size. */
const GEOMETRY = /\b(?:getBoundingClientRect|getClientRects|boundingBox|scrollWidth|scrollHeight|clientWidth|clientHeight|offsetWidth|offsetHeight)\b/;

type Image = { name: string; caption: string | null; byAgent: boolean };

/** Each file's changed lines (+ and -, without the marker), by its new path (old path for a deletion). */
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

/** Only the added lines of one file. */
function addedLines(diff: string, path: string): string[] {
  const out: string[] = [];
  let inFile = false;
  for (const line of diff.split("\n")) {
    const head = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (head) {
      inFile = head[2] === path;
      continue;
    }
    if (inFile && line.startsWith("+") && !line.startsWith("+++")) out.push(line.slice(1));
  }
  return out;
}

/** The branch's files that change a screen's layout: styles.css, or page/component .tsx whose changed lines hold JSX. */
export function layoutFiles(d: Pick<WorkspaceDiff, "files" | "diff" | "truncated">): string[] {
  const byFile = changedLinesByFile(d.diff);
  return d.files
    .map((f) => f.path)
    .filter((p) => {
      if (p === STYLES) return true;
      if (!SCREEN_TSX.test(p)) return false;
      const lines = byFile.get(p);
      if (!lines) return d.truncated || !d.diff; // not in the text we have: can't tell, so it counts
      return lines.some((l) => JSX_LINE.test(l));
    });
}

/** The branch's render tests that measure geometry (see the header for the truncated case). */
export function geometryRenderTests(d: Pick<WorkspaceDiff, "files" | "diff" | "truncated">): string[] {
  const byFile = changedLinesByFile(d.diff);
  return d.files
    .filter((f) => RENDER_TEST.test(f.path) && f.added > 0)
    .map((f) => f.path)
    .filter((p) => (byFile.has(p) ? addedLines(d.diff, p).some((l) => GEOMETRY.test(l)) : d.truncated || !d.diff));
}

/** Two agent-attached pictures, one named "before" and another "after" (caption or file name). */
export function hasBeforeAfterShots(images: Image[]): boolean {
  const mine = images.filter((i) => i.byAgent);
  const label = (i: Image) => `${i.caption ?? ""} ${i.name}`;
  const before = mine.filter((i) => /\bbefore\b/i.test(label(i)));
  const after = mine.filter((i) => /\bafter\b/i.test(label(i)));
  return before.length > 0 && after.length > 0 && new Set([...before, ...after]).size >= 2;
}

export function noVisualChangeProblem(why: string): string | null {
  const t = why.trim();
  if (t.length < NO_VISUAL_CHANGE_MIN) return `noVisualChange needs a reason of at least ${NO_VISUAL_CHANGE_MIN} characters: say why the layout doesn't change (e.g. "only the click handler changed").`;
  if (/[\r\n]/.test(t)) return "noVisualChange must be one line.";
  return null;
}

/** The refusal for a move to review, or null when the rule doesn't apply or is met. */
export function renderCheckRefusal(input: { diff: Pick<WorkspaceDiff, "files" | "diff" | "truncated">; images: Image[]; noVisualChange?: string }): string | null {
  const files = layoutFiles(input.diff);
  if (!files.length) return null;
  if (input.noVisualChange?.trim()) return null;
  const test = geometryRenderTests(input.diff).length > 0;
  const shots = hasBeforeAfterShots(input.images);
  if (test && shots) return null;
  const missing = [
    ...(test ? [] : ["a render test (apps/web/test/<name>-render.test.tsx) that measures geometry in a real browser"]),
    ...(shots ? [] : ['before and after screenshots attached to the ticket (attach_image, captions naming "before" and "after")']),
  ];
  const named = files.slice(0, 5).join(", ") + (files.length > 5 ? ` and ${files.length - 5} more` : "");
  return [
    `This branch changes a screen's layout (${named}), so it needs a real-browser check before review (BOS-2511). Missing: ${missing.join("; ")}.`,
    "The render test follows apps/web/test/merge-queue-held-render.test.tsx (BOS-1078): the real component and styles.css in a headless browser, at the widths the devices tool gives plus a 390 px phone, with the new state (an age, a long name, many items). It asserts geometry (boxes don't overlap, a line stays one line tall, nothing runs off its container), not that classes exist.",
    "The screenshots come from scripts/screenshot.mjs with seeded --api data, before (on origin/main) and after (on your branch), at the same widths. HTML mock-ups don't count. See docs/28-browser-checks.md.",
    'If the change truly doesn\'t alter the layout (a handler, a label\'s wording), move to review again with noVisualChange: "<why>"; the reviewer must agree with it.',
  ].join("\n");
}

/** For the review wake: what a reviewer checks on a branch the rule covers. */
export const RENDER_CHECK_REVIEW_GUIDANCE =
  'Screen changes (BOS-2511): if the branch changes apps/web/src/styles.css or the JSX of a page or component, open the ticket\'s "before" and "after" screenshots (open_attachment) and say in your verdict what you checked and at which widths, and confirm its *-render.test measures geometry (overlap, one line tall, nothing running off), not class names. If the state note says "No visual change", say whether you agree. Not opening the screenshots, or a mock-up in place of the app, means request changes.';
