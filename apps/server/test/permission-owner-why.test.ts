import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { agents, decisions, runners } from "../src/db/schema.js";

// BOS-793 (QA, BOS-800): a permission card that goes to the owner says in one plain line why it is theirs and
// not the CEO's, on the card (context.explain.ownerWhy) and in its question text, which is the phone push body.
// A card that goes to the CEO carries no such line, and routing is the same as before.

let ctx: Awaited<ReturnType<typeof setup>>;
const CLEANUP = "rm -rf /tmp/rv86 /tmp/rv86-install.log && git worktree add /tmp/rv86 origin/main";

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const companyId = ((await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } }).company.id;
  const dev = (await req("POST", `/api/companies/${companyId}/agents`, { name: "Senior Developer" })).json() as { id: string };
  const [ceo] = await db.select().from(agents).where(and(eq(agents.companyId, companyId), eq(agents.role, "ceo")));
  const reg = (await req("POST", `/api/companies/${companyId}/runner`)).json() as { runnerId: string };
  const [runner] = await db.select().from(runners).where(eq(runners.id, reg.runnerId));
  built.runners.connect(runner!.id, () => true);
  let seq = 0;
  const ask = async (command: string, agentId = dev.id, tool?: { title: string; kind: string; rawInput: unknown }) => {
    const runId = randomUUID();
    const requestId = randomUUID();
    await built.runners.ingest(runner!, { seq: ++seq, at: new Date().toISOString(), event: { type: "run.started", runId, agentId, acpSessionId: "s", model: null } });
    await built.runners.ingest(runner!, { seq: ++seq, at: new Date().toISOString(), event: { type: "run.permission_request", runId, requestId, ...(tool ?? { title: "Run a command", kind: "execute", rawInput: { command } }), optionKinds: ["allow_once", "reject_once"] } as never });
    const [d] = await db.select().from(decisions).where(eq(decisions.dedupeKey, `permission:${requestId}`));
    return d!;
  };
  return { ...built, db, close, dev, ceo: ceo!, ask };
}

beforeEach(async () => {
  ctx = await setup();
});
afterEach(async () => {
  await ctx.app.close();
  await ctx.close();
});

const whyOf = (d: { context: unknown }) => (d.context as { explain: { ownerWhy?: string } }).explain.ownerWhy;

describe("a permission card for the owner says why it is theirs (BOS-793)", () => {
  it("names the destructive-command guard when it caught the command, on the card and in the push text", async () => {
    const d = await ctx.ask("rm -rf /tmp/../home");
    expect(d).toMatchObject({ tier: "owner" });
    expect(whyOf(d)).toMatch(/^Sent to you, not the CEO, because the destructive-command guard/);
    // The question is what the phone push shows, so the line is in it too.
    expect(d.question).toContain(whyOf(d)!);
  });

  it("says so when it is the CEO's own request", async () => {
    const d = await ctx.ask(CLEANUP, ctx.ceo.id);
    expect(d).toMatchObject({ tier: "owner" });
    expect(whyOf(d)).toBe("Sent to you, not the CEO, because it is the CEO's own request.");
    expect(d.question).toContain("it is the CEO's own request.");
  });

  it("says so when the CEO is paused and could not take it first", async () => {
    await ctx.db.update(agents).set({ paused: true }).where(eq(agents.id, ctx.ceo.id));
    const d = await ctx.ask(CLEANUP);
    expect(d).toMatchObject({ tier: "owner" });
    expect(whyOf(d)).toMatch(/^Sent to you, not the CEO, because the CEO could not take it first/);
    expect(d.question).toContain(whyOf(d)!);
  });

  it("adds no line to a card that goes to the CEO, and does not change where it goes", async () => {
    const temp = await ctx.ask(CLEANUP);
    expect(temp).toMatchObject({ tier: "ceo" });
    expect(whyOf(temp)).toBeUndefined();
    expect(temp.question).not.toContain("Sent to you");
    const tool = await ctx.ask("", ctx.dev.id, { title: "mcp__frobnicator__run", kind: "other", rawInput: {} });
    expect(tool).toMatchObject({ tier: "ceo" });
    expect(whyOf(tool)).toBeUndefined();
    expect(tool.question).not.toContain("Sent to you");
  });
});
