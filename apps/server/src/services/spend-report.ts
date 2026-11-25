import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { dateIn, isTimeZone, ticketRef } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { agents, companies, costEvents, features, fundingSources, projects, runs, tickets } from "../db/schema.js";

export const SPEND_REPORT_PERIODS = [7, 30, 90] as const;

export type SpendReportRow = {
  /** The owner's local day, YYYY-MM-DD. */
  date: string;
  agentId: string | null;
  agent: string;
  featureId: string | null;
  feature: string;
  projectId: string | null;
  project: string;
  tickets: number;
  micros: number;
};

/** One of the period's costliest tickets; `ticketId` null is the "Not on a ticket" row (spend with no ticket). */
export type SpendTopTicket = {
  ticketId: string | null;
  ref: string | null;
  title: string;
  state: string | null;
  feature: string | null;
  micros: number;
  runs: number;
};

/**
 * One model's use (BOS-2401). Unlike the other splits this counts plan (subscription) use too, at list price, kept apart
 * from pay-as-you-go: `micros` is both added, `planMicros` and `payMicros` the two parts. `date` is empty in the period totals.
 */
export type SpendModelRow = {
  date: string;
  model: string;
  micros: number;
  planMicros: number;
  payMicros: number;
  runs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

/** One name's money in the previous period (BOS-2432); `key` is the agent, feature or project id, else `none:<name>`; the model split keys on the model name. */
export type SpendPreviousItem = { key: string; name: string; micros: number };

/** The same figures for the period of the same length just before this one. Money rows only, except `models` (plan use too, like the model split). */
export type SpendPrevious = {
  days: number;
  totalMicros: number;
  agents: SpendPreviousItem[];
  features: SpendPreviousItem[];
  projects: SpendPreviousItem[];
  models: SpendPreviousItem[];
};

export type SpendReport = {
  /** The previous period of the same length, in the same time zone (BOS-2432). */
  previous: SpendPrevious;
  timeZone: string;
  days: string[];
  rows: SpendReportRow[];
  totalMicros: number;
  topTickets: SpendTopTicket[];
  /** The period's totals per model, biggest first. */
  models: SpendModelRow[];
  /** The same per local day and model, for the chart and CSV. */
  modelDays: SpendModelRow[];
};

export const UNKNOWN_MODEL = "Unknown model";

const TOP_TICKETS = 10;

/** A zone Intl accepts, else UTC (the browser sends its own zone; a bad one must not fail the page). */
export function validZone(tz: string | undefined): string {
  return tz && isTimeZone(tz) ? tz : "UTC";
}

/**
 * Money a company spent, one row per local day, agent, feature and project over the last `days` days (BOS-2194).
 * Real spend only: cost events on subscription sources carry a list price but aren't money, so they are left out,
 * as on the dashboard. A cost with no ticket shows under "No feature"; one with no agent or project likewise.
 * Days are the owner's local days; the grouping is one pass in code (the zone can't be done in one cheap query, BOS-643).
 */
export async function spendReport(db: Db, companyId: string, opts: { days: number; timeZone?: string; now?: Date }): Promise<SpendReport> {
  const now = opts.now ?? new Date();
  const timeZone = validZone(opts.timeZone);
  const [y, m, d] = dateIn(now, timeZone).split("-").map(Number) as [number, number, number];
  const days = Array.from({ length: opts.days }, (_, i) => new Date(Date.UTC(y, m - 1, d - (opts.days - 1 - i))).toISOString().slice(0, 10));
  const first = days[0]!;
  const prevDays = Array.from({ length: opts.days }, (_, i) => new Date(Date.parse(`${first}T00:00:00Z`) + (i - opts.days) * 86_400_000).toISOString().slice(0, 10));
  // A day of slack either side of the zone offset; rows outside the listed days are dropped below.
  const since = new Date(Date.parse(`${prevDays[0]!}T00:00:00Z`) - 86_400_000);
  const events = await db
    .select({
      at: costEvents.occurredAt,
      micros: costEvents.costMicros,
      runId: costEvents.runId,
      agentId: costEvents.agentId,
      agent: agents.name,
      ticketId: tickets.id,
      featureId: tickets.featureId,
      feature: features.title,
      projectId: projects.id,
      project: projects.name,
      model: costEvents.model,
      kind: fundingSources.kind,
      inTok: costEvents.inputTokens,
      outTok: costEvents.outputTokens,
      readTok: costEvents.cacheReadTokens,
      writeTok: costEvents.cacheWriteTokens,
    })
    .from(costEvents)
    .innerJoin(fundingSources, eq(fundingSources.id, costEvents.fundingSourceId))
    .leftJoin(agents, eq(agents.id, costEvents.agentId))
    .leftJoin(runs, eq(runs.id, costEvents.runId))
    .leftJoin(tickets, eq(tickets.id, runs.ticketId))
    .leftJoin(features, eq(features.id, tickets.featureId))
    // Same project the budget page uses: the charged project of engagement work, else the event's, else the ticket's.
    .leftJoin(projects, eq(projects.id, sql`coalesce(${costEvents.chargedProjectId}, ${costEvents.projectId}, ${tickets.projectId})`))
    .where(and(eq(costEvents.companyId, companyId), gte(costEvents.occurredAt, since)));

  const daySet = new Set(days);
  // not state: locals that live for this one call
  const modelTotals = new Map<string, SpendModelRow & { runIds: Set<string> }>();
  const modelByDay = new Map<string, SpendModelRow & { runIds: Set<string> }>();
  const addModel = (map: Map<string, SpendModelRow & { runIds: Set<string> }>, date: string, e: (typeof events)[number]) => {
    const model = e.model?.trim() || UNKNOWN_MODEL;
    const k = `${date}|${model}`;
    let m = map.get(k);
    if (!m) {
      m = { date, model, micros: 0, planMicros: 0, payMicros: 0, runs: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, runIds: new Set() };
      map.set(k, m);
    }
    m.micros += e.micros;
    if (e.kind === "subscription") m.planMicros += e.micros;
    else m.payMicros += e.micros;
    m.inputTokens += e.inTok ?? 0;
    m.outputTokens += e.outTok ?? 0;
    m.cacheReadTokens += e.readTok ?? 0;
    m.cacheWriteTokens += e.writeTok ?? 0;
    if (e.runId) m.runIds.add(e.runId);
  };
  // not state: locals that live for this one call
  const perTicket = new Map<string, { ticketId: string | null; micros: number; runs: Set<string> }>();
  // not state: a local that lives for this one call
  const groups = new Map<string, SpendReportRow & { ids: Set<string> }>();
  let totalMicros = 0;
  const prevSet = new Set(prevDays);
  // not state: locals that live for this one call
  const prev = { agents: new Map<string, SpendPreviousItem>(), features: new Map<string, SpendPreviousItem>(), projects: new Map<string, SpendPreviousItem>(), models: new Map<string, SpendPreviousItem>() };
  let prevTotal = 0;
  const addPrev = (m: Map<string, SpendPreviousItem>, id: string | null, name: string, micros: number) => {
    const key = id ?? `none:${name}`;
    const it = m.get(key) ?? { key, name, micros: 0 };
    it.micros += micros;
    m.set(key, it);
  };
  for (const e of events) {
    const date = dateIn(e.at, timeZone);
    if (prevSet.has(date)) {
      const model = e.model?.trim() || UNKNOWN_MODEL;
      addPrev(prev.models, model, model, e.micros);
      if (e.kind !== "subscription") {
        addPrev(prev.agents, e.agentId, e.agent ?? "No agent", e.micros);
        addPrev(prev.features, e.featureId, e.feature ?? "No feature", e.micros);
        addPrev(prev.projects, e.projectId, e.project ?? "No project", e.micros);
        prevTotal += e.micros;
      }
      continue;
    }
    if (!daySet.has(date)) continue;
    addModel(modelByDay, date, e);
    addModel(modelTotals, "", e);
    // The other splits are real money only: plan use is left out of them.
    if (e.kind === "subscription") continue;
    const key = [date, e.agentId ?? "", e.featureId ?? "", e.projectId ?? ""].join("|");
    let g = groups.get(key);
    if (!g) {
      g = {
        date,
        agentId: e.agentId,
        agent: e.agent ?? "No agent",
        featureId: e.featureId,
        feature: e.feature ?? "No feature",
        projectId: e.projectId,
        project: e.project ?? "No project",
        tickets: 0,
        micros: 0,
        ids: new Set(),
      };
      groups.set(key, g);
    }
    g.micros += e.micros;
    totalMicros += e.micros;
    if (e.ticketId) g.ids.add(e.ticketId);
    const tk = e.ticketId ?? "";
    const t = perTicket.get(tk) ?? { ticketId: e.ticketId, micros: 0, runs: new Set<string>() };
    t.micros += e.micros;
    if (e.runId) t.runs.add(e.runId);
    perTicket.set(tk, t);
  }
  const ranked = [...perTicket.values()].sort((a, b) => b.micros - a.micros).slice(0, TOP_TICKETS);
  const ids = ranked.flatMap((t) => (t.ticketId ? [t.ticketId] : []));
  const info = ids.length
    ? await db
        .select({ id: tickets.id, number: tickets.number, title: tickets.title, state: tickets.systemState, feature: features.title, prefix: companies.ticketPrefix })
        .from(tickets)
        .innerJoin(companies, eq(companies.id, tickets.companyId))
        .leftJoin(features, eq(features.id, tickets.featureId))
        .where(inArray(tickets.id, ids))
    : [];
  const infoById = new Map(info.map((i) => [i.id, i]));
  const topTickets: SpendTopTicket[] = ranked.map((t) => {
    const i = t.ticketId ? infoById.get(t.ticketId) : undefined;
    return {
      ticketId: t.ticketId,
      ref: i ? ticketRef(i.prefix, i.number) : null,
      title: i?.title ?? "Not on a ticket",
      state: i?.state ?? null,
      feature: i?.feature ?? null,
      micros: t.micros,
      runs: t.runs.size,
    };
  });
  const rows = [...groups.values()]
    .map(({ ids, ...r }) => ({ ...r, tickets: ids.size }))
    .sort((a, b) => a.date.localeCompare(b.date) || b.micros - a.micros || a.agent.localeCompare(b.agent));
  const finish = (m: SpendModelRow & { runIds: Set<string> }): SpendModelRow => {
    const { runIds, ...r } = m;
    return { ...r, runs: runIds.size };
  };
  const models = [...modelTotals.values()].map(finish).sort((a, b) => b.micros - a.micros || a.model.localeCompare(b.model));
  const modelDays = [...modelByDay.values()].map(finish).sort((a, b) => a.date.localeCompare(b.date) || b.micros - a.micros || a.model.localeCompare(b.model));
  const list = (m: Map<string, SpendPreviousItem>) => [...m.values()].sort((a, b) => b.micros - a.micros || a.name.localeCompare(b.name));
  const previous: SpendPrevious = { days: opts.days, totalMicros: prevTotal, agents: list(prev.agents), features: list(prev.features), projects: list(prev.projects), models: list(prev.models) };
  return { previous, timeZone, days, rows, totalMicros, topTickets, models, modelDays };
}
