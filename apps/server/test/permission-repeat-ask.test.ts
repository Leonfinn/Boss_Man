import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { RunnerCommand } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { agents, decisions, runners } from "../src/db/schema.js";

// BOS-334: OpenCode asks twice for one shell command that reaches outside the checkout (the folder, then the
// command). One Allow once must cover the one tool call, not raise a second identical card.
// BOS-376: the same command comes back as a new ask (a harness retry, or a second run of the same call) with a
// new requestId and often a different or missing toolCallId. A repeat of the same command in the same run,
// soon after an Allow once, gets that answer applied instead of a second card. A Deny is never turned into one.

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
  return { ...built, db, close, sent, ask, emit, req, companyId, runId, ceo: ceo! };
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

  it("is only for that call: another call or another title still raises a card", async () => {
    const first = await folder("call-1");
    await ctx.decisions.answer(first.d!.id, "Allow once");
    // Another command and another title are not this call.
    expect((await ctx.ask("rm -rf /tmp/other", "call-2")).d).toBeDefined();
    expect((await ctx.ask(CMD, "call-1", "Something else")).d).toBeDefined();
    // A folder ask carries a different input from the command ask (it lists the folder), so without the
    // tool call id it is not the same exact request and raises its own card (BOS-376 security review).
    expect((await ctx.ask(CMD, undefined)).d).toBeDefined();
  });

  it("does not carry over a Deny", async () => {
    const first = await folder("call-1");
    await ctx.decisions.answer(first.d!.id, "Deny");
    expect((await ctx.ask(CMD, "call-1")).d).toBeDefined();
  });
});

describe("an identical repeat in the same run is settled by the Allow once (BOS-376)", () => {
  it("answers a repeat of the same command asked as a new request, with no tool call id, without a card", async () => {
    const first = await ctx.ask(CMD, "call-1");
    expect(first.d).toBeDefined();
    await ctx.decisions.answer(first.d!.id, "Allow once");
    ctx.sent.length = 0;
    const again = await ctx.ask(CMD, undefined);
    expect(again.d).toBeUndefined();
    expect(ctx.sent).toEqual([expect.objectContaining({ type: "permission.decide", requestId: again.requestId, verdict: "allow" })]);
  });

  it("answers a repeat under a different tool call id, the way a retried call comes back", async () => {
    const first = await ctx.ask(CMD, "call-1");
    await ctx.decisions.answer(first.d!.id, "Allow once");
    ctx.sent.length = 0;
    const again = await ctx.ask(CMD, "call-9");
    expect(again.d).toBeUndefined();
    expect(ctx.sent).toEqual([expect.objectContaining({ type: "permission.decide", requestId: again.requestId, verdict: "allow" })]);
  });

  it("settles a repeat that arrives while the first card is still queued, once it is answered", async () => {
    const first = await ctx.ask(CMD, undefined);
    const repeat = await ctx.ask(CMD, undefined);
    // The second ask is held (not a new card) while the first is open.
    expect(repeat.d).toBeUndefined();
    ctx.sent.length = 0;
    await ctx.decisions.answer(first.d!.id, "Allow once");
    expect(ctx.sent).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "permission.decide", requestId: repeat.requestId, verdict: "allow" })]),
    );
  });

  it("keeps the answer on the run so a repeat after a reconnect is still settled", async () => {
    const first = await ctx.ask(CMD, undefined);
    await ctx.decisions.answer(first.d!.id, "Allow once");
    ctx.sent.length = 0;
    // A reconnect drops the runner's in-memory state; the server's record of the answer survives.
    await ctx.runners.connect((await ctx.db.select({ id: runners.id }).from(runners).limit(1))[0]!.id, (cmd) => (ctx.sent.push(cmd), true));
    expect((await ctx.ask(CMD, undefined)).d).toBeUndefined();
    expect(ctx.sent).toContainEqual(expect.objectContaining({ type: "permission.decide", verdict: "allow" }));
  });

  it("notes on the waiting card that a repeat rides on it, so one answer covers both", async () => {
    const first = await ctx.ask(CMD, undefined);
    const repeat = await ctx.ask(CMD, undefined);
    expect(repeat.d).toBeUndefined();
    const [card] = await ctx.db.select().from(decisions).where(eq(decisions.id, first.d!.id));
    expect(card!.question).toContain(repeat.requestId);
    const ctxOnCard = card!.context as { repeats?: Array<{ requestId: string }> };
    expect(ctxOnCard.repeats).toEqual([expect.objectContaining({ requestId: repeat.requestId })]);
  });

  it("records on the allowed card which repeat it settled, as same as its own id", async () => {
    const first = await ctx.ask(CMD, undefined);
    await ctx.decisions.answer(first.d!.id, "Allow once");
    await ctx.ask(CMD, undefined);
    const [card] = await ctx.db.select().from(decisions).where(eq(decisions.id, first.d!.id));
    expect((card!.context as { settledByRepeat?: { sameAs?: string } }).settledByRepeat?.sameAs).toBe(first.d!.id);
  });

  it("never turns a Deny into an Allow", async () => {
    const first = await ctx.ask(CMD, undefined);
    await ctx.decisions.answer(first.d!.id, "Deny");
    const repeat = await ctx.ask(CMD, undefined);
    expect(repeat.d).toBeDefined();
  });

  it("never turns a Deny into an Allow for a repeat riding on the card", async () => {
    const first = await ctx.ask(CMD, undefined);
    const repeat = await ctx.ask(CMD, undefined);
    // The repeat rides on the open card instead of raising its own (BOS-376).
    expect(repeat.d).toBeUndefined();
    ctx.sent.length = 0;
    await ctx.decisions.answer(first.d!.id, "Deny");
    // The one Deny must reach the waiting repeat as a deny, never as an allow.
    expect(ctx.sent).toContainEqual(expect.objectContaining({ type: "permission.decide", requestId: repeat.requestId, verdict: "deny" }));
    expect(ctx.sent).not.toContainEqual(expect.objectContaining({ requestId: repeat.requestId, verdict: "allow" }));
    const [card] = await ctx.db.select().from(decisions).where(eq(decisions.id, first.d!.id));
    const repeats = (card!.context as { repeats?: Array<{ requestId: string; settled?: string }> }).repeats;
    expect(repeats?.find((r) => r.requestId === repeat.requestId)?.settled).toBe("deny");
  });

  it("does not carry an Allow over to a different command, or to another run", async () => {
    const first = await ctx.ask(CMD, undefined);
    await ctx.decisions.answer(first.d!.id, "Allow once");
    expect((await ctx.ask("rm -rf /tmp/other", undefined)).d).toBeDefined();
    const otherRun = randomUUID();
    await ctx.emit({ type: "run.started", runId: otherRun, agentId: ctx.ceo.id, acpSessionId: "s2", model: null });
    const requestId = randomUUID();
    await ctx.emit({ type: "run.permission_request", runId: otherRun, requestId, title: CMD, kind: "execute", rawInput: { command: CMD }, optionKinds: ["allow_once", "reject_once"] });
    const [d] = await ctx.db.select().from(decisions).where(eq(decisions.dedupeKey, `permission:${requestId}`));
    expect(d).toBeDefined();
  });
});

describe("a public fetch is a built-in allow while a private one is always denied (BOS-376, BOS-307)", () => {
  // BOS-307 (DR-001): a company routing rule only fires for a request that would otherwise ask, so it can no
  // longer put a card on an ordinary public fetch (a built-in allow). The home-network block is still row 1,
  // checked before any rule, so a private fetch is always a deny however an earlier public fetch was answered.
  const fetchAsk = async (url: string) => {
    const requestId = randomUUID();
    await ctx.emit({ type: "run.permission_request", runId: ctx.runId, requestId, title: "crawl4ai", kind: "fetch", rawInput: { url }, optionKinds: ["allow_once", "reject_once"] });
    const [d] = await ctx.db.select().from(decisions).where(eq(decisions.dedupeKey, `permission:${requestId}`));
    return { d, requestId };
  };

  it("a public fetch is a built-in allow and a private one is still denied, not allowed", async () => {
    const pub = await fetchAsk("https://example.com/page");
    // A public fetch never raises a card now: the built-in allow covers it (row 6).
    expect(pub.d).toBeUndefined();
    expect(ctx.sent).toContainEqual(expect.objectContaining({ type: "permission.decide", requestId: pub.requestId, verdict: "allow" }));
    ctx.sent.length = 0;
    const probe = await fetchAsk("http://192.168.68.67/admin");
    expect(probe.d).toBeUndefined();
    expect(ctx.sent).toContainEqual(expect.objectContaining({ type: "permission.decide", requestId: probe.requestId, verdict: "deny" }));
    expect(ctx.sent).not.toContainEqual(expect.objectContaining({ requestId: probe.requestId, verdict: "allow" }));
  });

  it("a private-network fetch is denied even while a public fetch was just allowed", async () => {
    const pub = await fetchAsk("https://example.com/page");
    expect(pub.d).toBeUndefined();
    ctx.sent.length = 0;
    // The private fetch arrives right after: it must be its own deny, never allowed by the public allow.
    const probe = await fetchAsk("http://192.168.68.67/admin");
    expect(ctx.sent).toContainEqual(expect.objectContaining({ type: "permission.decide", requestId: probe.requestId, verdict: "deny" }));
    expect(ctx.sent).not.toContainEqual(expect.objectContaining({ requestId: probe.requestId, verdict: "allow" }));
  });
});
