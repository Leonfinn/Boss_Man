import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { RunnerCommand, RunnerEvent } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { activity, companies, decisions, runners, tickets } from "../src/db/schema.js";

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.app.close();
  await ctx?.close();
  ctx = undefined;
});

const GB = 1024 ** 3;
const DAY = 86_400_000;

async function setup() {
  const { db, close } = await openPglite();
  let clock = new Date("2026-10-16T09:00:00Z");
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws", diskLimits: { defaultCapBytes: 10 * GB }, now: () => clock });
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Customer app" })).json() as { id: string };
  const reg = (await req("POST", `/api/companies/${company.id}/runner`)).json() as { runnerId: string };
  const [runnerRow] = await db.select().from(runners).where(eq(runners.id, reg.runnerId));
  const sent: RunnerCommand[] = [];
  built.runners.connect(reg.runnerId, (c) => (sent.push(c), true));
  const ticket = async (title: string) => (await req("POST", `/api/projects/${project.id}/tickets`, { title })).json() as { id: string };
  let seq = 0;
  const report = async (tickets: Array<{ ticketId: string; bytes: number }>, extra = 0) => {
    const event: RunnerEvent = {
      type: "runner.disk",
      usedBytes: tickets.reduce((a, t) => a + t.bytes, 0) + extra,
      tickets: tickets.map((t) => ({ ...t, projectId: project.id })),
      repos: [{ projectId: project.id, bytes: extra }],
      removed: [],
    };
    await built.runners.ingest(runnerRow!, { seq: ++seq, at: clock.toISOString(), event });
    await new Promise((r) => setTimeout(r, 50));
  };
  const advance = (ms: number) => (clock = new Date(clock.getTime() + ms));
  return { ...built, db, close, req, company, project, runnerRow: runnerRow!, sent, ticket, report, advance };
}

describe("workspace clean-up and disk caps (R54)", () => {
  it("records disk use and releases worktrees of tickets done a week ago, or gone", async () => {
    const c = (ctx = await setup());
    const active = await c.ticket("Still going");
    const done = await c.ticket("Finished");
    await c.req("PATCH", `/api/tickets/${done.id}`, { state: "done" });
    const gone = randomUUID();

    await c.report([{ ticketId: active.id, bytes: 1000 }, { ticketId: done.id, bytes: 2000 }, { ticketId: gone, bytes: 10 }]);
    expect((await c.db.select().from(runners))[0]).toMatchObject({ diskUsedBytes: 3010 });
    // Recently done: kept a while in case it comes back. Unknown: released straight away.
    expect(c.sent).toEqual([{ type: "workspace.release", projectId: c.project.id, ticketId: gone }]);

    c.advance(8 * DAY);
    c.sent.length = 0;
    await c.report([{ ticketId: active.id, bytes: 1000 }, { ticketId: done.id, bytes: 2000 }]);
    expect(c.sent).toEqual([{ type: "workspace.release", projectId: c.project.id, ticketId: done.id }]);
  });

  it("tells the owner once a day while a company is over its disk cap, naming the biggest workspaces", async () => {
    const c = (ctx = await setup());
    const big = await c.ticket("Video pipeline");
    const small = await c.ticket("Typo fix");
    await c.report([{ ticketId: big.id, bytes: 9 * GB }, { ticketId: small.id, bytes: 0.5 * GB }], 1 * GB);
    await c.report([{ ticketId: big.id, bytes: 9 * GB }, { ticketId: small.id, bytes: 0.5 * GB }], 1 * GB);
    const alerts = await c.db.select().from(decisions).where(eq(decisions.kind, "question"));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.question).toBe(
      `App Co's workspaces use 10.5 GB, over its 10.0 GB disk cap. The biggest ticket workspaces are "Video pipeline" (9.0 GB), "Typo fix" (0.5 GB). This is a warning: nothing is stopped by it. To raise it, open Settings → Reviews and CEO → Workspace disk and set "Disk cap (GB)" higher than its current 10.0 GB; it takes effect at the next hourly clean-up. Otherwise, finish or cancel tickets; worktrees of tickets done more than 7 days ago are removed automatically.`,
    );

    c.advance(DAY);
    await c.report([{ ticketId: big.id, bytes: 9 * GB }], 2 * GB);
    expect(await c.db.select().from(decisions).where(eq(decisions.kind, "question"))).toHaveLength(2);

    // A higher cap for this company stops the alerts.
    expect((await c.req("PATCH", `/api/companies/${c.company.id}`, { diskCapGb: 50 })).json()).toMatchObject({ diskCapBytes: 50 * GB });
    c.advance(DAY);
    await c.report([{ ticketId: big.id, bytes: 9 * GB }], 2 * GB);
    expect(await c.db.select().from(decisions).where(eq(decisions.kind, "question"))).toHaveLength(2);
  });

  it("records who changed the company's disk cap, and resetting it to the server default", async () => {
    const c = (ctx = await setup());
    await c.req("PATCH", `/api/companies/${c.company.id}`, { diskCapGb: 60 });
    await c.req("PATCH", `/api/companies/${c.company.id}`, { diskCapGb: null });
    const rows = await c.db.select().from(activity).where(and(eq(activity.companyId, c.company.id), eq(activity.kind, "settings")));
    expect(rows.map((r) => r.summary)).toEqual(["Owner set the workspace disk cap to 60.0 GB", "Owner reset the workspace disk cap to the server default (20 GB)"]);
    expect((await c.db.select().from(companies).where(eq(companies.id, c.company.id)))[0]!.diskCapBytes).toBeNull();
  });

  it("names where to raise the cap on the card, and says nothing is stopped", async () => {
    const c = (ctx = await setup());
    const big = await c.ticket("Video pipeline");
    await c.report([{ ticketId: big.id, bytes: 21 * GB }], 0);
    const [alert] = await c.db.select().from(decisions).where(eq(decisions.kind, "question"));
    expect(alert!.question).toContain("Settings → Reviews and CEO → Workspace disk");
    expect(alert!.question).toContain('"Disk cap (GB)" higher than its current 10.0 GB');
    expect(alert!.question).toContain("This is a warning: nothing is stopped by it.");
  });

  it("never releases another company's ticket on a runner's say-so", async () => {
    const c = (ctx = await setup());
    const { company: other } = (await c.req("POST", "/api/companies", { name: "Other Co" })).json() as { company: { id: string } };
    const otherProject = (await c.req("POST", `/api/companies/${other.id}/projects`, { name: "Theirs" })).json() as { id: string };
    const theirs = (await c.req("POST", `/api/projects/${otherProject.id}/tickets`, { title: "Theirs" })).json() as { id: string };
    await c.db.update(tickets).set({ systemState: "done", lastActivityAt: new Date("2020-01-01") }).where(eq(tickets.id, theirs.id));
    await c.report([{ ticketId: theirs.id, bytes: 100 }]);
    expect(c.sent).toEqual([]);
    expect((await c.db.select().from(companies).where(eq(companies.id, other.id)))[0]!.diskCapBytes).toBeNull();
  });
});
