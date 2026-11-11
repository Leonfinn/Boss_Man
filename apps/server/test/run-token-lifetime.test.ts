import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { runs, runTokens } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";

// BOS-513: a run token works only while its own run is live, so a copy left in a shared file stops working.

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
  const { company, ceo } = (await built.app.inject({ method: "POST", url: "/api/companies", headers: { cookie }, payload: { name: "App Co" } })).json() as { company: { id: string }; ceo: { id: string } };
  const worker = (await built.app.inject({ method: "POST", url: `/api/companies/${company.id}/agents`, headers: { cookie }, payload: { name: "Engineer" } })).json() as { id: string };
  const startRun = async (agentId: string) => {
    const runId = randomUUID();
    await db.insert(runs).values({ id: runId, companyId: company.id, agentId, startedAt: new Date() });
    return { runId, token: await issueRunToken(db, { companyId: company.id, agentId, runId }) };
  };
  // An MCP call: 401 means the token was refused; anything else means it got through.
  const call = (token: string) =>
    built.app.inject({
      method: "POST",
      url: "/mcp",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    });
  return { ...built, db, close, company, ceo, worker, startRun, call };
}

describe("run token lifetime (BOS-513)", () => {
  it("accepts a token while its run is live", async () => {
    const c = (ctx = await setup());
    const { token } = await c.startRun(c.worker.id);
    expect((await c.call(token)).statusCode).not.toBe(401);
  });

  it("refuses the same token once its run has ended, whatever the outcome", async () => {
    const c = (ctx = await setup());
    for (const outcome of ["done", "error: boom", "lost", "interrupted", null]) {
      const { runId, token } = await c.startRun(c.worker.id);
      expect((await c.call(token)).statusCode, `live before ${outcome}`).not.toBe(401);
      await c.db.update(runs).set({ endedAt: new Date(), outcome }).where(eq(runs.id, runId));
      const refused = await c.call(token);
      expect(refused.statusCode, `ended with ${outcome}`).toBe(401);
      expect(refused.json()).toEqual({ error: "unknown_or_expired_run_token" });
    }
  });

  it("ending one agent's run leaves another agent's live token working", async () => {
    const c = (ctx = await setup());
    const a = await c.startRun(c.worker.id);
    const b = await c.startRun(c.ceo.id);
    await c.db.update(runs).set({ endedAt: new Date() }).where(eq(runs.id, a.runId));
    expect((await c.call(a.token)).statusCode).toBe(401);
    expect((await c.call(b.token)).statusCode).not.toBe(401);
  });

  it("refuses a token whose run row is missing", async () => {
    const c = (ctx = await setup());
    const { runId, token } = await c.startRun(c.worker.id);
    await c.db.delete(runs).where(eq(runs.id, runId));
    expect((await c.call(token)).statusCode).toBe(401);
  });

  it("ending a run through the runners service deletes its token row", async () => {
    const c = (ctx = await setup());
    const { runId, token } = await c.startRun(c.worker.id);
    expect(await c.db.select().from(runTokens).where(eq(runTokens.runId, runId))).toHaveLength(1);
    expect(await c.runners.endRun(runId, "done")).toBe(true);
    expect(await c.db.select().from(runTokens).where(eq(runTokens.runId, runId))).toHaveLength(0);
    expect((await c.call(token)).statusCode).toBe(401);
  });

  it("refuses unknown, empty and expired tokens", async () => {
    const c = (ctx = await setup());
    expect((await c.call("bm_run_notatoken")).statusCode).toBe(401);
    expect((await c.call("")).statusCode).toBe(401);
    const runId = randomUUID();
    await c.db.insert(runs).values({ id: runId, companyId: c.company.id, agentId: c.worker.id, startedAt: new Date() });
    const expired = await issueRunToken(c.db, { companyId: c.company.id, agentId: c.worker.id, runId }, -1);
    expect((await c.call(expired)).statusCode).toBe(401);
  });
});
