// BOS-2581 (step 3 of the milestones work): the owner puts a milestone in the CEO's hands with "CEO manages at risk"
// (off by default). Each sweep asks the Roadmap's own status rule for every managed milestone and wakes that company's
// CEO once each time one turns At risk or Late, with the milestone's title, its date and the reason line under its badge.
// A switched-off milestone never wakes anyone, and a status that stays the same never wakes twice. The switch is saved on
// the milestone (the PATCH), and "on for all" sets every milestone of the company at once (the POST), both off by default.
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { ceoPlanWake, needsCeoPlan } from "@boss-man/shared";
import { decisions, milestones as msTable, settings, ticketDependencies, tickets as ticketsTable, agents } from "../src/db/schema.js";
import { milestoneRiskService, reasonForWake } from "../src/services/milestone-risk.js";
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
  const { company, ceo } = (await req("POST", "/api/companies", { name: "App Co", ceo: { name: "Chief", agentKind: "claude", model: "claude-opus-5-5" } })).json() as { company: { id: string }; ceo: { id: string } };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Customer app" })).json() as { id: string };
  const ticket = async (title: string, fields: Record<string, unknown> = {}) => (await req("POST", `/api/projects/${project.id}/tickets`, { title, ...fields })).json() as { id: string; number: number };
  const objective = async (title = "Ship it") => (await req("POST", `/api/companies/${company.id}/objectives`, { title, priority: 1 })).json() as { id: string; title: string; priority: number };
  const milestone = async (objectiveId: string, title: string, targetDate?: string) => (await req("POST", `/api/objectives/${objectiveId}/milestones`, { title, ...(targetDate ? { targetDate } : {}) })).json() as { id: string; title: string; ceoManagesRisk: boolean };
  const woken: Array<{ agentId: string; reason: string; note: string }> = [];
  return { req, company, project, ticket, objective, milestone, ceo, woken, db: t!.db, planning: t!.planning };
}

/** A milestone that is At risk now: its date has passed with work left, so the badge is Late (also one the CEO manages). */
async function lateNow(c: Awaited<ReturnType<typeof setup>>, title = "Launch") {
  const o = await c.objective();
  const m = await c.milestone(o.id, title, "2026-10-10");
  await c.ticket("Done work", { milestoneId: m.id, state: "done" });
  await c.ticket("Left to build", { milestoneId: m.id, state: "in_progress" });
  const read = (await c.req("GET", "/api/roadmap?today=2026-10-16")).json()[0].objectives[0].milestones[0] as { status: string; reason: string | null };
  return { o, m, read };
}

const sweep = (c: Awaited<ReturnType<typeof setup>>, now: string) =>
  milestoneRiskService(c.db, {
    planning: c.planning,
    wake: async (input) => {
      c.woken.push(input);
      // The scheduler's wake row, with its id: since BOS-2633 a tell counts only when it resolved with a real row.
      return { id: `wake-${c.woken.length}`, outcome: "queued" };
    },
    now: () => new Date(`${now}T09:00:00Z`),
  });

describe("milestone at risk: the switch is off by default and saved per milestone (BOS-2581)", () => {
  it("a new milestone is off; turning it on saves it and turning it off again saves that", async () => {
    const c = await setup();
    const o = await c.objective();
    const m = await c.milestone(o.id, "Launch", "2026-10-20");
    expect(m.ceoManagesRisk).toBe(false);
    const read = async () => (await c.req("GET", "/api/roadmap?today=2026-10-16")).json()[0].objectives[0].milestones[0].ceoManagesRisk as boolean;
    expect(await read()).toBe(false);
    expect((await c.req("PATCH", `/api/milestones/${m.id}`, { ceoManagesRisk: true })).json().ceoManagesRisk).toBe(true);
    expect(await read()).toBe(true);
    expect((await c.req("PATCH", `/api/milestones/${m.id}`, { ceoManagesRisk: false })).json().ceoManagesRisk).toBe(false);
    expect(await read()).toBe(false);
  });

  it("on for all sets every milestone of the company at once, and turning it off does too", async () => {
    const c = await setup();
    const o1 = await c.objective("One");
    const o2 = await c.objective("Two");
    const a = await c.milestone(o1.id, "A", "2026-10-20");
    const b = await c.milestone(o1.id, "B");
    const d = await c.milestone(o2.id, "D", "2026-12-01");
    const all = async () =>
      ((await c.req("GET", "/api/roadmap?today=2026-10-16")).json()[0].objectives as Array<{ milestones: Array<{ id: string; ceoManagesRisk: boolean }> }>).flatMap((o) => o.milestones).map((m) => [m.id, m.ceoManagesRisk]);
    expect(await all()).toEqual([[a.id, false], [b.id, false], [d.id, false]]);
    const res = await c.req("POST", `/api/companies/${c.company.id}/milestones/ceo-manages-risk`, { on: true });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ changed: 3, on: true });
    expect(await all()).toEqual([[a.id, true], [b.id, true], [d.id, true]]);
    await c.req("POST", `/api/companies/${c.company.id}/milestones/ceo-manages-risk`, { on: false });
    expect(await all()).toEqual([[a.id, false], [b.id, false], [d.id, false]]);
  });
});

describe("milestone at risk: who wakes the CEO, and when (BOS-2581)", () => {
  it("a switched-on milestone that is Late wakes the CEO once, with its title, date and the reason line", async () => {
    const c = await setup();
    const { m, read } = await lateNow(c);
    expect(read.status).toBe("late");
    await c.req("PATCH", `/api/milestones/${m.id}`, { ceoManagesRisk: true });
    expect(await sweep(c, "2026-10-16").run()).toEqual({ woken: 1 });
    expect(c.woken).toHaveLength(1);
    expect(c.woken[0]!.agentId).toBe(c.ceo.id);
    expect(c.woken[0]!.reason).toBe("milestone at risk");
    expect(c.woken[0]!.note).toContain('"Launch"');
    expect(c.woken[0]!.note).toContain("is now Late");
    expect(c.woken[0]!.note).toContain("Its date is 2026-10-10.");
    // Its reason line, with its "Late:" heading and full stop taken off: the sentence says the status once.
    expect(c.woken[0]!.note).toContain("is now Late: its date passed");
    expect(c.woken[0]!.note).toContain("and 1 ticket is not built and live yet. Its date is");
  });

  it("a switched-on milestone that is At risk wakes the CEO once, and says At risk", async () => {
    const c = await setup();
    const o = await c.objective();
    // Nothing finished lately, so no estimate, and it is due within 4 weeks: the At risk rule's third case.
    const m = await c.milestone(o.id, "Launch", "2026-10-30");
    const made = await c.ticket("Left to build", { milestoneId: m.id, state: "in_progress" });
    await c.db.update(ticketsTable).set({ size: 3 }).where(eq(ticketsTable.id, made.id));
    const read = (await c.req("GET", "/api/roadmap?today=2026-10-16")).json()[0].objectives[0].milestones[0] as { status: string; reason: string | null };
    expect(read.status).toBe("at_risk");
    await c.req("PATCH", `/api/milestones/${m.id}`, { ceoManagesRisk: true });
    expect(await sweep(c, "2026-10-16").run()).toEqual({ woken: 1 });
    expect(c.woken[0]!.note).toContain("is now At risk");
    expect(c.woken[0]!.note).toContain("nothing finished in the last 4 weeks");
  });

  it("a milestone At risk only because a ticket waits on the owner's card wakes the CEO and accepts a plan (BOS-2627)", async () => {
    const c = await setup();
    const o = await c.objective();
    // Due well out, with an estimate, so the pace and estimate rules stay quiet: the only reason is the open card.
    const m = await c.milestone(o.id, "Launch", "2026-12-30");
    const made = await c.ticket("Left to build", { milestoneId: m.id, state: "ready" });
    await c.db.update(ticketsTable).set({ size: 1 }).where(eq(ticketsTable.id, made.id));
    const [d] = await c.db.insert(decisions).values({ companyId: c.company.id, kind: "question", question: "Ship it this way?", options: ["Yes", "No"], recommendedOption: "Yes", raisedByAgentId: c.ceo.id }).returning();
    await c.db.insert(ticketDependencies).values({ blockedTicketId: made.id, blockerDecisionId: d!.id });
    const read = (await c.req("GET", "/api/roadmap?today=2026-10-16")).json()[0].objectives[0].milestones[0] as { status: string; reason: string | null };
    expect(read.status).toBe("at_risk");
    expect(read.reason).toContain("waits on your card");
    await c.req("PATCH", `/api/milestones/${m.id}`, { ceoManagesRisk: true });
    // The screen says At risk, so the wake and set_plan must agree rather than working it out differently.
    expect(await sweep(c, "2026-10-16").run()).toEqual({ woken: 1 });
    expect(c.woken[0]!.note).toContain("is now At risk");
    expect((await c.req("PATCH", `/api/milestones/${m.id}`, { ceoPlan: "Ask the owner for a yes on the card." })).statusCode).toBe(200);
    const after = (await c.req("GET", "/api/roadmap?today=2026-10-16")).json()[0].objectives[0].milestones[0] as { ceoPlan: string | null };
    expect(after.ceoPlan).toBe("Ask the owner for a yes on the card.");
  });

  it("a switched-off milestone never wakes the CEO, however at risk it is", async () => {
    const c = await setup();
    const { read } = await lateNow(c);
    expect(read.status).toBe("late");
    expect(await sweep(c, "2026-10-16").run()).toEqual({ woken: 0 });
    expect(c.woken).toEqual([]);
  });

  it("no repeat wake while the status stays the same, and no second wake when it turns Late from At risk", async () => {
    const c = await setup();
    const { m } = await lateNow(c);
    await c.req("PATCH", `/api/milestones/${m.id}`, { ceoManagesRisk: true });
    expect(await sweep(c, "2026-10-16").run()).toEqual({ woken: 1 });
    expect(await sweep(c, "2026-10-17").run()).toEqual({ woken: 0 });
    expect(await sweep(c, "2026-10-18").run()).toEqual({ woken: 0 });
    expect(c.woken).toHaveLength(1);
  });

  it("a milestone that clears and turns Late again wakes once more", async () => {
    const c = await setup();
    const { m } = await lateNow(c);
    await c.req("PATCH", `/api/milestones/${m.id}`, { ceoManagesRisk: true });
    expect(await sweep(c, "2026-10-16").run()).toEqual({ woken: 1 });
    // On track: its date moves well ahead, so the status leaves At risk/Late and the wake is reset.
    await c.db.update(msTable).set({ targetDate: "2027-03-01" }).where(eq(msTable.id, m.id));
    expect((await c.req("GET", "/api/roadmap?today=2026-10-17")).json()[0].objectives[0].milestones[0].status).toBe("on_track");
    expect(await sweep(c, "2026-10-17").run()).toEqual({ woken: 0 });
    // Back in the past with work left: Late again, and a new wake.
    await c.db.update(msTable).set({ targetDate: "2026-10-15" }).where(eq(msTable.id, m.id));
    expect(await sweep(c, "2026-10-18").run()).toEqual({ woken: 1 });
    expect(c.woken).toHaveLength(2);
  });

  it("switching it off and on again starts afresh, so a Late milestone wakes once more", async () => {
    const c = await setup();
    const { m } = await lateNow(c);
    await c.req("PATCH", `/api/milestones/${m.id}`, { ceoManagesRisk: true });
    expect(await sweep(c, "2026-10-16").run()).toEqual({ woken: 1 });
    expect(await sweep(c, "2026-10-16").run()).toEqual({ woken: 0 });
    await c.req("PATCH", `/api/milestones/${m.id}`, { ceoManagesRisk: false });
    expect(await sweep(c, "2026-10-16").run()).toEqual({ woken: 0 });
    // Its last wake is forgotten while it is off (the setting goes).
    expect(await c.db.select().from(settings).where(eq(settings.key, `milestone_risk:${m.id}`))).toEqual([]);
    await c.req("PATCH", `/api/milestones/${m.id}`, { ceoManagesRisk: true });
    expect(await sweep(c, "2026-10-16").run()).toEqual({ woken: 1 });
    expect(c.woken).toHaveLength(2);
  });

  it("with nothing managed the pass reads no milestone's tickets at all, so the switch's default costs the sweep nothing", async () => {
    const c = await setup();
    const { m } = await lateNow(c);
    await c.req("GET", "/api/roadmap?today=2026-10-16"); // the fixture's own read, before counting
    let asked: string[] = [];
    const counted = milestoneRiskService(c.db, {
      planning: { managedMilestones: async (today: string) => ((asked.push(today), [])) } as unknown as typeof c.planning,
      wake: async () => ({ id: "w0", outcome: "queued" }),
      now: () => new Date("2026-10-16T09:00:00Z"),
    });
    expect(await counted.run()).toEqual({ woken: 0 });
    expect(asked).toEqual([]);
    // Switched on, the pass asks for the managed milestone and gets exactly that one, not the whole roadmap.
    await c.req("PATCH", `/api/milestones/${m.id}`, { ceoManagesRisk: true });
    const one = await c.planning.managedMilestones("2026-10-16");
    expect(one.map((x) => x.id)).toEqual([m.id]);
    expect(one[0]).toMatchObject({ status: "late", company: "App Co", objective: "Ship it" });
  });

  it("nothing managed means nobody is woken, and the wake goes to that company's own CEO", async () => {
    const c = await setup();
    await c.objective();
    expect(await sweep(c, "2026-10-16").run()).toEqual({ woken: 0 });
    const { m } = await lateNow(c, "Second");
    await c.req("PATCH", `/api/milestones/${m.id}`, { ceoManagesRisk: true });
    expect(await sweep(c, "2026-10-16").run()).toEqual({ woken: 1 });
    expect(c.woken.map((w) => w.agentId)).toEqual([c.ceo.id]);
  });
});

describe("milestone at risk: the wake goes through tellOnce (BOS-2633)", () => {
  /** A sweep that records what the pass logged, with the wake's outcome (or a throw) under the test's control. */
  const through = (c: Awaited<ReturnType<typeof setup>>, now: string, wake: () => Promise<unknown>) => {
    const logs: string[] = [];
    const service = milestoneRiskService(c.db, { planning: c.planning, wake: async (input) => ((c.woken.push(input), wake())), now: () => new Date(`${now}T09:00:00Z`), log: (m) => logs.push(m) });
    return { logs, service };
  };

  it("a wake that was not saved counts as not told, is logged once, and the next pass tries again", async () => {
    const c = await setup();
    const { m } = await lateNow(c);
    await c.req("PATCH", `/api/milestones/${m.id}`, { ceoManagesRisk: true });
    // wake() saying null is what a sweep gets when nothing was saved: tellOnce answers null, so the milestone is not woken.
    const first = through(c, "2026-10-16", async () => null);
    expect(await first.service.run()).toEqual({ woken: 0 });
    expect(c.woken).toHaveLength(1);
    expect(first.logs.some((l) => l.includes('"milestone at risk Launch') && l.includes("nothing was sent"))).toBe(true);
    // The row stays "not woken yet", so the next pass tries again and, this time, it goes through.
    const [kept] = await c.db.select().from(settings).where(eq(settings.key, `milestone_risk:${m.id}`));
    expect(kept!.value).toMatchObject({ status: null });
    expect(await through(c, "2026-10-17", async () => ({ id: "w1", outcome: "queued" })).service.run()).toEqual({ woken: 1 });
    expect(c.woken).toHaveLength(2);
  });

  it("a company with no CEO is not woken and nothing is logged every pass, and the wake happens once a CEO exists", async () => {
    const c = await setup();
    const { m } = await lateNow(c);
    await c.req("PATCH", `/api/milestones/${m.id}`, { ceoManagesRisk: true });
    // No CEO: there is nobody to tell, so no wake is attempted and the pass says nothing (BOS-2633, to keep a no-CEO
    // company from logging a line, and risking an owner card through BOS-2160, on every pass for every managed milestone).
    await c.db.update(agents).set({ retiredAt: new Date("2026-10-01T00:00:00Z") }).where(eq(agents.id, c.ceo.id));
    const first = through(c, "2026-10-16", async () => ({ id: "never", outcome: "queued" }));
    expect(await first.service.run()).toEqual({ woken: 0 });
    expect(c.woken).toHaveLength(0);
    expect(first.logs).toEqual([]);
    // Two more passes stay quiet, and the row stays "not woken yet".
    expect(await through(c, "2026-10-17", async () => ({ id: "never", outcome: "queued" })).service.run()).toEqual({ woken: 0 });
    expect(first.logs).toEqual([]);
    const [kept] = await c.db.select().from(settings).where(eq(settings.key, `milestone_risk:${m.id}`));
    expect(kept!.value).toMatchObject({ status: null });
    // A CEO is hired: the next pass wakes them, because the milestone was never marked woken.
    await c.db.update(agents).set({ retiredAt: null }).where(eq(agents.id, c.ceo.id));
    expect(await through(c, "2026-10-18", async () => ({ id: "w1", outcome: "queued" })).service.run()).toEqual({ woken: 1 });
    expect(c.woken.map((w) => w.agentId)).toEqual([c.ceo.id]);
  });

  it("a wake that throws is logged by tellOnce, the pass carries on, and the next pass wakes the CEO", async () => {
    const c = await setup();
    const { m } = await lateNow(c);
    await c.req("PATCH", `/api/milestones/${m.id}`, { ceoManagesRisk: true });
    const first = through(c, "2026-10-16", async () => {
      throw new Error("scheduler unavailable");
    });
    // tellOnce swallows the error on purpose: the sweep step must not go down for one failed tell.
    expect(await first.service.run()).toEqual({ woken: 0 });
    expect(first.logs.some((l) => l.includes("scheduler unavailable"))).toBe(true);
    const [kept] = await c.db.select().from(settings).where(eq(settings.key, `milestone_risk:${m.id}`));
    expect(kept!.value).toMatchObject({ status: null });
    expect(await through(c, "2026-10-17", async () => ({ id: "w2", outcome: "queued" })).service.run()).toEqual({ woken: 1 });
    expect(c.woken).toHaveLength(2);
  });

  it("a dropped wake is retried, and only a wake that really started goes quiet", async () => {
    const c = await setup();
    const { m } = await lateNow(c);
    await c.req("PATCH", `/api/milestones/${m.id}`, { ceoManagesRisk: true });
    const first = through(c, "2026-10-16", async () => ({ id: "w3", outcome: "dropped" }));
    expect(await first.service.run()).toEqual({ woken: 0 });
    expect(first.logs.some((l) => l.includes("dropped"))).toBe(true);
    expect(await through(c, "2026-10-17", async () => ({ id: "w4", outcome: "queued" })).service.run()).toEqual({ woken: 1 });
    expect(await through(c, "2026-10-18", async () => ({ id: "w5", outcome: "queued" })).service.run()).toEqual({ woken: 0 });
    expect(c.woken).toHaveLength(2);
  });
});

describe("milestone at risk: the wake is never lost (BOS-2627, kept through tellOnce)", () => {
  /** A sweep whose wake goes through a scheduler-like queue: outcomes are whatever `outcome` says, and failures throw. */
  const queued = (c: Awaited<ReturnType<typeof setup>>, now: string, outcome: { value: unknown } | (() => unknown)) => {
    const logs: string[] = [];
    const service = milestoneRiskService(c.db, {
      planning: c.planning,
      wake: async (input) => {
        c.woken.push(input);
        return typeof outcome === "function" ? outcome() : outcome.value;
      },
      now: () => new Date(`${now}T09:00:00Z`),
      log: (m) => logs.push(m),
    });
    return { service, logs };
  };

  it("a wake that was not started (dropped) is tried again next pass, and only a real wake keeps it quiet", async () => {
    const c = await setup();
    const { m } = await lateNow(c);
    await c.req("PATCH", `/api/milestones/${m.id}`, { ceoManagesRisk: true });
    // The first pass's wake comes back "dropped": the milestone was not woken, so the next pass tries again.
    expect(await queued(c, "2026-10-16", { value: { id: "w1", outcome: "dropped" } }).service.run()).toEqual({ woken: 0 });
    const [kept] = await c.db.select().from(settings).where(eq(settings.key, `milestone_risk:${m.id}`));
    expect(kept!.value).toMatchObject({ status: null, managed: true, woke: false });
    // Next pass: this time it really starts; the CEO is woken and it goes quiet.
    expect(await queued(c, "2026-10-17", { value: { id: "w2", outcome: "queued" } }).service.run()).toEqual({ woken: 1 });
    expect(c.woken).toHaveLength(2);
    expect(await queued(c, "2026-10-18", { value: { id: "w3", outcome: "queued" } }).service.run()).toEqual({ woken: 0 });
    expect(c.woken).toHaveLength(2);
  });

  it("a wake that throws doesn't record the milestone as woken, so the next pass wakes the CEO", async () => {
    const c = await setup();
    const { m } = await lateNow(c);
    await c.req("PATCH", `/api/milestones/${m.id}`, { ceoManagesRisk: true });
    // tellOnce answers null for a throw (it logs it and the pass carries on), so nothing is recorded as woken.
    const first = queued(c, "2026-10-16", () => {
      throw new Error("scheduler unavailable");
    });
    expect(await first.service.run()).toEqual({ woken: 0 });
    expect(first.logs.some((l) => l.includes("scheduler unavailable"))).toBe(true);
    const [kept] = await c.db.select().from(settings).where(eq(settings.key, `milestone_risk:${m.id}`));
    expect(kept!.value).toMatchObject({ status: null });
    // Nobody was recorded as woken, so turning the switch on is not silently lost: the next pass wakes.
    expect(await sweep(c, "2026-10-17").run()).toEqual({ woken: 1 });
  });

  it("a pass skipped by an update hold wakes the CEO on the first pass after the hold, exactly once", async () => {
    const c = await setup();
    const { m } = await lateNow(c);
    await c.req("PATCH", `/api/milestones/${m.id}`, { ceoManagesRisk: true });
    // The sweep step is `if (!held && opts.milestoneRisk)`: while held, run() is never called, so nothing is recorded.
    // The first pass after the hold sees wasManaged false and wakes once.
    expect(await sweep(c, "2026-10-16").run()).toEqual({ woken: 1 });
    expect(await sweep(c, "2026-10-17").run()).toEqual({ woken: 0 });
    expect(c.woken).toHaveLength(1);
  });

  it("a row written under the old code (status recorded, wake never sent) still wakes the CEO once after the update", async () => {
    const c = await setup();
    const { m } = await lateNow(c);
    await c.req("PATCH", `/api/milestones/${m.id}`, { ceoManagesRisk: true });
    // f8969188 recorded the status on the pass that turned the switch on, whether or not the wake started, and swallowed
    // the failure. So a live row can say {status: "late", managed: true} with no wake ever reaching the CEO.
    await c.db.insert(settings).values({ key: `milestone_risk:${m.id}`, value: { status: "late", managed: true } });
    // The first pass after 25dcf039 must not read that as "already woken": it wakes once, then goes quiet.
    expect(await sweep(c, "2026-10-17").run()).toEqual({ woken: 1 });
    expect(await sweep(c, "2026-10-17").run()).toEqual({ woken: 0 });
    expect(c.woken).toHaveLength(1);
  });

  it("a row that records the status but says the wake had not started (status null) wakes on the next pass", async () => {
    const c = await setup();
    const { m } = await lateNow(c);
    await c.req("PATCH", `/api/milestones/${m.id}`, { ceoManagesRisk: true });
    await c.db.insert(settings).values({ key: `milestone_risk:${m.id}`, value: { status: null, managed: true } });
    expect(await sweep(c, "2026-10-17").run()).toEqual({ woken: 1 });
    expect(await sweep(c, "2026-10-17").run()).toEqual({ woken: 0 });
  });

  it("switching the switch on for an already At risk milestone wakes once, however long it has been At risk", async () => {
    const c = await setup();
    const o = await c.objective();
    const m = await c.milestone(o.id, "Launch", "2026-10-30");
    const made = await c.ticket("Left to build", { milestoneId: m.id, state: "in_progress" });
    await c.db.update(ticketsTable).set({ size: 3 }).where(eq(ticketsTable.id, made.id));
    // It has been At risk for days with nothing recorded; the owner turns the switch on now.
    expect((await c.req("GET", "/api/roadmap?today=2026-10-16")).json()[0].objectives[0].milestones[0].status).toBe("at_risk");
    await c.req("PATCH", `/api/milestones/${m.id}`, { ceoManagesRisk: true });
    expect(await sweep(c, "2026-10-16").run()).toEqual({ woken: 1 });
    expect(c.woken[0]!.note).toContain("is now At risk");
  });

  it("doesn't wake twice while the status stays the same, once the wake has really started (BOS-2650)", async () => {
    const c = await setup();
    const { m } = await lateNow(c);
    await c.req("PATCH", `/api/milestones/${m.id}`, { ceoManagesRisk: true });
    const started = new Map<string, { status: string }>([["wake-1", { status: "queued" }]]);
    const at = (now: string) =>
      milestoneRiskService(c.db, {
        planning: c.planning,
        wake: async (input) => (c.woken.push(input), { id: `wake-${c.woken.length}`, outcome: "queued" }),
        wakeStatus: async (id) => started.get(id) ?? null,
        now: () => new Date(`${now}T09:00:00Z`),
      });
    expect(await at("2026-10-16").run()).toEqual({ woken: 1 });
    // The CEO's run started: the wake's row left "queued". Later passes stay quiet.
    started.set("wake-1", { status: "running" });
    expect(await at("2026-10-16").run()).toEqual({ woken: 0 });
    expect(await at("2026-10-16").run()).toEqual({ woken: 0 });
    expect(c.woken).toHaveLength(1);
  });

  it("a row from the broken version that said the wake started, whose wake row no longer exists, wakes the CEO again (BOS-2653)", async () => {
    const c = await setup();
    const { m } = await lateNow(c);
    await c.req("PATCH", `/api/milestones/${m.id}`, { ceoManagesRisk: true });
    // 33ee0c0e9 wrote woke: true when the wake was saved; if that wake never started, its row is gone (or was never readable),
    // so a row claiming "woken" must not go quiet for good.
    await c.db.insert(settings).values({ key: `milestone_risk:${m.id}`, value: { status: "late", managed: true, woke: true, sentAt: "gone-wake" } });
    const at = (now: string) =>
      milestoneRiskService(c.db, {
        planning: c.planning,
        wake: async (input) => (c.woken.push(input), { id: `wake-${c.woken.length}`, outcome: "running" }),
        // Only the stale row's wake is gone; the wake this pass sends starts at once.
        wakeStatus: async (id) => (id === "gone-wake" ? null : { status: "launched", createdAt: `${now}T09:00:00Z` }),
        now: () => new Date(`${now}T09:00:00Z`),
      });
    expect(await at("2026-10-16").run()).toEqual({ woken: 1 });
    expect(await at("2026-10-16").run()).toEqual({ woken: 0 });
    expect(c.woken).toHaveLength(1);
  });

  it("a wake saved but still waiting to start is sent again, but only once per grace window (BOS-2650, BOS-2653)", async () => {
    const c = await setup();
    const { m } = await lateNow(c);
    await c.req("PATCH", `/api/milestones/${m.id}`, { ceoManagesRisk: true });
    // The scheduler held it (quiet hours, or a quota hold): the row says "queued" and nothing ever started. The wake's
    // row carries the real send time its grace is measured from (`sentAt` holds its id, not a time).
    const savedAt = new Map<string, string>([["wake-1", "2026-10-16T09:00:00Z"]]);
    // The clock advances by minutes from the first pass; a queued wake is read back with the time it was saved.
    let nowAt = new Date("2026-10-16T09:00:00Z");
    const advance = (minutes: number) => (nowAt = new Date(nowAt.getTime() + minutes * 60_000));
    const wakeStatus = async (id: string): Promise<{ status: string; createdAt: string } | null> =>
      savedAt.has(id) ? { status: "queued", createdAt: savedAt.get(id)! } : { status: "running", createdAt: nowAt.toISOString() };
    const svc = () =>
      milestoneRiskService(c.db, {
        planning: c.planning,
        wake: async (input) => {
          c.woken.push(input);
          const id = `wake-${c.woken.length}`;
          savedAt.set(id, nowAt.toISOString());
          return { id, outcome: "queued" };
        },
        wakeStatus,
        now: () => nowAt,
      });
    expect(await svc().run()).toEqual({ woken: 1 });
    // Five minutes on, the first wake is still waiting: inside the grace, so nothing is sent.
    advance(5);
    expect(await svc().run()).toEqual({ woken: 0 });
    // Half an hour after it was saved, the first wake is still waiting: send once, and the note says why.
    advance(26);
    expect(await svc().run()).toEqual({ woken: 1 });
    expect(c.woken).toHaveLength(2);
    expect(c.woken[1]!.note).toContain("still plan it and record it");
    // Five minutes after the second send is still inside its own grace: nothing more.
    advance(5);
    expect(await svc().run()).toEqual({ woken: 0 });
    // The second one started (its row left "queued"), so later passes stay quiet.
    savedAt.delete("wake-2");
    advance(60);
    expect(await svc().run()).toEqual({ woken: 0 });
    expect(c.woken).toHaveLength(2);
  });

  // BOS-2843: the scheduler saves a held wake as "deferred", not "queued" (scheduler.wake's hold; tick()'s quota, budget
  // and limit holds move a queued one there). Before, only "queued" was read as waiting, so a held wake counted as told.
  it("a wake the scheduler holds as deferred is sent again after the grace, once (BOS-2843)", async () => {
    const c = await setup();
    const { m } = await lateNow(c);
    await c.req("PATCH", `/api/milestones/${m.id}`, { ceoManagesRisk: true });
    const held = new Map<string, string>();
    let nowAt = new Date("2026-10-16T09:00:00Z");
    const advance = (minutes: number) => (nowAt = new Date(nowAt.getTime() + minutes * 60_000));
    const svc = () =>
      milestoneRiskService(c.db, {
        planning: c.planning,
        wake: async (input) => {
          c.woken.push(input);
          const id = `wake-${c.woken.length}`;
          held.set(id, nowAt.toISOString());
          return { id, outcome: "deferred" };
        },
        wakeStatus: async (id) => (held.has(id) ? { status: "deferred", createdAt: held.get(id)! } : { status: "launched", createdAt: nowAt.toISOString() }),
        now: () => nowAt,
      });
    expect(await svc().run()).toEqual({ woken: 1 });
    advance(5);
    expect(await svc().run()).toEqual({ woken: 0 });
    // Still held half an hour on: the CEO was never told, so it is sent again, saying so.
    advance(26);
    expect(await svc().run()).toEqual({ woken: 1 });
    expect(c.woken[1]!.note).toContain("still plan it and record it");
    // The second one starts: quiet from then on.
    held.delete("wake-2");
    advance(60);
    expect(await svc().run()).toEqual({ woken: 0 });
    expect(c.woken).toHaveLength(2);
  });

  it("a wake saved and later dropped by the scheduler is sent again on the next pass (BOS-2843)", async () => {
    const c = await setup();
    const { m } = await lateNow(c);
    await c.req("PATCH", `/api/milestones/${m.id}`, { ceoManagesRisk: true });
    const status = new Map<string, string>();
    const at = (now: string) =>
      milestoneRiskService(c.db, {
        planning: c.planning,
        wake: async (input) => {
          c.woken.push(input);
          const id = `wake-${c.woken.length}`;
          status.set(id, "queued");
          return { id, outcome: "queued" };
        },
        wakeStatus: async (id) => ({ status: status.get(id) ?? "launched", createdAt: "2026-10-16T09:00:00Z" }),
        now: () => new Date(`${now}T09:00:00Z`),
      });
    expect(await at("2026-10-16").run()).toEqual({ woken: 1 });
    // Saved as queued (so tellOnce counted it), then dropped before it started: the CEO was never told.
    status.set("wake-1", "dropped");
    expect(await at("2026-10-16").run()).toEqual({ woken: 1 });
    status.set("wake-2", "launched");
    expect(await at("2026-10-16").run()).toEqual({ woken: 0 });
    expect(c.woken).toHaveLength(2);
  });

  it("a switched-on milestone with no work turns At risk because tickets were added, and the CEO is woken once (BOS-2843)", async () => {
    const c = await setup();
    const o = await c.objective();
    const m = await c.milestone(o.id, "Ready for anyone to install", "2026-10-30");
    await c.req("PATCH", `/api/milestones/${m.id}`, { ceoManagesRisk: true });
    const started = new Set<string>();
    const svc = () =>
      milestoneRiskService(c.db, {
        planning: c.planning,
        wake: async (input) => (c.woken.push(input), { id: `wake-${c.woken.length}`, outcome: "queued" }),
        wakeStatus: async (id) => ({ status: started.has(id) ? "launched" : "queued", createdAt: "2026-10-16T09:00:00Z" }),
        now: () => new Date("2026-10-16T09:00:00Z"),
      });
    const status = async () => (await c.req("GET", "/api/roadmap?today=2026-10-16")).json()[0].objectives[0].milestones[0].status as string;
    expect(await status()).not.toBe("at_risk");
    expect(await svc().run()).toEqual({ woken: 0 });
    // A review adds a batch of tickets to it: nothing finished lately and due within 4 weeks, so it turns At risk.
    for (const title of ["Fix one", "Fix two", "Fix three"]) {
      const made = await c.ticket(title, { milestoneId: m.id, state: "ready" });
      await c.db.update(ticketsTable).set({ size: 2 }).where(eq(ticketsTable.id, made.id));
    }
    expect(await status()).toBe("at_risk");
    expect(await svc().run()).toEqual({ woken: 1 });
    started.add("wake-1");
    expect(await svc().run()).toEqual({ woken: 0 });
    expect(await svc().run()).toEqual({ woken: 0 });
    expect(c.woken).toHaveLength(1);
    expect(c.woken[0]!.note).toContain('"Ready for anyone to install"');
    expect(c.woken[0]!.note).toContain("is now At risk");
  });

  it("with no way to read the wake's row, a status change is still sent exactly once (BOS-2650)", async () => {
    const c = await setup();
    const { m } = await lateNow(c);
    await c.req("PATCH", `/api/milestones/${m.id}`, { ceoManagesRisk: true });
    expect(await sweep(c, "2026-10-16").run()).toEqual({ woken: 1 });
    expect(await sweep(c, "2026-10-16").run()).toEqual({ woken: 0 });
    expect(c.woken).toHaveLength(1);
  });

  it("a held wake whose row has no readable send time is treated as still waiting, so it isn't re-sent every pass (BOS-2653)", async () => {
    const c = await setup();
    const { m } = await lateNow(c);
    await c.req("PATCH", `/api/milestones/${m.id}`, { ceoManagesRisk: true });
    // A queued row with no time to measure from is the case that used to read as Invalid Date and re-send every pass.
    const at = (now: string) =>
      milestoneRiskService(c.db, {
        planning: c.planning,
        wake: async (input) => (c.woken.push(input), { id: `wake-${c.woken.length}`, outcome: "queued" }),
        wakeStatus: async (id) => (id === "wake-1" ? { status: "queued", createdAt: null } : { status: "running" }),
        now: () => new Date(`${now}T09:00:00Z`),
      });
    expect(await at("2026-10-16").run()).toEqual({ woken: 1 });
    // Same pass's clock but one later pass: the row can't be aged, so it stays quiet rather than re-sending.
    expect(await at("2026-10-16").run()).toEqual({ woken: 0 });
    expect(c.woken).toHaveLength(1);
  });
});

describe("milestone at risk: the CEO's plan line (BOS-2627)", () => {
  it("is read by the roadmap under the reason, then cleared once the milestone leaves At risk/Late", async () => {
    const c = await setup();
    const { m } = await lateNow(c);
    await c.req("PATCH", `/api/milestones/${m.id}`, { ceoManagesRisk: true });
    const res = await c.req("PATCH", `/api/milestones/${m.id}`, { ceoPlan: "Move the two unbuilt tickets to Zippy on Monday." });
    expect(res.statusCode).toBe(200);
    const read = async (today: string) => (await c.req("GET", `/api/roadmap?today=${today}`)).json()[0].objectives[0].milestones[0] as { status: string; ceoPlan: string | null };
    expect((await read("2026-10-16")).ceoPlan).toBe("Move the two unbuilt tickets to Zippy on Monday.");
    // On track (the date moves well out), the sweep clears the plan: the line has nothing left to explain.
    await c.db.update(msTable).set({ targetDate: "2027-03-01" }).where(eq(msTable.id, m.id));
    expect((await read("2026-10-17")).status).toBe("on_track");
    expect(await sweep(c, "2026-10-17").run()).toEqual({ woken: 0 });
    expect((await read("2026-10-17")).ceoPlan).toBeNull();
    expect((await c.db.select().from(msTable).where(eq(msTable.id, m.id)))[0]!.ceoPlan).toBeNull();
  });

  it("is refused on a milestone the CEO doesn't manage, or one that isn't At risk or Late", async () => {
    const c = await setup();
    const { m } = await lateNow(c);
    // Managed switch off.
    expect((await c.req("PATCH", `/api/milestones/${m.id}`, { ceoPlan: "A plan." })).statusCode).toBe(422);
    // Managed but on track.
    await c.req("PATCH", `/api/milestones/${m.id}`, { ceoManagesRisk: true });
    await c.db.update(msTable).set({ targetDate: "2027-03-01" }).where(eq(msTable.id, m.id));
    expect((await c.req("PATCH", `/api/milestones/${m.id}`, { ceoPlan: "A plan." })).statusCode).toBe(422);
  });

  it("the roadmap shows the plan only while the milestone needs one, whatever is stored", async () => {
    const c = await setup();
    const { m } = await lateNow(c);
    await c.req("PATCH", `/api/milestones/${m.id}`, { ceoManagesRisk: true });
    await c.req("PATCH", `/api/milestones/${m.id}`, { ceoPlan: "Hire a second pair of hands." });
    // Flip the status to on track without the sweep: the page still hides it, so a stale plan can't show.
    await c.db.update(msTable).set({ targetDate: "2027-03-01" }).where(eq(msTable.id, m.id));
    const read = (await c.req("GET", "/api/roadmap?today=2026-10-16")).json()[0].objectives[0].milestones[0] as { status: string; ceoPlan: string | null };
    expect(read.status).toBe("on_track");
    expect(read.ceoPlan).toBeNull();
  });
});

describe("milestone at risk: the rule (BOS-2581)", () => {
  it("At risk and Late are the statuses that need a plan; On track and the rest do not", () => {
    expect(needsCeoPlan("at_risk")).toBe(true);
    expect(needsCeoPlan("late")).toBe(true);
    for (const s of ["on_track", "live_checked", "done", "no_work", "no_date"] as const) expect(needsCeoPlan(s), s).toBe(false);
  });

  it("wakes on entering At risk or Late, never on staying, and a status outside it resets the wake", () => {
    expect(ceoPlanWake({ managed: true, wasManaged: false, status: "at_risk", lastWoken: null })).toBe(true);
    expect(ceoPlanWake({ managed: true, wasManaged: true, status: "at_risk", lastWoken: "at_risk" })).toBe(false);
    // At risk to Late is the same state: no second wake.
    expect(ceoPlanWake({ managed: true, wasManaged: true, status: "late", lastWoken: "at_risk" })).toBe(false);
    // On track in between resets it.
    expect(ceoPlanWake({ managed: true, wasManaged: true, status: "at_risk", lastWoken: "on_track" })).toBe(true);
    // Off never wakes.
    expect(ceoPlanWake({ managed: false, wasManaged: false, status: "late", lastWoken: null })).toBe(false);
  });
});

// BOS-2639: the wake quotes the reason line the Roadmap shows, without repeating its status heading or its last full stop.
describe("reasonForWake (BOS-2639)", () => {
  it("gives an empty string when there is no reason", () => {
    expect(reasonForWake(null)).toBe("");
    expect(reasonForWake("")).toBe("");
  });

  it("strips the At risk or Late heading and the final full stop", () => {
    expect(reasonForWake("At risk: Nothing finished in 4 weeks, due in 9 days.")).toBe("Nothing finished in 4 weeks, due in 9 days");
    expect(reasonForWake("Late: its date passed 6 days ago.")).toBe("its date passed 6 days ago");
  });

  it("keeps a full stop inside the line", () => {
    expect(reasonForWake("At risk: one ticket is late. Two more are unstarted.")).toBe("one ticket is late. Two more are unstarted");
  });

  it("leaves a line without a heading or final stop unchanged, trimmed", () => {
    expect(reasonForWake("  Nothing finished yet  ")).toBe("Nothing finished yet");
  });
});
