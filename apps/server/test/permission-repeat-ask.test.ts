import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { RunnerCommand } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { agents, decisions, runners } from "../src/db/schema.js";

// BOS-334: OpenCode asks twice for one shell command that reaches outside the checkout (the folder, then the
// command). One Allow once must cover the one tool call, not raise a second identical card.

let ctx: Awaited<ReturnType<typeof setup>>;
const CMD = "rm -rf /tmp/shots/old && ls /tmp/shots";

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const companyId = ((await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } }).company.id;
  const dev = (await req("POST", `/api/companies/${companyId}/agents`, { name: "Developer" })).json() as { id: string };
  const reg = (await req("POST", `/api/companies/${companyId}/runner`)).json() as { runnerId: string };
  const [runner] = await db.select().from(runners).where(eq(runners.id, reg.runnerId));
  const sent: RunnerCommand[] = [];
  built.runners.connect(runner!.id, (cmd) => (sent.push(cmd), true));
  let seq = 0;
  const runId = randomUUID();
  const emit = (event: Parameters<typeof built.runners.ingest>[1]["event"]) => built.runners.ingest(runner!, { seq: ++seq, at: new Date().toISOString(), event });
  await emit({ type: "run.started", runId, agentId: dev.id, acpSessionId: "s", model: null });
  const ask = async (command: string, toolCallId: string | undefined, title = command, kind = "execute") => {
    const requestId = randomUUID();
    await emit({ type: "run.permission_request", runId, requestId, title, kind, rawInput: { command, ...(kind === "other" ? { directories: ["/tmp"], patterns: ["/tmp/*"] } : {}) }, optionKinds: ["allow_once", "reject_once"], ...(toolCallId ? { toolCallId } : {}) });
    const [d] = await db.select().from(decisions).where(eq(decisions.dedupeKey, `permission:${requestId}`));
    return { d, requestId };
  };
  const [ceo] = await db.select().from(agents).where(and(eq(agents.companyId, companyId), eq(agents.role, "ceo")));
  return { ...built, db, close, sent, ask, ceo: ceo! };
}

beforeEach(async () => {
  ctx = await setup();
});
afterEach(async () => {
  await ctx.app.close();
  await ctx.close();
});

describe("one Allow once covers the one tool call (BOS-334)", () => {
  // First the folder ("other"), then the command ("execute"), both for the same tool call.
  const folder = (id: string | undefined, title = CMD) => ctx.ask(CMD, id, title, "other");

  it("answers the command's ask for a tool call whose folder ask was allowed, without a new card", async () => {
    const first = await folder("call-1");
    expect(first.d).toBeDefined();
    await ctx.decisions.answer(first.d!.id, "Allow once");
    ctx.sent.length = 0;
    const second = await ctx.ask(CMD, "call-1");
    expect(second.d).toBeUndefined();
    expect(ctx.sent).toEqual([expect.objectContaining({ type: "permission.decide", requestId: second.requestId, verdict: "allow" })]);
  });

  it("is only for that call: another call, another title or no call id still raises a card", async () => {
    const first = await folder("call-1");
    await ctx.decisions.answer(first.d!.id, "Allow once");
    expect((await ctx.ask(CMD, "call-2")).d).toBeDefined();
    expect((await ctx.ask(CMD, "call-1", "Something else")).d).toBeDefined();
    expect((await ctx.ask(CMD, undefined)).d).toBeDefined();
  });

  it("does not carry over a Deny", async () => {
    const first = await folder("call-1");
    await ctx.decisions.answer(first.d!.id, "Deny");
    expect((await ctx.ask(CMD, "call-1")).d).toBeDefined();
  });
});
