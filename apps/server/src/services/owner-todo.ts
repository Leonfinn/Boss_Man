// An owner to-do always has a card (BOS-1576, T19 of the 15 Nov cock-ups answer). The owner only looks at their
// Decisions queue, so a job for them written in a ticket reply or a state note is lost. Three places close that:
// a reply that asks the owner to act is held until a card covers it (mcp.ts), a state note that says the ticket
// waits on the owner is refused without a card (mcp-tickets.ts), and this hourly sweep tells the CEO about older
// notes that slipped through (written before the rule, or left behind when a card was withdrawn or expired).
import { and, eq, isNotNull, ne } from "drizzle-orm";
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
