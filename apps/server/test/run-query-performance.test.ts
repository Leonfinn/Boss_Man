// The Dashboard's latest-run-per-agent query and the indexes behind the hot reads (BOS-407). The
// rewrite must return exactly the rows the old DISTINCT ON over every run returned, while the
// origin subqueries run only on the chosen rows; and the index migration must be the thing the
// planner picks for each query it was added for.
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { desc, eq, gte, inArray, isNull, lte, isNotNull, and, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { PgDialect } from "drizzle-orm/pg-core";
import { PGlite } from "@electric-sql/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "../src/db/schema.js";
import { agents, checkJobs, checkResults, decisions, notifications, nudges, reviewRequests, runs, ticketDependencies, tickets, wakes } from "../src/db/schema.js";
import { migrationsFolder } from "../src/db/client.js";
import { runOriginQuery } from "../src/services/runs.js";
import { mergeQueueQueries } from "../src/services/merge-queue.js";

type Db = ReturnType<typeof drizzle<typeof schema>>;
let ctx: { db: Db; client: PGlite; close: () => Promise<void> } | undefined;
afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

async function setup() {
  const client = new PGlite({ extensions: { vector: (await import("@electric-sql/pglite-pgvector")).vector } });
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder });
  const close = async () => client.close();
  ctx = { db, client, close };
  return ctx;
}

const ts = (minutes: number) => new Date(Date.now() - minutes * 60_000);

/** Company, agents and a couple of tickets, enough to hang runs and decisions off. */
async function world(c: NonNullable<typeof ctx>) {
  const [company] = await c.db.insert(schema.companies).values({ name: "App Co" }).returning();
  const [ceo] = await c.db.insert(agents).values({ companyId: company!.id, name: "CEO", role: "ceo", agentKind: "claude" }).returning();
  const [worker] = await c.db.insert(agents).values({ companyId: company!.id, name: "Engineer", role: "worker", agentKind: "claude" }).returning();
  const [project] = await c.db.insert(schema.projects).values({ companyId: company!.id, name: "Site" }).returning();
  const [ticket] = await c.db.insert(tickets).values({ companyId: company!.id, projectId: project!.id, number: 1, title: "Fix login" }).returning();
  return { company: company!, ceo: ceo!, worker: worker!, project: project!, ticket: ticket! };
}

/** How the Dashboard picks each agent's latest run now (BOS-407): the run first, then its origin. */
function newLatest(db: Db, agentIds: string[]) {
  const latest = db.selectDistinctOn([runs.agentId]).from(runs).where(inArray(runs.agentId, agentIds)).orderBy(runs.agentId, desc(runs.startedAt)).as("latest");
  return db
    .select({ agentId: latest.agentId, id: latest.id, ticketId: latest.ticketId, ticket: tickets.title, purpose: latest.purpose, startedAt: latest.startedAt, endedAt: latest.endedAt, outcome: latest.outcome, ...runOriginQuery("latest") })
    .from(latest)
    .leftJoin(tickets, eq(tickets.id, latest.ticketId));
}

/** How it did it before (BOS-407): DISTINCT ON over every run, origin computed on every row. */
function oldLatest(db: Db, agentIds: string[]) {
  return db
    .selectDistinctOn([runs.agentId], { agentId: runs.agentId, id: runs.id, ticketId: runs.ticketId, ticket: tickets.title, purpose: runs.purpose, startedAt: runs.startedAt, endedAt: runs.endedAt, outcome: runs.outcome, ...runOriginQuery("runs") })
    .from(runs)
    .leftJoin(tickets, eq(tickets.id, runs.ticketId))
    .where(inArray(runs.agentId, agentIds))
    .orderBy(runs.agentId, desc(runs.startedAt));
}

const plain = (rows: Array<Record<string, unknown>>) =>
  rows.map((r) => JSON.stringify(Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v instanceof Date ? v.toISOString() : v])))).sort();

/** EXPLAIN of a drizzle query, as the PostgreSQL dialect would send it. */
async function explain(c: NonNullable<typeof ctx>, q: { toSQL: () => { sql: string; params: unknown[] } }) {
  const { sql: text, params } = q.toSQL();
  const rows = (await c.client.query(`explain ${text}`, params)).rows as Array<Record<string, string>>;
  return rows.map((r) => Object.values(r)[0]!).join("\n");
}

describe("the Dashboard's latest run per agent (BOS-407)", () => {
  it("returns exactly the rows the old query did", async () => {
    const c = await setup();
    const w = await world(c);
    const ids = [w.worker.id, w.ceo.id];
    for (const [i, agentId] of ids.entries()) {
      // Several runs each, the newest one ticketless and nudged, so the origin columns have to say
      // who nudged, why and which wake brought it. The second agent's newest run has no nudge, so
      // its origin must come out empty just as it did before.
      for (let n = 0; n < 4; n++) {
        const [run] = await c.db
          .insert(runs)
          .values({ companyId: w.company.id, agentId, ticketId: n === 0 ? w.ticket.id : null, purpose: `p${n}`, origin: n === 3 ? "nudge" : null, startedAt: ts(i * 100 + n), endedAt: n === 3 ? null : ts(i * 100 + n - 1) })
          .returning({ id: runs.id });
        if (n === 2 || (i === 0 && n === 3)) {
          const [wake] = await c.db.insert(wakes).values({ companyId: w.company.id, agentId, reason: "nudge", priority: 1, note: `note for ${i}-${n}` }).returning({ id: wakes.id });
          await c.db.insert(nudges).values({ companyId: w.company.id, fromAgentId: w.ceo.id, toAgentId: agentId, wakeId: wake!.id, why: `why ${i}-${n}` });
        }
      }
    }
    // The worker's newest run is ticketless with a run_ticket_id, and a wake (with the nudge that
    // delivered it) points at it, so every origin column has a value.
    const [wake] = await c.db.insert(wakes).values({ companyId: w.company.id, agentId: w.worker.id, reason: "nudge", priority: 1, note: "note for newest" }).returning({ id: wakes.id });
    const [newest] = await c.db.insert(runs).values({ companyId: w.company.id, agentId: w.worker.id, startedAt: new Date(Date.now() + 60_000), runTicketId: w.ticket.id, origin: "nudge" }).returning({ id: runs.id });
    await c.db.update(wakes).set({ runId: newest!.id }).where(eq(wakes.id, wake!.id));
    await c.db.insert(nudges).values({ companyId: w.company.id, fromAgentId: w.ceo.id, toAgentId: w.worker.id, wakeId: wake!.id, why: "why newest" });
    const before = plain((await oldLatest(c.db, ids)) as unknown as Array<Record<string, unknown>>);
    const after = plain((await newLatest(c.db, ids)) as unknown as Array<Record<string, unknown>>);
    expect(after).toHaveLength(2);
    expect(after).toEqual(before);
    const byAgent = new Map(after.map((r) => { const j = JSON.parse(r); return [j.agentId, j]; }));
    expect(byAgent.get(w.worker.id)).toMatchObject({ origin: "nudge", originFrom: "CEO", originNote: "why newest", wakeNote: "note for newest", runTicketId: w.ticket.id });
    expect(byAgent.get(w.ceo.id)).toMatchObject({ origin: null, originFrom: null, originNote: null, wakeNote: null });
  });

  it("keeps the origin lookup on the chosen rows only, never on the runs table itself", async () => {
    const c = await setup();
    const w = await world(c);
    for (let n = 0; n < 5; n++) await c.db.insert(runs).values({ companyId: w.company.id, agentId: w.worker.id, startedAt: ts(n) });
    expect(await newLatest(c.db, [w.worker.id])).toHaveLength(1);
    const plan = await explain(c, newLatest(c.db, [w.worker.id]));
    // One latest run comes out first (Limit over the runs_agent_started index), and only then are
    // the origin subqueries asked: runs is read once, and every origin lookup starts from a wake
    // by run_id, not from a scan of runs.
    expect(plan).toMatch(/Limit/);
    expect(plan).toMatch(/runs_agent_started/);
    expect(plan.match(/on runs\b/g), plan).toHaveLength(1);
    expect(plan).toMatch(/wakes_run_id/);
  });
});

// Each index the migration adds, its definition, and one query it is for. The definition check
// proves the migration built the index where and how the ticket asked; the forced-index check
// proves PostgreSQL can and does use it for the query, and returns the same rows with and without.
type World = Awaited<ReturnType<typeof world>> & { wakeId: string; decisionId: string };

/** Every index the migration adds, its definition, and one query it is for. */
const INDEXES: Array<{ name: string; table: string; definition: string; query?: (db: Db, w: World) => { toSQL: () => { sql: string; params: unknown[] } } }> = [
  { name: "runs_live", table: "runs", definition: 'ON public.runs USING btree (company_id) WHERE (ended_at IS NULL)', query: (db, w) => db.select({ id: runs.id }).from(runs).where(and(eq(runs.companyId, w.company.id), isNull(runs.endedAt))) },
  { name: "runs_ticket_started", table: "runs", definition: 'ON public.runs USING btree (ticket_id, started_at)', query: (db, w) => db.select({ id: runs.id }).from(runs).where(eq(runs.ticketId, w.ticket.id)).orderBy(runs.startedAt) },
  { name: "runs_agent_started", table: "runs", definition: 'ON public.runs USING btree (agent_id, started_at DESC NULLS LAST)', query: (db, w) => db.select({ id: runs.id }).from(runs).where(eq(runs.agentId, w.worker.id)).orderBy(desc(runs.startedAt)) },
  { name: "runs_ended", table: "runs", definition: 'ON public.runs USING btree (ended_at DESC NULLS LAST) WHERE (ended_at IS NOT NULL)', query: (db) => db.select({ id: runs.id }).from(runs).where(isNotNull(runs.endedAt)).orderBy(desc(runs.endedAt)).limit(50) },
  { name: "nudges_wake", table: "nudges", definition: 'ON public.nudges USING btree (wake_id)', query: (db, w) => db.select({ id: nudges.id }).from(nudges).where(eq(nudges.wakeId, w.wakeId)) },
  { name: "decisions_status", table: "decisions", definition: 'ON public.decisions USING btree (status)', query: (db) => db.select({ id: decisions.id }).from(decisions).where(eq(decisions.status, "open")) },
  { name: "ticket_dependencies_blocked", table: "ticket_dependencies", definition: 'ON public.ticket_dependencies USING btree (blocked_ticket_id)', query: (db, w) => db.select({ id: ticketDependencies.id }).from(ticketDependencies).where(eq(ticketDependencies.blockedTicketId, w.ticket.id)) },
  { name: "ticket_dependencies_blocker", table: "ticket_dependencies", definition: 'ON public.ticket_dependencies USING btree (blocker_ticket_id)', query: (db, w) => db.select({ id: ticketDependencies.id }).from(ticketDependencies).where(eq(ticketDependencies.blockerTicketId, w.ticket.id)) },
  { name: "tickets_watcher", table: "tickets", definition: 'ON public.tickets USING btree (watcher_agent_id) WHERE (watcher_agent_id IS NOT NULL)', query: (db) => db.select({ id: tickets.id }).from(tickets).where(sql`${tickets.watcherAgentId} is not null`) },
  { name: "tickets_monitor_at", table: "tickets", definition: 'ON public.tickets USING btree (monitor_at) WHERE (monitor_at IS NOT NULL)', query: (db) => db.select({ id: tickets.id }).from(tickets).where(lte(tickets.monitorAt, new Date())) },
  { name: "notifications_unread_decision", table: "notifications", definition: 'ON public.notifications USING btree (decision_id) WHERE (read_at IS NULL)', query: (db, w) => db.select({ id: notifications.id }).from(notifications).where(and(isNull(notifications.readAt), eq(notifications.decisionId, w.decisionId))) },
  // The merge queue's recently-failed-checks read (BOS-587, migration 0105): its own query, by company and time.
  { name: "check_results_company_at", table: "check_results", definition: 'ON public.check_results USING btree (company_id, at)', query: (db, w) => db.select({ id: checkResults.id }).from(checkResults).where(and(eq(checkResults.companyId, w.company.id), gte(checkResults.at, ts(7 * 24 * 60)))) },
];

describe("the indexes the BOS-407 migration adds", () => {
  it("are in the schema where the ticket asked, and each is usable for its query", async () => {
    const c = await setup();
    const w = await world(c);
    // Enough rows that a sequential scan is the wrong plan, and statistics for the planner.
    const N = 300;
    const n2 = Array.from({ length: N }, (_, n) => n);
    await c.db.insert(runs).values(n2.map((n) => ({ companyId: w.company.id, agentId: n % 3 === 0 ? w.worker.id : w.ceo.id, ticketId: n % 5 === 0 ? w.ticket.id : null, startedAt: ts(n), endedAt: n % 2 === 0 ? ts(n - 1) : null })));
    await c.db.insert(tickets).values(n2.map((n) => ({ companyId: w.company.id, projectId: w.project.id, number: n + 2, title: `T${n}`, ...(n % 5 === 0 ? { watcherAgentId: w.worker.id } : {}), ...(n % 7 === 0 ? { monitorAt: ts(-1) } : {}) })));
    const decs = await c.db.insert(decisions).values(n2.map((n) => ({ companyId: w.company.id, kind: "question" as const, question: `Q${n}`, recommendedOption: "A", status: n % 10 === 0 ? ("open" as const) : ("answered" as const) }))).returning({ id: decisions.id });
    const decIds = decs.map((d) => d.id);
    await c.db.insert(ticketDependencies).values(n2.map(() => ({ blockedTicketId: w.ticket.id, blockerTicketId: w.ticket.id })));
    const [wake] = await c.db.insert(wakes).values({ companyId: w.company.id, agentId: w.worker.id, reason: "nudge", priority: 1, note: "n" }).returning({ id: wakes.id });
    for (let n = 0; n < 40; n++) await c.db.insert(nudges).values({ companyId: w.company.id, fromAgentId: w.ceo.id, toAgentId: w.worker.id, wakeId: wake!.id, why: `w${n}` });
    const [dec] = await c.db.insert(decisions).values({ companyId: w.company.id, kind: "question", question: "Unread?", recommendedOption: "A" }).returning({ id: decisions.id });
    decIds.push(dec!.id);
    // One unread note per decision in play (the column is unique per decision), plus a few read ones.
    await c.db.insert(notifications).values([
      ...n2.filter((n) => n % 3 === 0).map((n) => ({ companyId: w.company.id, requested: "note" as const, level: "note" as const, title: `Card ${n}`, link: "#/tickets", decisionId: decIds[n % decIds.length]! })),
      ...n2.slice(0, 50).map((n) => ({ companyId: w.company.id, requested: "note" as const, level: "note" as const, title: `Read ${n}`, link: "#/tickets", readAt: ts(n) })),
    ]);
    const world2 = { ...w, wakeId: wake!.id, decisionId: dec!.id };
    await c.client.exec("analyze");

    for (const ix of INDEXES) {
      const [{ indexdef } = { indexdef: "" }] = (await c.client.query("select indexdef from pg_indexes where indexname = $1", [ix.name])).rows as Array<{ indexdef: string }>;
      expect(indexdef, ix.name).toContain(ix.definition);
      if (!ix.query) continue;
      const q = ix.query(c.db, world2);
      const { sql: text, params } = q.toSQL();
      const answer = (await c.client.query(text, params)).rows.map((r) => JSON.stringify(r)).sort();
      // With sequential and bitmap scans ruled out, PostgreSQL must reach for exactly this index
      // by a plain index scan; it cannot fall back to another index the same way.
      await c.client.exec("set enable_seqscan = off; set enable_bitmapscan = off");
      const plan = (await c.client.query(`explain ${text}`, params)).rows.map((r) => String(Object.values(r as Record<string, unknown>)[0])).join("\n");
      const pinned = (await c.client.query(text, params)).rows.map((r) => JSON.stringify(r)).sort();
      await c.client.exec("reset enable_seqscan; reset enable_bitmapscan");
      expect(plan, ix.name).toMatch(new RegExp(ix.name));
      // ...and it must not change the answer.
      expect(pinned, ix.name).toEqual(answer);
    }
  });
});

// The decisions table's per-poll reads (BOS-546). Every hot one names the company as well as the
// status: the Dashboard's waiting count, the brief's "Needs you" list and the queue. `decisions_status`
// alone served them until BOS-546, when decisions became the biggest full-scan source left after
// BOS-407. More than one company is seeded, so a plan that ignored company_id would show up.
describe("the indexes behind the decisions reads (BOS-546)", () => {
  /** A company with a CEO, plus one other company with its own CEO. */
  async function twoCompanies(c: NonNullable<typeof ctx>) {
    const [main] = await c.db.insert(schema.companies).values({ name: "App Co" }).returning();
    const [other] = await c.db.insert(schema.companies).values({ name: "Other Co" }).returning();
    await c.db.insert(agents).values([
      { companyId: main!.id, name: "CEO", role: "ceo", agentKind: "claude" },
      { companyId: other!.id, name: "Other CEO", role: "ceo", agentKind: "claude" },
    ]);
    return { main: main!, other: other! };
  }

  it("is in the schema as built, and both open-status reads reach for it", async () => {
    const c = await setup();
    const { main, other } = await twoCompanies(c);
    // Enough rows, and mostly settled ones, that a sequential scan is the wrong plan and a look at
    // status alone would still have to filter away most of what it found.
    const N = 600;
    const ns = Array.from({ length: N }, (_, n) => n);
    await c.db.insert(decisions).values(
      ns.map((n) => ({
        companyId: n % 7 === 0 ? other.id : main.id,
        kind: "question" as const,
        question: `Q${n}`,
        recommendedOption: "A",
        tier: n % 3 === 0 ? ("owner" as const) : ("ceo" as const),
        status: n % 20 === 0 ? ("open" as const) : ("answered" as const),
      })),
    );
    await c.client.exec("analyze");

    const [{ indexdef } = { indexdef: "" }] = (await c.client.query("select indexdef from pg_indexes where indexname = $1", ["decisions_company_status"])).rows as Array<{ indexdef: string }>;
    expect(indexdef).toContain("ON public.decisions USING btree (company_id, status)");

    // The Dashboard's waiting count and the brief's "Needs you" list, as the services write them.
    const waiting = c.db
      .select({ n: sql<number>`count(*)::int` })
      .from(decisions)
      .where(and(eq(decisions.companyId, main.id), eq(decisions.status, "open"), eq(decisions.tier, "owner")));
    const needs = c.db.select().from(decisions).where(and(eq(decisions.companyId, main.id), eq(decisions.tier, "ceo"), eq(decisions.status, "open"))).orderBy(decisions.createdAt);
    const queue = c.db.select().from(decisions).where(and(eq(decisions.companyId, main.id), eq(decisions.status, "open")));

    for (const [label, q] of [["waiting", waiting], ["needs", needs], ["queue", queue]] as const) {
      const { sql: text, params } = q.toSQL();
      // With sequential scans ruled out as the reason (PGlite has no cost to weigh here) the plan
      // must still name the composite index; the status-only `decisions_status` still exists in the
      // schema, but the planner picks the composite because it also covers company_id.
      const plan = (await c.client.query(`explain ${text}`, params)).rows.map((r) => String(Object.values(r as Record<string, unknown>)[0])).join("\n");
      expect(plan, label).toMatch(/decisions_company_status/);
      expect(plan, label).not.toMatch(/Seq Scan on decisions/);
      // ...and the read still returns rows for the main company (the index changed the plan, not the answer).
      expect((await c.client.query(text, params)).rows.length, label).toBeGreaterThan(0);
    }
  });
});

describe("the merge queue's reads (BOS-587)", () => {
  it("are plain index scans, never a whole-table scan, on a busy company", async () => {
    const c = await setup();
    const w = await world(c);
    // A busy company: many tickets in every state and thousands of check results, so a sequential
    // scan would be the cheap plan if the indexes weren't there.
    const N = 3000;
    const n2 = Array.from({ length: N }, (_, n) => n);
    await c.db.insert(tickets).values(n2.map((n) => ({ companyId: w.company.id, projectId: w.project.id, number: n + 2, title: `T${n}`, systemState: (["backlog", "ready", "in_progress", "review", "done"] as const)[n % 5]!, mergeCommit: n % 5 === 4 ? "abcdef1234" : null })));
    const rows = await c.db.select({ id: tickets.id }).from(tickets);
    await c.db.insert(checkResults).values(rows.map((r, n) => ({ companyId: w.company.id, ticketId: r.id, kind: "verify", passed: n % 4 === 0, at: ts(n) })));
    await c.db.insert(reviewRequests).values(rows.map((r, n) => ({ ticketId: r.id, kind: "code", round: 1, seq: 0, status: n % 3 === 0 ? "pending" : "approved" })));
    await c.client.exec("analyze");

    // Every read the screen makes, exactly as the service builds it. The reviews read is keyed by the
    // ticket ids the in-review read returns, so it is bounded by them and uses the ticket index.
    const since = ts(7 * 24 * 60);
    const someIds = rows.slice(0, 50).map((r) => r.id);
    for (const q of [mergeQueueQueries.inReview(c.db, w.company.id), mergeQueueQueries.recentlyDone(c.db, w.company.id, since), mergeQueueQueries.recentFailedChecks(c.db, w.company.id, since), mergeQueueQueries.latestReviews(c.db, someIds)]) {
      const { sql: text, params } = q.toSQL();
      const plan = (await c.client.query(`explain ${text}`, params)).rows.map((r) => String(Object.values(r as Record<string, unknown>)[0])).join("\n");
      // A whole-table scan on check_results, tickets or review_requests is the thing this ticket forbids.
      expect(plan, text).not.toMatch(/Seq Scan on (public\.)?check_results/);
      expect(plan, text).not.toMatch(/Seq Scan on (public\.)?tickets/);
      expect(plan, text).not.toMatch(/Seq Scan on (public\.)?review_requests/);
    }
  });

  // BOS-597: in server mode the screen also reads the company's check_jobs for its running and
  // waiting counts. check_jobs has no company index, so the read filters on the live states and
  // rides check_jobs_state_queued: it must never be a whole-table scan, nor touch tickets/projects.
  it("counts a company's live check jobs through the state index, never whole-table", async () => {
    const c = await setup();
    const w = await world(c);
    const N = 3000;
    const ns = Array.from({ length: N }, (_, n) => n);
    await c.db.insert(checkJobs).values(
      ns.map((n) => ({ companyId: w.company.id, projectId: w.project.id, ticketId: w.ticket.id, kind: "merge" as const, scope: "full" as const, commit: `${n}`.padStart(40, "0"), tree: `${n}`.padStart(40, "0"), state: (["queued", "running", "passed", "failed"] as const)[n % 4]!, queuedAt: ts(n) })),
    );
    await c.client.exec("analyze");

    const q = c.db
      .select({
        running: sql<number>`(count(*) filter (where ${checkJobs.state} = 'running'))::int`.mapWith(Number),
        waiting: sql<number>`(count(*) filter (where ${checkJobs.state} = 'queued'))::int`.mapWith(Number),
      })
      .from(checkJobs)
      .where(and(eq(checkJobs.companyId, w.company.id), inArray(checkJobs.state, ["queued", "running"])));
    const { sql: text, params } = q.toSQL();
    // The two counts share one SQL expression (the same state column), so read them through it, as
    // the service does, rather than re-reading the driver's single unnamed `count` column.
    const answer = await q;
    // With sequential and bitmap scans ruled out, the plan must name the state index, not just any index.
    await c.client.exec("set enable_seqscan = off; set enable_bitmapscan = off");
    const plan = (await c.client.query(`explain ${text}`, params)).rows.map((r) => String(Object.values(r as Record<string, unknown>)[0])).join("\n");
    await c.client.exec("reset enable_seqscan; reset enable_bitmapscan");
    expect(plan).toMatch(/Index (Only )?Scan using check_jobs_state_queued on check_jobs/);
    expect(plan).not.toMatch(/Seq Scan on (public\.)?check_jobs/);
    expect(plan).not.toMatch(/Seq Scan on (public\.)?(tickets|projects)/);
    // ...and the read still counts only this company's live jobs, one answer per state in four.
    expect(answer[0]).toMatchObject({ running: N / 4, waiting: N / 4 });
  });
});

