// Acceptance criteria on tickets: the same shape as engagements.acceptanceCriteria, plus the
// check that the author reported pass or fail for each before a review, and the checklist the
// reviewer sees. The verdict parser is deliberately plain text matching, not NLP: the refusal
// message tells the author exactly what to write, and what it cannot tie to a criterion counts
// as missing. Shared so the server's review gate and the web's checklist agree exactly.
import { z } from "zod";

/** Same limits as engagements' Terms (app.ts, mcp.ts): up to 10 non-empty strings, capped length.
 * Only the max is enforced here: an empty list means "no criteria", which is allowed everywhere. */
export const acceptanceCriteriaSchema = z.array(z.string().trim().min(1).max(500)).max(10);

export type Verdict = "pass" | "fail" | null;

/** Lowercase and flatten whitespace so matching ignores case and double spaces. */
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ");

/** Filler words that carry none of a criterion's meaning once it is parsed apart. */
const STOP = new Set(["a", "an", "the", "and", "or", "is", "are", "was", "be", "been", "to", "of", "for", "in", "on", "with", "it", "its", "each", "every", "this", "that", "these", "those", "which", "when", "if", "any", "all"]);

/** Criterion words minus the filler; numbers stay, they often are the check itself. */
const tokens = (s: string) => norm(s).split(/[^a-z0-9]+/).filter((w) => w.length >= 2 && !STOP.has(w));

const PASS = /\b(pass|passed|passes|passing|ok|done|yes|green|✓|✔)\b/i;
const FAIL = /\b(fail|failed|fails|failing|broken|red|✗|✘)\b/i;

/**
 * Reads the author's pass/fail for each criterion out of the state note. The note is cut into
 * sentences (on . ; and newlines); a sentence counts for a criterion when it contains enough of
 * the criterion's words (60%, or every word if the criterion has few), and that sentence's pass
 * or fail word is the verdict. A criterion no sentence claims comes back as null: not reported.
 */
export function readVerdicts(criteria: readonly string[], note: string | null | undefined): Array<{ criterion: string; verdict: Verdict }> {
  const segments = (note ?? "").split(/[.;\n]/).map((s) => s.trim()).filter(Boolean);
  const bag = segments.map((s) => new Set(tokens(s)));
  const raw = segments;
  return criteria.map((criterion) => {
    const want = tokens(criterion);
    let verdict: Verdict = null;
    if (want.length) {
      const need = want.length <= 2 ? want.length : Math.ceil(want.length * 0.6);
      let best = -1;
      for (let i = 0; i < bag.length; i++) {
        const hit = want.filter((w) => bag[i]!.has(w)).length;
        if (hit >= need && hit > (best < 0 ? 0 : want.filter((w) => bag[best]!.has(w)).length)) best = i;
      }
      if (best >= 0) verdict = PASS.test(raw[best]!) ? "pass" : FAIL.test(raw[best]!) ? "fail" : null;
    }
    return { criterion, verdict };
  });
}

/** The criteria the author gave no pass or fail verdict for; empty means the note covers them all. */
export function missingVerdicts(criteria: readonly string[], note: string | null | undefined): string[] {
  return readVerdicts(criteria, note)
    .filter((r) => r.verdict === null)
    .map((r) => r.criterion);
}