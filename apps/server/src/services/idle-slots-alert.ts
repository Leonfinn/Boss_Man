// "Nothing is running" alert (BOS-2358, replaces BOS-1881's free-slots rule). It judges the outcome the owner sees:
// no non-chat work run in the company while a Ready or In-progress ticket of an unpaused agent waits. After 15 minutes
// the CEO gets one card listing why each ticket isn't running; if it is still true 30 minutes after that, the owner
// gets one info notice. Both close by themselves (DR-016, clearWhen idleSlotsGone) when a work run starts or no open
// ticket is left. It counts during update holds and quiet hours too: the card names the hold instead of staying silent.
// The waiting clock lives in `settings`, so a server restart does not restart the quarter hour.
import { and, asc, desc, eq, inArray, isNull, like, notInArray } from "drizzle-orm";
import { ticketRef } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { agents, companies, decisions, runs, settings, tickets, wakes } from "../db/schema.js";
import { isWorkingRun, ticketIsBlocked } from "./agent-wip.js";

export const NOTHING_RUNNING_AFTER_MS = 15 * 60_000;
/** How long the CEO card has stood before the owner gets a notice. */
export const NOTHING_RUNNING_OWNER_AFTER_MS = 30 * 60_000;
const CLOCK_KEY = "idle_slots_since:";

export const idleSlotsKey = (companyId: string) => `idle-slots:${companyId}`;
export const idleSlotsOwnerKey = (companyId: string) => `idle-slots-owner:${companyId}`;

const hhmm = (d: Date) => `${d.toISOString().slice(11, 16)} UTC`;

export type WaitingTicket = { id: string; number: number | null; title: string; agent: string; why: string };
export type NothingRunningFacts = { workRuns: number; waiting: WaitingTicket[] };

/**
 * The facts the alert and its closer both judge: live non-chat runs in the company, and each Ready or In-progress
 * ticket of an unpaused agent with the reason it isn't running (the same predicates the sweeps use).
 */
export async function nothingRunningFacts(db: Db, companyId: string, now: Date): Promise<NothingRunningFacts> {
  const live = await db.select({ purpose: runs.purpose }).from(runs).where(and(eq(runs.companyId, companyId), isNull(runs.endedAt)));
  const workRuns = live.filter(isWorkingRun).length;
  const open = await db
    .select({ ticket: tickets, agent: agents.name })
    .from(tickets)
    .innerJoin(agents, eq(agents.id, tickets.assigneeAgentId))
    .where(and(eq(tickets.companyId, companyId), inArray(tickets.systemState, ["ready", "in_progress"]), eq(agents.paused, false), isNull(agents.retiredAt)))
    .orderBy(asc(tickets.createdAt));
  const waiting: WaitingTicket[] = [];
  for (const { ticket: t, agent } of open) {
    waiting.push({ id: t.id, number: t.number ?? null, title: t.title, agent, why: await whyNotRunning(db, t, now) });
  }
  return { workRuns, waiting };
}

async function whyNotRunning(db: Db, t: typeof tickets.$inferSelect, now: Date): Promise<string> {
  if (await ticketIsBlocked(db, t.id)) return "blocked on an unfinished ticket, card or engagement";
  if (t.planFirst && !t.planApprovedAt) return "its plan is not approved yet";
  const [wake] = await db
    .select({ status: wakes.status, notBefore: wakes.notBefore, why: wakes.statusReason, reason: wakes.reason })
    .from(wakes)
    .where(and(eq(wakes.agentId, t.assigneeAgentId!), inArray(wakes.status, ["queued", "deferred"])))
    .orderBy(asc(wakes.createdAt))
    .limit(1);
  if (wake?.status === "deferred") {
    const until = wake.notBefore && wake.notBefore.getTime() > now.getTime() ? `deferred until ${hhmm(wake.notBefore)}` : "deferred and due now";
    return `wake ${until}${wake.why ? ` (${wake.why})` : ` (${wake.reason})`}`;
  }
  if (wake?.status === "queued") return `wake queued (${wake.reason}), not started yet`;
  if (t.monitorAt && t.monitorAt.getTime() > now.getTime()) return `check booked for ${hhmm(t.monitorAt)}`;
  const [last] = await db.select({ outcome: runs.outcome, endedAt: runs.endedAt }).from(runs).where(eq(runs.ticketId, t.id)).orderBy(desc(runs.startedAt)).limit(1);
  if (last?.endedAt && last.outcome?.startsWith("error")) return `last run errored at ${hhmm(last.endedAt)} (${last.outcome.slice(0, 120)})`;
  return "no wake queued and nothing booked: not started";
}

/** True while the alert's condition holds. */
export const nothingRunningHolds = (f: NothingRunningFacts) => f.workRuns === 0 && f.waiting.length > 0;

/** For the closer: why the condition is over, or null while it still holds. */
export async function idleSlotsGoneReason(db: Db, companyId: string, now: Date = new Date()): Promise<string | null> {
  const f = await nothingRunningFacts(db, companyId, now);
  if (nothingRunningHolds(f)) return null;
  return f.workRuns > 0 ? `${f.workRuns} work run${f.workRuns === 1 ? " is" : "s are"} running again` : "no Ready or In-progress ticket of an active agent is waiting";
}

export function idleSlotsSweep(
  db: Db,
  opts: {
    alert: (input: Record<string, unknown>) => Promise<unknown>;
    /** Why new runs are held right now (an update hold), or null; named on the card so a hold isn't silent. */
    holdReason?: () => Promise<string | null>;
    now: () => Date;
  },
) {
  const openCard = async (key: string) => (await db.select({ id: decisions.id }).from(decisions).where(and(eq(decisions.dedupeKey, key), eq(decisions.status, "open"))).limit(1))[0];
  return {
    /** One pass: at most one CEO card per company, and later one owner notice. Returns how many it raised. */
    run: async (): Promise<{ raised: number }> => {
      const t = opts.now();
      const cos = await db.select({ id: companies.id, prefix: companies.ticketPrefix }).from(companies).where(eq(companies.paused, false));
      const holding: string[] = [];
      let raised = 0;
      for (const c of cos) {
        const [ceo] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, c.id), eq(agents.role, "ceo"), eq(agents.paused, false), isNull(agents.retiredAt)));
        if (!ceo) continue;
        const facts = await nothingRunningFacts(db, c.id, t);
        if (!nothingRunningHolds(facts)) continue;
        holding.push(c.id);
        const key = `${CLOCK_KEY}${c.id}`;
        const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, key));
        const since = Date.parse((row?.value as { since?: string } | undefined)?.since ?? "");
        if (!Number.isFinite(since)) {
          await db.insert(settings).values({ key, value: { since: t.toISOString() } }).onConflictDoUpdate({ target: settings.key, set: { value: { since: t.toISOString() } } });
          continue;
        }
        const waited = t.getTime() - since;
        if (waited < NOTHING_RUNNING_AFTER_MS) continue;
        const hold = (await opts.holdReason?.().catch(() => null)) ?? null;
        const mins = Math.round(waited / 60_000);
        const lines = facts.waiting.slice(0, 12).map((w) => `- ${w.number != null ? `${ticketRef(c.prefix, w.number) ?? w.id} ` : ""}"${w.title}" (${w.agent}): ${w.why}`);
        const body = [
          `No work run has been going for ${mins} minutes, and ${facts.waiting.length} Ready or In-progress ticket${facts.waiting.length === 1 ? " waits" : "s wait"}.`,
          hold ? `New runs are held: ${hold}.` : "",
          ...lines,
          facts.waiting.length > lines.length ? `...and ${facts.waiting.length - lines.length} more.` : "",
        ].filter(Boolean);
        // The CEO card first.
        if (!(await openCard(idleSlotsKey(c.id)))) {
          await opts.alert({
            companyId: c.id,
            kind: "idle_slots",
            question: [...body, `Wake the agent that should carry on, fix what holds it, or move the ticket. This closes by itself once a work run starts.`].join("\n"),
            from: "ceo",
            why: "nothing running while work waits is the CEO's to settle first",
            dedupeKey: idleSlotsKey(c.id),
            clearWhen: [{ kind: "idleSlotsGone", companyId: c.id }],
            about: [],
            context: { type: "question" },
          });
          raised++;
          continue;
        }
        // Still true 30 minutes after the CEO's card: one info notice on the owner's queue.
        if (waited >= NOTHING_RUNNING_AFTER_MS + NOTHING_RUNNING_OWNER_AFTER_MS && !(await openCard(idleSlotsOwnerKey(c.id)))) {
          await opts.alert({
            companyId: c.id,
            kind: "idle_slots_owner",
            question: [...body, `The CEO has had this for 30 minutes. Nothing for you to do unless you want to look: this closes by itself once a work run starts.`].join("\n"),
            from: "owner",
            why: "still nothing running after the CEO was told, so the owner should know",
            dedupeKey: idleSlotsOwnerKey(c.id),
            clearWhen: [{ kind: "idleSlotsGone", companyId: c.id }],
            about: [],
          });
          raised++;
        }
      }
      // The condition ended (or never held) everywhere else: its clock starts afresh next time.
      await db.delete(settings).where(and(like(settings.key, `${CLOCK_KEY}%`), holding.length ? notInArray(settings.key, holding.map((id) => `${CLOCK_KEY}${id}`)) : undefined));
      return { raised };
    },
  };
}
