// Idle-slots alert (BOS-1881). When a company's free run slots outnumber the Ready tickets that could start, and
// an agent sits idle, for 30 minutes, the CEO (never the owner) gets one alert naming the idle agents and any signed-off
// ticket stuck outside review. It closes by itself (DR-016, clearWhen idleSlotsGone) once the condition ends.
// The waiting clock lives in `settings`, so a server restart does not restart the half hour.
import { and, asc, eq, isNull, like, notInArray, sql } from "drizzle-orm";
import { ticketRef } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { agents, companies, decisions, settings, tickets } from "../db/schema.js";
import { busyAgentIds, canStartNow } from "./agent-wip.js";
import { findSignedOffStuck } from "./signoff.js";

export const IDLE_SLOTS_AFTER_MS = 30 * 60_000;
const CLOCK_KEY = "idle_slots_since:";

export const idleSlotsKey = (companyId: string) => `idle-slots:${companyId}`;

export type IdleSlotFacts = { free: number; startable: number; idle: string[] };

/** The three facts the alert and its closer both judge: free run slots, Ready tickets that could start now, and idle agents. */
export async function idleSlotFacts(db: Db, companyId: string, freeSlots: (companyId: string) => Promise<number>): Promise<IdleSlotFacts> {
  const free = await freeSlots(companyId);
  const ready = await db
    .select({ ticket: tickets })
    .from(tickets)
    .innerJoin(agents, eq(agents.id, tickets.assigneeAgentId))
    .where(and(eq(tickets.companyId, companyId), eq(tickets.systemState, "ready"), eq(agents.paused, false), isNull(agents.retiredAt)));
  let startable = 0;
  for (const { ticket } of ready) if (await canStartNow(db, ticket)) startable++;
  const busy = await busyAgentIds(db);
  const team = await db
    .select({ id: agents.id, name: agents.name })
    .from(agents)
    .where(and(eq(agents.companyId, companyId), sql`${agents.role} <> 'ceo'`, eq(agents.paused, false), isNull(agents.retiredAt)))
    .orderBy(asc(agents.name));
  return { free, startable, idle: team.filter((a) => !busy.has(a.id)).map((a) => a.name) };
}

/** True while the alert's condition holds: more free slots than startable Ready tickets, with someone idle to name. */
export const idleSlotsHold = (f: IdleSlotFacts) => f.free > f.startable && f.idle.length > 0;

/** For the closer: why the condition is over, or null while it still holds. */
export async function idleSlotsGoneReason(db: Db, companyId: string, freeSlots: (companyId: string) => Promise<number>): Promise<string | null> {
  const f = await idleSlotFacts(db, companyId, freeSlots);
  if (idleSlotsHold(f)) return null;
  return `free run slots (${f.free}) no longer outnumber the Ready tickets that can start (${f.startable}), or no agent is idle`;
}

export function idleSlotsSweep(
  db: Db,
  opts: {
    freeSlots?: (companyId: string) => Promise<number>;
    alert: (input: Record<string, unknown>) => Promise<unknown>;
    /** The branch head on the runner, for finding signed-off tickets stuck outside review; without it those aren't listed. */
    headOf?: (ticketId: string) => Promise<string | null>;
    now: () => Date;
  },
) {
  return {
    /** One pass: raises at most one CEO alert per company, and none while its card is open. Returns how many it raised. */
    run: async (): Promise<{ raised: number }> => {
      if (!opts.freeSlots) return { raised: 0 };
      const t = opts.now();
      const cos = await db
        .select({ id: companies.id, prefix: companies.ticketPrefix })
        .from(companies)
        .where(eq(companies.paused, false));
      const holding: string[] = [];
      let raised = 0;
      for (const c of cos) {
        const [ceo] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, c.id), eq(agents.role, "ceo"), eq(agents.paused, false), isNull(agents.retiredAt)));
        if (!ceo) continue;
        const facts = await idleSlotFacts(db, c.id, opts.freeSlots);
        if (!idleSlotsHold(facts)) continue;
        holding.push(c.id);
        const key = `${CLOCK_KEY}${c.id}`;
        const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, key));
        const since = Date.parse((row?.value as { since?: string } | undefined)?.since ?? "");
        if (!Number.isFinite(since)) {
          await db.insert(settings).values({ key, value: { since: t.toISOString() } }).onConflictDoUpdate({ target: settings.key, set: { value: { since: t.toISOString() } } });
          continue;
        }
        if (t.getTime() - since < IDLE_SLOTS_AFTER_MS) continue;
        // One alert at a time: nothing more while its card is open.
        const [open] = await db.select({ id: decisions.id }).from(decisions).where(and(eq(decisions.dedupeKey, idleSlotsKey(c.id)), eq(decisions.status, "open"))).limit(1);
        if (open) continue;
        const stuck = opts.headOf ? await findSignedOffStuck(db, { headOf: opts.headOf, now: t, graceMs: 30 * 60_000 }).catch(() => []) : [];
        const stuckHere = stuck.filter((s) => s.companyId === c.id);
        const mins = Math.round((t.getTime() - since) / 60_000);
        const question = [
          `${facts.free} run slot${facts.free === 1 ? " is" : "s are"} free but only ${facts.startable} Ready ticket${facts.startable === 1 ? " can" : "s can"} start, and this has held for ${mins} minutes.`,
          `Idle agents: ${facts.idle.join(", ")}.`,
          stuckHere.length ? `Signed off by the owner but stuck outside review (Boss Man moves these back to review by itself): ${stuckHere.map((s) => `${ticketRef(c.prefix, s.number) ?? s.id} "${s.title}"`).join(", ")}.` : "",
          `Give an idle agent its next ticket with assign_ticket and move it to ready, or start Ready work that is held. This closes by itself once the slots are used or no agent is idle.`,
        ]
          .filter(Boolean)
          .join("\n");
        await opts.alert({
          companyId: c.id,
          kind: "idle_slots",
          question,
          from: "ceo",
          why: "free slots with idle agents is the CEO's to settle, not the owner's",
          dedupeKey: idleSlotsKey(c.id),
          clearWhen: [{ kind: "idleSlotsGone", companyId: c.id }],
          about: [],
          context: { type: "question" },
        });
        raised++;
      }
      // The condition ended (or never held) everywhere else: its clock starts afresh next time.
      await db.delete(settings).where(and(like(settings.key, `${CLOCK_KEY}%`), holding.length ? notInArray(settings.key, holding.map((id) => `${CLOCK_KEY}${id}`)) : undefined));
      return { raised };
    },
  };
}
