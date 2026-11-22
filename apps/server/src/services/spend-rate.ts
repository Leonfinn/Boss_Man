// Spend-rate alert (BOS-2173). Boss Man stops spend at the ticket and monthly caps, but nothing watched the rate:
// a loop that stays under each cap only showed on the bill. Once a minute (from the sweep) this compares each
// company's spend so far today (UTC, from cost_events) with its average daily spend over the previous full days
// (up to 7). Over SPIKE_FACTOR times that average and over SPIKE_FLOOR_MICROS, the owner gets one alert naming
// the top agents and tickets. At most one per company per UTC day; under MIN_HISTORY_DAYS of history, none.
// The day an alert was raised lives in one `settings` row per company, so a restart does not raise it again.
import { and, desc, eq, gte, lt, min, sql, sum } from "drizzle-orm";
import { ticketRef } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { agents, companies, costEvents, runs, settings, tickets } from "../db/schema.js";
import type { AlertInput } from "./alert-ladder.js";

export const SPIKE_FACTOR = 3;
export const SPIKE_FLOOR_MICROS = 5_000_000; // $5
export const MIN_HISTORY_DAYS = 3;
export const WINDOW_DAYS = 7;
const DAY_MS = 86_400_000;
const TOP = 3;

export const spendRateKey = (companyId: string, day: string) => `spend-rate:${companyId}:${day}`;
const markKey = (companyId: string) => `spend_rate_alerted:${companyId}`;

const usd = (micros: number) => `$${(micros / 1_000_000).toFixed(2)}`;

export type SpendRateFacts = { todayMicros: number; averageMicros: number; historyDays: number };

/** Today's spend and the daily average over the previous full days; null when today is under the floor or the history is too short. */
export async function spendRateFacts(db: Db, companyId: string, now: Date): Promise<SpendRateFacts | null> {
  const dayStart = new Date(Math.floor(now.getTime() / DAY_MS) * DAY_MS);
  // Cheap first look: most companies are under the floor most of the day.
  const [today] = await db.select({ total: sum(costEvents.costMicros) }).from(costEvents).where(and(eq(costEvents.companyId, companyId), gte(costEvents.occurredAt, dayStart)));
  const todayMicros = Number(today?.total ?? 0);
  if (todayMicros < SPIKE_FLOOR_MICROS) return null;
  const [first] = await db.select({ at: min(costEvents.occurredAt) }).from(costEvents).where(eq(costEvents.companyId, companyId));
  const firstAt = first?.at ? new Date(first.at).getTime() : null;
  if (firstAt === null) return null;
  const historyDays = Math.min(WINDOW_DAYS, Math.floor(dayStart.getTime() / DAY_MS) - Math.floor(firstAt / DAY_MS)); // full UTC days from the first spend's day to today
  if (historyDays < MIN_HISTORY_DAYS) return null;
  const from = new Date(dayStart.getTime() - historyDays * DAY_MS);
  const [prior] = await db.select({ total: sum(costEvents.costMicros) }).from(costEvents).where(and(eq(costEvents.companyId, companyId), gte(costEvents.occurredAt, from), lt(costEvents.occurredAt, dayStart)));
  return { todayMicros, averageMicros: Number(prior?.total ?? 0) / historyDays, historyDays };
}

/** True when today's spend is over SPIKE_FACTOR times the usual and the floor. */
export const isSpike = (f: SpendRateFacts) => f.todayMicros >= SPIKE_FLOOR_MICROS && f.todayMicros > SPIKE_FACTOR * f.averageMicros;

/** The agents and tickets that spent the most so far today. */
export async function topSpenders(db: Db, companyId: string, prefix: string | null, now: Date) {
  const dayStart = new Date(Math.floor(now.getTime() / DAY_MS) * DAY_MS);
  const base = and(eq(costEvents.companyId, companyId), gte(costEvents.occurredAt, dayStart));
  const byAgent = await db
    .select({ name: agents.name, total: sum(costEvents.costMicros) })
    .from(costEvents)
    .leftJoin(agents, eq(agents.id, costEvents.agentId))
    .where(base)
    .groupBy(agents.name)
    .orderBy(desc(sum(costEvents.costMicros)))
    .limit(TOP);
  const byTicket = await db
    .select({ id: tickets.id, number: tickets.number, title: tickets.title, total: sum(costEvents.costMicros) })
    .from(costEvents)
    .innerJoin(runs, eq(runs.id, costEvents.runId))
    .innerJoin(tickets, eq(tickets.id, runs.ticketId))
    .where(base)
    .groupBy(tickets.id, tickets.number, tickets.title)
    .orderBy(desc(sum(costEvents.costMicros)))
    .limit(TOP);
  return {
    agents: byAgent.map((a) => `${a.name ?? "an agent that has since been removed"} (${usd(Number(a.total ?? 0))})`),
    tickets: byTicket.map((t) => `${ticketRef(prefix, t.number) ?? t.id} "${t.title.slice(0, 60)}" (${usd(Number(t.total ?? 0))})`),
  };
}

export function spendRateSweep(db: Db, opts: { alert: (input: AlertInput) => Promise<unknown>; now: () => Date }) {
  return {
    /** One pass: raises at most one owner alert per company per UTC day. Returns how many it raised. */
    run: async (): Promise<{ raised: number }> => {
      const t = opts.now();
      const day = t.toISOString().slice(0, 10);
      const cos = await db.select({ id: companies.id, prefix: companies.ticketPrefix }).from(companies).where(eq(companies.paused, false));
      let raised = 0;
      for (const c of cos) {
        const [mark] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, markKey(c.id)));
        if ((mark?.value as { day?: string } | undefined)?.day === day) continue;
        const facts = await spendRateFacts(db, c.id, t);
        if (!facts || !isSpike(facts)) continue;
        const top = await topSpenders(db, c.id, c.prefix, t);
        const times = facts.averageMicros > 0 ? `about ${Math.round(facts.todayMicros / facts.averageMicros)} times the usual ${usd(facts.averageMicros)} a day` : "far above the usual, which has been close to nothing";
        const question = [
          `Spending today is ${usd(facts.todayMicros)}, ${times}.`,
          `Most of it: ${top.agents.length ? top.agents.join(", ") : "no agent recorded"}${top.tickets.length ? ` on ${top.tickets.join(", ")}` : ""}.`,
          `Boss Man has not stopped anything: each ticket's cap and the monthly cap still apply. If this looks like a loop, pause the agent or ticket named above. You get at most one of these a day.`,
        ].join("\n");
        await opts.alert({
          companyId: c.id,
          kind: "spend_rate",
          question,
          from: "owner",
          why: "a spending spike is the owner's to judge: only they can say whether it is expected",
          dedupeKey: spendRateKey(c.id, day),
          about: [],
        });
        // Marked after the raise: a failed raise is tried again next minute, a raised one never twice in a day.
        await db.insert(settings).values({ key: markKey(c.id), value: { day } }).onConflictDoUpdate({ target: settings.key, set: { value: { day } } });
        raised++;
      }
      return { raised };
    },
  };
}
