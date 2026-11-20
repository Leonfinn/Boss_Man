// BOS-1908 (BOS-1905 group 3): a ticket started for an agent who is running another ticket stays in Ready as that agent's one
// "Next up", starts by itself when the run ends, counts toward neither limit, and a Next up waiting over a day is raised to the CEO.
// An In progress ticket whose agent is running another one shows "Agent busy" and isn't counted. Parked tickets keep starting as before.
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { RunnerCommand } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { runs, settings, tickets, wakes } from "../src/db/schema.js";
import { record } from "../src/services/activity.js";
import { moveTicket } from "../src/services/ticket-moves.js";
import { agentWipCount, countInProgress } from "../src/services/agent-wip.js";
import { IDLE_AGENTS_REASON } from "../src/services/scheduler.js";

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.app.close();
  await ctx?.close();
  ctx = undefined;
});

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "POST" | "GET", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company, ceo } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string }; ceo: { id: string } };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Customer app" })).json() as { id: string };
  const worker = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Engineer" })).json() as { id: string };
  const reg = (await req("POST", `/api/companies/${company.id}/runner`)).json() as { runnerId: string };
  const commands: Extract<RunnerCommand, { type: "run.start" }>[] = [];
  built.runners.connect(reg.runnerId, (c) => {
    if (c.type === "run.start") commands.push(c);
    return true;
  });
  const ticket = async (state: typeof tickets.$inferInsert["systemState"], patch: Partial<typeof tickets.$inferInsert> = {}) => {
    const t = (await req("POST", `/api/projects/${project.id}/tickets`, { title: `Work ${randomUUID().slice(0, 4)}`, assigneeAgentId: worker.id })).json() as { id: string };
    await db.update(tickets).set({ systemState: state, ...patch }).where(eq(tickets.id, t.id));
    await db.delete(wakes).where(eq(wakes.ticketId, t.id));
    return t;
  };
  const row = async (id: string) => (await db.select().from(tickets).where(eq(tickets.id, id)))[0]!;
  /** The agent is running `ticketId` right now (a live run, not a chat). */
  const startRun = async (ticketId: string) => {
    const id = randomUUID();
    await db.insert(runs).values({ id, companyId: company.id, agentId: worker.id, ticketId, model: "m", startedAt: new Date() });
    return id;
  };
  const endRuns = () => db.update(runs).set({ endedAt: new Date() }).where(eq(runs.agentId, worker.id));
  const board = async () => ((await req("GET", `/api/projects/${project.id}/board`)).json() as { columns: { tickets: { id: string; wipExempt?: string | null; busyOnNumber?: number | null; busyOnTicketId?: string | null; nextUp?: boolean }[] }[] }).columns.flatMap((c) => c.tickets);
  const setLimits = (v: { agent: number | null; company?: number | null }) => db.insert(settings).values({ key: "wip_limits", value: v }).onConflictDoUpdate({ target: settings.key, set: { value: v } });
  return { ...built, db, close, req, company, ceo, project, worker, commands, ticket, row, startRun, endRuns, board, setLimits };
}

describe("a start for a busy agent waits in Ready as Next up (criteria 1 and 2)", () => {
  it("stays in Ready with the Next up note naming the running ticket, then starts by itself when the run ends", async () => {
    const c = (ctx = await setup());
    const running = await c.ticket("in_progress");
    await c.startRun(running.id);
    const t = await c.ticket("ready");
    const r = await moveTicket(c.db, t.id, "in_progress", {});
    expect(r.ticket.systemState).toBe("ready");
    const n = (await c.row(running.id)).number;
    expect(r.held).toBe(`Next up for Engineer: starts when Engineer finishes APP-${n}.`);
    const held = await c.row(t.id);
    expect(held.nextUpAt).not.toBeNull();
    expect(held.wipHeldAt).not.toBeNull();
    expect(held.stateNote).toMatch(/^Next up for Engineer: starts when Engineer finishes /);
    expect((await c.board()).find((x) => x.id === t.id)?.nextUp).toBe(true);

    // The run ends; Boss Man's own pass wakes the agent on the ticket and the launch puts it in progress. Nobody moves it.
    await c.endRuns();
    await moveTicket(c.db, running.id, "review", { internal: true });
    await c.sweeps.run();
    await c.scheduler.tick();
    const after = await c.row(t.id);
    expect(after.systemState).toBe("in_progress");
    expect(after.nextUpAt).toBeNull();
    expect(after.wipHeldAt).toBeNull();
    expect((await c.board()).find((x) => x.id === t.id)?.nextUp).toBe(false);
  });

  it("an idle agent's start is not held: the ticket goes straight to In progress", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("ready");
    const r = await moveTicket(c.db, t.id, "in_progress", {});
    expect(r.ticket.systemState).toBe("in_progress");
    expect(r.held).toBeNull();
    expect((await c.row(t.id)).nextUpAt).toBeNull();
  });
});

describe("one Next up per agent (criterion 3)", () => {
  it("a second start for the same busy agent is held, unmarked, with a message naming the first", async () => {
    const c = (ctx = await setup());
    const running = await c.ticket("in_progress");
    await c.startRun(running.id);
    const first = await c.ticket("ready");
    const second = await c.ticket("ready");
    await moveTicket(c.db, first.id, "in_progress", {});
    const r = await moveTicket(c.db, second.id, "in_progress", {});
    expect(r.ticket.systemState).toBe("ready");
    const firstRow = await c.row(first.id);
    const secondRow = await c.row(second.id);
    expect(firstRow.nextUpAt).not.toBeNull();
    expect(secondRow.nextUpAt).toBeNull();
    expect(r.held).toBe(`Waiting: Engineer is busy on APP-${(await c.row(running.id)).number} and already has APP-${firstRow.number} as Next up; this one starts after it.`);
    // Re-trying the first keeps it as the Next up with its first time.
    await moveTicket(c.db, first.id, "in_progress", {});
    expect((await c.row(first.id)).nextUpAt?.getTime()).toBe(firstRow.nextUpAt!.getTime());
  });
});

describe("Next up counts toward neither limit (criterion 4)", () => {
  it("with both limits at 2 and one ticket running, the Next up leaves the agent and company counts at 1", async () => {
    const c = (ctx = await setup());
    await c.setLimits({ agent: 2, company: 2 });
    const running = await c.ticket("in_progress");
    await c.startRun(running.id);
    const t = await c.ticket("ready");
    const r = await moveTicket(c.db, t.id, "in_progress", {});
    expect(r.ticket.systemState).toBe("ready");
    expect(await agentWipCount(c.db, c.worker.id)).toBe(1);
    expect(await countInProgress(c.db, eq(tickets.companyId, c.company.id), undefined, "company")).toBe(1);
    expect((await c.row(t.id)).nextUpAt).not.toBeNull();
  });
});

describe("an In progress ticket whose agent is running another one (criterion 5)", () => {
  it("shows Agent busy on that ticket and is not counted; the running ticket itself is", async () => {
    const c = (ctx = await setup());
    const running = await c.ticket("in_progress");
    const parked = await c.ticket("in_progress");
    expect(await agentWipCount(c.db, c.worker.id)).toBe(2);
    await c.startRun(running.id);
    expect(await agentWipCount(c.db, c.worker.id)).toBe(1);
    expect(await countInProgress(c.db, eq(tickets.companyId, c.company.id), undefined, "company")).toBe(1);
    const cards = await c.board();
    const p = cards.find((x) => x.id === parked.id);
    expect(p).toMatchObject({ wipExempt: "busy", busyOnTicketId: running.id, busyOnNumber: (await c.row(running.id)).number });
    expect(cards.find((x) => x.id === running.id)?.wipExempt ?? null).toBeNull();
    // The run ends: it counts again.
    await c.endRuns();
    expect(await agentWipCount(c.db, c.worker.id)).toBe(2);
    expect((await c.board()).find((x) => x.id === parked.id)?.wipExempt ?? null).toBeNull();
  });

  it("a chat run does not make the agent busy", async () => {
    const c = (ctx = await setup());
    const other = await c.ticket("in_progress");
    const mine = await c.ticket("in_progress");
    await c.db.insert(runs).values({ id: randomUUID(), companyId: c.company.id, agentId: c.worker.id, ticketId: other.id, purpose: "chat", model: "m", startedAt: new Date() });
    expect(await agentWipCount(c.db, c.worker.id)).toBe(2);
    expect((await c.board()).find((x) => x.id === mine.id)?.wipExempt ?? null).toBeNull();
  });
});

describe("a Next up waiting over a day goes to the CEO's idle check (criterion 6)", () => {
  const idleAsks = (c: Awaited<ReturnType<typeof setup>>) => c.db.select().from(wakes).where(and(eq(wakes.agentId, c.ceo.id), eq(wakes.reason, IDLE_AGENTS_REASON)));

  it("raised at 25 hours, not at 1 hour", async () => {
    const c = (ctx = await setup());
    const running = await c.ticket("in_progress");
    await c.startRun(running.id);
    const t = await c.ticket("ready");
    await moveTicket(c.db, t.id, "in_progress", {});
    await c.sweeps.run();
    expect((await idleAsks(c)).filter((w) => /Next up for over a day/.test(w.note ?? ""))).toHaveLength(0);

    await c.db.update(tickets).set({ nextUpAt: new Date(Date.now() - 25 * 3_600_000) }).where(eq(tickets.id, t.id));
    await c.sweeps.run();
    const asks = (await idleAsks(c)).filter((w) => /Next up for over a day/.test(w.note ?? ""));
    expect(asks).toHaveLength(1);
    expect(asks[0]!.note).toContain(`"${(await c.row(t.id)).title}"`);
    expect(asks[0]!.note).toContain("next up for Engineer");
    // The same list isn't sent again.
    await c.sweeps.run();
    expect((await idleAsks(c)).filter((w) => /Next up for over a day/.test(w.note ?? ""))).toHaveLength(1);
  });
});

describe("tickets parked In progress keep starting as today (criterion 7)", () => {
  it("an existing In progress row stays In progress while its agent runs another ticket", async () => {
    const c = (ctx = await setup());
    const parked = await c.ticket("in_progress");
    await c.startRun((await c.ticket("in_progress")).id);
    const r = await moveTicket(c.db, parked.id, null, { fields: { stateNote: "still mine" } });
    expect(r.ticket.systemState).toBe("in_progress");
    expect(r.ticket.nextUpAt).toBeNull();
  });

  it("a ticket that was in progress before goes straight back in, as does an urgent one and the agent's own move", async () => {
    const c = (ctx = await setup());
    const running = await c.ticket("in_progress");
    await c.startRun(running.id);
    const before = await c.ticket("ready");
    await record(c.db, { companyId: c.company.id, ticketId: before.id, kind: "state", summary: "ready -> in_progress" });
    expect((await moveTicket(c.db, before.id, "in_progress", {})).ticket.systemState).toBe("in_progress");
    const urgent = await c.ticket("ready", { urgent: true });
    expect((await moveTicket(c.db, urgent.id, "in_progress", {})).ticket.systemState).toBe("in_progress");
    const own = await c.ticket("ready");
    expect((await moveTicket(c.db, own.id, "in_progress", { by: c.worker.id })).ticket.systemState).toBe("in_progress");
    // The owner's override skips the hold too.
    const forced = await c.ticket("ready");
    expect((await moveTicket(c.db, forced.id, "in_progress", { overLimit: true })).ticket.systemState).toBe("in_progress");
  });
});
