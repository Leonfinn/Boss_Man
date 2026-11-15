// Read-only report (BOS-1456): permission cards that reached the owner in the last N hours, in every company,
// grouped by the rule that sent them. For the owner's route and the CEO's `permission_report` tool.
//
// The deciding rule is stored on each card (context.rule, written when the card is raised). A card that went to
// the CEO first and reached the owner later carries a ladder; its last hop says why (the CEO's time ran out, the
// CEO escalated it, the CEO could not take it). Such cards are grouped apart from cards that went to the owner
// directly, so "temp-cleanup, CEO first, then timed out" is not mixed with "temp-cleanup straight to the owner".
//
// Only what the card already shows the owner leaves here: the title and one-line summary, the ownerWhy line, the
// answer. Never the command, the tool input or the agent's reason.
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { ticketRef } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { agents, companies, decisions, runs, tickets } from "../db/schema.js";

export const PERMISSION_REPORT_DEFAULT_HOURS = 48;
export const PERMISSION_REPORT_MAX_HOURS = 168;

export type Route = "direct" | "ceo_timeout" | "ceo_escalated" | "ceo_unavailable";

export interface ExampleCard {
  cardId: string;
  company: string;
  at: string;
  agent: string | null;
  ticket: string | null;
  /** Minutes from raised to answered; null while the card is still open. */
  waitMinutes: number | null;
  status: string;
  answer: string | null;
  /** The card's own title and one-line summary, as the owner sees them. */
  what: string;
}

export interface PermissionGroup {
  rule: string;
  route: Route;
  count: number;
  /** Cards per hour, keyed by the start of the hour (UTC, ISO), only hours with at least one. */
  perHour: Record<string, number>;
  /** The ownerWhy lines on these cards with how many each, most common first (at most 3). */
  ownerWhy: Array<{ text: string; count: number }>;
  example: ExampleCard;
}

export interface PermissionReport {
  from: string;
  to: string;
  hours: number;
  total: number;
  groups: PermissionGroup[];
}

export interface CardRow {
  id: string;
  companyId: string;
  company: string;
  status: string;
  answer: string | null;
  createdAt: Date;
  answeredAt: Date | null;
  agent: string | null;
  ticket: string | null;
  context: unknown;
}

type Ctx = { rule?: string; ladder?: { hops?: Array<{ to?: string; why?: string }> }; explain?: { title?: string; summary?: string; ownerWhy?: string } };

/** How the card came to the owner, read from its ladder; "direct" when it never went to the CEO. */
export function routeOf(ctx: Ctx): Route {
  const hops = ctx.ladder?.hops;
  if (!hops?.length) return "direct";
  const why = (hops.filter((h) => h.to === "owner").at(-1)?.why ?? "").toLowerCase();
  if (/in time|time ran out|timed out|didn't settle|did not settle|no answer|expired/.test(why)) return "ceo_timeout";
  if (/dropped|paused|could not take|can't take/.test(why)) return "ceo_unavailable";
  return "ceo_escalated";
}

const hourStart = (d: Date) => new Date(Math.floor(d.getTime() / 3_600_000) * 3_600_000).toISOString();

/** Pure: groups the rows (newest example per group). Exported for tests. */
export function groupCards(rows: CardRow[], from: Date, to: Date, hours: number): PermissionReport {
  // not state: a local built and dropped within this one call
  const groups = new Map<string, { rule: string; route: Route; rows: CardRow[] }>();
  for (const row of rows) {
    const ctx = (row.context ?? {}) as Ctx;
    const rule = typeof ctx.rule === "string" && ctx.rule ? ctx.rule : "(no rule recorded)";
    const route = routeOf(ctx);
    const key = `${rule}\u0000${route}`;
    const g = groups.get(key) ?? { rule, route, rows: [] };
    g.rows.push(row);
    groups.set(key, g);
  }
  const out: PermissionGroup[] = [...groups.values()].map((g) => {
    const perHour: Record<string, number> = {};
    const why = new Map<string, number>();
    for (const r of g.rows) {
      const h = hourStart(r.createdAt);
      perHour[h] = (perHour[h] ?? 0) + 1;
      const w = (r.context as Ctx | null)?.explain?.ownerWhy;
      if (w) why.set(w, (why.get(w) ?? 0) + 1);
    }
    const newest = g.rows.reduce((a, b) => (b.createdAt > a.createdAt ? b : a));
    const e = (newest.context as Ctx | null)?.explain;
    return {
      rule: g.rule,
      route: g.route,
      count: g.rows.length,
      perHour: Object.fromEntries(Object.entries(perHour).sort(([a], [b]) => (a < b ? -1 : 1))),
      ownerWhy: [...why.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([text, count]) => ({ text, count })),
      example: {
        cardId: newest.id,
        company: newest.company,
        at: newest.createdAt.toISOString(),
        agent: newest.agent,
        ticket: newest.ticket,
        waitMinutes: newest.answeredAt ? Math.round((newest.answeredAt.getTime() - newest.createdAt.getTime()) / 6000) / 10 : null,
        status: newest.status,
        answer: newest.answer,
        what: [e?.title, e?.summary].filter(Boolean).join(". "),
      },
    };
  });
  out.sort((a, b) => b.count - a.count || (a.rule < b.rule ? -1 : 1));
  return { from: from.toISOString(), to: to.toISOString(), hours, total: rows.length, groups: out };
}

/** Read-only: owner-tier permission cards created in the last `hours`, across every company. */
export async function permissionReport(db: Db, opts: { hours?: number; now?: Date } = {}): Promise<PermissionReport> {
  const hours = Math.min(PERMISSION_REPORT_MAX_HOURS, Math.max(1, Math.floor(opts.hours ?? PERMISSION_REPORT_DEFAULT_HOURS)));
  const to = opts.now ?? new Date();
  const from = new Date(to.getTime() - hours * 3_600_000);
  // Plan cards share kind "permission" but are the plan approver's, not a permission rule's: left out.
  const found = await db
    .select({ d: decisions, company: companies.name })
    .from(decisions)
    .innerJoin(companies, eq(companies.id, decisions.companyId))
    .where(and(eq(decisions.kind, "permission"), eq(decisions.tier, "owner"), gte(decisions.createdAt, from), sql`${decisions.context}->'plan' is null`));
  const runIds = [...new Set(found.map((f) => (f.d.context as { runId?: string }).runId).filter((x): x is string => typeof x === "string"))];
  const runRows = runIds.length ? await db.select({ id: runs.id, agentId: runs.agentId, ticketId: runs.ticketId }).from(runs).where(inArray(runs.id, runIds)) : [];
  const agentIds = [...new Set(runRows.map((r) => r.agentId).filter((x): x is string => !!x))];
  const ticketIds = [...new Set(runRows.map((r) => r.ticketId).filter((x): x is string => !!x))];
  const agentRows = agentIds.length ? await db.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, agentIds)) : [];
  const ticketRows = ticketIds.length
    ? await db.select({ id: tickets.id, number: tickets.number, prefix: companies.ticketPrefix }).from(tickets).innerJoin(companies, eq(companies.id, tickets.companyId)).where(inArray(tickets.id, ticketIds))
    : [];
  const run = new Map(runRows.map((r) => [r.id, r]));
  const agentName = new Map(agentRows.map((a) => [a.id, a.name]));
  const ticketName = new Map(ticketRows.map((t) => [t.id, ticketRef(t.prefix, t.number)]));
  const rows: CardRow[] = found.map(({ d, company }) => {
    const r = run.get((d.context as { runId?: string }).runId ?? "");
    return {
      id: d.id,
      companyId: d.companyId,
      company,
      status: d.status,
      answer: d.answer,
      createdAt: d.createdAt,
      answeredAt: d.answeredAt,
      agent: (r?.agentId ? agentName.get(r.agentId) : null) ?? (d.context as { alwaysAgent?: { name?: string } }).alwaysAgent?.name ?? null,
      ticket: r?.ticketId ? (ticketName.get(r.ticketId) ?? null) : null,
      context: d.context,
    };
  });
  return groupCards(rows, from, to, hours);
}

export function formatPermissionReport(r: PermissionReport): string {
  const lines = [`Owner-tier permission cards, last ${r.hours} h (${r.from.slice(0, 16)}Z to ${r.to.slice(0, 16)}Z): ${r.total} cards in ${r.groups.length} groups`];
  for (const g of r.groups) {
    lines.push("", `${g.rule} [${g.route}]: ${g.count} cards`, `  per hour: ${Object.entries(g.perHour).map(([h, n]) => `${h.slice(5, 13)}h ${n}`).join(", ")}`);
    for (const w of g.ownerWhy) lines.push(`  why (${w.count}): ${w.text}`);
    const e = g.example;
    lines.push(`  example: ${e.at.slice(0, 16)}Z ${e.company} / ${e.agent ?? "?"} / ${e.ticket ?? "no ticket"} / card ${e.cardId} / wait ${e.waitMinutes ?? "still open"} min / ${e.answer ?? e.status}: ${e.what}`);
  }
  return lines.join("\n");
}
