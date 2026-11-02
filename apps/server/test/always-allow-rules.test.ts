import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { decisions, policyRules, runners } from "../src/db/schema.js";
import { AnswerError } from "../src/services/decisions.js";

let ctx: Awaited<ReturnType<typeof setup>>;

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, heartbeatMs: 200 });
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const co = (await built.app.inject({ method: "POST", url: "/api/companies", headers: { cookie }, payload: { name: "App Co" } })).json() as { company: { id: string }; ceo: { id: string } };
  const dev = (await built.app.inject({ method: "POST", url: `/api/companies/${co.company.id}/agents`, headers: { cookie }, payload: { name: "Dev" } })).json() as { id: string };
  const reg = (await built.app.inject({ method: "POST", url: `/api/companies/${co.company.id}/runner`, headers: { cookie } })).json() as { runnerId: string };
  const [runner] = await db.select().from(runners).where(eq(runners.id, reg.runnerId));
  let seq = 0;
  const ingest = (event: object) => built.runners.ingest(runner!, { seq: ++seq, at: new Date().toISOString(), event } as never);
  /** An agent's run asks for a tool; returns the card it raised (null if the policy settled it). */
  const ask = async (agentId: string, title: string, command?: string) => {
    const runId = randomUUID();
    const requestId = randomUUID();
    built.runners.connect(runner!.id, () => true);
    await ingest({ type: "run.started", runId, agentId, acpSessionId: "s", model: null });
    await ingest({ type: "run.permission_request", runId, requestId, title, kind: command ? "execute" : "other", rawInput: command ? { command } : { url: "https://x.dev" }, optionKinds: ["allow_once", "reject_once"] });
    const [row] = await db.select().from(decisions).where(eq(decisions.dedupeKey, `permission:${requestId}`));
    return row && row.status === "open" ? row : null;
  };
  const answer = (id: string, a: string, payload: object = {}) => built.app.inject({ method: "POST", url: `/api/decisions/${id}/answer`, headers: { cookie }, payload: { answer: a, ...payload } });
  const rules = () => db.select().from(policyRules).where(and(eq(policyRules.companyId, co.company.id), eq(policyRules.trigger, "permission")));
  return { ...built, db, close, cookie, co, dev, ask, answer, rules };
}

beforeEach(async () => {
  ctx = await setup();
});
afterEach(async () => {
  await ctx.app.close();
  await ctx.close();
});

const MD = "mcp__crawl4ai__md";
const ALWAYS = "Always allow crawl4ai's md tool";

describe("Always allow on a permission card (BOS-294)", () => {
  it("saves a rule for the asking agent only by default, and records who, when and which card", async () => {
    const card = await ctx.ask(ctx.dev.id, MD);
    expect((card!.context as { alwaysAgent?: unknown }).alwaysAgent).toMatchObject({ id: ctx.dev.id, name: "Dev" });
    expect((await ctx.answer(card!.id, ALWAYS)).statusCode).toBe(200);
    const [rule] = await ctx.rules();
    expect(rule).toMatchObject({ outcome: "allow", createdBy: "leon", sourceDecisionId: card!.id, condition: { titlePattern: `^${MD}$`, safeOnly: true, agentIds: [ctx.dev.id] } });
    expect(rule!.createdAt).toBeInstanceOf(Date);
    expect(rule!.name).toMatch(/for Dev/);
    // The same agent is now allowed without a card; another agent still gets one.
    expect(await ctx.ask(ctx.dev.id, MD)).toBeNull();
    expect(await ctx.ask(ctx.co.ceo.id, MD)).not.toBeNull();
  });

  it("covers every agent only when the owner picks that scope", async () => {
    const card = await ctx.ask(ctx.dev.id, MD);
    expect((await ctx.answer(card!.id, ALWAYS, { alwaysScope: "company" })).statusCode).toBe(200);
    const [rule] = await ctx.rules();
    expect(rule!.condition).toEqual({ titlePattern: `^${MD}$`, safeOnly: true });
    expect(await ctx.ask(ctx.co.ceo.id, MD)).toBeNull();
  });

  it("builds the rule from the stored card, not from what the browser sends", async () => {
    const card = await ctx.ask(ctx.dev.id, MD);
    const forged = await ctx.answer(card!.id, ALWAYS, { alwaysScope: "company", match: { kinds: ["execute"] }, agentIds: [] });
    expect(forged.statusCode).toBe(200);
    expect((await ctx.rules())[0]!.condition).toEqual({ titlePattern: `^${MD}$`, safeOnly: true });
    const bad = await ctx.ask(ctx.dev.id, "mcp__crawl4ai__crawl");
    expect((await ctx.answer(bad!.id, "Always allow everything")).statusCode).toBe(422);
    expect((await ctx.answer(bad!.id, ALWAYS.replace("md", "crawl"), { alwaysScope: "everyone" })).statusCode).toBe(400);
    expect(await ctx.rules()).toHaveLength(1);
  });

  it.each([
    ["push to main", "git push origin main"],
    ["force push", "git push --force origin work"],
    ["branch delete", "git push origin --delete work"],
    ["a destructive command", "rm -rf src"],
  ])("offers no Always on %s, and a forged Always answer makes no rule", async (_what, command) => {
    const card = await ctx.ask(ctx.dev.id, command, command);
    expect(card).not.toBeNull();
    expect(card!.options).toEqual(["Allow once", "Deny"]);
    const forged = await ctx.answer(card!.id, "Always allow this exact command");
    expect(forged.statusCode).toBe(422);
    expect(await ctx.rules()).toHaveLength(0);
  });

  it("never lets the CEO save a standing rule", async () => {
    const card = await ctx.ask(ctx.dev.id, MD);
    await expect(ctx.decisions.answer(card!.id, ALWAYS, { settledBy: { agentId: ctx.co.ceo.id }, by: "ceo" })).rejects.toBeInstanceOf(AnswerError);
    expect(await ctx.rules()).toHaveLength(0);
    const [still] = await ctx.db.select().from(decisions).where(eq(decisions.id, card!.id));
    expect(still!.status).toBe("open");
  });
});
