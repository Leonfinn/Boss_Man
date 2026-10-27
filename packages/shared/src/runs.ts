// What a run with no ticket was doing (BOS-118): a short label from the reason it started,
// so a card never says "work with no task". The reason is the wake's, kept on the run as
// `origin`; agent-written text (a nudge's why) is cut short and the page escapes it.

/** How much of an agent-written nudge reason a label shows. */
export const RUN_LABEL_REASON_MAX = 120;

const REASON_LABEL: Record<string, string> = {
  assigned: "Was given the task",
  "woken by owner": "You woke it",
  message: "Your message",
  owner_chat: "Chat with you",
  chat: "Chat with you",
  /** A chat run that has ended answered the owner; one still going is answering. */
  "chat answered": "Answered the owner in chat",
  decision: "Answering a decision",
  "decision answered": "Your answer to its question",
  feedback: "Triage of new feedback",
  chased: "Chased: something is waiting on it",
  unblocked: "Its task was unblocked",
  resume: "Picking up after a restart",
  engagement: "Another company's request",
  "deploy rejected": "You rejected its deploy",
  review: "Review feedback",
  "review requested": "Asked to review",
  reviewer: "Asked to review",
  "changes requested": "Changes requested",
  "verify failed": "Its merge check failed",
  "deploy approved": "You approved its deploy",
  "ci failed": "Its merge check failed",
  "ci passed": "Its merge check passed",
  "check due": "A scheduled check",
  "missed work": "A missed-work sweep (scheduled)",
  "wiki upkeep": "Wiki sweep (scheduled)",
  "ticket watch": "A missed-work sweep (scheduled)",
  "tree stopped": "A stopped ticket tree needed it",
  watchdog: "A routine check (scheduled)",
  alert: "Answering an alert from Boss Man",
  "watchdog re-wake": "Woken again after an alert",
  "watchdog escalation": "Handed a problem by Boss Man",
  "update pending": "Picking up after a runner update",
};

/** Reasons nobody wrote down, which get the honest fallback instead of a label. */
const NO_REASON = new Set(["run"]);

/** "Asked to review RLH-3, RLH-4", or the plain label when the note names no ticket. */
function reviewLabel(note: string | null | undefined) {
  const refs = (note?.match(/\b[A-Z][A-Z0-9]{0,7}-\d+\b/g) ?? []).filter((r, i, all) => all.indexOf(r) === i);
  if (!refs.length) return REASON_LABEL["review requested"]!;
  const shown = refs.slice(0, 3).join(", ") + (refs.length > 3 ? ` and ${refs.length - 3} more` : "");
  return `Asked to review ${shown}`;
}

/** A nudge's own words, cut short: one line, no more than RUN_LABEL_REASON_MAX characters. */
export function shortReason(why: string | null | undefined) {
  const one = (why ?? "").replace(/\s+/g, " ").trim();
  if (!one) return "";
  const cut = one.length > RUN_LABEL_REASON_MAX ? `${one.slice(0, RUN_LABEL_REASON_MAX - 1).trimEnd()}…` : one;
  return cut;
}

/** "Nudged by CEO: re-check the add-a-skill build" — who nudged, then why when there is a why. */
export function nudgeLabel(from: string | null | undefined, why: string | null | undefined) {
  const who = from?.trim() || "a colleague";
  const said = shortReason(why);
  return said ? `Nudged by ${who}: ${said}` : `Nudged by ${who}`;
}

export type RunOrigin = {
  /** "chat" for the owner chat. */
  purpose?: string | null;
  /** What started it: the wake's reason. */
  origin?: string | null;
  /** A nudge's sender and why, when a nudge started it. */
  originFrom?: string | null;
  originNote?: string | null;
  /** The wake's own note, which names the tickets a review run is about. */
  wakeNote?: string | null;
  /** The ticket it was about without being on it (a nudge that named one). */
  runTicketId?: string | null;
  endedAt?: string | null;
  /** The old way of telling a chat run; kept for runs started before `origin`. */
  reason?: string | null;
};

export type RunLabel = {
  /** The label shown on the card, in the runs list and in the brief. */
  text: string;
  /** True when nothing recorded why the run started, so the label says so. */
  unknown: boolean;
  /** The ticket the run was about without being on it, when there is one. */
  ticketId: string | null;
};

/**
 * The label for a run that isn't on a ticket. A run with neither a reason nor a chat purpose
 * gets the honest fallback.
 */
export function runLabel(run: RunOrigin): RunLabel {
  const ticketId = run.runTicketId ?? null;
  if (run.origin === "nudge") return { text: nudgeLabel(run.originFrom, run.originNote), unknown: false, ticketId };
  if (run.purpose === "chat" || run.origin === "owner_chat") {
    return { text: run.endedAt ? REASON_LABEL["chat answered"]! : "Answering the owner in chat", unknown: false, ticketId };
  }
  if (run.origin === "review requested") return { text: reviewLabel(run.originNote ?? run.wakeNote ?? run.reason), unknown: false, ticketId };
  const reason = run.origin ?? run.reason ?? null;
  if (!reason || NO_REASON.has(reason)) return { text: "Run without a ticket (reason not recorded)", unknown: true, ticketId };
  const known = REASON_LABEL[reason];
  if (known) return { text: known, unknown: false, ticketId };
  // A reason nobody has written a label for yet still reads better than nothing.
  return { text: reason[0]!.toUpperCase() + reason.slice(1).replace(/_/g, " "), unknown: false, ticketId };
}
