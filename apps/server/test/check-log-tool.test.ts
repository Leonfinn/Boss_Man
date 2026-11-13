// BOS-1228: the tickets tool's check_log action opens the kept, redacted full log of a failed check job.
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { tickets } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";
import { checkQueue } from "../src/services/check-queue.js";

let ctx: Awaited<ReturnType<typeof setup>>;

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const base = `127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "POST", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const mk = async (name: string) => {
    const co = (await req("POST", "/api/companies", { name })).json() as { company: { id: string } };
    const dev = (await req("POST", `/api/companies/${co.company.id}/agents`, { name: `Dev of ${name}` })).json() as { id: string };
    const project = (await req("POST", `/api/companies/${co.company.id}/projects`, { name: "App" })).json() as { id: string };
    return { companyId: co.company.id, devId: dev.id, projectId: project.id };
  };
  return { ...built, db, close, base, mk };
}

beforeEach(async () => {
  ctx = await setup();
});
afterEach(async () => {
  await ctx.app.close();
  await ctx.close();
});

const textOf = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? "");

describe("tickets check_log", () => {
  it("returns the kept log to the ticket's own company, in parts, and refuses another company", async () => {
    const a = await ctx.mk("Co A");
    const b = await ctx.mk("Co B");
    const [t] = await ctx.db.insert(tickets).values({ companyId: a.companyId, projectId: a.projectId, title: "T", number: 1, systemState: "in_progress" }).returning();
    const q = checkQueue(ctx.db);
    const { job } = await q.enqueue({ companyId: a.companyId, projectId: a.projectId, ticketId: t!.id, kind: "pre_review", scope: "quick", commit: "c1", tree: "t1" });
    await q.claimNext(null);
    // Fake secret, made up for this test.
    const log = `FAIL  related tests (exit 1)\nMY_API_KEY=hunter2fakevalue\n${"some failing output\n".repeat(4000)}LAST-LINE\n`;
    await q.complete(job.id, { runnerId: null, commit: "c1", exitCode: 1, logTail: "tail", fullLog: log });

    const open = async (company: { companyId: string; devId: string }, args: Record<string, unknown>) => {
      const token = await issueRunToken(ctx.db, { companyId: company.companyId, agentId: company.devId, runId: randomUUID() });
      const c = new Client({ name: "test", version: "0" });
      await c.connect(new StreamableHTTPClientTransport(new URL(`http://${ctx.base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
      try {
        return await c.callTool({ name: "tickets", arguments: { action: "check_log", ticketId: t!.id, ...args } });
      } finally {
        await c.close();
      }
    };

    const first = textOf(await open(a, { jobId: job.id }));
    expect(first).toContain("FAIL  related tests (exit 1)");
    expect(first).not.toContain("hunter2fakevalue");
    expect(first).toMatch(/continue with tickets check_log offset=\d+/);
    const next = Number(/offset=(\d+)/.exec(first)![1]);
    expect(textOf(await open(a, { jobId: job.id, offset: next }))).toBeTruthy();
    // No jobId: the newest kept log of the ticket.
    expect(textOf(await open(a, {}))).toContain("FAIL  related tests");
    // Another company can't read it, even with the ids.
    const other = await open(b, { jobId: job.id });
    expect(other).toMatchObject({ isError: true });
  });
});
