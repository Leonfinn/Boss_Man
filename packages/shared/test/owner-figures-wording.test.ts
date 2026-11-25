import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// BOS-2583: R43 (packages/shared/src/owner-figures.ts) is the one place an owner-visible count is named and worded.
// But nothing stopped a screen building "N tasks are waiting on you" inline: on 25 Nov the board counted tasks while
// the Decisions badge counted cards, both said "waiting on you", and the registry never saw either figure
// ([[engineering/architecture/cock-ups-answer-25-nov-3-tasks-waiting-on-you-vs-2-decisions-cards]]).
//
// This lint reads apps/web/src and fails when a string literal or JSX text carries that "you owe / waiting on you"
// wording, which is how an owner-led count reads. The wording belongs in a registry label (figureText or its entry),
// and the registry lives in packages/shared, not in a screen. So a phrase the app scan finds came from a screen, not
// the registry. A few current uses are plain prose or a fixed state label (no count); each is listed below with why it
// is not a figure, so the next inline figure fails the check. A listed text that no longer matches also fails, so
// the list can't rot: fix the wording or drop the line.

/** The wording that reads as an owner-led count: one word "you" doing the asking. */
export const PHRASES = [/waiting on you/i, /waiting for you/i, /you owe/i, /answers owed/i];

/** One place a phrase is allowed to appear in a screen, because it is not a count. */
type Allowed = { file: string; text: string; why: string };

// Current uses on main (after BOS-2578). The prose and fixed-state ones are not counts. The last three are real
// counts the board already showed before R43 reached them: BOS-2578 kept the board's two-variable sentence (cards and
// tasks) rather than one registry label, so they are listed here with that reason. A NEW inline count is not listed,
// and fails the check.
export const ALLOWED: Allowed[] = [
  { file: "components/WeeklySummaryForm.tsx", text: "cards still waiting for you", why: "a sentence saying what the weekly email will contain, with no count next to it" },
  { file: "pages/settings/Tools.tsx", text: "waiting for you", why: "a deploy state's one-word label; there is no count" },
  { file: "pages/Dashboard.tsx", text: "Nothing is waiting for you.", why: "the empty case of a dashboard sentence, with no count (its counted case is Dashboard's, listed below)" },
  { file: "pages/Decisions.tsx", text: "Waiting for you", why: "a fixed pill label for a card kind; there is no count in it" },
  { file: "pages/Decisions.tsx", text: "It is waiting on you for a permission answer.", why: "one run's state as a sentence; there is no count" },
  { file: "pages/Decisions.tsx", text: "It is not waiting on you.", why: "the empty case of the same run state; there is no count" },
  { file: "pages/Decisions.tsx", text: "is waiting on you", why: "a pill saying one live run is holding its card; there is no count" },
  { file: "pages/MilestoneLeft.tsx", text: "Nothing here is waiting for you", why: "the empty case of a milestone's What's left list: it says no ticket waits for the owner, and its only number is a gone-quiet count, not a waiting-on-you figure" },
  { file: "pages/Ticket.tsx", text: "waiting for you", why: "a sign-off state word shown for one ticket; there is no count" },
  // Real counts the board already showed before this rule reached them; kept because the sentence is not one figure.
  {
    file: "components/OwnerAsks.tsx",
    text: "waiting on you",
    why: "the your-review banner; BOS-2578 kept its two-variable sentence (questions and tasks) rather than one registry label, so it is listed here, not registered",
  },
  {
    file: "pages/Decisions.tsx",
    text: "waiting for you",
    why: "the Decisions page's count line ({summary.total}); a single registry label would drop its per-kind breakdown, so it is listed here",
  },
  {
    file: "pages/Dashboard.tsx",
    text: "Waiting for you now",
    why: "the old dashboard 'Right now' line, partly retired; listed until it is replaced, not registered as a new figure",
  },
];

/** One phrase occurrence: its 1-based line, the enclosing quoted/JSX text run, and the raw line for the report. */
export type Hit = { file: string; line: number; region: string; text: string };

/** Blank out comments so a phrase in a comment is not a hit: block comments outright, `//` and JSX `{/* … *\/}` to the line end. */
function codeOf(line: string): string {
  return line
    .replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length))
    .replace(/(^|[^:"'`])\/\/.*$/, "$1");
}

const wordBoundary = (s: string, at: number, len: number) => {
  const before = at > 0 ? s[at - 1]! : "";
  const after = s[at + len] ?? "";
  return !/[A-Za-z]/.test(before) && !/[A-Za-z]/.test(after);
};

const unescaped = (s: string, i: number) => {
  let bs = 0;
  for (let k = i - 1; k >= 0 && s[k] === "\\"; k--) bs++;
  return bs % 2 === 0;
};

/**
 * The text run a phrase sits in. If it is inside a quoted literal, that literal's text (`"…"`, `'…'`, or a backtick
 * template scanned across the whole line). Otherwise the JSX text between the tags around it.
 */
function regionOf(code: string, at: number): string {
  // The innermost literal around the phrase: its opener is the nearest unescaped quote of one kind to the left whose
  // matching close is to the right of the phrase.
  let best: { start: number; end: number } | null = null;
  for (const q of ['"', "'", "`"]) {
    for (let i = 0; i < at; i++) {
      if (code[i] !== q || !unescaped(code, i)) continue;
      const end = code.indexOf(q, i + 1);
      if (end === -1 || at >= end) continue;
      if (!best || i > best.start) best = { start: i, end };
    }
  }
  if (best) return code.slice(best.start + 1, best.end);
  // JSX text: from the nearest tag/element boundary before to the nearest after.
  const before = Math.max(code.lastIndexOf(">", at), code.lastIndexOf("{", at), -1);
  const afterMatches = [code.indexOf("<", at), code.indexOf("{", at)].filter((i) => i !== -1);
  const after = afterMatches.length ? Math.min(...afterMatches) : code.length;
  return code.slice(before + 1, after).trim();
}

/** Every phrase occurrence in one file's source, outside comments, deduped by line and run. */
export function scanSource(file: string, source: string): Hit[] {
  const hits: Hit[] = [];
  const seen = new Set<string>();
  source.split("\n").forEach((raw, i) => {
    const code = codeOf(raw);
    for (const phrase of PHRASES) {
      for (const m of code.matchAll(new RegExp(phrase.source, "gi"))) {
        const at = m.index ?? 0;
        if (!wordBoundary(code, at, m[0].length)) continue;
        const region = regionOf(code, at);
        const key = `${i + 1}\u0000${region}`;
        if (seen.has(key)) continue;
        seen.add(key);
        hits.push({ file, line: i + 1, region, text: raw.trim() });
      }
    }
  });
  return hits;
}

const isAllowed = (hit: Hit) => ALLOWED.find((a) => a.file === hit.file && hit.region.includes(a.text));

/** The hits that are neither allowed nor produced through the registry. Kept pure so a fixture can exercise it. */
export function unaccountedHits(files: Array<{ file: string; source: string }>): Hit[] {
  return files.flatMap((f) => scanSource(f.file, f.source)).filter((h) => !isAllowed(h));
}

const WEB = fileURLToPath(new URL("../../../apps/web/src/", import.meta.url));

function webSources(dir: string = WEB): Array<{ file: string; source: string }> {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => {
      const p = join(dir, e.name);
      if (e.isDirectory()) return webSources(p);
      return /\.tsx?$/.test(e.name) ? [{ file: relative(WEB, p).replace(/\\/g, "/"), source: readFileSync(p, "utf8") }] : [];
    })
    .sort((a, b) => a.file.localeCompare(b.file));
}

const describeHit = (h: Hit) => `${h.file}:${h.line}: "${h.text}"`;

describe("no owner-led 'waiting on you' figure is built inline in apps/web/src (R43, BOS-2583)", () => {
  it("fails on an inline '3 tasks are waiting on you' template and names its file and line", () => {
    const fixture = "apps/web/src/components/Board.tsx";
    const source = ["function Banner({ tasks }: { tasks: number }) {", "  return <p>{`${tasks} tasks are waiting on you.`}</p>;", "}"].join("\n");
    expect(unaccountedHits([{ file: fixture, source }]).map(describeHit)).toEqual([
      `${fixture}:2: "${"return <p>{`${tasks} tasks are waiting on you.`}</p>;"}"`,
    ]);
  });

  it("fails on the same wording in plain JSX text and in a double-quoted string", () => {
    expect(unaccountedHits([{ file: "pages/Board.tsx", source: "const x = <span>3 answers owed</span>;" }]).map(describeHit)).toEqual([
      `pages/Board.tsx:1: "const x = <span>3 answers owed</span>;"`,
    ]);
    expect(unaccountedHits([{ file: "pages/Board.tsx", source: 'const line = "Cards waiting for you: 3";' }]).map(describeHit)).toEqual([
      `pages/Board.tsx:1: "${'const line = "Cards waiting for you: 3";'}"`,
    ]);
  });

  it("ignores the wording in a comment (it is not shown to the owner)", () => {
    expect(unaccountedHits([{ file: "pages/Board.tsx", source: "// 3 tasks are waiting on you, see BOS-2578\nconst x = 1;" }])).toEqual([]);
    expect(unaccountedHits([{ file: "pages/Board.tsx", source: "/* cards waiting for you */\nconst x = 1;" }])).toEqual([]);
  });

  it("every current use in apps/web/src goes through the registry or is listed above with a reason", () => {
    const bad = unaccountedHits(webSources());
    expect(
      bad.map(describeHit),
      "add the figure to packages/shared/src/owner-figures.ts (a label's `word`/`label`) and show it with figureText; or, if it is plain prose and not a count, add it to ALLOWED in this test with why",
    ).toEqual([]);
  });

  it("every ALLOWED entry still matches a real run, so the list can't rot", () => {
    const hits = webSources().flatMap((f) => scanSource(f.file, f.source));
    const stale = ALLOWED.filter((a) => !hits.some((h) => h.file === a.file && h.region.includes(a.text))).map((a) => a.file);
    expect(stale, "remove the ALLOWED entry, or fix its file/text: it no longer matches any line").toEqual([]);
  });
});
