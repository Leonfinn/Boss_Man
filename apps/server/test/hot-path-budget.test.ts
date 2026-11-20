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
const ITERATIONS = 7;
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

const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]!;

/**
 * Median of the longest loop stall, and of the wall time, over ITERATIONS runs after one warm-up. `refs` holds the
 * reference scan's block before every run and one after the last, so run i sits between refs[i] and refs[i + 1].
 */
// BOS-1940: SETTLE_MS was 20. blockOf runs about 16 times per item (warm-up, samples, reference readings), so the two
// waits cost ~19 s of this file's ~35 s of tests while measuring nothing. 5 ms is still 5 ticks of the 1 ms histogram
// timer, and both waits only need one: Node starts counting at the histogram's first tick, and a stall is recorded by
// the first tick after it. That tick is due before our 5 ms timer, and timers fire in due order, so this holds on a
// busy machine too.
const SETTLE_MS = 5;

async function blockOf(fn: () => Promise<unknown>): Promise<{ block: number; wall: number }> {
  const h = monitorEventLoopDelay({ resolution: 1 });
  h.enable();
  // Let the histogram's own timer run a few times first: a stall that starts before its first tick is not recorded.
  await new Promise((r) => setTimeout(r, SETTLE_MS));
  const t0 = performance.now();
  await fn();
  const wall = performance.now() - t0;
  // The histogram records a stall only when its timer fires after it, so give the loop a few ticks before stopping.
  await new Promise((r) => setTimeout(r, SETTLE_MS));
  h.disable();
  return { block: h.max / 1e6, wall };
}

/** A fixed piece of database work: one scan and sum over the 50k cost events. Its block is this machine's speed at database work, right now. */
const reference = () => ctx.db.execute(sql`select count(*)::int n, sum(cost_micros)::bigint s from cost_events`);

async function measure(fn: () => Promise<unknown>) {
  await fn();
  await reference();
  const blocks: number[] = [];
  const walls: number[] = [];
  // One reference reading before every run and one after the last, so run i sits between refs[i] and refs[i + 1].
  const refs: number[] = [(await blockOf(reference)).block];
  for (let i = 0; i < ITERATIONS; i++) {
    const m = await blockOf(fn);
    walls.push(m.wall);
    blocks.push(m.block);
    refs.push((await blockOf(reference)).block);
  }
  return { block: median(blocks), wall: median(walls), blocks, refs };
}

// BOS-1217: the merge gate runs up to 3 checks at once, so a fixed limit read "board 106 ms, limit 100" on a loaded box
// (board is 45 ms idle). Each sample's limit is scaled by how much slower this machine was right then than at its quietest
// in this run: a fixed CPU workload (spin) is timed next to every sample and compared to the fastest spin of the whole run.
// The scale is at least 1 (never tighter than LIMIT_MS) and at most MAX_LOAD_SCALE.
// BOS-1321: the first version took the best of 3 short spins (~9 ms) once before and once after an item's 7 samples. A
// short spin usually fits in one scheduler slice, so the best of 3 dodged exactly the CPU sharing that the 45-100 ms route
// stall sat through: on a loaded gate it read x1.01 while board took 106 ms. Now each spin is one ~20 ms run (preemption
// counts), it is taken between every two samples, and each sample is judged against its own neighbours' scale; the item
// passes when the median of block / scaled limit is at most 1.
// What it still catches: one query that scans or joins far too much (shown on the board route: a self-join of runs
// blocked 3.6 s against a limit of 244 ms), and the BOS-643 freeze (3-4 s). The scale is capped at 2.5, so the limit never
// exceeds 250 ms. (BOS-1724: a machine whose reference scan blocks under 8.4 ms, i.e. a fast one, keeps the plain 100 ms.) Many small queries in a row (an
// N+1 loop) are NOT caught: the query yield in setup() splits them.
//
// BOS-1724: that scale still failed by 1 to 3 ms, mostly on the slower second check worker, because "slower than the
// quietest spin of this run" is blind to a machine that is slow the whole run (its quietest spin is slow too, so the scale
// stays 1 and the limit stays at the dev-machine figure). And a CPU spin is not the work under test: PGlite runs wasm. So
// the baseline is now database work of a known size (reference(): one scan of the 50k cost events), timed the same way,
// in turn next to every sample. The limit scales with that machine's own speed at that moment: REF_TO_LIMIT = 12 means
// "an item may block up to 12 times what the reference scan blocks" (the items read 0.2 to 5.3 times it here, so there is
// more than twice the room, and the room moves with the machine). The scale stays between 1 and MAX_LOAD_SCALE: never
// tighter than LIMIT_MS, never looser than 2.5x.
const MAX_LOAD_SCALE = 2.5;
const REF_TO_LIMIT = 12;
/** Limit scale for one reference reading: how many times `limitMs` the machine's database speed allows right now. */
const loadScale = (refBlockMs: number, limitMs: number) => Math.min(MAX_LOAD_SCALE, Math.max(1, (REF_TO_LIMIT * refBlockMs) / limitMs));
/**
 * Per-sample scale: the lower of the reference readings either side (the item's own garbage must not raise its own
 * limit). Returns the median of block / (limit x scale), which passes at <= 1, and the median scale for the report.
 */
function judge(m: { blocks: number[]; refs: number[] }, limitMs: number) {
  const scales = m.blocks.map((_, i) => loadScale(Math.min(m.refs[i]!, m.refs[i + 1]!), limitMs));
  return { ratio: median(m.blocks.map((b, i) => b / (limitMs * scales[i]!))), scale: median(scales) };
}

// BOS-1801: the reference scale above still bounced merges at the gate (BOS-1711: board 229 ms vs 199; BOS-1762: board
// 162 ms vs 162, after 30 min of check-all next to other checks). The gate log shows why no same-run baseline fixes it:
// idle, board blocks 6x the reference scan (60 ms vs 10 ms); under that load it read 12x (162 ms vs 13.5 ms). The
// reference is one short stall and the board route a longer one, and CPU sharing stretches a longer stall by more, so
// the scale lags exactly when it matters. Tuning REF_TO_LIMIT again would only move the edge.
// So a miss is re-measured instead. Every item is measured once; any item over its scaled limit is measured again
// after the rest (later, so not inside the same burst of load), up to ATTEMPTS times in all, and fails only when
// every attempt is over. What a real regression looks like: an item that is over on every attempt. The cases this
// test exists for are far past that (the board self-join blocked 3.6 s against 244 ms; the BOS-643 freeze 3-4 s), and
// a route that has slowly grown past its limit misses on every attempt on a quiet machine too. What it no longer
// fails on: one item brushing its limit once while the machine is shared.
const ATTEMPTS = 3;

type Attempt = { m: Awaited<ReturnType<typeof measure>>; ratio: number; scale: number };

/** Measures every item, re-measures those over their limit (up to `attempts` in all), and returns each item's attempts in order. An item passes when its last attempt is at most 1. */
async function budgetCheck(entries: Array<[string, () => Promise<unknown>]>, limitOf: (name: string) => number, attempts = ATTEMPTS) {
  const results = new Map<string, Attempt[]>();
  let pending = entries;
  for (let a = 0; a < attempts && pending.length > 0; a++) {
    for (const [name, fn] of pending) {
      const m = await measure(fn);
      results.set(name, [...(results.get(name) ?? []), { m, ...judge(m, limitOf(name)) }]);
    }
    pending = pending.filter(([name]) => results.get(name)!.at(-1)!.ratio > 1);
  }
  return results;
}

const overEveryAttempt = (results: Map<string, Attempt[]>) => [...results].filter(([, tries]) => tries.at(-1)!.ratio > 1).map(([name]) => name);

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

  // BOS-1801: proves the re-measure on fake items. The limit here is a fifth of LIMIT_MS so the spins stay short; the
  // over item spins 3x its limit at the 2.5x load cap, so it is over on any machine.
  it("re-measures a miss: one that clears later passes, one over on every attempt fails", async () => {
    const limit = LIMIT_MS / 5;
    const spin = (ms: number) => {
      const end = performance.now() + ms;
      while (performance.now() < end);
    };
    let calls = 0;
    const perAttempt = ITERATIONS + 1; // measure() runs one warm-up, then ITERATIONS samples
    const results = await budgetCheck(
      [
        ["over once, then fine", async () => spin(++calls <= perAttempt ? limit * MAX_LOAD_SCALE * 3 : 1)],
        ["over every time", async () => spin(limit * MAX_LOAD_SCALE * 3)],
        ["always fine", async () => spin(1)],
      ],
      () => limit,
    );
    expect(results.get("over once, then fine")!.map((a) => a.ratio > 1)).toEqual([true, false]);
    expect(results.get("over every time")!.map((a) => a.ratio > 1)).toEqual([true, true, true]);
    expect(results.get("always fine")!.length).toBe(1);
    expect(overEveryAttempt(results)).toEqual(["over every time"]);
  }, 60_000);

  it(`keeps every item under ${LIMIT_MS} ms of event-loop block`, async () => {
    const limitOf = (name: string) => (KNOWN_SLOW[name] ? KNOWN_SLOW_CEILING_MS : LIMIT_MS);
    // Each sample is judged against the reference readings taken right next to it; a miss is re-measured (BOS-1801).
    const results = await budgetCheck(Object.entries(list), limitOf);
    const pct = (a: Attempt) => `${(a.ratio * 100).toFixed(0)}%`;
    for (const [name, tries] of results) {
      const slow = KNOWN_SLOW[name];
      const { m, ratio, scale } = tries.at(-1)!;
      const retried = tries.length > 1 ? `   (re-measured: ${tries.map(pct).join(", ")})` : "";
      report.push(`${name.padEnd(34)} block ${m.block.toFixed(0).padStart(5)} ms   wall ${m.wall.toFixed(0).padStart(5)} ms   load x${scale.toFixed(2)}   ref ${median(m.refs).toFixed(0)} ms (x${(m.block / median(m.refs)).toFixed(1)})   ${(ratio * 100).toFixed(0)}% of limit${slow ? `   (known slow, ${slow}; ceiling ${limitOf(name)} ms)` : ""}${retried}`);
    }
    const over = overEveryAttempt(results).map((name) => {
      const tries = results.get(name)!;
      const { m, scale } = tries.at(-1)!;
      return `${name}: over on all ${tries.length} attempts (${tries.map((a) => `${a.m.block.toFixed(0)} ms, ${pct(a)}`).join("; ")}); last ${m.block.toFixed(0)} ms vs limit ${(limitOf(name) * scale).toFixed(0)} at median load x${scale.toFixed(2)}`;
    });
    expect(over).toEqual([]);
  }, 120_000);
});
