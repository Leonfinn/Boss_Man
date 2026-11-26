// BOS-2737 (R60): the one place a "someone is on it" line for an owner screen is worded.
//
// Cock-ups round 7 (BOS-2736, group L1) found five screens saying someone was acting ("looking into it", "has been
// told", "is handling it") when no run had started and no ticket existed: the words were fixed strings, written once,
// not read from what was going on. Every such line now comes from actionClaim, which can only claim what its facts
// show: a run that has started, a ticket with an assignee, or the time an alert was raised (and if nobody has picked
// it up, it says so). The wording lint (packages/shared/test/action-claim-wording.test.ts) refuses the fixed phrases
// anywhere else in apps/web/src and apps/server/src.
//
// It lives in packages/shared, not in one server file, so the server (board, holds, CEO plan) and the web's This host
// panel, which words the server's facts itself, call the same function.

type At = Date | string;

/** What is known about who acts on one thing, read from live state by the caller. */
export type ClaimFacts = {
  /** Who the alert or wake went to, as a sentence subject: "The CEO", "The Scrum Master". */
  who: string;
  /** When Boss Man alerted or woke `who` about it; true when it did but the time is not known; absent when nobody has been alerted. */
  raisedAt?: At | true | null;
  /** The ticket open for it, with its assignee's name (null when unassigned) and when Boss Man woke the assignee on it, if known. */
  ticket?: { ref: string; agent: string | null; wokenAt?: At | null } | null;
  /** The first run that started on it since it was raised: who ran it and when. */
  run?: { agent: string; startedAt: At } | null;
  /** The alert was answered; `note` is the answer's words, if any. */
  answered?: { note: string | null } | null;
  /**
   * false for text that is kept once written (a card's question, an agent's reply): it then names the ticket and
   * assignee but never says work is under way, since that stops being true while the text stays.
   */
  live?: boolean;
};

export type ActionClaim = {
  /** started: a run is going. assigned: a ticket has an assignee, no run yet. answered: the alert was answered. alerted: raised, nobody picked it up. none: nobody alerted. */
  kind: "started" | "assigned" | "unassigned" | "answered" | "alerted" | "none";
  text: string;
};

const time = (at: At): string | null => {
  const d = typeof at === "string" ? new Date(at) : at;
  return Number.isFinite(d.getTime()) ? `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC` : null;
};

const NOTE_MAX = 200;

/** The one "someone is on it" line, from facts only. See the file header. */
export function actionClaim(f: ClaimFacts): ActionClaim {
  const live = f.live !== false;
  // "raised at 15:30 UTC" when the time is known, "raised" when only the fact is, null when nobody was alerted.
  const raised = f.raisedAt === true ? "raised" : f.raisedAt ? (time(f.raisedAt) ? `raised at ${time(f.raisedAt)}` : "raised") : null;
  const t = f.ticket ?? null;
  const woken = t?.wokenAt && time(t.wokenAt) ? `, woken at ${time(t.wokenAt)}` : "";
  if (live && f.run) {
    const at = time(f.run.startedAt);
    return { kind: "started", text: `${f.run.agent} started work on it${t ? ` on ${t.ref}` : ""}${at ? ` at ${at}` : ""}.` };
  }
  if (t?.agent) {
    if (!live) return { kind: "assigned", text: `${t.ref} is assigned to ${t.agent}.` };
    return { kind: "assigned", text: `${t.ref} is assigned to ${t.agent}${woken}; no run has started on it yet.` };
  }
  if (f.answered) {
    const n = f.answered.note?.trim();
    const note = n ? `: "${n.length > NOTE_MAX ? `${n.slice(0, NOTE_MAX)}…` : n}"` : ".";
    return { kind: "answered", text: `${f.who} answered the alert${note}${t ? ` ${t.ref} is open for it, not assigned yet.` : ""}` };
  }
  if (t) return { kind: "unassigned", text: `${t.ref} is open for it, not assigned yet.${raised ? ` ${f.who} was alerted: ${raised}, nobody has picked it up yet.` : ""}` };
  if (raised) return { kind: "alerted", text: `${f.who} was alerted: ${raised}, nobody has picked it up yet.` };
  return { kind: "none", text: `Nobody has picked it up yet: ${lower(f.who)} has not been alerted.` };
}

const lower = (s: string) => (s.startsWith("The ") ? `the ${s.slice(4)}` : s);
