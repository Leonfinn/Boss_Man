// Acceptance criteria on tickets: the same shape as engagements.acceptanceCriteria, plus the
// check that the author reported pass or fail for each before a review, and the checklist the
// reviewer sees. The verdict parser is deliberately plain text matching, not NLP: the refusal
// message tells the author exactly what to write, and what it cannot tie to a criterion counts
// as missing. Shared so the server's review gate and the web's checklist agree exactly.
import { z } from "zod";
import { factClauses, namesHostFact } from "./host-facts.js";
import { namesPage, pageClauses } from "./page-clause.js";

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
function numberedVerdicts(count: number, segments: readonly string[]): Map<number, { verdict: Exclude<Verdict, null>; at: number }> {
  const found = new Map<number, { verdict: Exclude<Verdict, null>; at: number }>();
  segments.forEach((seg, at) => {
    const m = NUMBERED.exec(seg.trim());
    if (!m) return;
    const n = Number(m[1]);
    if (n < 1 || n > count || found.has(n)) return;
    found.set(n, { verdict: FAIL.test(m[2]!) ? "fail" : "pass", at });
  });
  return found;
}

/**
 * A verdict Boss Man wrote from the owner's answer on a card (BOS-1155): `Owner answered "..." (the owner): 5 pass and 6 fail — ...`.
 * cardAnswerLine writes it with no . ; or , in it, so it is always one segment. A later verdict the ticket's
 * own author reports for the same criterion replaces it; the card line never counts as the author's words.
 */
const CARD_LINE = /^Owner answered .*?\) ?: ((?:\d{1,2} (?:pass|fail)(?: and )?)+)/;

/** What an option means for the criteria its card settles (BOS-1155). */
export type OptionVerdicts = Record<string, "pass" | "fail" | "none">;

/** Null when `map` gives every option exactly one of pass, fail or none (and names no other option); otherwise the refusal text. */
export function optionVerdictsRefusal(options: readonly string[], map: Record<string, string> | undefined | null): string | null {
  const how = "A card that settles an after-merge check needs optionVerdicts: for each option, whether choosing it means the check passed (\"pass\"), failed (\"fail\") or says nothing about it (\"none\"), e.g. {\"Close it on the tests\": \"pass\", \"Keep it open\": \"none\"}. Boss Man never guesses this from the option's words.";
  if (!map || !Object.keys(map).length) return how;
  const bad = options.filter((o) => !["pass", "fail", "none"].includes(map[o] as string));
  if (bad.length) return `optionVerdicts has no pass, fail or none for ${bad.map((o) => `"${o}"`).join(", ")}. ${how}`;
  const extra = Object.keys(map).filter((k) => !options.includes(k));
  if (extra.length) return `optionVerdicts names ${extra.map((o) => `"${o}"`).join(", ")}, which ${extra.length === 1 ? "is" : "are"} not an option on the card. Use each option's exact text.`;
  return null;
}

/** The note line for a card answer. `said` and `question` have their separators removed so the line stays one segment. */
export function cardAnswerLine(question: string, by: string, verdicts: ReadonlyArray<{ n: number; verdict: "pass" | "fail"; text: string }>, said: string): string {
  const plain = (s: string) => s.replace(/[.;,\n]+/g, " ").replace(/\s+/g, " ").trim();
  const nums = verdicts.map((v) => `${v.n} ${v.verdict}`).join(" and ");
  const cue = verdicts.map((v) => `"${plain(v.text)}"`).join(" and ");
  return `Owner answered "${plain(question).slice(0, 120)}" (${by}): ${nums} — ${cue} — "${plain(said)}"`;
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
  const all = (note ?? "").split(/[.;\n]/).map((s) => s.trim()).filter(Boolean);
  // Card answers are read by their numbers (BOS-1155), never by the words they quote.
  const cards = new Map<number, { verdict: "pass" | "fail"; at: number }>();
  all.forEach((seg, at) => {
    const m = CARD_LINE.exec(seg);
    if (!m) return;
    for (const v of m[1]!.matchAll(/(\d{1,2}) (pass|fail)/g)) cards.set(Number(v[1]), { verdict: v[2] as "pass" | "fail", at });
  });
  const segments = all.map((s) => (CARD_LINE.test(s) ? "" : s));
  const bag = segments.map((s) => new Set(tokens(s)));
  const raw = segments;
  // The segment each numbered verdict sits in (a segment may hold commas, which also split verdicts).
  const numberedAt = new Map<number, { verdict: Exclude<Verdict, null>; at: number }>();
  segments.forEach((s, at) => {
    for (const [n, v] of numberedVerdicts(texts.length, s.split(","))) if (!numberedAt.has(n)) numberedAt.set(n, { verdict: v.verdict, at });
  });
  return texts.map((criterion, idx) => {
    const byNumber = numberedAt.get(idx + 1) ?? null;
    const want = tokens(criterion);
    let verdict: Verdict = null;
    let wordAt = -1;
    if (want.length) {
      const need = want.length <= 2 ? want.length : Math.ceil(want.length * 0.6);
      let best = -1;
      for (let i = 0; i < bag.length; i++) {
        const hit = want.filter((w) => bag[i]!.has(w)).length;
        if (hit >= need && hit > (best < 0 ? 0 : want.filter((w) => bag[best]!.has(w)).length)) best = i;
      }
      if (best >= 0) {
        verdict = FAIL.test(raw[best]!) ? "fail" : PASS.test(raw[best]!) ? "pass" : null;
        if (verdict) wordAt = best;
      }
    }
    // A fail from either reading wins, so stray prose can never turn a stated fail into a pass.
    let at = -1;
    if (byNumber?.verdict === "fail" || verdict === "fail") {
      verdict = "fail";
      at = byNumber?.verdict === "fail" ? byNumber.at : wordAt;
    } else {
      verdict = byNumber?.verdict ?? verdict;
      at = byNumber ? byNumber.at : wordAt;
    }
    // The owner's answer on a card stands in until the author reports the criterion: a verdict the author
    // wrote later replaces it, and one written earlier is overruled by a card fail only (BOS-1155).
    const card = cards.get(idx + 1);
    if (card && !(verdict && at > card.at)) {
      if (card.verdict === "fail" || !verdict) verdict = card.verdict;
    }
    return { criterion, verdict };
  });
}

/**
 * How many of the criterion's words a piece of text must contain to count as being about it (BOS-963). Lower
 * than readVerdicts' 60%: a card needn't restate a criterion, only plainly refer to its subject, and matching
 * one wrongly is safe (the answer still needs a pass or fail word, and the criterion it names is the one on
 * the card). Short criteria still need every word.
 */
const wordsNeeded = (want: readonly string[]) => (want.length <= 3 ? want.length : Math.max(3, Math.ceil(want.length * 0.4)));

/** True when `text` carries enough of the criterion's own words to be about it (BOS-963). */
export function mentionsCriterion(criterion: string, text: string): boolean {
  const want = tokens(criterion);
  if (!want.length) return false;
  const bag = new Set(tokens(text));
  return want.filter((w) => bag.has(w)).length >= wordsNeeded(want);
}

/** How many of the criterion's words `text` carries: used to name the closest one when none matches (BOS-963). */
export const criterionOverlap = (criterion: string, text: string): number => {
  const bag = new Set(tokens(text));
  return tokens(criterion).filter((w) => bag.has(w)).length;
};

/**
 * The after-merge criteria a card is about, matched by what the card asks and offers (BOS-963): a card raised
 * to settle a live check names it in its question or its options, even when the wording differs from the
 * criterion's, and that answer must record against that criterion. An empty list means the card doesn't name
 * any after-merge criterion, so its answer settles nothing by itself.
 */
export function criteriaForCard(criteria: readonly Criterion[], question: string, options: readonly string[]): number[] {
  const said = `${question}\n${options.join("\n")}`;
  return criteria.flatMap((c, i) => (isAfterMerge(c) && mentionsCriterion(criterionText(c), said) ? [i] : []));
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
  const parts: string[] = [];
  if (loose.length) {
    const names = loose.map((c) => `"${criterionText(c)}"`).join(", ");
    const them = loose.length === 1 ? "it" : "them";
    parts.push(`${names} can only be checked once the work is live: mark ${them} "on a real host" so reviewers don't fail the ticket on ${them}. This is a warning only.`);
  }
  // BOS-1586: an after-merge criterion about something the host reports needs the clause the server checks.
  const unclaused = criteria.filter((c) => isAfterMerge(c) && namesHostFact(criterionText(c)) && !factClauses(criterionText(c)).length);
  if (unclaused.length) {
    const names = unclaused.map((c) => `"${criterionText(c)}"`).join(", ");
    parts.push(`${names} names something the host reports, but has no fact clause, so the ticket could close on a "pass" while the host still shows it failing. Add one to the criterion, e.g. "(fact: repo.probe = ok)" or "(fact: no failing check)": the ticket then closes only when the host's newest report taken after it went live agrees. This is a warning only.`);
  }
  // R37: an after-merge criterion about a live page needs the page clause the done move checks.
  const pageless = criteria.filter((c) => isAfterMerge(c) && namesPage(criterionText(c)) && !pageClauses(criterionText(c)).length);
  if (pageless.length) {
    const names = pageless.map((c) => `"${criterionText(c)}"`).join(", ");
    parts.push(`${names} is about a live page but has no page clause: add (page: https://example.com/path shows "words only the working page shows") or this can close on a status code. With it, a pass must cite a screenshot attached after go-live and quote those words. This is a warning only.`);
  }
  return parts.join("\n");
}

/** A criterion that lets a raised card stand in for the check ("... or names one ... with a card raised for it"). */
export const allowsCardInstead = (text: string): boolean => /\bor\b[^.]*\bcard\b/i.test(text.replace(/\(\s*fact\s*:[^)]*\)/gi, ""));
/** A real staging environment, not git's "staging area" or "staged changes" (BOS-1473). */
const STAGING = /\b(?:on|to|in|against|at|via|the)\s+(?:the\s+)?staging\b(?!\s+(?:area|index|changes|files?|directory))|\bstaging\s+(?:environment|server|host|target|deploy(?:ment)?|site|instance)\b/i;

/** Whether a text names a staging environment (as opposed to git's staging area). */
export const namesStaging = (s: string): boolean => STAGING.test(s);

/**
 * The warning when a criterion or the ticket text names staging in a project nothing can reach staging in
 * (BOS-1473). Warning only; empty means nothing to say.
 */
export function stagingLint(texts: readonly string[]): string {
  const hit = texts.filter(namesStaging);
  if (!hit.length) return "";
  const names = hit.map((t) => `"${t.length > 80 ? `${t.slice(0, 77)}...` : t}"`).join(", ");
  return `${names} names staging, but this project has no staging target an agent can reach, so a check there can't be run and the ticket would sit in Blocked. Word it for what can be checked (the merge check, or "on a real host" after merge). This is a warning only.`;
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
