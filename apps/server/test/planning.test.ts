import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { activity, decisions, features, ticketDependencies, tickets } from "../src/db/schema.js";
import { effectiveSize, forecastMilestone } from "../src/services/planning.js";
import { makeApp, signIn, type TestApp } from "./helpers.js";

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

async function setup() {
  t = await makeApp();
  const { cookie } = await signIn(t);
  const req = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) => t!.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company } = (await req("POST", "/api/companies", { name: "App Co" })).json();
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Customer app" })).json();
  const ticket = async (title: string, fields: Record<string, unknown> = {}) => (await req("POST", `/api/projects/${project.id}/tickets`, { title, ...fields })).json() as { id: string };
  return { req, company, project, ticket, db: t.db };
}

describe("roadmap badge and reason (BOS-2579)", () => {
  async function milestone(c: Awaited<ReturnType<typeof setup>>, targetDate: string) {
    const obj = (await c.req("POST", `/api/companies/${c.company.id}/objectives`, { title: "Ship it", priority: 1 })).json();
    return (await c.req("POST", `/api/objectives/${obj.id}/milestones`, { title: "Launch", targetDate })).json() as { id: string };
  }
  const read = async (c: Awaited<ReturnType<typeof setup>>) => (await c.req("GET", "/api/roadmap?today=2026-10-16")).json()[0].objectives[0].milestones[0];

  it("reads merged, live tickets as delivered: only final checks left means Live, being checked, not Late or At risk", async () => {
    const c = await setup();
    const m = await milestone(c, "2026-10-10");
    const a = await c.ticket("Built and live", { milestoneId: m.id, state: "blocked" });
    await c.ticket("Done work", { milestoneId: m.id, state: "done" });
    await c.db.update(tickets).set({ mergeCommit: "abc123", goLiveWait: null }).where(eq(tickets.id, a.id));
    const got = await read(c);
    expect(got).toMatchObject({ status: "live_checked", blocked: 0 });
    expect(got.reason).toContain("1 final check running");
  });

  it("a merged ticket still waiting to go live is not delivered, so the date still counts", async () => {
    const c = await setup();
    const m = await milestone(c, "2026-10-10");
    const a = await c.ticket("Merged, not live", { milestoneId: m.id, state: "blocked" });
    await c.db.update(tickets).set({ mergeCommit: "abc123", goLiveWait: "server" }).where(eq(tickets.id, a.id));
    expect(await read(c)).toMatchObject({ status: "late" });
  });

  it("names an unbuilt ticket that waits on the owner's card; a blocked ticket with no card is only on track", async () => {
    const c = await setup();
    const m = await milestone(c, "2026-11-30");
    const waiting = await c.ticket("Needs an answer", { milestoneId: m.id, state: "blocked" });
    await c.ticket("Done work", { milestoneId: m.id, state: "done" });
    expect(await read(c)).toMatchObject({ status: "on_track", reason: null, blocked: 1 });
    const [d] = await c.db.insert(decisions).values({ companyId: c.company.id, kind: "question", question: "Which provider?", options: ["A", "B"], recommendedOption: "A", context: { type: "question" } }).returning();
    await c.db.insert(ticketDependencies).values({ blockedTicketId: waiting.id, blockerDecisionId: d!.id });
    const got = await read(c);
    expect(got.status).toBe("at_risk");
    expect(got.reason).toMatch(/^At risk: [A-Z]+-\d+ waits on your card\.$/);
    // The reason names exactly the tickets it links.
    expect(got.reasonTickets).toEqual([{ ref: expect.stringMatching(/^[A-Z]+-\d+$/), id: waiting.id }]);
  });
});

describe("roadmap", () => {
  it("groups milestones by objective and company with their progress and status", async () => {
    const c = await setup();
    const obj = (await c.req("POST", `/api/companies/${c.company.id}/objectives`, { title: "Launch the beta", priority: 1 })).json();
    await c.req("POST", `/api/objectives/${obj.id}/key-results`, { title: "Beta users", target: 50, current: 20 });
    const alpha = (await c.req("POST", `/api/objectives/${obj.id}/milestones`, { title: "Alpha", targetDate: "2026-10-10" })).json();
    const beta = (await c.req("POST", `/api/objectives/${obj.id}/milestones`, { title: "Beta", targetDate: "2026-10-25" })).json();
    const later = (await c.req("POST", `/api/objectives/${obj.id}/milestones`, { title: "Later" })).json();
    await c.ticket("Sign-in", { milestoneId: alpha.id, state: "done" });
    await c.ticket("Payments", { milestoneId: alpha.id, state: "in_progress" });
    await c.ticket("Onboarding", { milestoneId: beta.id, state: "done" });
    await c.ticket("Invites", { milestoneId: beta.id, state: "blocked" });
    await c.ticket("Dropped idea", { milestoneId: beta.id, state: "done", outcome: "cancelled" });

    const [co] = (await c.req("GET", "/api/roadmap?today=2026-10-16")).json();
    expect(co.name).toBe("App Co");
    const [o] = co.objectives;
    expect(o.keyResults[0]).toMatchObject({ title: "Beta users", progress: 0.4 });
    expect(o.milestones.map((m: { title: string; status: string; total: number; done: number }) => [m.title, m.status, m.done, m.total])).toEqual([
      ["Alpha", "late", 1, 2],
      // BOS-2579: a blocked ticket alone no longer turns the badge amber.
      ["Beta", "on_track", 1, 2],
      ["Later", "no_work", 0, 0],
    ]);

    // Now / Next / Later: from work and dates, unless pinned.
    expect(o.milestones.map((m: { title: string; horizon: string; pinned: string | null }) => [m.title, m.horizon, m.pinned])).toEqual([
      ["Alpha", "now", null],
      ["Beta", "now", null],
      ["Later", "later", null],
    ]);
    expect((await c.req("PATCH", `/api/milestones/${later.id}`, { horizon: "next" })).json().horizon).toBe("next");
    const soon = (await c.req("POST", `/api/objectives/${obj.id}/milestones`, { title: "Polish", horizon: "next" })).json();
    expect(soon.horizon).toBe("next");
    const pinned = (await c.req("GET", "/api/roadmap?today=2026-10-16")).json()[0].objectives[0].milestones;
    expect(pinned.filter((m: { horizon: string }) => m.horizon === "next").map((m: { title: string }) => m.title).sort()).toEqual(["Later", "Polish"]);
    expect((await c.req("PATCH", `/api/milestones/${later.id}`, { horizon: "soon" })).statusCode).toBe(400);
    await c.req("DELETE", `/api/milestones/${soon.id}`);

    expect((await c.req("PATCH", `/api/milestones/${beta.id}`, { targetDate: "2026-12-01" })).json().targetDate).toBe("2026-12-01");
    expect((await c.req("GET", `/api/milestones/${alpha.id}/tickets`)).json().map((x: { title: string }) => x.title)).toEqual(["Sign-in", "Payments"]);

    // Deleting a milestone keeps its tickets.
    expect((await c.req("DELETE", `/api/milestones/${later.id}`)).statusCode).toBe(204);
    expect((await c.req("DELETE", `/api/milestones/${alpha.id}`)).statusCode).toBe(204);
    expect((await c.db.select().from(tickets)).length).toBe(5);

    // Closed objectives leave the roadmap unless asked for.
    await c.req("PATCH", `/api/objectives/${obj.id}`, { status: "done" });
    expect((await c.req("GET", "/api/roadmap")).json()[0].objectives).toEqual([]);
    expect((await c.req("GET", "/api/roadmap?closed=1")).json()[0].objectives).toHaveLength(1);
    expect((await c.req("PATCH", `/api/objectives/${obj.id}`, { status: "paused" })).statusCode).toBe(400);
  });
});

describe("plan", () => {
  it("draws what tickets wait on, finds blocked chains, and releases a ticket when its last blocker goes", async () => {
    const c = await setup();
    const design = await c.ticket("Design the API", { state: "in_progress" });
    const api = await c.ticket("Build the API", { state: "blocked" });
    const ui = await c.ticket("Build the UI", { state: "blocked" });
    await c.ticket("Unrelated", { state: "ready" });
    const dep1 = (await c.req("POST", `/api/tickets/${api.id}/dependencies`, { ticketId: design.id })).json();
    await c.req("POST", `/api/tickets/${ui.id}/dependencies`, { ticketId: api.id });
    const [d] = await c.db.insert(decisions).values({ companyId: c.company.id, kind: "question", question: "Which payment provider?", options: ["Stripe", "Adyen"], recommendedOption: "Stripe", context: { type: "question" } }).returning();
    await c.db.insert(ticketDependencies).values({ blockedTicketId: ui.id, blockerDecisionId: d!.id });

    const plan = (await c.req("GET", `/api/companies/${c.company.id}/plan`)).json();
    const node = (id: string) => plan.nodes.find((n: { id: string }) => n.id === id);
    expect(plan.nodes).toHaveLength(4);
    expect(node(design.id)).toMatchObject({ kind: "ticket", ref: expect.stringMatching(/^APP-\d+$/), layer: 0, blocked: false, holdingUp: 2, link: `#/tickets/${design.id}`, project: "Customer app" });
    expect(node(ui.id)).toMatchObject({ layer: 2, blocked: true, holdingUp: 0 });
    expect(node(ui.id).causes.sort()).toEqual([d!.id, design.id].sort());
    expect(node(d!.id)).toMatchObject({ kind: "decision", ref: null, open: true, title: "Which payment provider?" });

    const links = (await c.req("GET", `/api/tickets/${api.id}/links`)).json();
    expect(links.waitsOn).toEqual([expect.objectContaining({ kind: "ticket", id: design.id, open: true, dependencyId: dep1.id })]);
    expect(links.blocks).toEqual([expect.objectContaining({ id: ui.id, title: "Build the UI" })]);

    // A decision blocker goes by answering the decision.
    const decisionDep = (await c.req("GET", `/api/tickets/${ui.id}/links`)).json().waitsOn.find((w: { kind: string }) => w.kind === "decision");
    expect((await c.req("DELETE", `/api/dependencies/${decisionDep.dependencyId}`)).statusCode).toBe(422);

    expect((await c.req("DELETE", `/api/dependencies/${dep1.id}`)).statusCode).toBe(204);
    const lines = (await c.db.select().from(activity).where(eq(activity.ticketId, api.id))).filter((a) => a.kind === "dependency");
    expect(lines.map((l) => l.summary)).toContainEqual(expect.stringMatching(/^The owner removed the wait on APP-\d+ Design the API$/));
    expect((await c.db.select().from(tickets).where(eq(tickets.id, api.id)))[0]!.systemState).toBe("ready");
    expect((await c.req("GET", `/api/companies/${c.company.id}/open-tickets`)).json()).toHaveLength(4);
  });
});

describe("related tickets", () => {
  it("lists feature, parent, sub-tasks, peers, dependencies and tickets named in the description, each once", async () => {
    const c = await setup();
    const [f] = await c.db.insert(features).values({ companyId: c.company.id, title: "Rate limits" }).returning();
    const origin = await c.ticket("The big one");
    const me = await c.ticket("Split-out piece");
    const peer = await c.ticket("Same feature");
    const sibling = await c.ticket("Same parent");
    const child = await c.ticket("Child");
    const waits = await c.ticket("Needed first");
    const refOf = async (id: string) => `${(await c.req("GET", `/api/tickets/${id}`)).json().ref}`;
    await c.db.update(tickets).set({ featureId: f!.id, parentTicketId: origin.id, body: `Split out of ${await refOf(origin.id)}, see also ${await refOf(waits.id)} and BOS-9999.` }).where(eq(tickets.id, me.id));
    await c.db.update(tickets).set({ featureId: f!.id }).where(eq(tickets.id, peer.id));
    await c.db.update(tickets).set({ parentTicketId: origin.id, featureId: f!.id }).where(eq(tickets.id, sibling.id));
    await c.db.update(tickets).set({ parentTicketId: me.id, featureId: f!.id }).where(eq(tickets.id, child.id));
    await c.db.insert(ticketDependencies).values({ blockedTicketId: me.id, blockerTicketId: waits.id });

    const r = (await c.req("GET", `/api/tickets/${me.id}/related`)).json();
    expect(r.feature).toMatchObject({ id: f!.id, title: "Rate limits" });
    expect(r.parent).toMatchObject({ id: origin.id, title: "The big one" });
    expect(r.subtasks.map((x: { id: string }) => x.id)).toEqual([child.id]);
    expect(r.peers.map((x: { id: string }) => x.id).sort()).toEqual([peer.id, sibling.id].sort());
    expect(r.waitsOn.map((x: { id: string }) => x.id)).toEqual([waits.id]);
    expect(r.blocks).toEqual([]);
    // Already shown as parent / waits-on, and BOS-9999 matches nothing.
    expect(r.mentioned).toEqual([]);
    expect(r.peers[0].ref).toMatch(/-\d+$/);
  });

  it("is empty for a ticket with no links, and 404 for an unknown ticket", async () => {
    const c = await setup();
    const lone = await c.ticket("Alone");
    const r = (await c.req("GET", `/api/tickets/${lone.id}/related`)).json();
    expect(r).toEqual({ feature: null, parent: null, subtasks: [], peers: [], waitsOn: [], blocks: [], mentioned: [] });
    expect((await c.req("GET", "/api/tickets/00000000-0000-4000-8000-000000000000/related")).statusCode).toBe(404);
  });

  it("shows a ticket named only in the description under Mentioned", async () => {
    const c = await setup();
    const a = await c.ticket("Origin");
    const b = await c.ticket("Follow-up");
    const ref = (await c.req("GET", `/api/tickets/${a.id}`)).json().ref;
    await c.db.update(tickets).set({ body: `Came from ${ref}.` }).where(eq(tickets.id, b.id));
    const r = (await c.req("GET", `/api/tickets/${b.id}/related`)).json();
    expect(r.mentioned.map((x: { id: string }) => x.id)).toEqual([a.id]);
  });
});

describe("feature forecast (BOS-2396)", () => {
  it("5+3 done, 8+2 open, one unsized, at 20 points a week: 8 done, 10 left, 1 unsized, finish 4 days out", () => {
    const rows = [{ size: 5, done: true }, { size: 3, done: true }, { size: 8, done: false }, { size: 2, done: false }, { size: null, done: false }];
    expect(forecastMilestone(rows, 20, null, "2026-11-23")).toMatchObject({ pointsDone: 8, pointsLeft: 10, unsized: 1, expectedFinish: "2026-11-27" });
  });

  it("shows points done/left, unsized tasks and a finish on the detail, points on the list, and none for released", async () => {
    const c = await setup();
    const feat = (await c.req("POST", `/api/companies/${c.company.id}/features`, { title: "Big one", status: "in_progress" })).json();
    const done = await c.ticket("Done 5", { featureId: feat.id, state: "done" });
    const open = await c.ticket("Open 8", { featureId: feat.id, state: "in_progress" });
    await c.ticket("Open unsized", { featureId: feat.id, state: "in_progress" });
    const gone = await c.ticket("Cancelled 5", { featureId: feat.id, state: "done", outcome: "cancelled" });
    await c.db.update(tickets).set({ size: 5 }).where(eq(tickets.id, done.id));
    await c.db.update(tickets).set({ size: 8 }).where(eq(tickets.id, open.id));
    await c.db.update(tickets).set({ size: 5 }).where(eq(tickets.id, gone.id));
    const detail = (await c.req("GET", `/api/features/${feat.id}`)).json();
    expect(detail.forecast).toMatchObject({ pointsDone: 5, pointsLeft: 8, unsized: 1, pace: 1.25 });
    expect(detail.forecast.expectedFinish).toBeTruthy();
    const list = (await c.req("GET", `/api/companies/${c.company.id}/features`)).json();
    expect(list.features.find((f: { id: string }) => f.id === feat.id)).toMatchObject({ pointsDone: 5, pointsTotal: 13 });
    await c.req("PATCH", `/api/features/${feat.id}`, { status: "released" });
    expect((await c.req("GET", `/api/features/${feat.id}`)).json().forecast).toBeNull();
  });
});

describe("milestone forecast (points and pace)", () => {
  it("splits points, reports unsized separately, and forecasts from the last 28 days", async () => {
    const c = await setup();
    const obj = (await c.req("POST", `/api/companies/${c.company.id}/objectives`, { title: "Launch", priority: 1 })).json();
    const ms = (await c.req("POST", `/api/objectives/${obj.id}/milestones`, { title: "Beta", targetDate: "2026-01-01" })).json();
    const a = await c.ticket("Done 5", { milestoneId: ms.id, state: "done" });
    const b = await c.ticket("Open 8", { milestoneId: ms.id, state: "in_progress" });
    await c.ticket("Open unsized", { milestoneId: ms.id, state: "in_progress" });
    await c.db.update(tickets).set({ size: 5 }).where(eq(tickets.id, a.id));
    await c.db.update(tickets).set({ size: 8 }).where(eq(tickets.id, b.id));
    const today = new Date().toISOString().slice(0, 10);
    const f = (await c.req("GET", `/api/roadmap?today=${today}`)).json()[0].objectives[0].milestones[0].forecast;
    // 5 points finished in 28 days = 1.25 a week; 8 left = 6.4 weeks = 45 days.
    expect(f).toMatchObject({ pointsDone: 5, pointsLeft: 8, unsized: 1, pace: 1.25 });
    expect(f.expectedFinish > today).toBe(true);
    expect(f.daysLate).toBeGreaterThan(0);
  });

  it("serves an 8-week burn-up on each milestone (BOS-2397), leaving cancelled work out", async () => {
    const c = await setup();
    const obj = (await c.req("POST", `/api/companies/${c.company.id}/objectives`, { title: "Launch", priority: 1 })).json();
    const ms = (await c.req("POST", `/api/objectives/${obj.id}/milestones`, { title: "Beta" })).json();
    const a = await c.ticket("Done 5", { milestoneId: ms.id, state: "done" });
    const b = await c.ticket("Open 8", { milestoneId: ms.id, state: "in_progress" });
    const x = await c.ticket("Dropped 20", { milestoneId: ms.id, state: "done", outcome: "cancelled" });
    for (const [t, size] of [[a, 5], [b, 8], [x, 3]] as const) await c.db.update(tickets).set({ size }).where(eq(tickets.id, t.id));
    const today = new Date().toISOString().slice(0, 10);
    const burnup = (await c.req("GET", `/api/roadmap?today=${today}`)).json()[0].objectives[0].milestones[0].burnup;
    expect(burnup).toHaveLength(8);
    expect(burnup.at(-1)).toMatchObject({ weekEnd: today, done: 5, total: 13 });
    expect(burnup[0]).toMatchObject({ done: 0, total: 0 });
  });

  it("sums 5+3 done, 8+2 left, ignores unsized points, and finishes two weeks out at 20 points per 28 days", () => {
    const rows = [{ size: 5, done: true }, { size: 3, done: true }, { size: 8, done: false }, { size: 2, done: false }, { size: null, done: false }];
    expect(forecastMilestone(rows, 20 / 4, "2026-12-30", "2026-11-23")).toMatchObject({ pointsDone: 8, pointsLeft: 10, unsized: 1, expectedFinish: "2026-12-07" });
  });

  // BOS-2532 (G2): on 24 Nov the owner's "N of M points done" left a sized task's points out of M. A task whose size
  // reads 0 is not on the point scale (the size is refused now), so it counts as unsized, never as "sized, worth nothing".
  it("BOS-2532: a task whose size reads 0 counts as unsized, so M is the whole of what is sized", () => {
    const rows = [{ size: 3, done: true }, { size: 0, done: false }, { size: 5, done: false }];
    expect(forecastMilestone(rows, 20, null, "2026-11-23")).toMatchObject({ pointsDone: 3, pointsLeft: 5, unsized: 1 });
    // 3 of 8 points done, and the list under it shows two sized tasks: the two numbers now agree.
    expect(rows.filter((r) => (r.size ?? 0) >= 1).length).toBe(2);
  });

  it("has no finish date without pace, and none is late without a target", () => {
    expect(forecastMilestone([{ size: 3, done: false }], 0, "2026-12-01", "2026-11-23")).toMatchObject({ pointsLeft: 3, expectedFinish: null, daysLate: 0 });
    expect(forecastMilestone([{ size: 7, done: false }], 7, null, "2026-11-23")).toMatchObject({ expectedFinish: "2026-11-30", daysLate: 0 });
    expect(forecastMilestone([{ size: 7, done: false }], 7, "2026-11-25", "2026-11-23")).toMatchObject({ daysLate: 5 });
  });
});

describe("one ticket set per milestone (BOS-2560)", () => {
  it("a milestone fed only through a feature has the same done/total, status, forecast and ticket list everywhere", async () => {
    const c = await setup();
    const obj = (await c.req("POST", `/api/companies/${c.company.id}/objectives`, { title: "Launch", priority: 1 })).json();
    const today = new Date().toISOString().slice(0, 10);
    const due = new Date(Date.now() + 40 * 86_400_000).toISOString().slice(0, 10);
    const ms = (await c.req("POST", `/api/objectives/${obj.id}/milestones`, { title: "Beta", targetDate: due })).json();
    const [feat] = await c.db.insert(features).values({ companyId: c.company.id, title: "Sign-in", milestoneId: ms.id }).returning();
    const a = await c.ticket("Done 5", { state: "done" });
    const b = await c.ticket("Open 8", { state: "in_progress" });
    const x = await c.ticket("Dropped", { state: "done", outcome: "cancelled" });
    for (const [t, size] of [[a, 5], [b, 8], [x, 3]] as const) await c.db.update(tickets).set({ size, featureId: feat!.id }).where(eq(tickets.id, t.id));

    const m = (await c.req("GET", `/api/roadmap?today=${today}`)).json()[0].objectives[0].milestones[0];
    // The counts, the forecast, the burn-up and the ticket list all read the same two tickets (the cancelled one is out).
    expect([m.done, m.total]).toEqual([1, 2]);
    expect(m.forecast).toMatchObject({ pointsDone: 5, pointsLeft: 8 });
    expect(m.burnup.at(-1)).toMatchObject({ done: 5, total: 13 });
    // 5 points finished in 4 weeks is its own pace, 1.25 a week: 8 left finishes in 45 days, after the date 40 days out.
    expect(m.forecast.pace).toBe(1.25);
    expect(m.status).toBe("at_risk");
    expect(m.forecast.daysLate).toBeGreaterThan(0);
    const listed = (await c.req("GET", `/api/milestones/${ms.id}/tickets`)).json();
    expect(listed.map((r: { title: string }) => r.title).sort()).toEqual(["Done 5", "Dropped", "Open 8"]);
    expect(listed.filter((r: { outcome: string | null }) => r.outcome !== "cancelled")).toHaveLength(m.total);
  });

  it("uses the milestone's own pace, not the company's: another milestone's finished work doesn't speed it up", async () => {
    const c = await setup();
    const obj = (await c.req("POST", `/api/companies/${c.company.id}/objectives`, { title: "Launch", priority: 1 })).json();
    const today = new Date().toISOString().slice(0, 10);
    const due = new Date(Date.now() + 40 * 86_400_000).toISOString().slice(0, 10);
    const busy = (await c.req("POST", `/api/objectives/${obj.id}/milestones`, { title: "Busy", targetDate: due })).json();
    const idle = (await c.req("POST", `/api/objectives/${obj.id}/milestones`, { title: "Idle", targetDate: due })).json();
    const d = await c.ticket("Done 8", { milestoneId: busy.id, state: "done" });
    const o1 = await c.ticket("Open 3", { milestoneId: idle.id, state: "in_progress" });
    for (const [t, size] of [[d, 8], [o1, 3]] as const) await c.db.update(tickets).set({ size }).where(eq(tickets.id, t.id));
    const ms = (await c.req("GET", `/api/roadmap?today=${today}`)).json()[0].objectives[0].milestones as Array<{ title: string; status: string; forecast: { pace: number; expectedFinish: string | null } }>;
    const idleM = ms.find((x) => x.title === "Idle")!;
    expect(idleM.forecast).toMatchObject({ pace: 0, expectedFinish: null });
    expect(idleM.status).toBe("on_track"); // nothing finished in 4 weeks, but it is due in 40 days
  });
});

describe("effectiveSize (BOS-2532, BOS-2567)", () => {
  it("gives a sized ticket its whole-number points", () => {
    expect(effectiveSize(1)).toBe(1);
    expect(effectiveSize(3)).toBe(3);
    expect(effectiveSize(8)).toBe(8);
  });

  it("falls back to 0 when no size is set", () => {
    expect(effectiveSize(null)).toBe(0);
    expect(effectiveSize(undefined)).toBe(0);
  });

  it("counts a size that is not on the point scale as unsized, not as points", () => {
    expect(effectiveSize(0)).toBe(0);
    expect(effectiveSize(-2)).toBe(0);
    expect(effectiveSize(Number.NaN)).toBe(0);
    expect(effectiveSize(Number.POSITIVE_INFINITY)).toBe(0);
    // A stored fraction is rounded to whole points, as the comment on the helper promises.
    expect(effectiveSize(3.4)).toBe(3);
    expect(effectiveSize(3.6)).toBe(4);
  });
});
