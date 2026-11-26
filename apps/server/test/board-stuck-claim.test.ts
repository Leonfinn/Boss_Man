// BOS-2737 (R60): the board's Looks stuck line, read through the real board route. A flag handed to the Scrum Master
// with no Scrum Master run since says when it was raised and that nobody has picked it up; once the Scrum Master's run
// starts it names that run. Main said "The Scrum Master has been told." whatever had happened.
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { agents, runs, tickets, wakes, watchdogFlags } from "../src/db/schema.js";
import { SCRUM_MASTER_DUTY } from "../src/services/watchdog.js";

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
  const { company } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Customer app" })).json() as { id: string };
  const worker = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Engineer" })).json() as { id: string };
  const sm = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Sam" })).json() as { id: string };
  await db.update(agents).set({ duty: SCRUM_MASTER_DUTY }).where(eq(agents.id, sm.id));
  const t = (await req("POST", `/api/projects/${project.id}/tickets`, { title: `Work ${randomUUID().slice(0, 4)}`, assigneeAgentId: worker.id })).json() as { id: string };
  await db.update(tickets).set({ systemState: "in_progress" }).where(eq(tickets.id, t.id));
  await db.delete(wakes).where(eq(wakes.ticketId, t.id));
  const stuckLine = async () =>
    ((await req("GET", `/api/projects/${project.id}/board`)).json() as { columns: { tickets: { id: string; looksStuck?: { claim?: string } | null }[] }[] }).columns
      .flatMap((c) => c.tickets)
      .find((x) => x.id === t.id)?.looksStuck ?? null;
  return { ...built, db, close, company, sm, worker, t, stuckLine };
}

describe("board Looks stuck line names who acts, from facts (BOS-2737)", () => {
  it("handed on with no Scrum Master run: raised at HH:MM, nobody has picked it up yet; then the run once it starts", async () => {
    ctx = await setup();
    const c = ctx;
    const handed = new Date(Date.now() - 30 * 60_000);
    const hhmm = handed.toISOString().slice(11, 16);
    await c.db.insert(watchdogFlags).values({ companyId: c.company.id, ticketId: c.t.id, rule: "stale_in_progress", openedAt: new Date(Date.now() - 3 * 3_600_000), lastFlaggedAt: handed, flagCount: 1, detail: { idleMs: 3 * 3_600_000 } });
    // A Scrum Master run from before the hand-off, and a chat after it, are not a pick-up.
    await c.db.insert(runs).values({ companyId: c.company.id, agentId: c.sm.id, startedAt: new Date(handed.getTime() - 60_000), endedAt: handed });
    await c.db.insert(runs).values({ companyId: c.company.id, agentId: c.sm.id, purpose: "chat", startedAt: new Date(handed.getTime() + 60_000) });
    expect((await c.stuckLine())?.claim).toBe(`The Scrum Master was alerted: raised at ${hhmm} UTC, nobody has picked it up yet.`);
    const started = new Date(handed.getTime() + 2 * 60_000);
    await c.db.insert(runs).values({ companyId: c.company.id, agentId: c.sm.id, startedAt: started });
    expect((await c.stuckLine())?.claim).toBe(`Sam started work on it at ${started.toISOString().slice(11, 16)} UTC.`);
  });
});
