// An owner to-do always has a card (BOS-1576, T19 of the 15 Nov cock-ups answer). The owner only looks at their
// Decisions queue, so a job for them written in a ticket reply or a state note is lost. Three places close that:
// a reply that asks the owner to act is held until a card covers it (mcp.ts), a state note that says the ticket
// waits on the owner is refused without a card (mcp-tickets.ts), and this hourly sweep tells the CEO about older
// notes that slipped through (written before the rule, or left behind when a card was withdrawn or expired).
import { and, eq, inArray, isNotNull, ne } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { companies, tickets } from "../db/schema.js";
import { openBlockers, openCardIds } from "./ticket-links.js";

/** What a note says when the ticket waits on the owner: "waiting on the owner", "needs the owner", "keep or drop". */
const OWNER_WAIT = /\b(?:wait(?:s|ing|ed)?|awaits?|awaiting|needs?|pending)\b[^.;:\n]{0,30}?\bowner\b(?!['’]s\s+sign-?off)(?!\s+sign-?off)|\bkeep or drop\b/gi;
/** A negation just before the match turns it round ("nothing waits on the owner", "no longer waiting for the owner"). */
const NEGATED = /\b(?:no|not|nothing|nobody|never|isn['’]t|aren['’]t|longer|without)\b[^.;:\n]{0,25}$/i;

/** True when a state note says the ticket waits on the owner. The owner's sign-off is left out: Boss Man raises that card itself. */
export function waitsOnOwnerNote(note: string | null | undefined): boolean {
  if (!note) return false;
  for (const m of note.matchAll(OWNER_WAIT)) {
    const before = note.slice(Math.max(0, (m.index ?? 0) - 40), m.index ?? 0);
    if (!NEGATED.test(before)) return true;
  }
  return false;
}

/**
 * A note that parks the ticket until something happens (BOS-1591, R21): "waits for the repo going public",
 * "parked until the launch", "on hold once X is decided". The words are the ticket's own condition.
 */
const WAITS_FOR = /\b(?:wait(?:s|ing)|parked|on hold|held|paused|blocked)\b[^.;\n]{0,30}?\b(for|on|until|till|once|when|after)\b|\b(?:will|to) (?:resume|restart|continue|pick (?:it )?up)\b[^.;\n]{0,15}?\b(until|once|when|after)\b|\buntil\b(?=[^.;\n]{3,})/gi;
/** What the wait is for, when it is something Boss Man already tracks on its own: not a missing link. */
const TRACKED_WAIT = /^\W*(?:the |a |an |my |your |their |our |its |this |that )?(?:owner|review(?:er|ers|s)?\b|checks?\b|quick check|full check|ci\b|merge|merging|gate|approval|sign-?off|plan approval|build|builds|tests?\b|typecheck|runner|queue|slot|lock|next run|wake|schedule_check|deploy(?:ment)?\b|go-live|live\b)/i;
/** "Until" with no wait word before it is a plain English "until" far too often ("run until it passes"): only these count. */
const UNTIL_PARK = /\b(?:parked|hold|holding|paused|dormant|not started|can['’]?t start|cannot start|do not start|don['’]t start|resume|backlog)\b[^.;\n]{0,40}$/i;

/** True when a note says the ticket waits for something, other than the owner (the owner card has its own rule) or what Boss Man tracks itself. */
export function waitsForNote(note: string | null | undefined): boolean {
  if (!note) return false;
  for (const m of note.matchAll(WAITS_FOR)) {
    const at = m.index ?? 0;
    const before = note.slice(Math.max(0, at - 40), at);
    if (NEGATED.test(before)) continue;
    const word = (m[1] ?? m[2] ?? "").toLowerCase();
    const matched = m[0].toLowerCase();
    // A bare "until" counts only after a parking word.
    if (matched.startsWith("until") && !UNTIL_PARK.test(note.slice(Math.max(0, at - 60), at))) continue;
    // "blocked/held/paused on/for X" are common for tracked reasons; they count only with a clear condition word.
    if (/^(?:held|blocked|paused)\b/.test(matched) && !["until", "till", "once", "when", "after"].includes(word)) continue;
    const after = note.slice(at + m[0].length);
    if (TRACKED_WAIT.test(after)) continue;
    return true;
  }
  return false;
}

/** The refusal when a note says the ticket waits for something and nothing links it to what settles it. */
export const WAIT_LINK_REFUSAL =
  "Not saved. This note says the ticket waits for something, but nothing links it to what settles that, so nothing would ever wake it when it happens. Link it one way, then set the state again: (1) a ticket it waits on: update_ticket waitsOn add (it wakes you when that ticket merges or is done); (2) a card the owner answers: raise_decision with blocksTicketId, or, if a card about it is already open on another ticket, update_ticket waitsOn addCards with that card's id (do not raise a second card); (3) an engagement with another company; (4) a date: blocked_until with blocked_reason (within 30 days). If you can't name any of these, the ticket isn't waiting: say what you need and who has to give it.";

const NOT_ABOUT = new Set(["waits", "waiting", "wait", "until", "once", "when", "that", "this", "with", "from", "have", "will", "ticket", "owner", "then", "than", "there", "their", "about", "after", "before", "date", "parked", "hold", "held", "blocked", "paused", "keep", "drop", "needs", "need", "done", "work", "going"]);
const contentWords = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 3 && !NOT_ABOUT.has(w)));

/** True when a waiting note is about what a card asked: at least two of its subject words, and most of them, are in the question. */
export function noteMatchesQuestion(note: string, question: string): boolean {
  const n = contentWords(note);
  const q = contentWords(question);
  let shared = 0;
  // A word also counts when one is the start of the other ("repo" and "repository", "public" and "publicly").
  for (const w of n) if (q.has(w) || [...q].some((x) => x.startsWith(w) || w.startsWith(x))) shared++;
  return shared >= 2 && shared / n.size >= 0.6;
}

/**
 * Older tickets, parked in Backlog, Ready or Blocked, whose note says they wait for something this card's answer settles
 * but that were never linked to the card (BOS-1591): the answer released nothing for them, so the CEO is told once.
 */
export async function unlinkedWaiters(db: Db, input: { companyId: string; question: string; releasedIds: string[]; limit?: number }): Promise<Array<{ id: string; number: number | null; title: string }>> {
  const rows = await db
    .select({ id: tickets.id, number: tickets.number, title: tickets.title, note: tickets.stateNote })
    .from(tickets)
    .where(and(eq(tickets.companyId, input.companyId), inArray(tickets.systemState, ["backlog", "ready", "blocked"]), isNotNull(tickets.stateNote)));
  const out: Array<{ id: string; number: number | null; title: string }> = [];
  for (const t of rows) {
    if (input.releasedIds.includes(t.id) || !t.note) continue;
    if (!waitsForNote(t.note) && !waitsOnOwnerNote(t.note)) continue;
    if (!noteMatchesQuestion(t.note, input.question)) continue;
    out.push({ id: t.id, number: t.number, title: t.title });
    if (out.length >= (input.limit ?? 10)) break;
  }
  return out;
}

/** An open card on this ticket: it names the ticket, or the ticket waits on it. */
export async function ticketHasOpenCard(db: Db, ticketId: string): Promise<boolean> {
  if ((await openCardIds(db, ticketId)).length) return true;
  return (await openBlockers(db, ticketId)).some((b) => b.kind === "decision");
}

/** The refusal when a state note says the ticket waits on the owner and no card is open on it. */
export const OWNER_WAIT_REFUSAL =
  "Not saved. This note says the ticket waits on the owner, but no open card is on it, and the owner only looks at their Decisions queue, so they would never see it. Call raise_decision with blocksTicketId set to this ticket (what you tried first, and what you need from them), then set the state again. If it is a call the CEO can make, say \"waiting on the CEO\" and nudge the CEO instead. If the owner has steps to do only after this change goes live, put them in ownerSetup: Boss Man raises a checked card for them at go-live. If the note only mentions the owner without waiting on them, reword it.";

/** How often the sweep reads the board, and how old a note must be before it counts as forgotten. */
export const OWNER_WAIT_SWEEP_EVERY_MS = 60 * 60_000;
export const OWNER_WAIT_NOTE_AGE_MS = 60 * 60_000;

/**
 * The backup (hourly): a ticket outside Done whose note, older than an hour, says it waits on the owner while no
 * card is open on it. The company's CEO is told once per note. `told` remembers what was said this process, so
 * the hourly pass repeats nothing; a server restart may tell once more, which is harmless.
 */
export function ownerWaitWatch(db: Db, tellCeo: (companyId: string, note: string) => Promise<unknown>, now: () => Date = () => new Date()) {
  const told = new Map<string, string>(); // shortcut: lost on restart, harmless because the CEO is then told once more about a note that still has no card.
  let lastRun = 0;
  return {
    async run(force = false): Promise<{ flagged: number }> {
      const at = now().getTime();
      if (!force && at - lastRun < OWNER_WAIT_SWEEP_EVERY_MS) return { flagged: 0 };
      lastRun = at;
      const rows = await db
        .select({ id: tickets.id, title: tickets.title, companyId: tickets.companyId, note: tickets.stateNote, noteAt: tickets.stateNoteAt })
        .from(tickets)
        .innerJoin(companies, eq(companies.id, tickets.companyId))
        .where(and(ne(tickets.systemState, "done"), isNotNull(tickets.stateNote), eq(companies.paused, false)));
      let flagged = 0;
      for (const t of rows) {
        if (!t.noteAt || at - t.noteAt.getTime() < OWNER_WAIT_NOTE_AGE_MS) continue;
        if (!waitsOnOwnerNote(t.note)) continue;
        const key = `${t.noteAt.toISOString()}`;
        if (told.get(t.id) === key) continue;
        if (await ticketHasOpenCard(db, t.id)) continue;
        told.set(t.id, key);
        flagged++;
        await tellCeo(t.companyId, `"${t.title}" (${t.id}) has a note saying it waits on the owner, but no card is open on it, so the owner has never been asked. Raise the card now (raise_decision with blocksTicketId), or make the call yourself if it is yours to make.`).catch(() => undefined);
      }
      return { flagged };
    },
  };
}
