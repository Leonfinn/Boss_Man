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
  // A line inside a multi-line block comment (" * …", or one opening "/**" or "/*") is all comment (BOS-2737).
  if (/^\s*(\*(?!\/)|\/\*)/.test(line) && !/\*\/./.test(line)) return " ".repeat(line.length);
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
export function scanSource(file: string, source: string, phrases: RegExp[] = PHRASES): Hit[] {
  const hits: Hit[] = [];
  const seen = new Set<string>();
  source.split("\n").forEach((raw, i) => {
    const code = codeOf(raw);
    for (const phrase of phrases) {
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

const isAllowed = (hit: Hit, allowed: Allowed[]) => allowed.find((a) => a.file === hit.file && hit.region.includes(a.text));

/** The hits that are neither allowed nor produced through the registry. Kept pure so a fixture can exercise it. */
export function unaccountedHits(files: Array<{ file: string; source: string }>, phrases: RegExp[] = PHRASES, allowed: Allowed[] = ALLOWED): Hit[] {
  return files.flatMap((f) => scanSource(f.file, f.source, phrases)).filter((h) => !isAllowed(h, allowed));
}

const WEB = fileURLToPath(new URL("../../../apps/web/src/", import.meta.url));
const APPS = fileURLToPath(new URL("../../../apps/", import.meta.url));
const SHARED = fileURLToPath(new URL("../src/", import.meta.url));

/** Every .ts/.tsx file under `dir`, named relative to `base` (apps/web/src by default, as the R43 list names them). */
function webSources(dir: string = WEB, base: string = WEB): Array<{ file: string; source: string }> {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => {
      const p = join(dir, e.name);
      if (e.isDirectory()) return webSources(p, base);
      return /\.tsx?$/.test(e.name) ? [{ file: relative(base, p).replace(/\\/g, "/"), source: readFileSync(p, "utf8") }] : [];
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

// BOS-2737 (R60): the same lint for "someone is on it" claims. Cock-ups round 7 (BOS-2736, L1) found five screens
// saying someone was acting when no run or ticket existed, each a fixed string. Every such line now comes from
// actionClaim (packages/shared/src/action-claim.ts), which words it from a started run, a ticket's assignee or an alert
// time. These phrases are refused anywhere else in apps/web/src, apps/server/src and packages/shared/src, outside
// comments. The uses listed below are agent-facing text or say something that was done in the same step (a card or
// wake sent there and then), each with why; a new fixed claim fails.

/** The fixed claim phrases. "on it" only as "is/are/'s on it", since "act on it" or "work on it" claim nothing. */
export const CLAIM_PHRASES = [/being looked into/i, /looking into/i, /looked into/i, /has been told/i, /have been told/i, /is handling/i, /(?:is|are|'s) on it/i];

export const CLAIM_ALLOWED: Allowed[] = [
  { file: "web/src/pages/Ticket.tsx", text: "the reviewer has been told that", why: "the review request carries the missing criteria in the same step that shows this; it names no one as acting" },
  { file: "web/src/pages/ProjectBudget.tsx", text: "The CEO has been told", why: "an out-of-band cost raises the CEO's cost alert in the same pass that marks the run (cost-check.ts raiseCostAlert); it says the alert went out, not that anyone is acting" },
  { file: "server/src/mcp-decisions.ts", text: "", why: "the decisions tool's description and replies, read by agents, not shown on an owner screen" },
  { file: "server/src/services/owner-todo.ts", text: "", why: "a refusal sent to the agent who wrote the note, not an owner screen" },
  { file: "server/src/services/review-common.ts", text: "The CEO has been told", why: "the merge gate's foreign-files result, written when its card goes to the CEO in the same step; not a claim that anyone is acting" },
  { file: "server/src/services/owner-holds.ts", text: "looked into it", why: "past tense, after the hold was released: names who released it with their own words, which is a fact" },
  { file: "server/src/services/loop-guards.ts", text: "It has been told to try a different approach", why: "the looping agent's note is sent in the same step; it says the agent was sent a note, not that anyone is acting" },
  { file: "server/src/services/no-progress.ts", text: "own CEO has been told too", why: "the home company's card is raised in the same step (raise, homeKey); it says the alert went out" },
  { file: "server/src/services/host-warnings.ts", text: "nobody is handling it yet", why: "the card's why: a negative, saying nobody acts yet" },
  { file: "server/src/services/line-holder.ts", text: "", why: "a note to the agent that holds the merge line, not an owner screen" },
];

const claimSources = () => [...webSources(join(APPS, "web/src"), APPS), ...webSources(join(APPS, "server/src"), APPS), ...webSources(SHARED, join(SHARED, "../.."))];

describe("no fixed 'someone is on it' claim outside actionClaim (R60, BOS-2737)", () => {
  const unaccounted = (file: string, source: string) => unaccountedHits([{ file, source }], CLAIM_PHRASES, CLAIM_ALLOWED).map(describeHit);

  it("fails on a fixed 'has been told' / 'looking into' / 'is handling' / 'on it' and names the file and line", () => {
    expect(unaccounted("web/src/pages/Board.tsx", "<span>No movement for 2 hours. The Scrum Master has been told.</span>")).toEqual([
      'web/src/pages/Board.tsx:1: "<span>No movement for 2 hours. The Scrum Master has been told.</span>"',
    ]);
    expect(unaccounted("web/src/host-facts-display.ts", 'const doing = "The CEO has been told and is looking into it.";')).toEqual([
      `web/src/host-facts-display.ts:1: "${'const doing = "The CEO has been told and is looking into it.";'}"`,
    ]);
    expect(unaccounted("server/src/services/ceo-plan.ts", "const s = `${who} is handling it.`;\nconst t = 'Dougal is on it';")).toEqual([
      'server/src/services/ceo-plan.ts:1: "const s = `${who} is handling it.`;"',
      `server/src/services/ceo-plan.ts:2: "const t = 'Dougal is on it';"`,
    ]);
  });

  it("lets through a comment and wording that claims nobody ('act on it', 'work on it')", () => {
    expect(unaccounted("server/src/services/x.ts", "// the CEO has been told\nconst a = 'Act on it now.';\nconst b = `Pick a run to work on it`;")).toEqual([]);
  });

  it("every current use in the app's source is actionClaim's or listed above with a reason", () => {
    const bad = unaccountedHits(claimSources(), CLAIM_PHRASES, CLAIM_ALLOWED);
    expect(bad.map(describeHit), "word the line with actionClaim (packages/shared/src/action-claim.ts) from the run, ticket or alert it is about; or, if it claims nobody is acting, add it to CLAIM_ALLOWED with why").toEqual([]);
  });

  it("every CLAIM_ALLOWED entry still matches a real line, so the list can't rot", () => {
    const hits = claimSources().flatMap((f) => scanSource(f.file, f.source, CLAIM_PHRASES));
    const stale = CLAIM_ALLOWED.filter((a) => !hits.some((h) => h.file === a.file && h.region.includes(a.text))).map((a) => a.file);
    expect(stale, "remove the CLAIM_ALLOWED entry, or fix its file/text: it no longer matches any line").toEqual([]);
  });
});
