// The close gate for after-merge criteria that name a host fact (BOS-1586). A ticket closed on its assignee's "pass"
// while the This host panel still showed a failing check (BOS-986). The host's own newest report, taken after the
// work went live, decides instead: neither a "pass" nor an owner card answer overrides it.
import { allowsCardInstead, criterionText, evalFactClause, factClauses, isAfterMerge, readVerdicts, type Criterion } from "@boss-man/shared";
import type { HostFactsRecord } from "./host-facts.js";

const at = (iso: string): string => `${iso.slice(0, 16).replace("T", " ")} UTC`;

const WAYS_OUT = `Neither a "pass" in the note nor an owner's card answer overrides what the host reports. Ways out: fix the cause and wait for the host's next report; report that criterion as fail (Boss Man then opens the follow-up for it); or, if the work should not count, the CEO closes the ticket as cancelled with a reason.`;

/**
 * The refusal for a done move, or null when every fact clause holds. `liveSince` is when the ticket went live (or was
 * merged, when nothing better is recorded); a host report older than it says nothing about the new code.
 */
export function hostFactRefusal(
  criteria: readonly Criterion[],
  rec: Pick<HostFactsRecord, "facts" | "reportedAt">,
  liveSince: Date | null,
  note: string,
): string | null {
  const lines: string[] = [];
  const verdicts = readVerdicts(criteria, note);
  for (const [i, c] of criteria.entries()) {
    if (!isAfterMerge(c)) continue;
    // Reporting the criterion as fail is the honest way out: Boss Man opens the follow-up for it.
    if (verdicts[i]?.verdict === "fail") continue;
    const clauses = factClauses(criterionText(c));
    if (!clauses.length) continue;
    if (!rec.reportedAt) {
      lines.push(`"${criterionText(c)}": the host has sent no report yet.`);
      continue;
    }
    if (liveSince && Date.parse(rec.reportedAt) < liveSince.getTime()) {
      lines.push(`"${criterionText(c)}": the newest host report (${at(rec.reportedAt)}) is from before this ticket went live (${at(liveSince.toISOString())}), so it says nothing about the new code. Wait for the host's next report.`);
      continue;
    }
    for (const clause of clauses) {
      const r = evalFactClause(clause, rec.facts);
      if (!r.met) lines.push(`"${criterionText(c)}": the host reports ${r.seen} (host report ${at(rec.reportedAt)}).`);
    }
  }
  return lines.length ? `The host's own report doesn't show this ticket's after-merge fact checks as met:\n${lines.join("\n")}\n${WAYS_OUT}` : null;
}

/** An id of an open card counts as cited when the note holds the whole id or its first 8 characters. */
export function citedOpenCard(note: string, openCardIds: readonly string[]): string | null {
  const lower = note.toLowerCase();
  return openCardIds.find((id) => lower.includes(id.toLowerCase()) || lower.includes(id.slice(0, 8).toLowerCase())) ?? null;
}

/**
 * A criterion that allows "or a card was raised for it" passes only when the pass cites the open card that covers it.
 * Criteria with a fact clause are left to the clause. Returns the criteria whose pass cites no open card.
 */
export function uncitedCardPasses(criteria: readonly Criterion[], note: string, openCardIds: readonly string[]): string[] {
  if (citedOpenCard(note, openCardIds)) return [];
  const verdicts = readVerdicts(criteria, note);
  return criteria.flatMap((c, i) => {
    const text = criterionText(c);
    return isAfterMerge(c) && verdicts[i]?.verdict === "pass" && !factClauses(text).length && allowsCardInstead(text) ? [text] : [];
  });
}

export const CARD_CITE_REFUSAL = (texts: string[]): string =>
  `${texts.map((t) => `"${t}"`).join(", ")} allows "or a card was raised for it", so a pass must name the open card that covers it (its id, in the note). None is cited, so it counts as a fail. Cite the open card's id with the pass (raise one first with raise_decision blocksTicketId if there is none), or report the criterion as fail.`;
