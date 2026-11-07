// Acceptance criteria on tickets: the same shape as engagements.acceptanceCriteria, plus the
// check that the author reported pass or fail for each before a review, and the checklist the
// reviewer sees. The verdict parser is deliberately plain text matching, not NLP: the refusal
// message tells the author exactly what to write, and what it cannot tie to a criterion counts
// as missing. Shared so the server's review gate and the web's checklist agree exactly.
import { z } from "zod";

/** A criterion as stored: a plain string, checked before merge (old rows stay strings), or the
 * `{ text, after: "merge" }` form for a check only a real host can settle (DR-024 #5). */
export type Criterion = string | { text: string; after: "merge" };

/** The criterion's own words, without its after-merge mark. */
export const criterionText = (c: Criterion): string => (typeof c === "string" ? c : c.text);

/** True when the criterion is checked after merge, so reviewers skip it. */
export const isAfterMerge = (c: Criterion): boolean => typeof c !== "string" && c.after === "merge";

/** The stored criteria as plain text, for the forms and tools that only take a list of strings. */
export const criteriaText = (criteria: readonly Criterion[]): string[] => criteria.map(criterionText);

const criterionSchema = z.union([z.string().trim().min(1).max(500), z.object({ text: z.string().trim().min(1).max(500), after: z.literal("merge") })]);

/** Same limits as engagements' Terms (app.ts, mcp.ts): up to 10 non-empty criteria, capped length.
 * Only the max is enforced here: an empty list means "no criteria", which is allowed everywhere. */
export const acceptanceCriteriaSchema = z.array(criterionSchema).max(10);

/** Parses a value that may hold criteria (a stored jsonb column, an API body) and returns `fallback` when it doesn't. */
export const readCriteria = (value: unknown, fallback: readonly Criterion[] = []): Criterion[] => {
  const parsed = acceptanceCriteriaSchema.safeParse(value);
  return parsed.success ? parsed.data : [...fallback];
};

export type Verdict = "pass" | "fail" | null;

/** Lowercase and flatten whitespace so matching ignores case and double spaces. */
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ");

/** Filler words that carry none of a criterion's meaning once it is parsed apart. */
const STOP = new Set(["a", "an", "the", "and", "or", "is", "are", "was", "be", "been", "to", "of", "for", "in", "on", "with", "it", "its", "each", "every", "this", "that", "these", "those", "which", "when", "if", "any", "all"]);

/** Criterion words minus the filler; numbers stay, they often are the check itself. */
const tokens = (s: string) => norm(s).split(/[^a-z0-9]+/).filter((w) => w.length >= 2 && !STOP.has(w));

const PASS = /\b(pass|passed|passes|passing|ok|done|yes|green|✓|✔)\b/i;
const FAIL = /\b(fail|failed|fails|failing|broken|red|✗|✘)\b/i;

/** "1 pass", "C2 fail: why", "3: ok": a criterion's number (in criteria order) then its verdict word. */
const NUMBERED = /^c?(\d{1,2})\s*[:=)-]?\s*(pass(?:ed|es|ing)?|ok|done|yes|green|✓|✔|fail(?:ed|s|ing)?|broken|red|✗|✘)(?!\w)/i;

/** Verdicts given by number; only where a segment (split on . ; , and newlines) starts with the number, so
 * "Suite: 3 passed" is not criterion 3. The first one stated for a number wins, numbers out of range are ignored. */
function numberedVerdicts(count: number, note: string): Map<number, Exclude<Verdict, null>> {
  const found = new Map<number, Exclude<Verdict, null>>();
  for (const seg of note.split(/[.;,\n]/)) {
    const m = NUMBERED.exec(seg.trim());
    if (!m) continue;
    const n = Number(m[1]);
    if (n < 1 || n > count || found.has(n)) continue;
    found.set(n, FAIL.test(m[2]!) ? "fail" : "pass");
  }
  return found;
}

/**
 * Reads the author's pass/fail for each criterion out of the state note. The note is cut into
 * sentences (on . ; and newlines); a sentence counts for a criterion when it contains enough of
 * the criterion's words (60%, or every word if the criterion has few), and that sentence's pass
 * or fail word is the verdict. Numbered verdicts ("1 pass; 2 fail: why", "C3 ok") in criteria order
 * also count when they start a segment; a fail from either reading wins. A criterion no sentence claims comes back as null: not reported.
 */
export function readVerdicts(criteria: readonly Criterion[], note: string | null | undefined): Array<{ criterion: string; verdict: Verdict }> {
  const texts = criteria.map(criterionText);
  const segments = (note ?? "").split(/[.;\n]/).map((s) => s.trim()).filter(Boolean);
  const bag = segments.map((s) => new Set(tokens(s)));
  const raw = segments;
  const numbered = numberedVerdicts(texts.length, note ?? "");
  return texts.map((criterion, idx) => {
    const byNumber = numbered.get(idx + 1) ?? null;
    const want = tokens(criterion);
    let verdict: Verdict = null;
    if (want.length) {
      const need = want.length <= 2 ? want.length : Math.ceil(want.length * 0.6);
      let best = -1;
      for (let i = 0; i < bag.length; i++) {
        const hit = want.filter((w) => bag[i]!.has(w)).length;
        if (hit >= need && hit > (best < 0 ? 0 : want.filter((w) => bag[best]!.has(w)).length)) best = i;
      }
      if (best >= 0) verdict = FAIL.test(raw[best]!) ? "fail" : PASS.test(raw[best]!) ? "pass" : null;
    }
    // A fail from either reading wins, so stray prose can never turn a stated fail into a pass.
    if (byNumber === "fail" || verdict === "fail") verdict = "fail";
    else verdict = byNumber ?? verdict;
    return { criterion, verdict };
  });
}

/**
 * The criteria the author gave no pass or fail verdict for; empty means the note covers them all.
 * `only` narrows it: "before" is the review gate (after-merge criteria never hold up a review), and
 * "after" is the done gate once the work has merged.
 */
export function missingVerdicts(criteria: readonly Criterion[], note: string | null | undefined, only?: "before" | "after"): string[] {
  const keep = (c: Criterion) => !only || (only === "after" ? isAfterMerge(c) : !isAfterMerge(c));
  return readVerdicts(criteria, note)
    .filter((r, i) => keep(criteria[i]!) && r.verdict === null)
    .map((r) => r.criterion);
}

/** The after-merge criteria with no verdict yet: what keeps a merged ticket open. */
export const unreportedAfterMerge = (criteria: readonly Criterion[], note: string | null | undefined): string[] => missingVerdicts(criteria, note, "after");

/** The after-merge criteria reported fail: a live check that failed, which gets a follow-up ticket (DR-009 #5, BOS-575). */
export const failedAfterMerge = (criteria: readonly Criterion[], note: string | null | undefined): string[] =>
  readVerdicts(criteria, note)
    .filter((r, i) => isAfterMerge(criteria[i]!) && r.verdict === "fail")
    .map((r) => r.criterion);

/**
 * At merge (BOS-575): nothing can have failed on the live work yet, so a criterion still at fail when the
 * branch lands hasn't been shown, it has been put off ("3 fail: measured after merge, owner accepted").
 * It is carried over: marked after merge, and its stale fail dropped from the note (a fail always wins
 * in readVerdicts, so it would otherwise outvote the later pass). The passes are kept by number. Null when
 * no criterion is at fail, so the note is left exactly as it was.
 */
export function carryFailedOver(criteria: readonly Criterion[], note: string | null | undefined): { criteria: Criterion[]; carried: string[]; note: string } | null {
  const verdicts = readVerdicts(criteria, note);
  if (!verdicts.some((r) => r.verdict === "fail")) return null;
  const next = criteria.map((c, i): Criterion => (verdicts[i]!.verdict === "fail" ? { text: criterionText(c), after: "merge" } : c));
  const passed = verdicts.flatMap((r, i) => (r.verdict === "pass" ? [`${i + 1} pass`] : []));
  const put = verdicts.flatMap((r, i) => (r.verdict === "fail" ? [i + 1] : []));
  // No pass or fail word in the second sentence, so it can't be read as a verdict for any criterion.
  const rest = `Carried over at merge, to show now the work is live: criterion ${put.join(" and ")}`;
  return { criteria: next, carried: verdicts.filter((r) => r.verdict === "fail").map((r) => r.criterion), note: passed.length ? `${passed.join("; ")}. ${rest}` : rest };
}

/** Words that mean a check can only be settled once the work is live, not in a review. */
const LIVE = /\b(after (the )?merg(?:e|ing)|once (it'?s |it is )?(merged|live|deployed|in production)|post-?merge|standby window|live deploy|on a real host|on the (real|production) host|on your (own )?(host|machine|server)|on the (owner'?s )?(host|machine|server))\b/i;

/**
 * The warning the author sees when a criterion reads like a live check but isn't marked after merge:
 * it doesn't refuse anything, so an old ticket is never held up. Empty means nothing to warn about.
 */
export function afterMergeLint(criteria: readonly Criterion[]): string {
  const loose = criteria.filter((c) => !isAfterMerge(c) && LIVE.test(criterionText(c)));
  if (!loose.length) return "";
  const names = loose.map((c) => `"${criterionText(c)}"`).join(", ");
  const them = loose.length === 1 ? "it" : "them";
  return `${names} can only be checked once the work is live: mark ${them} "on a real host" so reviewers don't fail the ticket on ${them}. This is a warning only.`;
}
/**
 * The criteria a stuck review could move to "after the merge" (BOS-422): what the reviewers' words fail, when every one
 * of those reads like a live check (see afterMergeLint) and there is nothing else to fix. Empty when a review has a line
 * comment, fails nothing we can name, or fails any criterion that must hold before merge.
 */
export function movableFailures(criteria: readonly Criterion[], comments: readonly unknown[], reviewText: string): string[] {
  if (comments.length) return [];
  const failed = readVerdicts(criteria, reviewText).flatMap((r, i) => (r.verdict === "fail" ? [criteria[i]!] : []));
  if (!failed.length || failed.some((c) => isAfterMerge(c) || !LIVE.test(criterionText(c)))) return [];
  return failed.map(criterionText);
}
