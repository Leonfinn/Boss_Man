// R38 (BOS-1683): a card that asks the owner to put something live (publish, deploy, release) is held to the same
// proof as the work itself. A website publish card reached the owner (16 Nov) with its ticket's preview check
// unreported and an untested "rolls back in seconds" promise. Self-deploy cards have their own gates and don't use this.
import { criterionText, isAfterMerge, missingVerdicts, normQuote, pageClauses, readVerdicts, type Criterion } from "@boss-man/shared";

/** Words that say a card is about putting something live. */
const GO_LIVE_WORDS = /\b(?:publish(?:ed|ing)?|deploy(?:ed|ing|ment)?|release[sd]?|go(?:ing)? live|goes live|production)\b/i;

/** True when a card's question or steps talk about going live. */
export const sayGoLive = (...texts: ReadonlyArray<string | undefined>): boolean => texts.some((t) => !!t && GO_LIVE_WORDS.test(t));

/** The note for a card that talks about going live but isn't marked goLive: its checks are skipped, so say so. */
/** BOS-2085 (R54): the first full 40-hex commit sha the question or steps name, lower-cased; undefined when none (a short sha is not enough to pin a release). */
export function releasedCommitOf(...texts: ReadonlyArray<string | undefined>): string | undefined {
  for (const t of texts) {
    const m = t ? /(?<![0-9a-fA-F])[0-9a-fA-F]{40}(?![0-9a-fA-F])/.exec(t) : null;
    if (m) return m[0].toLowerCase();
  }
  return undefined;
}

export const GO_LIVE_UNMARKED =
  "This card talks about putting something live (publish, deploy, release, go live or production) but isn't marked goLive. A go-live card is checked: its ticket's before-merge checks must be reported with page proof, and it must state its undo (rollback, tagged \"tested: <when, how>\" or \"not tested: <docs URL>\"). If it is one, withdraw it and raise it again with goLive true.";

const FAST = /\b(?:in\s+(?:a\s+few\s+)?seconds?|instant(?:ly)?)\b/i;

/** The refusal for a go-live card's rollback, or null when it is stated with its source. */
export function rollbackRefusal(rollback: string | undefined): string | null {
  const r = (rollback ?? "").trim();
  if (!r) return "A go-live card must carry rollback: the exact undo, starting \"tested: <when, how>\" or \"not tested: <docs URL>\".";
  const tag = /^(tested|not tested)\s*:\s*(.*)$/is.exec(r);
  if (!tag) return "rollback must start with \"tested: <when, how it was tried>\" or \"not tested: <docs URL>\", then the exact undo.";
  const tested = tag[1]!.toLowerCase() === "tested";
  const rest = tag[2]!.trim();
  if (rest.length < 10) return "rollback says nothing after its tag: give the exact undo and where it comes from.";
  if (!tested && !/https?:\/\/\S+/i.test(rest)) return "A \"not tested\" rollback must name its source, a docs URL (https://…), so the owner can see where the undo comes from.";
  if (!tested && FAST.test(rest)) return "rollback promises \"in seconds\" or \"instant\" but is tagged \"not tested\": nobody has tried it. Say what the docs say, without the speed, or test it first and tag it \"tested: <when, how>\".";
  return null;
}

/** The undo as the owner reads it: a "not tested" undo is shown as "not tried yet". */
export function rollbackLine(rollback: string): string {
  const tag = /^(tested|not tested)\s*:\s*(.*)$/is.exec(rollback.trim());
  if (!tag) return `How to undo it: ${rollback.trim()}`;
  return tag[1]!.toLowerCase() === "tested" ? `How to undo it (tested: ${tag[2]!.trim()})` : `How to undo it (not tried yet; from ${tag[2]!.trim()})`;
}

/**
 * The refusal when the ticket a go-live card blocks still has before-merge criteria unreported, or a page clause
 * whose pass cites no screenshot attached to the ticket or doesn't quote the page's words. Null when all are met.
 */
export function goLiveProofRefusal(criteria: readonly Criterion[], note: string | null | undefined, imageIds: readonly string[]): string | null {
  const lines: string[] = [];
  const open = missingVerdicts(criteria, note, "before");
  if (open.length) lines.push(`These before-merge checks are not reported pass or fail yet: ${open.map((t) => `"${t}"`).join("; ")}.`);
  const verdicts = readVerdicts(criteria, note);
  const lower = (note ?? "").toLowerCase();
  const quoted = normQuote(note ?? "");
  const cited = imageIds.some((id) => lower.includes(id.toLowerCase()) || lower.includes(id.slice(0, 8).toLowerCase()));
  for (const [i, c] of criteria.entries()) {
    if (isAfterMerge(c) || verdicts[i]?.verdict !== "pass") continue;
    const clauses = pageClauses(criterionText(c));
    if (!clauses.length) continue;
    const gaps: string[] = [];
    if (!cited) gaps.push("no screenshot of this ticket is cited (attach one with attach_image and put its id in the note)");
    const unquoted = clauses.filter((p) => !quoted.includes(normQuote(p.text)));
    if (unquoted.length) gaps.push(`the note doesn't quote ${unquoted.map((p) => `"${p.text}"`).join(", ")} as seen on the page`);
    if (gaps.length) lines.push(`"${criterionText(c)}": ${gaps.join("; ")}.`);
  }
  return lines.length
    ? `This go-live card is refused: the owner is not asked to put it live until the ticket's preview checks are reported with page proof.\n${lines.join("\n")}\nReport each check (set_ticket_state note, pass or fail), cite a screenshot of the preview for each page clause, then raise the card again.`
    : null;
}
