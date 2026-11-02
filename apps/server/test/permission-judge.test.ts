import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { RunnerCommand } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { decisions, runners } from "../src/db/schema.js";

// BOS-337: the rules judge picks the card's suggested button by where a command reaches, per company setting.
// It never answers a card: the policy decides who gets it first.

let ctx: Awaited<ReturnType<typeof setup>>;
// The old text rule says Deny (a relative delete it can't vouch for); the judge says Allow (stays in its own folder).
const OLD_DENY_JUDGE_ALLOW = 'rm -rf shots && git status --porcelain && echo "clean-check-done"';
// The old rule says Allow (the only delete is build output); the judge says Deny (prints environment values).
const OLD_ALLOW_JUDGE_DENY = "rm -rf dist && env";
const logged: string[] = [];

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws", now: () => new Date() });
  vi.spyOn(built.app.log, "error").mockImplementation(((m: unknown) => void logged.push(String(m))) as never);
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const companyId = ((await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } }).company.id;
  const dev = (await req("POST", `/api/companies/${companyId}/agents`, { name: "Senior Developer" })).json() as { id: string };
  const reg = (await req("POST", `/api/companies/${companyId}/runner`)).json() as { runnerId: string };
  const [runner] = await db.select().from(runners).where(eq(runners.id, reg.runnerId));
  const sent: RunnerCommand[] = [];
  built.runners.connect(runner!.id, (cmd) => (sent.push(cmd), true));
  let seq = 0;
  const ask = async (command: string) => {
    const runId = randomUUID();
    const requestId = randomUUID();
    const at = new Date().toISOString();
    await built.runners.ingest(runner!, { seq: ++seq, at, event: { type: "run.started", runId, agentId: dev.id, acpSessionId: "s", model: null } });
    await built.runners.ingest(runner!, { seq: ++seq, at, event: { type: "run.permission_request", runId, requestId, title: "Clean up", kind: "execute", rawInput: { command }, options: [] } as never });
    const [d] = await db.select().from(decisions).where(eq(decisions.dedupeKey, `permission:${requestId}`));
    return d!;
  };
  return { ...built, db, close, req, companyId, ask };
}

beforeEach(async () => {
  logged.length = 0;
  ctx = await setup();
});
afterEach(async () => {
  await ctx.app.close();
  await ctx.close();
});

const setMode = (permissionJudge: string) => ctx.req("PATCH", `/api/companies/${ctx.companyId}`, { permissionJudge });

describe("rules judge setting (BOS-337)", () => {
  it("is on by default: the judge's verdict is the suggested button and its fixed reason is on the card", async () => {
    const a = await ctx.ask(OLD_DENY_JUDGE_ALLOW);
    expect(a).toMatchObject({ recommendedOption: "Allow once", context: { judge: { mode: "advise", verdict: "allow", row: "ok" } } });
    const b = await ctx.ask(OLD_ALLOW_JUDGE_DENY);
    expect(b).toMatchObject({ recommendedOption: "Deny", context: { judge: { mode: "advise", verdict: "deny", row: "secret", reason: expect.stringMatching(/secret/) } } });
  });

  it("off: the older text rule suggests, nothing is recorded", async () => {
    expect((await setMode("off")).statusCode).toBe(200);
    const a = await ctx.ask(OLD_DENY_JUDGE_ALLOW);
    expect(a.recommendedOption).toBe("Deny");
    expect((a.context as { judge?: unknown }).judge).toBeUndefined();
  });

  it("watch: the older rule still suggests, the judge's reading is kept and logged next to the answer", async () => {
    await setMode("watch");
    const a = await ctx.ask(OLD_DENY_JUDGE_ALLOW);
    expect(a).toMatchObject({ recommendedOption: "Deny", context: { judge: { mode: "watch", verdict: "allow" } } });
    await ctx.req("POST", `/api/decisions/${a.id}/answer`, { answer: "Allow once" });
    expect(logged.some((l) => l.includes(a.id) && l.includes("judge=allow") && l.includes("human=allow") && !l.includes("DISAGREE"))).toBe(true);
    const b = await ctx.ask(OLD_ALLOW_JUDGE_DENY);
    await ctx.req("POST", `/api/decisions/${b.id}/answer`, { answer: "Allow once" });
    expect(logged.some((l) => l.includes(b.id) && l.includes("judge=deny") && l.includes("human=allow") && l.includes("DISAGREE"))).toBe(true);
  });

  it("only takes off, watch or advise", async () => {
    expect((await setMode("act")).statusCode).toBe(400);
  });
});
