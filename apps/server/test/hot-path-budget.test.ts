// BOS-653: every background pass, polled route and runner-event handler stays under 100 ms of event-loop
// block at realistic data size (20k runs, 50k cost events, 2k decisions, 1k tickets).
//
// Why: the dateIn freeze (BOS-643) was an O(rows x days) loop that no test caught, because tests use tiny data.
//
// How a block is measured, and why this isn't flaky on a busy runner:
// - Each item runs ITERATIONS times after one warm-up. Each run gets its own monitorEventLoopDelay histogram
//   (1 ms resolution); its `max` is the longest single stall of the loop during that run.
// - The assertion is on the MEDIAN of those maxima, so one slow run (a busy CPU, a GC pause) can't fail it, but
//   an item that blocks every time does. The limit is 100 ms; the BOS-643 loop took 3-4 s.
// - PGlite runs the database inside this process, so database time counts as block here. Real Postgres is a
//   separate process, so this is the stricter reading: an item that passes here is safe on the live server.
// - Items that block over the limit today are listed in KNOWN_SLOW with the follow-up ticket and skipped.
//
// Set BOSSMAN_HOT_PATH_REPORT=1 to print each item's median block and median wall time.
import { monitorEventLoopDelay } from "node:perf_hooks";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RunnerEvent } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { runners } from "../src/db/schema.js";
import { pruneRunnerEvents } from "../src/services/housekeeping.js";

// 100 ms on the owner's host and at the merge gate. GitHub's shared runners read 2.5-5x slower (funding status 121 ms and
// recent runs 127 ms there, 49 ms and 25 ms on a dev machine; board is 45 ms here), so CI gets 300 ms: still a tenth of
// the 3-4 s freeze this test exists for.
const LIMIT_MS = process.env.GITHUB_ACTIONS === "true" ? 300 : 100;
const ITERATIONS = 5;
const COUNTS = { runs: 20_000, costEvents: 50_000, decisions: 2_000, tickets: 1_000 };

/** Looser ceiling for KNOWN_SLOW items: still catches a real regression (the BOS-643 dateIn loop blocked 3-4 s). Removing the entry tightens the item to LIMIT_MS. */
const KNOWN_SLOW_CEILING_MS = 1000;

/** Items that fail the budget today: name -> follow-up ticket. Held to KNOWN_SLOW_CEILING_MS instead of LIMIT_MS. */
const KNOWN_SLOW: Record<string, string> = {
  // Three heavy reads (tickets by created_at 66 ms, latest run per agent 38 ms, token sums 34 ms): 100-115 ms.
  "route: dashboard": "BOS-672",
};

let ctx: Awaited<ReturnType<typeof setup>>;

async function setup() {
  const { db, close } = await openPglite();
  // PGlite answers a query through promise steps only, so a pass that makes hundreds of queries in a row never lets the
  // loop's timers run, which a real database connection (a socket round trip per query) always does. Yield once per
  // query so a pass of many small queries isn't counted as one long block. Database time inside one query still counts.
  const client = (db as unknown as { $client: { query: (...a: unknown[]) => Promise<unknown> } }).$client;
  const query = client.query.bind(client);
  client.query = async (...a: unknown[]) => {
    await new Promise((r) => setImmediate(r));
    return query(...a);
  };
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company } = (await req("POST", "/api/companies", { name: "Big Co" })).json() as { company: { id: string } };
  for (let i = 0; i < 12; i++) await req("POST", `/api/companies/${company.id}/agents`, { name: `Worker ${i}` });
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Site" })).json() as { id: string };
  const source = (await req("POST", "/api/funding-sources", { name: "Claude Max", kind: "subscription", provider: "anthropic" })).json() as { id: string };
  const reg = (await req("POST", `/api/companies/${company.id}/runner`)).json() as { runnerId: string };
  const [runner] = await db.select().from(runners);
  return { ...built, db, close, req, company, project, source, runner: runner!, reg };
}

/** Runs `;`-separated statements one at a time (a prepared statement takes only one). */
async function q(c: { db: { execute: (s: ReturnType<typeof sql.raw>) => Promise<unknown> } }, text: string) {
  for (const stmt of text.split(";")) if (stmt.trim()) await c.db.execute(sql.raw(stmt));
}

/** Fills the NOT NULL columns that have no default, generically, so the seed survives schema changes. */
async function fill(table: string, fixed: Record<string, string>, count: number) {
  const res = (await ctx.db.execute(sql`select column_name, data_type, udt_name from information_schema.columns where table_name = ${table} and is_nullable = 'NO' and column_default is null`)) as unknown as { rows: Array<{ column_name: string; data_type: string; udt_name: string }> };
  const names: string[] = [];
  const vals: string[] = [];
  for (const c of res.rows) {
    if (c.column_name in fixed) continue;
    names.push(`"${c.column_name}"`);
    let v: string;
    if (c.data_type === "uuid") v = "gen_random_uuid()";
    else if (c.data_type.startsWith("timestamp")) v = "now() - (g || ' seconds')::interval";
    else if (["integer", "bigint", "numeric", "real", "double precision"].includes(c.data_type)) v = "g";
    else if (c.data_type === "boolean") v = "false";
    else if (c.data_type === "jsonb" || c.data_type === "json") v = "'{}'::jsonb";
    else if (c.data_type === "USER-DEFINED") v = `(enum_range(null::"${c.udt_name}"))[1]`;
    else if (c.data_type === "ARRAY") v = "'{}'";
    else v = "'x' || g";
    vals.push(v);
  }
  for (const [k, v] of Object.entries(fixed)) {
    names.push(`"${k}"`);
    vals.push(v);
  }
  await q(ctx, `insert into "${table}" (${names.join(",")}) select ${vals.join(",")} from generate_series(1, ${count}) g`);
}

async function seed() {
  const co = `'${ctx.company.id}'`;
  await q(ctx, `create temp table ag as select id, row_number() over () rn from agents where company_id = ${co}`);
  const nAgents = ((await ctx.db.execute(sql`select count(*)::int n from ag`)) as unknown as { rows: Array<{ n: number }> }).rows[0]!.n;
  await fill("tickets", { company_id: co, project_id: `'${ctx.project.id}'`, number: "1000 + g", system_state: `(case when g % 10 = 0 then 'in_progress' when g % 10 = 1 then 'review' else 'done' end)::system_state` }, COUNTS.tickets);
  await q(ctx, `create temp table tk as select id, row_number() over () rn from tickets; create index on tk(rn); create index on ag(rn)`);
  const nTickets = COUNTS.tickets;
  await fill(
    "runs",
    {
      company_id: co,
      agent_id: `(select id from ag where rn = 1 + g % ${nAgents})`,
      ticket_id: `(select id from tk where rn = 1 + g % ${nTickets})`,
      started_at: "now() - (g * 2 || ' minutes')::interval",
      ended_at: "(case when g <= 5 then null else now() - (g * 2 || ' minutes')::interval + interval '5 minutes' end)",
      last_event_at: "now() - (g * 2 || ' minutes')::interval",
    },
    COUNTS.runs,
  );
  await q(ctx, `create temp table rn as select id, row_number() over () n from runs; create index on rn(n)`);
  await fill(
    "cost_events",
    {
      company_id: co,
      funding_source_id: `'${ctx.source.id}'`,
      run_id: `(select id from rn where n = 1 + g % ${COUNTS.runs})`,
      agent_id: `(select id from ag where rn = 1 + g % ${nAgents})`,
      occurred_at: "now() - (g * 100 || ' seconds')::interval",
      cost_micros: "10000 + g % 5000",
    },
    COUNTS.costEvents,
  );
  await fill("decisions", { company_id: co, status: `(case when g % 50 = 0 then 'open' else 'answered' end)::decision_status` }, COUNTS.decisions);
  await q(ctx, "analyze");
}

/** Median of the longest loop stall, and of the wall time, over ITERATIONS runs after one warm-up. */
async function measure(fn: () => Promise<unknown>) {
  await fn();
  const blocks: number[] = [];
  const walls: number[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const h = monitorEventLoopDelay({ resolution: 1 });
    h.enable();
    // Let the histogram's own timer run a few times first: a stall that starts before its first tick is not recorded.
    await new Promise((r) => setTimeout(r, 20));
    const t0 = performance.now();
    await fn();
    walls.push(performance.now() - t0);
    // The histogram records a stall only when its timer fires after it, so give the loop a few ticks before stopping.
    await new Promise((r) => setTimeout(r, 20));
    h.disable();
    blocks.push(h.max / 1e6);
  }
  const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]!;
  return { block: median(blocks), wall: median(walls) };
}

let seqNo = 0;
const ingest = (event: RunnerEvent) => ctx.runners.ingest(ctx.runner, { seq: ++seqNo + 1_000_000, at: new Date().toISOString(), event });

function items(): Record<string, () => Promise<unknown>> {
  const get = (url: string) => async () => {
    const r = await ctx.req("GET", url);
    if (r.statusCode >= 400) throw new Error(`${url} -> ${r.statusCode} ${r.body.slice(0, 200)}`);
  };
  const cid = ctx.company.id;
  return {
    // background passes (main.ts)
    "pass: scheduler tick": () => ctx.scheduler.tick(),
    "pass: watch and monitor": () => ctx.scheduler.slow(),
    "pass: notification sync": () => ctx.notes.syncDecisions(),
    "pass: sweep": () => ctx.sweeps.run(),
    "pass: notification read sweep": () => ctx.notes.markAnsweredRead(),
    "pass: watchdog": () => ctx.watchdog.run(),
    "pass: retro": () => ctx.retro.sweep(),
    "pass: alert ladder": () => ctx.alerts.sweep(),
    "pass: pull request sync": () => ctx.review.syncPullRequests(),
    "pass: self-deploy sync": () => ctx.selfDeploy.sync(),
    "pass: drain step": () => ctx.maintenance.step(),
    "pass: check queue": () => ctx.checks.sweep(),
    "pass: runner events prune": () => pruneRunnerEvents(ctx.db, { days: 60 }),
    // routes the web polls
    "route: funding status": get(`/api/funding-sources/${ctx.source.id}/status`),
    "route: funding sources": get("/api/funding-sources"),
    "route: budgets": get("/api/budgets"),
    "route: decisions": get("/api/decisions"),
    "route: board": get(`/api/projects/${ctx.project.id}/board`),
    "route: dashboard": get(`/api/companies/${cid}/dashboard`),
    "route: notifications": get("/api/notifications"),
    "route: live runs": get("/api/runs"),
    "route: recent runs": get("/api/runs/recent"),
    // runner-event handlers
    "event: run.cost": () => ingest({ type: "run.cost", runId: crypto.randomUUID(), fundingSourceId: ctx.source.id, costMicrosDelta: 1234, model: "claude-sonnet" }),
    "event: run.quota": () =>
      ingest({
        type: "run.quota",
        fundingSourceId: ctx.source.id,
        claudeMeta: { "_claude/rateLimit": { rateLimitType: "seven_day", unifiedWindows: { five_hour: { utilization: 0.1, resetsAt: 1792177800 }, seven_day: { utilization: 0.4, resetsAt: 1792245600 } } } },
      }),
  };
}

describe("hot-path budget (BOS-653)", () => {
  let list: Record<string, () => Promise<unknown>>;
  const report: string[] = [];
  beforeAll(async () => {
    ctx = await setup();
    await seed();
    list = items();
  }, 120_000);
  afterAll(async () => {
    if (process.env.BOSSMAN_HOT_PATH_REPORT) process.stderr.write(`\nhot-path budget (median of ${ITERATIONS}; block = longest loop stall, wall = time taken)\n${report.join("\n")}\n`);
    await ctx?.app.close();
    await ctx?.close();
  });

  it("seeds the realistic size", async () => {
    const n = async (t: string) => ((await ctx.db.execute(sql.raw(`select count(*)::int n from ${t}`))) as unknown as { rows: Array<{ n: number }> }).rows[0]!.n;
    expect(await n("runs")).toBeGreaterThanOrEqual(COUNTS.runs);
    expect(await n("cost_events")).toBeGreaterThanOrEqual(COUNTS.costEvents);
    expect(await n("decisions")).toBeGreaterThanOrEqual(COUNTS.decisions);
    expect(await n("tickets")).toBeGreaterThanOrEqual(COUNTS.tickets);
  });

  // Proves the meter sees a block like the dateIn freeze (BOS-643): a loop 2.5x the limit (250 ms here) must read as over it,
  // and the same work split into 5 ms slices that yield must not.
  it("the meter catches a loop that blocks and passes one that yields", async () => {
    const spin = (ms: number) => {
      const end = performance.now() + ms;
      while (performance.now() < end);
    };
    const blocking = await measure(async () => spin(LIMIT_MS * 2.5));
    expect(blocking.block).toBeGreaterThan(LIMIT_MS);
    const yielding = await measure(async () => {
      for (let i = 0; i < 50; i++) {
        spin(5);
        await new Promise((r) => setImmediate(r));
      }
    });
    expect(yielding.block).toBeLessThan(LIMIT_MS);
  });

  it(`keeps every item under ${LIMIT_MS} ms of event-loop block`, async () => {
    const over: string[] = [];
    for (const [name, fn] of Object.entries(list)) {
      const slow = KNOWN_SLOW[name];
      const limit = slow ? KNOWN_SLOW_CEILING_MS : LIMIT_MS;
      const m = await measure(fn);
      report.push(`${name.padEnd(34)} block ${m.block.toFixed(0).padStart(5)} ms   wall ${m.wall.toFixed(0).padStart(5)} ms${slow ? `   (known slow, ${slow}; ceiling ${limit} ms)` : ""}`);
      if (m.block > limit) over.push(`${name}: ${m.block.toFixed(0)} ms (limit ${limit})`);
    }
    expect(over).toEqual([]);
  }, 90_000);
});
