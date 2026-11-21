// BOS-2200: an agent outside its working hours isn't woken for new work; the exemptions match company quiet hours;
// held work starts by itself when the hours open; setting hours leaves an activity line.
import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { nextWorkingStart, type RunnerCommand, type WorkingHours } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { signedInOwner } from "./helpers/owner-session.js";
import { appCache, sharedDatabase } from "./helpers/shared-server.js";
import { activity, agents, runners, wakes } from "../src/db/schema.js";

let ctx: Awaited<ReturnType<typeof setup>>;
let shared: Awaited<ReturnType<typeof sharedDatabase>>;
const apps = appCache<Awaited<ReturnType<typeof buildApp>>>();
beforeAll(async () => {
  shared = await sharedDatabase();
});
afterEach(() => ctx?.release());
afterAll(async () => {
  await apps.closeAll();
  await shared.close();
});

async function setup() {
  await shared.reset();
  const { db } = shared;
  const built = await apps.get("wh", () => buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" }));
  const cookie = await signedInOwner(db);
  const req = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company, ceo } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string }; ceo: { id: string } };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Customer app" })).json() as { id: string };
  const reg = (await req("POST", `/api/companies/${company.id}/runner`)).json() as { runnerId: string };
  const [runnerRow] = await db.select().from(runners).where(eq(runners.id, reg.runnerId));
  const sent: RunnerCommand[] = [];
  const commands: Extract<RunnerCommand, { type: "run.start" }>[] = [];
  const release = built.runners.connect(reg.runnerId, (c) => {
    sent.push(c);
    if (c.type === "run.start") commands.push(c);
    return true;
  });
  void runnerRow;
  return { ...built, db, release, req, company, ceo, project, sent, commands };
}

/** Hours on every day that open three hours from now and close an hour later, so "now" is outside them. */
function hoursLater(): WorkingHours {
  const at = (h: number) => {
    const d = new Date(Date.now() + h * 3_600_000);
    return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  };
  return { days: [0, 1, 2, 3, 4, 5, 6], start: at(3), end: at(4), timeZone: "UTC" };
}

const heldWakes = async () => (await ctx.db.select().from(wakes)).filter((w) => w.status === "deferred" || w.status === "queued");

describe("agent working hours", () => {
  it("holds a new-work wake until the hours open, and starts it by itself after", async () => {
    ctx = await setup();
    const hours = hoursLater();
    expect((await ctx.req("PATCH", `/api/agents/${ctx.ceo.id}`, { workingHours: hours })).statusCode).toBe(200);
    const t = (await ctx.req("POST", `/api/projects/${ctx.project.id}/tickets`, { title: "Night job", assigneeAgentId: ctx.ceo.id })).json() as { id: string };
    await ctx.scheduler.notify(ctx.ceo.id, { ticketId: t.id, reason: "assigned", note: "Yours." });
    const [w] = (await heldWakes()).filter((x) => x.ticketId === t.id);
    expect(w).toMatchObject({ status: "deferred", statusReason: "working hours" });
    const expected = nextWorkingStart(new Date(), hours)!;
    // test-lines-ok: compares two computed instants (not elapsed wall time); the 2-minute slack only absorbs the clock moving between the two calls
    expect(Math.abs(w!.notBefore!.getTime() - expected.getTime())).toBeLessThan(120_000);
    expect(await ctx.scheduler.tick()).toMatchObject({ launched: 0 });
    expect(ctx.commands).toHaveLength(0);

    // The ticket card says why, and the Agents list says when the agent is back.
    const detail = (await ctx.req("GET", `/api/tickets/${t.id}`)).json() as { workingHoursNote: string | null };
    expect(detail.workingHoursNote).toMatch(/^Waiting for .*'s working hours, from /);
    const list = (await ctx.req("GET", `/api/companies/${ctx.company.id}/agents`)).json() as Array<{ id: string; offUntil: { label: string } | null }>;
    expect(list.find((a) => a.id === ctx.ceo.id)!.offUntil?.label).toMatch(/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) \d\d:\d\d$/);

    // When the start time passes, the normal timer pass starts it: nobody has to do anything.
    await ctx.db.update(wakes).set({ notBefore: new Date(Date.now() - 1000) }).where(eq(wakes.id, w!.id));
    expect(await ctx.scheduler.tick()).toMatchObject({ launched: 1 });
    expect(ctx.commands).toHaveLength(1);
  });

  it("lets an owner reply, an urgent ticket and a high-priority wake through", async () => {
    ctx = await setup();
    await ctx.req("PATCH", `/api/agents/${ctx.ceo.id}`, { workingHours: hoursLater() });
    const urgent = (await ctx.req("POST", `/api/projects/${ctx.project.id}/tickets`, { title: "Urgent fix", assigneeAgentId: ctx.ceo.id })).json() as { id: string };
    await ctx.req("PATCH", `/api/tickets/${urgent.id}`, { urgent: true });
    await ctx.db.delete(wakes);
    await ctx.scheduler.notify(ctx.ceo.id, { ticketId: urgent.id, reason: "assigned", note: "Urgent." });
    const plain = (await ctx.req("POST", `/api/projects/${ctx.project.id}/tickets`, { title: "Routine", assigneeAgentId: ctx.ceo.id })).json() as { id: string };
    await ctx.db.delete(wakes).where(eq(wakes.ticketId, plain.id));
    await ctx.scheduler.wake({ agentId: ctx.ceo.id, ticketId: plain.id, reason: "woken by owner" });
    await ctx.scheduler.wake({ agentId: ctx.ceo.id, ticketId: plain.id, reason: "decision answered", priority: 3 });
    const all = await heldWakes();
    expect(all.filter((w) => w.ticketId === urgent.id)).toEqual([expect.objectContaining({ status: "queued" })]);
    expect(all.filter((w) => w.reason === "woken by owner")).toEqual([expect.objectContaining({ status: "queued" })]);
    expect(all.filter((w) => w.reason === "decision answered")).toEqual([expect.objectContaining({ status: "queued" })]);
  });

  it("changes nothing when working hours are off, and doesn't stop a run already going", async () => {
    ctx = await setup();
    const t = (await ctx.req("POST", `/api/projects/${ctx.project.id}/tickets`, { title: "Day job", assigneeAgentId: ctx.ceo.id })).json() as { id: string };
    await ctx.scheduler.notify(ctx.ceo.id, { ticketId: t.id, reason: "assigned", note: "Yours." });
    expect(await ctx.scheduler.tick()).toMatchObject({ launched: 1 });
    // Turning hours on while it runs, with the hours closed now, leaves the run alone.
    await ctx.req("PATCH", `/api/agents/${ctx.ceo.id}`, { workingHours: hoursLater() });
    expect(ctx.sent.filter((c) => c.type !== "run.start")).toEqual([]);
    // A reply from the owner on its ticket still reaches it.
    await ctx.scheduler.wake({ agentId: ctx.ceo.id, ticketId: t.id, reason: "woken by owner" });
    expect((await heldWakes()).filter((w) => w.reason === "woken by owner")).toEqual([expect.objectContaining({ status: "queued" })]);
    // Off again: routine wakes aren't held.
    await ctx.req("PATCH", `/api/agents/${ctx.ceo.id}`, { workingHours: null });
    await ctx.scheduler.wake({ agentId: ctx.ceo.id, ticketId: null, reason: "check due", note: "x" });
    expect((await heldWakes()).filter((w) => w.reason === "check due")).toEqual([expect.objectContaining({ status: "queued" })]);
  });

  it("refuses bad hours, records an activity line, and frees held work when they are turned off", async () => {
    ctx = await setup();
    expect((await ctx.req("PATCH", `/api/agents/${ctx.ceo.id}`, { workingHours: { days: [1], start: "9:00", end: "17:00", timeZone: "UTC" } })).statusCode).toBe(422);
    expect((await ctx.req("PATCH", `/api/agents/${ctx.ceo.id}`, { workingHours: { days: [1], start: "09:00", end: "17:00", timeZone: "Mars/Base" } })).statusCode).toBe(422);
    expect((await ctx.req("PATCH", `/api/agents/${ctx.ceo.id}`, { workingHours: { days: [], start: "09:00", end: "17:00", timeZone: "UTC" } })).statusCode).toBe(400);
    expect((await ctx.db.select().from(agents).where(eq(agents.id, ctx.ceo.id)))[0]!.workingHours).toBeNull();

    await ctx.req("PATCH", `/api/agents/${ctx.ceo.id}`, { workingHours: hoursLater() });
    await ctx.scheduler.wake({ agentId: ctx.ceo.id, ticketId: null, reason: "check due", note: "x" });
    expect((await heldWakes())[0]).toMatchObject({ status: "deferred", statusReason: "working hours" });
    await ctx.req("PATCH", `/api/agents/${ctx.ceo.id}`, { workingHours: null });
    // Freed at once (the route also runs a pass, which may already have started it).
    const [freed] = await ctx.db.select().from(wakes);
    expect(freed!.status).not.toBe("deferred");
    expect(freed!.statusReason).not.toBe("working hours");

    const lines = (await ctx.db.select().from(activity)).filter((a) => a.kind === "agent_working_hours").map((a) => a.summary);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/working hours were set: Sun, Mon, Tue, Wed, Thu, Fri, Sat/);
    expect(lines[1]).toMatch(/turned off/);
    const history = (await ctx.req("GET", `/api/agents/${ctx.ceo.id}/history`)).json() as Array<{ c: { field: string } }>;
    expect(history.filter((h) => h.c.field === "working_hours")).toHaveLength(2);
  });
});
