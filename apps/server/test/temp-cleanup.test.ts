import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { RunnerCommand } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { activity, agents, decisions, notifications, runners, wakes } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";
import type { Ladder } from "../src/services/alert-ladder.js";

// BOS-111: a request whose only deletes are of temp files goes to the CEO first, not the owner.

let ctx: Awaited<ReturnType<typeof setup>>;
const clients: Client[] = [];
const CLEANUP = "rm -rf /tmp/rv86 && git worktree add /tmp/rv86 origin/main && cd /tmp/rv86 && pnpm install > /tmp/rv86-install.log 2>&1";

async function setup() {
  let clock = new Date();
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws", now: () => clock });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const base = `127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const companyId = ((await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } }).company.id;
  const dev = (await req("POST", `/api/companies/${companyId}/agents`, { name: "Senior Developer" })).json() as { id: string };
  const [ceo] = await db.select().from(agents).where(and(eq(agents.companyId, companyId), eq(agents.role, "ceo")));
  const reg = (await req("POST", `/api/companies/${companyId}/runner`)).json() as { runnerId: string };
  const [runner] = await db.select().from(runners).where(eq(runners.id, reg.runnerId));
  const sent: RunnerCommand[] = [];
  built.runners.connect(runner!.id, (cmd) => (sent.push(cmd), true));
  let seq = 0;
  /** An agent's run asks to run a shell command; returns the decision it made, if any. */
  const ask = async (command: string, agentId = dev.id) => {
    const runId = randomUUID();
    const requestId = randomUUID();
    await built.runners.ingest(runner!, { seq: ++seq, at: clock.toISOString(), event: { type: "run.started", runId, agentId, acpSessionId: "s", model: null } });
    await built.runners.ingest(runner!, { seq: ++seq, at: clock.toISOString(), event: { type: "run.permission_request", runId, requestId, title: "Create branch worktree and install deps", kind: "execute", rawInput: { command }, optionKinds: ["allow_once", "reject_once"] } });
    const [d] = await db.select().from(decisions).where(eq(decisions.dedupeKey, `permission:${requestId}`));
    return { d, runId, requestId };
  };
  await db.delete(wakes);
  return { ...built, db, close, base, req, companyId, dev, ceo: ceo!, sent, ask, advance: (m: number) => (clock = new Date(clock.getTime() + m * 60_000)) };
}

beforeEach(async () => {
  ctx = await setup();
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  await ctx.app.close();
  await ctx.close();
});

async function client(agentId: string) {
  const token = await issueRunToken(ctx.db, { companyId: ctx.companyId, agentId, runId: randomUUID() });
  const c = new Client({ name: "test", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://${ctx.base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  clients.push(c);
  return c;
}
const textOf = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? "");
const isError = (r: unknown) => !!(r as { isError?: boolean }).isError;
const reload = async (id: string) => (await ctx.db.select().from(decisions).where(eq(decisions.id, id)))[0]!;
const ownerNotified = async (id: string) => {
  await ctx.notes.syncDecisions();
  return ctx.db.select().from(notifications).where(eq(notifications.decisionId, id));
};

describe("temp-file cleanup goes to the CEO first (BOS-111)", () => {
  it("waits with the CEO, off the owner's queue, recommended Allow, and the CEO is woken", async () => {
    const { d } = await ctx.ask(CLEANUP);
    expect(d).toMatchObject({ tier: "ceo", status: "open", recommendedOption: "Allow once" });
    const c = d!.context as { tempCleanup?: boolean; ladder: Ladder; explain: { summary: string } };
    expect(c.tempCleanup).toBe(true);
    expect(c.ladder).toMatchObject({ rung: "ceo", minutes: 5 });
    expect(c.explain.summary).not.toMatch(/doesn't recognise: worktree/);
    expect((await ctx.decisions.queue()).map((q) => q.id)).not.toContain(d!.id);
    expect((await ctx.decisions.withTeam()).map((q) => q.id)).toContain(d!.id);
    expect(await ownerNotified(d!.id)).toEqual([]);
    const [w] = await ctx.db.select().from(wakes).where(eq(wakes.agentId, ctx.ceo.id));
    expect(w).toMatchObject({ reason: "decision", priority: 3 });
    expect(w!.note).toContain(CLEANUP);
    expect(ctx.sent).toEqual([]);
  });

  it("the CEO settles it with a reason, the agent gets the verdict, and the owner can see who and why", async () => {
    const { d, runId, requestId } = await ctx.ask(CLEANUP);
    const ceo = await client(ctx.ceo.id);
    const listed = textOf(await ceo.callTool({ name: "decisions", arguments: { action: "list" } }));
    expect(listed).toContain(`${d!.id}: TEMP-FILE CLEANUP: `);
    const bare = await ceo.callTool({ name: "decisions", arguments: { action: "answer", id: d!.id, answer: "Allow once" } });
    expect(isError(bare)).toBe(true);
    expect(textOf(bare)).toMatch(/note saying why/);
    const ok = await ceo.callTool({ name: "decisions", arguments: { action: "answer", id: d!.id, answer: "Allow once", note: "It only removes its own scratch checkout in /tmp." } });
    expect(textOf(ok)).toBe("Answered: Allow once.");
    expect(ctx.sent).toEqual([{ type: "permission.decide", runId, requestId, verdict: "allow" }]);
    const after = await reload(d!.id);
    expect((after.context as { settled: { name: string; note: string } }).settled).toMatchObject({ agentId: ctx.ceo.id, note: "It only removes its own scratch checkout in /tmp." });
    const log = await ctx.db.select().from(activity).where(eq(activity.kind, "decision_answered"));
    expect(log.at(-1)!.summary).toMatch(/settled ".*": Allow once\. Reason: It only removes its own scratch checkout in \/tmp\.$/);
    expect(log.at(-1)!.summary).not.toMatch(/^Owner answered/);
    const settled = (await ctx.req("GET", "/api/decisions/advised")).json() as Array<{ id: string; settled?: { answer: string; note: string; command: string; tempCleanup: boolean } }>;
    expect(settled.find((s) => s.id === d!.id)?.settled).toEqual({ by: expect.any(String), answer: "Allow once", note: "It only removes its own scratch checkout in /tmp.", command: CLEANUP, tempCleanup: true });
  });

  it("moves to the owner after 5 minutes, or when the CEO escalates it", async () => {
    const { d } = await ctx.ask(CLEANUP);
    ctx.advance(4);
    await ctx.alerts.sweep();
    expect((await reload(d!.id)).tier).toBe("ceo");
    ctx.advance(2);
    await ctx.alerts.sweep();
    const moved = await reload(d!.id);
    expect(moved).toMatchObject({ tier: "owner", status: "open" });
    expect((await ctx.decisions.queue()).map((q) => q.id)).toContain(d!.id);
    expect((await ownerNotified(d!.id)).length).toBe(1);

    const { d: d2 } = await ctx.ask("rm -rf /tmp/other-agents-cache");
    const ceo = await client(ctx.ceo.id);
    const r = await ceo.callTool({ name: "decisions", arguments: { action: "escalate", id: d2!.id, triedFirst: "The folder isn't this agent's own scratch checkout, so I can't vouch for deleting it." } });
    expect(isError(r)).toBe(false);
    expect(await reload(d2!.id)).toMatchObject({ tier: "owner", status: "open" });
    expect((await reload(d2!.id)).context).toMatchObject({ triedFirst: "The folder isn't this agent's own scratch checkout, so I can't vouch for deleting it." });
  });

  it("goes to the owner as before when it's the CEO's own request, the CEO is paused, or it deletes outside /tmp", async () => {
    expect((await ctx.ask(CLEANUP, ctx.ceo.id)).d).toMatchObject({ tier: "owner" });
    expect((await ctx.ask("rm -rf /tmp/../home")).d).toMatchObject({ tier: "owner", recommendedOption: "Deny" });
    await ctx.db.update(agents).set({ paused: true }).where(eq(agents.id, ctx.ceo.id));
    const { d } = await ctx.ask(CLEANUP);
    expect(d).toMatchObject({ tier: "owner", recommendedOption: "Allow once" });
    expect((d!.context as { ladder?: unknown }).ladder).toBeUndefined();
  });
});
