// The close gate for after-merge criteria that name a host fact (BOS-1586). A ticket closed on its assignee's "pass"
// while the This host panel still showed a failing check (BOS-986). The host's own newest report, taken after the
// work went live, decides instead: neither a "pass" nor an owner card answer overrides it.
import { allowsCardInstead, criterionText, evalFactClause, factClauses, isAfterMerge, normQuote, pageClauses, readVerdicts, type Criterion } from "@boss-man/shared";
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
      lines.push(`"${criterionText(c)}": the newest host report (${at(rec.reportedAt)}) is from before this ticket went live (${at(liveSince.toISOString())}), so it says nothing about the new code. Waiting for a host report since go-live: try again after the host's next report (this isn't a failure).`);
      continue;
    }
    for (const clause of clauses) {
      const r = evalFactClause(clause, rec.facts);
      if (!r.met) lines.push(`"${criterionText(c)}": the host reports ${r.seen} (host report ${at(rec.reportedAt)}).`);
    }
  }
  return lines.length ? `The host's own report doesn't show this ticket's after-merge fact checks as met:\n${lines.join("\n")}\n${WAYS_OUT}` : null;
}

/**
 * R37 (BOS-1682): the refusal for a done move whose "pass" on a page-clause criterion isn't backed by what a visitor
 * sees, or null. The pass must cite (whole id or first 8 characters, like a card) an image attached to this ticket at
 * or after `liveSince`, and quote each clause's text. A fail, or no verdict (the unreported gate answers that), is
 * left alone. `images` are this ticket's own images; with no go-live time recorded any of them counts.
 */
export function pageShotRefusal(criteria: readonly Criterion[], images: ReadonlyArray<{ id: string; createdAt: Date }>, liveSince: Date | null, note: string): string | null {
  const verdicts = readVerdicts(criteria, note);
  const lower = note.toLowerCase();
  const quoted = normQuote(note);
  const fresh = images.filter((img) => !liveSince || img.createdAt.getTime() >= liveSince.getTime());
  const cited = fresh.some((img) => lower.includes(img.id.toLowerCase()) || lower.includes(img.id.slice(0, 8).toLowerCase()));
  const stale = !cited && images.some((img) => lower.includes(img.id.slice(0, 8).toLowerCase()));
  const lines: string[] = [];
  for (const [i, c] of criteria.entries()) {
    if (!isAfterMerge(c) || verdicts[i]?.verdict !== "pass") continue;
    const clauses = pageClauses(criterionText(c));
    if (!clauses.length) continue;
    const gaps: string[] = [];
    if (!cited) gaps.push(stale ? `the screenshot cited was attached before this ticket went live${liveSince ? ` (${at(liveSince.toISOString())})` : ""}` : "no screenshot of this ticket taken since go-live is cited (attach one with attach_image and put its id in the note)");
    const unquoted = clauses.filter((p) => !quoted.includes(normQuote(p.text)));
    if (unquoted.length) gaps.push(`the note doesn't quote ${unquoted.map((p) => `"${p.text}"`).join(", ")} as seen on the page`);
    if (gaps.length) lines.push(`"${criterionText(c)}": ${gaps.join("; ")}.`);
  }
  return lines.length
    ? `A pass on a page criterion needs a screenshot: a status code and title can't show what a visitor sees.\n${lines.join("\n")}\nOpen the page in a real browser, attach the screenshot to this ticket, then give the pass with the image's id and the words the page shows. If the page doesn't show them, report the criterion as fail: the ticket still closes and Boss Man opens the follow-up.`
    : null;
}

/** An after-merge criterion that is about what a service outside Boss Man shows (BOS-2076): a search engine, a payment or code host. */
const OUTSIDE_SERVICE = /\b(google|bing|search console|webmaster tools?|indexnow|sitemap|stripe|paypal|cloudflare|github|npm|docker hub|ghcr|sendgrid|mailgun|twilio|telegram|slack|ntfy)\b/i;
export const namesOutsideService = (text: string): boolean => OUTSIDE_SERVICE.test(text);

/**
 * BOS-2076: the refusal for a done move whose "pass" on an outside-service criterion carries no evidence, or null.
 * Evidence is a link, a screenshot of this ticket attached since go-live (its id in the note) or a quoted reading
 * ("..." with at least 6 characters). Criteria with a page or host-fact clause have their own gates. Like R37, one
 * piece of evidence in the note covers it: the reviewer reads it against the criterion.
 */
export function outsideServiceEvidenceRefusal(criteria: readonly Criterion[], images: ReadonlyArray<{ id: string; createdAt: Date }>, liveSince: Date | null, note: string): string | null {
  const verdicts = readVerdicts(criteria, note);
  const lower = note.toLowerCase();
  const hasLink = /https?:\/\/\S{4,}/i.test(note);
  const hasQuote = /["“][^"”]{6,}["”]/.test(note);
  const hasShot = images.some((img) => (!liveSince || img.createdAt.getTime() >= liveSince.getTime()) && (lower.includes(img.id.toLowerCase()) || lower.includes(img.id.slice(0, 8).toLowerCase())));
  if (hasLink || hasQuote || hasShot) return null;
  const lines = criteria.flatMap((c, i) => {
    const text = criterionText(c);
    return isAfterMerge(c) && verdicts[i]?.verdict === "pass" && namesOutsideService(text) && !pageClauses(text).length && !factClauses(text).length ? [`"${text}"`] : [];
  });
  return lines.length
    ? `A pass on a check about an outside service needs evidence: ${lines.join(", ")}. Add a link to what you looked at, a screenshot (attach_image, put its id in the note) or the reading quoted in double quotes, e.g. "Sitemap read, 12 pages discovered". If the service doesn't show it yet, report the criterion as fail: the ticket still closes and Boss Man opens the follow-up.`
    : null;
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
