// One gate for every agent run (DR-049 point 1, BOS-938): a run starts only when the runner's latest report proves the
// fence works and the network guard is on, unless the owner chose to run without one on this platform.
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { RunnerCommand, SandboxReport } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { companies, decisions, runners, wakes } from "../src/db/schema.js";
import { agentHold, GUARD_HELD, GUARD_KEEP_STOPPED, GUARD_RUN_WITHOUT, guardHoldSweep, REPORT_STALE_MS, UNPROVEN_HELD, FENCE_HELD, FENCE_KEEP_STOPPED, FENCE_RUN_UNFENCED, fenceDefaultSweep } from "../src/services/fence-default.js";

const PLATFORM = { kernel: "6.1.0-test", dockerVersion: "27.0.1", osType: "linux" };
const report = (o: { level?: SandboxReport["level"]; guard?: "on" | "absent" | null; platform?: typeof PLATFORM | null } = {}): SandboxReport => ({
  landlockAbi: 6,
  errno: null,
  level: o.level ?? "full",
  missing: [],
  userns: false,
  probe: true,
  ...(o.guard === null ? {} : { guard: { state: o.guard ?? "on", reason: o.guard === "absent" ? "connected to the gateway" : "refused at once", errno: null, ms: 3 } }),
  ...(o.platform === null ? {} : { platform: o.platform ?? PLATFORM }),
});
type TestCompany = { fenceMode: string; fenceModeChosenAt: Date | null; fenceOffFingerprint: string | null; guardOffChosenAt: Date | null; guardOffFingerprint: string | null };
const company: TestCompany = { fenceMode: "watch", fenceModeChosenAt: null, fenceOffFingerprint: null, guardOffChosenAt: null, guardOffFingerprint: null };
const now = new Date("2026-11-13T12:00:00Z");

describe("agentHold, the pure rule", () => {
  const hold = (c: Partial<TestCompany>, r: SandboxReport | null, checkedAt: Date | null = now) => agentHold({ ...company, ...c }, r, checkedAt, { requireProof: true, now });
  const fp = "6.1.0-test|docker 27.0.1|linux";

  it("lets a run start when the fence works and the guard is on", () => {
    expect(hold({}, report())).toBeNull();
    expect(hold({}, report({ level: "partial" }))).toBeNull();
  });

  it("holds a runner that hasn't reported, or whose report is too old", () => {
    expect(hold({}, null, null)).toBe(UNPROVEN_HELD);
    expect(hold({}, report(), new Date(now.getTime() - REPORT_STALE_MS - 1))).toBe(UNPROVEN_HELD);
  });

  it("holds when the guard is absent, or was never reported, and says so", () => {
    expect(hold({}, report({ guard: "absent" }))).toBe(GUARD_HELD);
    expect(hold({}, report({ guard: null }))).toBe(GUARD_HELD);
    expect(GUARD_HELD).toContain("home network");
  });

  it("holds when the fence can't work, even with the guard on", () => {
    expect(hold({}, report({ level: "unavailable" }))).toBe(FENCE_HELD);
  });

  it("lets the owner's choice through only on the platform it was made on", () => {
    const chosen = { guardOffChosenAt: now, guardOffFingerprint: fp };
    expect(hold(chosen, report({ guard: "absent" }))).toBeNull();
    expect(hold(chosen, report({ guard: "absent", platform: { ...PLATFORM, kernel: "6.8.0-new" } }))).toBe(GUARD_HELD);
    expect(hold(chosen, report({ guard: "absent", platform: { ...PLATFORM, dockerVersion: "28.0.0" } }))).toBe(GUARD_HELD);
    expect(hold(chosen, report({ guard: "absent", platform: null }))).toBe(GUARD_HELD);
    const fenceChosen = { fenceMode: "off", fenceModeChosenAt: now, fenceOffFingerprint: fp };
    expect(hold(fenceChosen, report({ level: "unavailable" }))).toBeNull();
    expect(hold(fenceChosen, report({ level: "unavailable", platform: { ...PLATFORM, osType: "windows" } }))).toBe(FENCE_HELD);
  });

  it("a fence Off chosen in Settings (no fingerprint) never expires, but the guard is still asked", () => {
    const off = { fenceMode: "off", fenceModeChosenAt: now };
    expect(hold(off, report({ level: "unavailable", guard: "on" }))).toBeNull();
    expect(hold(off, report({ level: "unavailable", guard: "absent" }))).toBe(GUARD_HELD);
  });

  it("without requireProof only the fence is looked at (tests that connect a stand-in runner)", () => {
    expect(agentHold(company, null, null, { requireProof: false, now })).toBeNull();
    expect(agentHold(company, report({ guard: "absent" }), now, { requireProof: false, now })).toBeNull();
    expect(agentHold(company, report({ level: "unavailable" }), now, { requireProof: false, now })).toBe(FENCE_HELD);
  });
});

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.app.close();
  await ctx?.close();
  ctx = undefined;
});

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws", requireRunnerProof: true } as never);
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company: co, ceo } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string }; ceo: { id: string } };
  const project = (await req("POST", `/api/companies/${co.id}/projects`, { name: "App" })).json() as { id: string };
  const reg = (await req("POST", `/api/companies/${co.id}/runner`)).json() as { runnerId: string };
  const commands: Extract<RunnerCommand, { type: "run.start" }>[] = [];
  built.runners.connect(reg.runnerId, (c) => (c.type === "run.start" && commands.push(c), true), ["fence"]);
  const send = (r: SandboxReport, at = new Date()) => built.runners.recordSandbox(reg.runnerId, r, at);
  const tick = async () => {
    commands.length = 0;
    await req("POST", "/api/scheduler/tick");
    return commands[0];
  };
  await req("POST", `/api/projects/${project.id}/tickets`, { title: "Work", assigneeAgentId: ceo.id });
  return { ...built, db, close, req, co, commands, send, tick };
}

describe("the gate in the scheduler", () => {
  const waiting = (c: NonNullable<typeof ctx>) => c.db.select({ status: wakes.status, statusReason: wakes.statusReason }).from(wakes).where(and(eq(wakes.companyId, c.co.id), isNull(wakes.runId)));
  const cards = (c: NonNullable<typeof ctx>, type: string) => c.db.select().from(decisions).where(and(eq(decisions.companyId, c.co.id), sql`${decisions.context}->>'type' = ${type}`));

  it("holds work until the runner reports, then starts it once both features are proven", async () => {
    const c = (ctx = await setup());
    expect(await c.tick()).toBeUndefined();
    for (const w of await waiting(c)) expect(w).toMatchObject({ status: "queued", statusReason: UNPROVEN_HELD });
    await c.send(report());
    expect(await c.tick()).toBeDefined();
  });

  it("holds work when the guard is absent, says why, and starts it by itself once the guard is on", async () => {
    const c = (ctx = await setup());
    await c.send(report({ guard: "absent" }));
    expect(await c.tick()).toBeUndefined();
    for (const w of await waiting(c)) expect(w).toMatchObject({ status: "queued", statusReason: GUARD_HELD });
    await c.send(report({ guard: "on" }));
    expect(await c.tick()).toBeDefined();
  });

  it("still starts the owner's chat with the CEO (board tools only) while held", async () => {
    const c = (ctx = await setup());
    await c.send(report({ guard: "absent" }));
    expect((await c.req("POST", `/api/companies/${c.co.id}/chat`, { text: "How is it going?" })).statusCode).toBe(201);
    await c.tick();
    expect(c.commands.find((s) => s.boardToolsOnly)).toBeDefined();
  });

  it("raises one guard card per episode; answering Run without it starts the work, and a new kernel asks again", async () => {
    const c = (ctx = await setup());
    await c.send(report({ guard: "absent" }));
    expect(await guardHoldSweep(c.db, new Date())).toEqual({ raised: 1, released: 0 });
    for (let i = 0; i < 3; i++) expect(await guardHoldSweep(c.db, new Date())).toEqual({ raised: 0, released: 0 });
    const [card] = await cards(c, "guard_unavailable");
    expect(card).toMatchObject({ status: "open", options: [GUARD_KEEP_STOPPED, GUARD_RUN_WITHOUT], recommendedOption: GUARD_KEEP_STOPPED });
    expect((await c.req("POST", `/api/decisions/${card!.id}/answer`, { answer: GUARD_RUN_WITHOUT })).statusCode).toBe(200);
    const [row] = await c.db.select().from(companies).where(eq(companies.id, c.co.id));
    expect(row).toMatchObject({ guardOffFingerprint: "6.1.0-test|docker 27.0.1|linux" });
    expect(await c.tick()).toBeDefined();
    // The host's kernel changes: the choice no longer covers it, and the owner is asked again.
    await c.send(report({ guard: "absent", platform: { ...PLATFORM, kernel: "6.8.0-new" } }));
    expect(await c.tick()).toBeUndefined();
    expect(await guardHoldSweep(c.db, new Date())).toEqual({ raised: 1, released: 0 });
  });

  it("withdraws the guard card by itself once the guard is proven on", async () => {
    const c = (ctx = await setup());
    await c.send(report({ guard: "absent" }));
    await guardHoldSweep(c.db, new Date());
    await c.send(report({ guard: "on" }));
    expect(await guardHoldSweep(c.db, new Date())).toEqual({ raised: 0, released: 1 });
    expect((await cards(c, "guard_unavailable"))[0]).toMatchObject({ status: "withdrawn" });
  });

  it("Settings' two buttons: run without the guard, then keep agents stopped again", async () => {
    const c = (ctx = await setup());
    await c.send(report({ guard: "absent" }));
    expect((await c.req("POST", `/api/companies/${c.co.id}/safety-choice`, { feature: "guard", run: true })).statusCode).toBe(200);
    expect((await c.req("GET", `/api/companies/${c.co.id}/runner`)).json().safety).toMatchObject({ guard: { proven: false, runWithout: true } });
    expect(await c.tick()).toBeDefined();
    await c.req("POST", `/api/companies/${c.co.id}/safety-choice`, { feature: "guard", run: false });
    expect((await c.req("GET", `/api/companies/${c.co.id}/runner`)).json().safety).toMatchObject({ guard: { runWithout: false } });
    expect(await c.tick()).toBeUndefined();
  });

  it("the fence card's Run without the fence is kept with the platform too", async () => {
    const c = (ctx = await setup());
    await c.send(report({ level: "unavailable" }));
    expect(await fenceDefaultSweep(c.db, new Date())).toMatchObject({ heldCards: 1 });
    const [card] = await cards(c, "fence_unavailable");
    expect(card!.options).toEqual([FENCE_KEEP_STOPPED, FENCE_RUN_UNFENCED]);
    await c.req("POST", `/api/decisions/${card!.id}/answer`, { answer: FENCE_RUN_UNFENCED });
    const [row] = await c.db.select().from(companies).where(eq(companies.id, c.co.id));
    expect(row).toMatchObject({ fenceMode: "off", fenceOffFingerprint: "6.1.0-test|docker 27.0.1|linux" });
    // Guard is still on, so the work starts unfenced; a new kernel holds it again.
    expect(await c.tick()).toBeDefined();
    // The next minute's sweep ends the episode (the owner's choice covers this platform), so a later one asks again.
    await fenceDefaultSweep(c.db, new Date());
    await c.send(report({ level: "unavailable", platform: { ...PLATFORM, kernel: "6.8.0-new" } }));
    expect(await c.tick()).toBeUndefined();
    expect(await fenceDefaultSweep(c.db, new Date())).toMatchObject({ heldCards: 1 });
  });

  it("a runner row that never reported is shown as not proven in Settings", async () => {
    const c = (ctx = await setup());
    const [r] = await c.db.select().from(runners);
    expect(r!.sandbox).toBeNull();
    expect((await c.req("GET", `/api/companies/${c.co.id}/runner`)).json().safety).toMatchObject({ fingerprint: null, guard: { proven: false }, fence: { proven: false } });
  });
});
