// What merged, what it cost and what waits for the owner (BOS-2195): the three lines on top of the daily summary,
// and the optional weekly email. The queries are shared; the wording is pure so tests can pin it.
// The weekly switch, address and last-sent time sit in the settings table (one key per company), so a restart
// neither forgets the switch nor sends the same week twice.
import { and, eq, gte, isNotNull, lt, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { companies, costEvents, decisions, features, settings, tickets } from "../db/schema.js";

const H = 3_600_000;
const DAY = 24 * H;

export type DayFacts = {
  merged: string[];
  /** Micro-dollars spent in the day, and the average per day over the 7 days before. */
  spentMicros: number;
  avgMicros: number;
  waiting: number;
  oldestWaitingMs: number | null;
};

const usd = (micros: number) => `$${(micros / 1_000_000).toFixed(2)}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const hours = (ms: number) => {
  const h = Math.max(1, Math.round(ms / H));
  return plural(h, "hour");
};

/** The three lines for the top of the daily summary; a line with nothing to say is left out. */
export function dayLines(f: DayFacts): string[] {
  const out: string[] = [];
  if (f.merged.length) {
    const shown = f.merged.slice(0, 5).map((t) => `"${t}"`).join(", ");
    const more = f.merged.length > 5 ? ` and ${f.merged.length - 5} more` : "";
    out.push(`Merged yesterday: ${plural(f.merged.length, "ticket")} (${shown}${more})`);
  }
  if (f.spentMicros > 0) out.push(`Spent yesterday: ${usd(f.spentMicros)} (7-day average ${usd(f.avgMicros)})`);
  if (f.waiting > 0) out.push(`Waiting for you: ${plural(f.waiting, "card")}, oldest ${hours(f.oldestWaitingMs ?? 0)}`);
  return out;
}

export async function spendBetween(db: Db, companyId: string, from: Date, to: Date): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`coalesce(sum(${costEvents.costMicros}), 0)::float8` })
    .from(costEvents)
    .where(and(eq(costEvents.companyId, companyId), gte(costEvents.occurredAt, from), lt(costEvents.occurredAt, to)));
  return Number(r?.n ?? 0);
}

async function mergedBetween(db: Db, companyId: string, from: Date, to: Date) {
  return db
    .select({ id: tickets.id, title: tickets.title, number: tickets.number, featureId: tickets.featureId, feature: features.title })
    .from(tickets)
    .leftJoin(features, eq(features.id, tickets.featureId))
    .where(and(eq(tickets.companyId, companyId), isNotNull(tickets.mergedAt), gte(tickets.mergedAt, from), lt(tickets.mergedAt, to)))
    .orderBy(tickets.mergedAt);
}

async function waitingCards(db: Db, companyId: string, at: Date) {
  const rows = await db
    .select({ askedAt: decisions.createdAt })
    .from(decisions)
    .where(and(eq(decisions.companyId, companyId), eq(decisions.status, "open"), eq(decisions.tier, "owner")))
    .orderBy(decisions.createdAt);
  return { waiting: rows.length, oldestWaitingMs: rows[0] ? at.getTime() - rows[0].askedAt.getTime() : null };
}

/** The facts behind the daily summary's three lines: the 24 hours up to `at`. */
export async function dayFacts(db: Db, companyId: string, at: Date): Promise<DayFacts> {
  const from = new Date(at.getTime() - DAY);
  const merged = await mergedBetween(db, companyId, from, at);
  const spentMicros = await spendBetween(db, companyId, from, at);
  const week = await spendBetween(db, companyId, new Date(at.getTime() - 8 * DAY), from);
  return { merged: merged.map((m) => m.title.replace(/\s+/g, " ").slice(0, 80)), spentMicros, avgMicros: week / 7, ...(await waitingCards(db, companyId, at)) };
}

// ---------- Weekly email ----------

export const WeeklySettingsInput = z.object({
  enabled: z.boolean(),
  /** Where the email goes: the owner's own address. */
  to: z.string().trim().max(254).regex(/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/, "That isn't an email address.").nullable(),
});

export type WeeklyStored = { enabled: boolean; to: string | null; lastSentAt: string | null };
const key = (companyId: string) => `weekly_summary:${companyId}`;

export type WeeklyFacts = {
  merged: Array<{ title: string; feature: string | null; /** The ticket, for the in-app view's links; the email doesn't use it. */ id?: string }>;
  spentMicros: number;
  beforeMicros: number;
  released: string[];
  waiting: number;
  oldestWaitingMs: number | null;
};

/** Plain text only: the mailer sends text. */
export function weeklyText(f: WeeklyFacts): { subject: string; text: string } {
  const groups = new Map<string, string[]>(); // shortcut: lost on restart, harmless because it is a local built and dropped inside this call.
  for (const m of f.merged) groups.set(m.feature ?? "Other work", [...(groups.get(m.feature ?? "Other work") ?? []), m.title]);
  const lines: string[] = [];
  lines.push(`Merged this week: ${plural(f.merged.length, "ticket")}`);
  for (const [feature, titles] of groups) lines.push(`- ${feature}: ${titles.slice(0, 5).join("; ")}${titles.length > 5 ? ` and ${titles.length - 5} more` : ""}`);
  const diff = f.spentMicros - f.beforeMicros;
  lines.push(`Spent this week: ${usd(f.spentMicros)} (the week before: ${usd(f.beforeMicros)}${f.beforeMicros > 0 ? `, ${diff >= 0 ? "up" : "down"} ${usd(Math.abs(diff))}` : ""})`);
  lines.push(f.released.length ? `Features released: ${f.released.join(", ")}` : "Features released: none");
  lines.push(f.waiting ? `Cards still waiting for you: ${f.waiting}, oldest ${hours(f.oldestWaitingMs ?? 0)}` : "Cards still waiting for you: none");
  return { subject: "Boss Man: your week", text: lines.join("\n") };
}

export function weeklySummaryService(
  db: Db,
  deps: { send: (msg: { to: string; subject: string; text: string }) => Promise<void>; isConfigured: () => Promise<boolean>; /** The owner's local weekday (1 = Monday) and hour at a moment. */ localDayHour: (t: Date) => { day: number; hour: number }; now?: () => Date; log?: (m: string) => void },
) {
  const now = () => deps.now?.() ?? new Date();
  const get = async (companyId: string): Promise<WeeklyStored> => {
    const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, key(companyId)));
    return { enabled: false, to: null, lastSentAt: null, ...((row?.value as Partial<WeeklyStored> | undefined) ?? {}) };
  };
  const put = async (companyId: string, v: WeeklyStored) => {
    await db.insert(settings).values({ key: key(companyId), value: v }).onConflictDoUpdate({ target: settings.key, set: { value: v } });
  };

  /** The 7 days up to `at`. Waiting cards are always read as of `waitAt` (now): what waited in the past isn't kept. */
  async function facts(companyId: string, at: Date, waitAt: Date = at): Promise<WeeklyFacts> {
    const from = new Date(at.getTime() - 7 * DAY);
    const merged = await mergedBetween(db, companyId, from, at);
    const rel = await db.select({ title: features.title }).from(features).where(and(eq(features.companyId, companyId), isNotNull(features.releasedAt), gte(features.releasedAt, from), lt(features.releasedAt, at)));
    return {
      merged: merged.map((m) => ({ title: `${m.title.replace(/\s+/g, " ").slice(0, 80)}`, feature: m.feature, id: m.id })),
      spentMicros: await spendBetween(db, companyId, from, at),
      beforeMicros: await spendBetween(db, companyId, new Date(from.getTime() - 7 * DAY), from),
      released: rel.map((r) => r.title),
      ...(await waitingCards(db, companyId, waitAt)),
    };
  }

  return {
    get,
    /** The in-app summary (BOS-2390): the same facts and text as the email, for the 7 days up to now ("this") or the 7 days before ("last"). Works without email set up. */
    async view(companyId: string, week: "this" | "last") {
      const t = now();
      const f = await facts(companyId, week === "this" ? t : new Date(t.getTime() - 7 * DAY), t);
      const w = weeklyText(f);
      const from = new Date((week === "this" ? t : new Date(t.getTime() - 7 * DAY)).getTime() - 7 * DAY);
      const to = week === "this" ? t : new Date(t.getTime() - 7 * DAY);
      return { week, from: from.toISOString(), to: to.toISOString(), ...f, text: week === "last" ? w.text.replace(/ this week/g, " last week") : w.text };
    },
    /** Every company whose switch is on; one failing company doesn't stop the rest. */
    async runAll() {
      for (const c of await db.select({ id: companies.id }).from(companies)) await this.run(c.id).catch((err) => deps.log?.(`weekly summary for ${c.id} failed: ${(err as Error).message}`));
    },
    async companyExists(companyId: string): Promise<boolean> {
      const [c] = await db.select({ id: companies.id }).from(companies).where(eq(companies.id, companyId));
      return !!c;
    },
    /** Sends the weekly email now, any day and hour, to the saved address. Leaves lastSentAt alone. A failure throws with the mail server's reason. */
    async sendNow(companyId: string): Promise<{ to: string }> {
      const s = await get(companyId);
      if (!s.enabled || !s.to) throw Object.assign(new Error("Switch the weekly summary on and save an address first."), { statusCode: 422 });
      if (!(await deps.isConfigured())) throw Object.assign(new Error("Outgoing email isn't set up yet. Add the mail server in Settings → Server and runner → Email."), { statusCode: 422 });
      const w = weeklyText(await facts(companyId, now()));
      try {
        await deps.send({ to: s.to, subject: w.subject, text: w.text });
      } catch (err) {
        deps.log?.(`weekly summary for ${companyId} send-now failed: ${(err as Error).message}`);
        throw Object.assign(new Error(`The mail server did not accept it: ${(err as Error).message}`), { statusCode: 502 });
      }
      return { to: s.to };
    },
    async save(companyId: string, input: z.infer<typeof WeeklySettingsInput>) {
      if (input.enabled && !input.to) throw Object.assign(new Error("Give the address the weekly summary goes to."), { statusCode: 422 });
      const prev = await get(companyId);
      const next = { ...prev, enabled: input.enabled, to: input.to };
      await put(companyId, next);
      return { ...next, configured: await deps.isConfigured() };
    },
    /** Sends this company's weekly email if it is on, it is Monday from 8 owner time, and none went out in the last 6 days. */
    async run(companyId: string): Promise<boolean> {
      const t = now();
      const s = await get(companyId);
      if (!s.enabled || !s.to) return false;
      const { day, hour } = deps.localDayHour(t);
      if (day !== 1 || hour < 8) return false;
      if (s.lastSentAt && t.getTime() - new Date(s.lastSentAt).getTime() < 6 * DAY) return false;
      if (!(await deps.isConfigured())) return false;
      const w = weeklyText(await facts(companyId, t));
      // Written down after sending: a failed send leaves lastSentAt alone, so the next sweep retries it.
      try {
        await deps.send({ to: s.to, subject: w.subject, text: w.text });
      } catch (err) {
        deps.log?.(`weekly summary for ${companyId} not sent: ${(err as Error).message}`);
        return false;
      }
      await put(companyId, { ...s, lastSentAt: t.toISOString() });
      return true;
    },
  };
}
