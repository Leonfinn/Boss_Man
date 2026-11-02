import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { RunnerCommand } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite, type Db } from "../src/db/client.js";
import { activity, agents, decisions, notifications, projects, runners, runs, tickets, wakes } from "../src/db/schema.js";
import type { Ladder } from "../src/services/alert-ladder.js";

// BOS-159: residual findings on the working-copy cleanup gate (BOS-120 adversarial rounds 4-6).
// 1. The CEO's "decision" wake for a permission card had no ticketId, so the 6-per-hour ticketless
//    limit could drop it, and the result was discarded: the request sat with nobody woken. Now the
//    wake carries the run's ticket, and a dropped wake sends the card straight to the owner.
// 2. The card claimed the deletes were "in the agent's working copy" from where the run STARTED;
//    a shell keeps its folder between commands and a cd is allowed on its own. The card and the
//    note now say what Boss Man can verify. (Covered by the updated assertions in temp-cleanup.test.ts.)
// 3. The answer path closed any OPEN decision; the alert ladder moves a card to the owner leaving
//    it open, so a CEO answering after the hop closed the owner's card. The closing update now
//    requires the tier it was read on.

let ctx: Awaited<ReturnType<typeof setup>>;
const cleanups: Array<() => Promise<void>> = [];

async function setup(dbWrap?: (db: Db) => Db) {
  let clock = new Date();
  const { db: rawDb, close } = await openPglite();
  const db = dbWrap ? dbWrap(rawDb) : rawDb;
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws", now: () => clock });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const companyId = ((await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } }).company.id;
  const dev = (await req("POST", `/api/companies/${companyId}/agents`, { name: "Senior Developer" })).json() as { id: string };
  const [ceo] = await rawDb.select().from(agents).where(and(eq(agents.companyId, companyId), eq(agents.role, "ceo")));
  const reg = (await req("POST", `/api/companies/${companyId}/runner`)).json() as { runnerId: string };
  const [runner] = await rawDb.select().from(runners).where(eq(runners.id, reg.runnerId));
  const sent: RunnerCommand[] = [];
  built.runners.connect(runner!.id, (cmd) => (sent.push(cmd), true));
  let seq = 0;
  const ask = async (command: string, opts: { ticketId?: string } = {}) => {
    const runId = randomUUID();
    const requestId = randomUUID();
    await built.runners.ingest(runner!, { seq: ++seq, at: clock.toISOString(), event: { type: "run.started", runId, agentId: dev.id, acpSessionId: "s", model: null } });
    if (opts.ticketId) {
      await rawDb.update(runs).set({ ticketId: opts.ticketId }).where(eq(runs.id, runId));
      await built.runners.ingest(runner!, { seq: ++seq, at: clock.toISOString(), event: { type: "run.workspace", runId, ticketId: opts.ticketId, branch: `bossman/${opts.ticketId}`, baseCommit: "abc123", created: false, restoredPatch: false } });
    }
    await built.runners.ingest(runner!, { seq: ++seq, at: clock.toISOString(), event: { type: "run.permission_request", runId, requestId, title: "Remove files", kind: "execute", rawInput: { command }, optionKinds: ["allow_once", "reject_once"] } });
    const [d] = await rawDb.select().from(decisions).where(eq(decisions.dedupeKey, `permission:${requestId}`));
    return { d: d ?? null, runId, requestId };
  };
  const [repo] = await rawDb.insert(projects).values({ companyId, name: "App", repoUrl: "https://example.com/app.git" }).returning();
  const [ticket] = await rawDb.insert(tickets).values({ companyId, projectId: repo!.id, title: "Probe extra spellings", systemState: "in_progress", assigneeAgentId: dev.id }).returning();
  await rawDb.delete(wakes);
  cleanups.push(async () => {
    await built.app.close();
    await close();
  });
  return { ...built, db: rawDb, companyId, dev, ceo: ceo!, runner: runner!, sent, ask, ticket: ticket!, advance: (m: number) => (clock = new Date(clock.getTime() + m * 60_000)) };
}

beforeEach(async () => {
  ctx = await setup();
});
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const reload = async (id: string) => (await ctx.db.select().from(decisions).where(eq(decisions.id, id)))[0]!;
const PROBE = "rm -f test/zz-probe.test.ts && rm -rf dist 2>/dev/null; git status";

describe("a dropped CEO wake can't leave a permission card with nobody woken (finding 1)", () => {
  it("ties the wake to the run's ticket, so the ticketless limit can't drop it", async () => {
    const { d } = await ctx.ask(PROBE, { ticketId: ctx.ticket.id });
    expect(d).toMatchObject({ tier: "ceo", status: "open" });
    const [w] = await ctx.db.select().from(wakes).where(eq(wakes.agentId, ctx.ceo.id));
    // Old code woke the CEO with no ticketId, so this wake counted against the ticketless limit.
    expect(w).toMatchObject({ reason: "decision", priority: 3, ticketId: ctx.ticket.id });
    expect(w!.status).not.toBe("dropped");
  });

  it("a wake dropped anyway sends the card straight to the owner, not to an empty rung", async () => {
    // BOS-272 made the "decision" reason exempt from the ticketless cap, and no other guard in
    // wake() can drop a run-less CEO wake, so force the drop where the scheduler records it: any
    // new "decision" wake row for the CEO is stored as dropped. This is what a refused wake looks like.
    const dropping = await setup((raw) =>
      new Proxy(raw, {
        get(t, p) {
          const v = (t as unknown as Record<PropertyKey, unknown>)[p];
          if (p !== "insert") return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
          return (table: unknown) => {
            const b = (v as (x: unknown) => { values: (x: unknown) => unknown }).call(t, table);
            if (table !== wakes) return b;
            return new Proxy(b, {
              get(bt, bp) {
                const bv = (bt as unknown as Record<PropertyKey, unknown>)[bp];
                if (bp !== "values") return typeof bv === "function" ? (bv as (...a: unknown[]) => unknown).bind(bt) : bv;
                return (vals: unknown) => {
                  const row = vals as { reason?: string; status?: string };
                  return (bt as unknown as { values: (x: unknown) => unknown }).values(row.reason === "decision" ? { ...row, status: "dropped", statusReason: "refused by the scheduler" } : vals);
                };
              },
            });
          };
        },
      }),
    );
    ctx = dropping;
    const { d } = await ctx.ask("rm -rf /tmp/bos159-cache");
    expect(d).not.toBeNull();
    const after = await reload(d!.id);
    expect(after).toMatchObject({ tier: "owner", status: "open" });
    const c = after.context as { ladder: Ladder; triedFirst?: string };
    expect(c.ladder).toMatchObject({ rung: "owner" });
    expect(c.ladder.hops.at(-1)).toMatchObject({ to: "owner" });
    expect(c.ladder.hops.at(-1)!.why).toContain("wake was dropped");
    expect(c.triedFirst).toContain("wake was dropped");
    const [w] = await ctx.db.select().from(wakes).where(and(eq(wakes.agentId, ctx.ceo.id), eq(wakes.reason, "decision")));
    expect(w).toMatchObject({ status: "dropped" });
    expect((await ctx.db.select().from(activity).where(eq(activity.kind, "watchdog"))).at(-1)!.summary).toContain("wake was dropped");
    // The owner is told now, not when the 5-minute sweep happens to run.
    await ctx.notes.syncDecisions();
    expect((await ctx.db.select().from(notifications).where(eq(notifications.decisionId, d!.id))).length).toBe(1);
    // Nobody was allowed yet: the runner still waits for the owner's verdict.
    expect(ctx.sent).toEqual([]);
  });
});

describe("the answer path can't close a card the ladder has already handed on (finding 3)", () => {
  it("a CEO answer read at the 'ceo' tier changes nothing once the card sits with the owner", async () => {
    // Arm a proxy that moves the card to the owner (as the alert ladder would) between the
    // answer reading the open card and its closing UPDATE.
    let armed = false;
    const wrapBuilder = (b: unknown, onThen: () => Promise<void>): unknown =>
      new Proxy(b as object, {
        get(t, p) {
          if (p === "then") {
            const orig = (t as PromiseLike<unknown>).then.bind(t as PromiseLike<unknown>);
            return (res?: ((v: unknown) => unknown) | null, rej?: ((e: unknown) => unknown) | null) => onThen().then(() => orig(res, rej));
          }
          const v = (t as Record<PropertyKey, unknown>)[p];
          if (typeof v === "function")
            return (...args: unknown[]) => {
              const r = (v as (...a: unknown[]) => unknown).apply(t, args);
              return r !== null && (typeof r === "object" || typeof r === "function") ? wrapBuilder(r, onThen) : r;
            };
          return v;
        },
      });
    const race = await setup((raw) => {
      return new Proxy(raw, {
        get(t, p) {
          const v = (t as unknown as Record<PropertyKey, unknown>)[p];
          if (p !== "update") return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
          return (table: unknown) => {
            const b = (v as (x: unknown) => unknown).call(t, table);
            if (!armed || table !== decisions) return b;
            armed = false;
            return wrapBuilder(b, async () => {
              const [found] = await raw.select().from(decisions).where(eq(decisions.tier, "ceo"));
              const card = found!;
              const c =card.context as { ladder: Ladder };
              await raw
                .update(decisions)
                .set({
                  tier: "owner",
                  forAgentId: null,
                  context: { ...(card.context as object), ladder: { ...c.ladder, rung: "owner", since: new Date().toISOString(), hops: [...c.ladder.hops, { to: "owner", at: new Date().toISOString(), why: "the CEO didn't settle it in time" }] } },
                })
                .where(and(eq(decisions.id, card.id), eq(decisions.status, "open")));
            });
          };
        },
      }) as Db;
    });
    const { d } = await race.ask(PROBE, { ticketId: race.ticket.id });
    expect(d).toMatchObject({ tier: "ceo", status: "open" });
    armed = true;
    const r = await race.decisions.answer(d!.id, "Allow once", { settledBy: { agentId: race.ceo.id }, note: "Looks like its own files." });
    const after = (await race.db.select().from(decisions).where(eq(decisions.id, d!.id)))[0]!;
    // Old code: the conditional UPDATE matched on "open" alone and the CEO closed the owner's card.
    expect(r).toBeNull();
    expect(after).toMatchObject({ status: "open", tier: "owner", answer: null });
    expect((after.context as { ladder: Ladder }).ladder).toMatchObject({ rung: "owner" });
    expect(race.sent).toEqual([]);
  });
});
