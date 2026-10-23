import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { decisions, features } from "../src/db/schema.js";

const DAY = 86_400_000;
let ctx: Awaited<ReturnType<typeof setup>>;
afterEach(async () => {
  await ctx.app.close();
  await ctx.close();
});

type Json = Record<string, any>;

async function setup() {
  const { db, close } = await openPglite();
  let offset = 0;
  const clock = () => new Date(Date.now() + offset);
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws", now: clock });
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = async (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => {
    const r = await built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
    return { status: r.statusCode, body: r.json() as Json };
  };
  const { company } = (await req("POST", "/api/companies", { name: "Goal Co" })).body as { company: { id: string } };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "App" })).body as { id: string };
  const objective = (await req("POST", `/api/companies/${company.id}/objectives`, { title: "Grow", priority: 1 })).body;
  const kr = (await req("POST", `/api/objectives/${objective.id}/key-results`, { title: "Signups", target: 100, current: 40, unit: "users" })).body;
  const feature = async (body: Record<string, unknown> = {}) => (await req("POST", `/api/companies/${company.id}/features`, { title: "Invite links", ...body })).body;
  const row = async (id: string) => (await db.select().from(features).where(eq(features.id, id)))[0]!;
  const open = async () => (await db.select().from(decisions).where(eq(decisions.status, "open"))).filter((d) => (d.context as Json).type === "goal_check");
  const advance = (ms: number) => (offset += ms);
  return { ...built, db, close, req, company, project, objective, kr, feature, row, open, advance, clock };
}

describe("did it move the goal? follow-up", () => {
  it("schedules one follow-up when a feature linked to a key result is released, 14 days out by default", async () => {
    ctx = await setup();
    const f = await ctx.feature({ objectiveId: ctx.objective.id });
    expect((await ctx.row(f.id)).goalCheckDueAt).toBeNull();
    const t0 = ctx.clock().getTime();
    await ctx.req("PATCH", `/api/features/${f.id}`, { status: "released" });
    const due = (await ctx.row(f.id)).goalCheckDueAt!.getTime();
    expect(Math.abs(due - (t0 + 14 * DAY))).toBeLessThan(5_000);
  });

  it("also schedules from a ticket linked to a key result, and uses the company's delay", async () => {
    ctx = await setup();
    await ctx.req("PATCH", `/api/companies/${ctx.company.id}`, { goalCheckDays: 3 });
    const f = await ctx.feature();
    await ctx.req("POST", `/api/projects/${ctx.project.id}/tickets`, { title: "Build it", featureId: f.id, keyResultId: ctx.kr.id });
    const t0 = ctx.clock().getTime();
    await ctx.req("PATCH", `/api/features/${f.id}`, { status: "released" });
    expect(Math.abs((await ctx.row(f.id)).goalCheckDueAt!.getTime() - (t0 + 3 * DAY))).toBeLessThan(5_000);
  });

  it("re-releasing does not add a second follow-up", async () => {
    ctx = await setup();
    const f = await ctx.feature({ objectiveId: ctx.objective.id });
    await ctx.req("PATCH", `/api/features/${f.id}`, { status: "released" });
    const first = (await ctx.row(f.id)).goalCheckDueAt!;
    ctx.advance(20 * DAY);
    await ctx.req("PATCH", `/api/features/${f.id}`, { status: "in_progress" });
    await ctx.req("PATCH", `/api/features/${f.id}`, { status: "released" });
    expect((await ctx.row(f.id)).goalCheckDueAt).toEqual(first);
    await ctx.req("POST", "/api/sweep");
    await ctx.req("POST", "/api/sweep");
    expect(await ctx.open()).toHaveLength(1);
  });

  it("raises one decision when due, showing current against target, and stores the answer on the feature", async () => {
    ctx = await setup();
    const f = await ctx.feature({ objectiveId: ctx.objective.id });
    await ctx.req("PATCH", `/api/features/${f.id}`, { status: "released" });

    ctx.advance(13 * DAY);
    await ctx.req("POST", "/api/sweep");
    expect(await ctx.open()).toHaveLength(0);

    ctx.advance(2 * DAY);
    await ctx.req("POST", "/api/sweep");
    await ctx.req("POST", "/api/sweep");
    const [d] = await ctx.open();
    expect(await ctx.open()).toHaveLength(1);
    expect(d!.question).toContain("Invite links");
    expect(d!.question).toContain("Signups: now 40 users, target 100 users");
    expect(d!.options).toEqual(["Keep", "Change", "Drop"]);

    expect((await ctx.req("POST", `/api/decisions/${d!.id}/answer`, { answer: "Maybe" })).status).toBe(422);
    expect((await ctx.req("POST", `/api/decisions/${d!.id}/answer`, { answer: "Change" })).status).toBe(200);
    const stored = await ctx.row(f.id);
    expect(stored.goalCheckAnswer).toBe("Change");
    expect(stored.goalCheckAnsweredAt).not.toBeNull();
    const detail = (await ctx.req("GET", `/api/features/${f.id}`)).body;
    expect(detail.feature.goalCheckAnswer).toBe("Change");
  });

  it("leaves a feature with no linked key result alone", async () => {
    ctx = await setup();
    const f = await ctx.feature();
    await ctx.req("PATCH", `/api/features/${f.id}`, { status: "released" });
    ctx.advance(30 * DAY);
    await ctx.req("POST", "/api/sweep");
    const r = await ctx.row(f.id);
    expect(r.goalCheckDueAt).toBeNull();
    expect(await ctx.open()).toHaveLength(0);
  });

  it("schedules a feature created already released", async () => {
    ctx = await setup();
    const f = await ctx.feature({ objectiveId: ctx.objective.id, status: "released" });
    expect((await ctx.row(f.id)).goalCheckDueAt).not.toBeNull();
  });

  it("schedules a feature linked only through its milestone, and does not re-ask after the answer", async () => {
    ctx = await setup();
    const m = (await ctx.req("POST", `/api/objectives/${ctx.objective.id}/milestones`, { title: "Beta" })).body;
    const f = await ctx.feature({ milestoneId: m.id });
    await ctx.req("PATCH", `/api/features/${f.id}`, { status: "released" });
    expect((await ctx.row(f.id)).goalCheckDueAt).not.toBeNull();
    ctx.advance(15 * DAY);
    await ctx.req("POST", "/api/sweep");
    const [d] = await ctx.open();
    expect(d).toBeDefined();
    expect((await ctx.req("POST", `/api/decisions/${d!.id}/answer`, { answer: "Keep" })).status).toBe(200);
    ctx.advance(10 * DAY);
    await ctx.req("POST", "/api/sweep");
    await ctx.req("POST", "/api/sweep");
    expect(await ctx.open()).toHaveLength(0);
    expect((await ctx.row(f.id)).goalCheckAnswer).toBe("Keep");
  });

  it("rejects a nonsense delay", async () => {
    ctx = await setup();
    expect((await ctx.req("PATCH", `/api/companies/${ctx.company.id}`, { goalCheckDays: 0 })).status).toBe(400);
  });
});
