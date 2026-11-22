// Timed "Allow" rules (BOS-2188): a rule past expires_at never matches, the card can save a rule for 1 hour,
// until midnight or always (the default), the Settings list still shows expired rules, a draft rule can be
// tried without saving, and the daily clean-up removes rules that ended over 7 days ago.
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { companies, decisions, policyRules, runners } from "../src/db/schema.js";
import { pruneExpiredPolicyRules } from "../src/services/housekeeping.js";
import { policyRulesService } from "../src/services/policy-rules.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MD = "mcp__crawl4ai__md";
const ALWAYS = "Always allow crawl4ai's md tool";

describe("policy rule expiry: lookup, list, draft and clean-up (service)", () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  async function setup() {
    const { db, close } = await openPglite();
    const [co] = await db.insert(companies).values({ name: "Company A" }).returning();
    let at = new Date("2026-11-22T10:00:00Z");
    const rules = policyRulesService(db, () => at);
    const add = async (name: string, expiresAt: Date | null, companyId: string | null = co!.id) => {
      const r = await rules.create({ companyId, name, match: { titlePattern: `^${MD}$` }, outcome: "allow" });
      await db.update(policyRules).set({ expiresAt }).where(eq(policyRules.id, r.id));
      return r;
    };
    return { db, close, rules, add, companyId: co!.id, setNow: (d: Date) => (at = d), at: () => at };
  }
  // A tool no built-in rule allows, so only a saved rule can make it Allow.
  const restart = { title: MD, kind: "other", rawInput: { url: "https://example.com" } };
  beforeEach(async () => {
    ctx = await setup();
  });
  afterEach(async () => {
    await ctx.close();
  });

  it("matches a rule with no expiry and one that ends later, and ignores one that has ended", async () => {
    const r = await ctx.add("Restarts", new Date(ctx.at().getTime() + HOUR));
    expect((await ctx.rules.test(ctx.companyId, restart)).outcome).toBe("allow");
    // Exactly at the end is already over; a minute before is not.
    ctx.setNow(new Date(r.expiresAt ? Date.parse("2026-11-22T10:59:00Z") : 0));
    expect((await ctx.rules.test(ctx.companyId, restart)).outcome).toBe("allow");
    ctx.setNow(new Date("2026-11-22T11:00:00Z"));
    const ended = await ctx.rules.test(ctx.companyId, restart);
    expect(ended.outcome).not.toBe("allow");
    expect(ended.rule).not.toBe("Restarts");
  });

  it("a rule with no expiry still matches (every rule made before this)", async () => {
    await ctx.add("Forever", null);
    expect((await ctx.rules.test(ctx.companyId, restart)).outcome).toBe("allow");
  });

  it("ignores an ended rule for every company too, not just the company's own", async () => {
    await ctx.add("Global restarts", new Date(ctx.at().getTime() - 1), null);
    expect((await ctx.rules.test(ctx.companyId, restart)).outcome).not.toBe("allow");
    expect((await ctx.rules.effective(ctx.companyId)).map((r) => r.name)).toEqual([]);
  });

  it("still lists an ended rule with its end time, so Settings can show it greyed", async () => {
    const ended = new Date(ctx.at().getTime() - HOUR);
    const r = await ctx.add("Old", ended);
    const listed = (await ctx.rules.list(ctx.companyId)).company;
    expect(listed.map((x) => x.id)).toEqual([r.id]);
    expect(listed[0]!.expiresAt).toBe(ended.toISOString());
  });

  it("an edit keeps the end time", async () => {
    const end = new Date(ctx.at().getTime() + HOUR);
    const r = await ctx.add("Timed", end);
    const edited = await ctx.rules.update(r.id, { name: "Timed, renamed", outcome: "allow" });
    expect(edited.expiresAt).toBe(end.toISOString());
  });

  it("tries a draft rule first without saving it, and refuses a bad pattern", async () => {
    const out = await ctx.rules.test(ctx.companyId, restart, { match: { titlePattern: `^${MD}$` }, outcome: "deny" });
    expect(out).toMatchObject({ outcome: "deny", rule: "Your draft rule" });
    expect(await ctx.rules.list(ctx.companyId).then((l) => l.company)).toEqual([]);
    await expect(ctx.rules.test(ctx.companyId, restart, { match: { commandPattern: "(" }, outcome: "allow" })).rejects.toMatchObject({ status: 422 });
  });

  it("clean-up removes rules that ended more than 7 days ago and nothing else", async () => {
    const old = await ctx.add("Ended 8 days ago", new Date(ctx.at().getTime() - 8 * DAY));
    const recent = await ctx.add("Ended 6 days ago", new Date(ctx.at().getTime() - 6 * DAY));
    const future = await ctx.add("Still running", new Date(ctx.at().getTime() + HOUR));
    const never = await ctx.add("Never ends", null);
    expect(await pruneExpiredPolicyRules(ctx.db, { now: ctx.at() })).toBe(1);
    const left = (await ctx.db.select({ id: policyRules.id }).from(policyRules)).map((r) => r.id).sort();
    expect(left).toEqual([recent.id, future.id, never.id].sort());
    expect(left).not.toContain(old.id);
    // A demoted leader stops the pass.
    expect(await pruneExpiredPolicyRules(ctx.db, { now: new Date(ctx.at().getTime() + 30 * DAY), stop: () => true })).toBe(0);
  });
});

describe("Allow from a permission card with a duration (BOS-2188)", () => {
  let ctx: Awaited<ReturnType<typeof setupApp>>;
  async function setupApp() {
    const { db, close } = await openPglite();
    const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, heartbeatMs: 200 });
    const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
    const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
    const co = (await built.app.inject({ method: "POST", url: "/api/companies", headers: { cookie }, payload: { name: "App Co" } })).json() as { company: { id: string }; ceo: { id: string } };
    const dev = (await built.app.inject({ method: "POST", url: `/api/companies/${co.company.id}/agents`, headers: { cookie }, payload: { name: "Dev" } })).json() as { id: string };
    await built.app.inject({ method: "PATCH", url: `/api/agents/${co.ceo.id}`, headers: { cookie }, payload: { paused: true } });
    const reg = (await built.app.inject({ method: "POST", url: `/api/companies/${co.company.id}/runner`, headers: { cookie } })).json() as { runnerId: string };
    const [runner] = await db.select().from(runners).where(eq(runners.id, reg.runnerId));
    let seq = 0;
    const ingest = (event: object) => built.runners.ingest(runner!, { seq: ++seq, at: new Date().toISOString(), event } as never);
    const ask = async (agentId: string, title: string) => {
      const runId = randomUUID();
      const requestId = randomUUID();
      built.runners.connect(runner!.id, () => true);
      await ingest({ type: "run.started", runId, agentId, acpSessionId: "s", model: null });
      await ingest({ type: "run.permission_request", runId, requestId, title, kind: "other", rawInput: { url: "https://x.dev" }, optionKinds: ["allow_once", "reject_once"] });
      const [row] = await db.select().from(decisions).where(eq(decisions.dedupeKey, `permission:${requestId}`));
      return row && row.status === "open" ? row : null;
    };
    const answer = (id: string, a: string, payload: object = {}) => built.app.inject({ method: "POST", url: `/api/decisions/${id}/answer`, headers: { cookie }, payload: { answer: a, ...payload } });
    const rules = () => db.select().from(policyRules).where(and(eq(policyRules.companyId, co.company.id), eq(policyRules.trigger, "permission")));
    return { ...built, db, close, cookie, co, dev, ask, answer, rules };
  }
  beforeEach(async () => {
    ctx = await setupApp();
  });
  afterEach(async () => {
    await ctx.app.close();
    await ctx.close();
  });

  it("saves a rule with no end by default", async () => {
    const card = await ctx.ask(ctx.dev.id, MD);
    expect((await ctx.answer(card!.id, ALWAYS)).statusCode).toBe(200);
    expect((await ctx.rules())[0]!.expiresAt).toBeNull();
  });

  it("'for 1 hour' stores an end an hour away, and the rule stops matching once it has passed", async () => {
    const card = await ctx.ask(ctx.dev.id, MD);
    const before = Date.now();
    expect((await ctx.answer(card!.id, ALWAYS, { alwaysTtl: "hour" })).statusCode).toBe(200);
    const [rule] = await ctx.rules();
    const end = rule!.expiresAt!.getTime();
    expect(end).toBeGreaterThanOrEqual(before + HOUR);
    expect(end).toBeLessThanOrEqual(Date.now() + HOUR);
    // Allowed while it runs; asks again after the end (the card comes back, never a silent allow).
    expect(await ctx.ask(ctx.dev.id, MD)).toBeNull();
    await ctx.db.update(policyRules).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(policyRules.id, rule!.id));
    expect(await ctx.ask(ctx.dev.id, MD)).not.toBeNull();
  });

  it("'until midnight' stores the server's next midnight, between now and 26 hours away", async () => {
    const card = await ctx.ask(ctx.dev.id, MD);
    expect((await ctx.answer(card!.id, ALWAYS, { alwaysTtl: "midnight" })).statusCode).toBe(200);
    const end = (await ctx.rules())[0]!.expiresAt!.getTime();
    expect(end).toBeGreaterThan(Date.now());
    expect(end).toBeLessThanOrEqual(Date.now() + 26 * HOUR);
  });

  it("refuses a duration it doesn't know, and saves nothing", async () => {
    const card = await ctx.ask(ctx.dev.id, MD);
    expect((await ctx.answer(card!.id, ALWAYS, { alwaysTtl: "forever" })).statusCode).toBe(400);
    expect(await ctx.rules()).toHaveLength(0);
  });

  it("the test route tries a draft rule, answers 422 for a bad pattern, and saves nothing", async () => {
    const test = (body: object) => ctx.app.inject({ method: "POST", url: "/api/policy-rules/test", headers: { cookie: ctx.cookie }, payload: { companyId: ctx.co.company.id, title: MD, kind: "other", ...body } });
    const ok = await test({ draft: { match: { titlePattern: `^${MD}$` }, outcome: "deny" } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ outcome: "deny", rule: "Your draft rule" });
    const bad = await test({ draft: { match: { titlePattern: "(" }, outcome: "allow" } });
    expect(bad.statusCode).toBe(422);
    expect(await ctx.rules()).toHaveLength(0);
  });

  it("the card's Always answer is still the owner's alone: a duration doesn't open it to the CEO", async () => {
    const card = await ctx.ask(ctx.dev.id, MD);
    expect(card!.options).toContain(ALWAYS);
    // Answered as the CEO (extra.by === "ceo") the service refuses; here the route is owner-only, so the timed rule carries the owner's name.
    expect((await ctx.answer(card!.id, ALWAYS, { alwaysTtl: "hour" })).statusCode).toBe(200);
    expect((await ctx.rules())[0]).toMatchObject({ createdBy: "leon" });
  });
});
