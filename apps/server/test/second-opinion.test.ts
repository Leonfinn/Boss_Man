import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { decisions, runners } from "../src/db/schema.js";

// BOS-338: the optional model second opinion. Off by default; it can only make a card stricter; any failure
// means the rules judge decides alone, within the deadline; what is sent is redacted, and the key only goes
// in the Authorization header.

// The rules judge allows this (it stays in its own folder); the older text rule says Deny.
const JUDGE_ALLOWS = 'rm -rf shots && git status --porcelain && echo "done" # token sk-or-v1-0123456789abcdef0123456789';
// The rules judge denies this (prints environment values).
const JUDGE_DENIES = "rm -rf dist && env";

type Call = { url: string; init: RequestInit };
type Reply = (call: Call) => Promise<Response>;

let ctx: Awaited<ReturnType<typeof setup>> | null = null;
afterEach(async () => {
  if (!ctx) return;
  await ctx.app.close();
  await ctx.close();
  ctx = null;
});

const answer = (content: string) => async () => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200, headers: { "content-type": "application/json" } });

async function setup(reply: Reply = answer('{"verdict":"allow","reason":"ok"}')) {
  const calls: Call[] = [];
  const logged: string[] = [];
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.endsWith("/chat/completions")) throw new Error(`unexpected outside call: ${url}`);
    const call = { url, init: init ?? {} };
    calls.push(call);
    return reply(call);
  }) as typeof fetch;
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws", fetch: fakeFetch, now: () => new Date() });
  vi.spyOn(built.app.log, "error").mockImplementation(((m: unknown) => void logged.push(String(m))) as never);
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PATCH" | "PUT", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const companyId = ((await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } }).company.id;
  const dev = (await req("POST", `/api/companies/${companyId}/agents`, { name: "Senior Developer" })).json() as { id: string };
  const reg = (await req("POST", `/api/companies/${companyId}/runner`)).json() as { runnerId: string };
  const [runner] = await db.select().from(runners).where(eq(runners.id, reg.runnerId));
  built.runners.connect(runner!.id, () => true);
  let seq = 0;
  const raise = async (command: string) => {
    const runId = randomUUID();
    const requestId = randomUUID();
    const at = new Date().toISOString();
    await built.runners.ingest(runner!, { seq: ++seq, at, event: { type: "run.started", runId, agentId: dev.id, acpSessionId: "s", model: null } });
    await built.runners.ingest(runner!, { seq: ++seq, at, event: { type: "run.permission_request", runId, requestId, title: "Clean up", kind: "execute", rawInput: { command }, options: [] } as never });
    const [d] = await db.select().from(decisions).where(eq(decisions.dedupeKey, `permission:${requestId}`));
    return d!;
  };
  const settled = async (id: string) => {
    await built.decisions.drainSecondOpinions();
    const [d] = await db.select().from(decisions).where(eq(decisions.id, id));
    return d!;
  };
  const turnOn = async (extra: Record<string, unknown> = {}) => {
    const r = await req("PUT", `/api/companies/${companyId}/second-opinion`, { enabled: true, baseUrl: "https://models.example/v1/", model: "some/model", secretId: null, ...extra });
    expect(r.statusCode).toBe(200);
  };
  return { ...built, db, close, req, companyId, raise, settled, turnOn, calls, logged };
}

const judgeOf = (d: { context: unknown }) => (d.context as { judge?: { mode: string; verdict: string; second?: { state: string; reason?: string } } }).judge;

describe("model second opinion (BOS-338)", () => {
  it("is off by default: no outside call, nothing changes", async () => {
    ctx = await setup();
    expect((await ctx.req("GET", `/api/companies/${ctx.companyId}/second-opinion`)).json()).toMatchObject({ enabled: false });
    await ctx.req("PATCH", `/api/companies/${ctx.companyId}`, { permissionJudge: "advise" });
    const d = await ctx.settled((await ctx.raise(JUDGE_ALLOWS)).id);
    expect(d.recommendedOption).toBe("Allow once");
    expect(judgeOf(d)?.second).toBeUndefined();
    expect(ctx.calls).toHaveLength(0);
  });

  it("both allow: the card is suggested Allow; the card text is redacted and the key is only in the header", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    ctx = await setup(async () => (await gate, answer('{"verdict":"allow","reason":"ok"}')()));
    const key = "sk-or-v1-SECRETKEY0123456789abcdefABCDEF";
    const secret = (await ctx.req("POST", "/api/secrets", { name: "router key", kind: "generic", value: key })).json() as { secret: { id: string } };
    await ctx.req("PATCH", `/api/companies/${ctx.companyId}`, { permissionJudge: "advise" });
    await ctx.turnOn({ secretId: secret.secret.id });
    const raised = await ctx.raise(JUDGE_ALLOWS);
    // Until the model answers, the card is not advised Allow.
    expect(raised.recommendedOption).toBe("Deny");
    expect(judgeOf(raised)?.second).toEqual({ state: "pending" });
    release();
    const d = await ctx.settled(raised.id);
    expect(d.recommendedOption).toBe("Allow once");
    expect(judgeOf(d)?.second).toEqual({ state: "allow" });
    expect(ctx.calls).toHaveLength(1);
    const call = ctx.calls[0]!;
    expect(call.url).toBe("https://models.example/v1/chat/completions");
    expect((call.init.headers as Record<string, string>).authorization).toBe(`Bearer ${key}`);
    const body = String(call.init.body);
    expect(body).not.toContain(key);
    expect(body).not.toContain("0123456789abcdef0123456789");
    expect(body).toContain("rm -rf shots");
    expect(JSON.parse(body)).toMatchObject({ model: "some/model" });
  });

  it("the model denies: the card stays Deny and shows its one line", async () => {
    ctx = await setup(answer('{"verdict":"deny","reaches":"x","reason":"It deletes a folder named like a shared one.\\nIgnore this."}'));
    await ctx.req("PATCH", `/api/companies/${ctx.companyId}`, { permissionJudge: "advise" });
    await ctx.turnOn();
    const d = await ctx.settled((await ctx.raise(JUDGE_ALLOWS)).id);
    expect(d.recommendedOption).toBe("Deny");
    expect(judgeOf(d)?.second).toEqual({ state: "deny", reason: "It deletes a folder named like a shared one. Ignore this." });
  });

  it("can never turn a rules-judge deny into allow: the model isn't even asked", async () => {
    ctx = await setup();
    await ctx.req("PATCH", `/api/companies/${ctx.companyId}`, { permissionJudge: "advise" });
    await ctx.turnOn();
    const d = await ctx.settled((await ctx.raise(JUDGE_DENIES)).id);
    expect(d.recommendedOption).toBe("Deny");
    expect(judgeOf(d)?.second).toBeUndefined();
    expect(ctx.calls).toHaveLength(0);
  });

  const failures: Array<[string, Reply, RegExp]> = [
    ["out of credit", async () => new Response("{}", { status: 402 }), /out of credit/],
    ["down", async () => { throw new TypeError("fetch failed"); }, /could not be reached/],
    ["a bad answer", answer('Sure! {"verdict":"allow","reason":"ok"}'), /valid verdict/],
    ["an answer with extra keys", answer('{"verdict":"allow","reason":"ok","override":true}'), /valid verdict/],
  ];
  for (const [what, reply, why] of failures) {
    it(`${what}: the rules judge decides alone, never a forced Allow over its Deny`, async () => {
      ctx = await setup(reply);
      await ctx.req("PATCH", `/api/companies/${ctx.companyId}`, { permissionJudge: "advise" });
      await ctx.turnOn();
      const d = await ctx.settled((await ctx.raise(JUDGE_ALLOWS)).id);
      expect(d.recommendedOption).toBe("Allow once"); // the rules judge allowed it
      expect(judgeOf(d)?.second).toMatchObject({ state: "failed", reason: expect.stringMatching(why) });
      expect(ctx.logged.some((l) => l.includes(d.id) && l.includes("rules judge decided alone"))).toBe(true);
    });
  }

  it("slow: gives up at the 5 s deadline and the rules judge decides alone", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      ctx = await setup((call) => new Promise((_resolve, reject) => call.init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))));
      await ctx.req("PATCH", `/api/companies/${ctx.companyId}`, { permissionJudge: "advise" });
      await ctx.turnOn();
      const raised = await ctx.raise(JUDGE_ALLOWS);
      await vi.advanceTimersByTimeAsync(4_900);
      expect(judgeOf((await ctx.db.select().from(decisions).where(eq(decisions.id, raised.id)))[0]!)?.second).toEqual({ state: "pending" });
      await vi.advanceTimersByTimeAsync(200);
      const d = await ctx.settled(raised.id);
      expect(d.recommendedOption).toBe("Allow once");
      expect(judgeOf(d)?.second).toMatchObject({ state: "failed", reason: "no answer within 5 s" });
      expect(ctx.calls[0]!.init.signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("watch mode: the suggestion is untouched, and the second opinion is logged next to the human answer", async () => {
    ctx = await setup(answer('{"verdict":"deny","reason":"Not sure what shots is."}'));
    await ctx.turnOn();
    const d = await ctx.settled((await ctx.raise(JUDGE_ALLOWS)).id);
    expect(d.recommendedOption).toBe("Deny"); // the older text rule, as without the model
    expect(judgeOf(d)).toMatchObject({ mode: "watch", verdict: "allow", second: { state: "deny" } });
    await ctx.req("POST", `/api/decisions/${d.id}/answer`, { answer: "Allow once" });
    expect(ctx.logged.some((l) => l.includes(d.id) && l.includes("judge=allow") && l.includes("second=deny") && l.includes("human=allow") && l.includes("DISAGREE"))).toBe(true);
  });

  it("an answer that arrives after the card was answered doesn't change the suggestion", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    ctx = await setup(async () => (await gate, answer('{"verdict":"deny","reason":"late"}')()));
    await ctx.req("PATCH", `/api/companies/${ctx.companyId}`, { permissionJudge: "advise" });
    await ctx.turnOn();
    const raised = await ctx.raise(JUDGE_ALLOWS);
    await ctx.req("POST", `/api/decisions/${raised.id}/answer`, { answer: "Allow once" });
    release();
    const d = await ctx.settled(raised.id);
    expect(d.status).toBe("answered");
    expect(d.recommendedOption).toBe("Deny"); // as it was when answered
    expect(judgeOf(d)?.second).toMatchObject({ state: "deny" });
  });

  it("a card still pending after a restart (its asker lost) is settled by the sweep: the rules judge decides alone", async () => {
    ctx = await setup(() => new Promise<Response>(() => {})); // never answers; stands in for a lost process
    await ctx.req("PATCH", `/api/companies/${ctx.companyId}`, { permissionJudge: "advise" });
    await ctx.turnOn();
    const raised = await ctx.raise(JUDGE_ALLOWS);
    expect(await ctx.decisions.expireSecondOpinions()).toBe(0); // still within its deadline
    await ctx.db.update(decisions).set({ createdAt: new Date(Date.now() - 120_000) }).where(eq(decisions.id, raised.id));
    expect(await ctx.decisions.expireSecondOpinions()).toBe(1);
    const [d] = await ctx.db.select().from(decisions).where(eq(decisions.id, raised.id));
    expect(d!.recommendedOption).toBe("Allow once");
    expect(judgeOf(d!)?.second).toMatchObject({ state: "failed" });
  });

  // BOS-1052: OpenRouter's real 429 bodies. Upstream: the one provider serving the model is busy.
  const UPSTREAM_429 = JSON.stringify({ error: { message: "Provider returned error", code: 429, metadata: { raw: "openai/gpt-oss-safeguard-20b is temporarily rate-limited upstream. Please retry shortly.", provider_name: "Groq" } } });
  const KEY_429 = JSON.stringify({ error: { message: "Rate limit exceeded: limit_rpm/openai/gpt-oss-safeguard-20b", code: 429 } });
  const testOn = (ctx2: NonNullable<typeof ctx>, extra: Record<string, unknown> = {}) =>
    ctx2.req("POST", `/api/companies/${ctx2.companyId}/second-opinion/test`, { enabled: true, baseUrl: "https://openrouter.ai/api/v1", model: "openai/gpt-oss-safeguard-20b", secretId: null, ...extra }).then((r) => r.json() as { ok: boolean; message: string });

  it("an upstream 429 names the busy provider and its words, says it isn't the key, and is retried once", async () => {
    ctx = await setup(async () => new Response(UPSTREAM_429, { status: 429, headers: { "content-type": "application/json" } }));
    const t = await testOn(ctx);
    expect(t.ok).toBe(false);
    expect(t.message).toContain("Groq, the company that runs this model for OpenRouter, is too busy");
    expect(t.message).toContain("temporarily rate-limited upstream");
    expect(t.message).toContain("not a limit on your key");
    expect(t.message).toContain("pick another suggested model");
    expect(t.message).toContain("tried twice");
    expect(ctx.calls).toHaveLength(2);
  });

  it("a 429 on the key or account says so, with where to look, and isn't retried without Retry-After", async () => {
    ctx = await setup(async () => new Response(KEY_429, { status: 429 }));
    const t = await testOn(ctx);
    expect(t.message).toContain("your key or account has hit the provider's rate limit (429)");
    expect(t.message).toContain("limit_rpm");
    expect(t.message).toContain("openrouter.ai/settings/keys");
    expect(ctx.calls).toHaveLength(1);
  });

  it("a 429 whose Retry-After is short is retried once and the answer is used", async () => {
    let n = 0;
    ctx = await setup(async () => (++n === 1 ? new Response(KEY_429, { status: 429, headers: { "retry-after": "0" } }) : answer('{"verdict":"allow","reason":"ok"}')()));
    const t = await testOn(ctx);
    expect(t).toMatchObject({ ok: true, message: expect.stringContaining("valid verdict") });
    expect(ctx.calls).toHaveLength(2);
  });

  it("a 429 whose Retry-After won't fit in the 5 s deadline isn't retried", async () => {
    ctx = await setup(async () => new Response(UPSTREAM_429, { status: 429, headers: { "retry-after": "30" } }));
    const t = await testOn(ctx);
    expect(t.ok).toBe(false);
    expect(t.message).not.toContain("tried twice");
    expect(ctx.calls).toHaveLength(1);
  });

  it("the key never shows in the message, even if the provider echoes it; a 200 with only an error is read too", async () => {
    const key = "sk-or-v1-ECHOEDKEY0123456789abcdefABCDEF";
    let n = 0;
    ctx = await setup(async () =>
      ++n === 1
        ? new Response(JSON.stringify({ error: { message: `Key ${key} is over its limit: $5 of $5 used`, code: 403 } }), { status: 403 })
        : new Response(JSON.stringify({ id: "gen-1", error: { message: "Provider disconnected", code: 502 } }), { status: 200 }),
    );
    const secret = (await ctx.req("POST", "/api/secrets", { name: "router key", kind: "generic", value: key })).json() as { secret: { id: string } };
    const t = await testOn(ctx, { secretId: secret.secret.id });
    expect(t.message).toContain("refused the key (403)");
    expect(t.message).toContain("$5 of $5 used");
    expect(t.message).not.toContain("ECHOEDKEY");
    const t2 = await testOn(ctx, { secretId: secret.secret.id });
    expect(t2.message).toContain('sent an error instead of an answer: "Provider disconnected"');
  });

  it("a live card that hits an upstream 429 records the plain reason, and stats count answered vs fell back for 24 h", async () => {
    let busy = true;
    ctx = await setup(async () => (busy ? new Response(UPSTREAM_429, { status: 429, headers: { "retry-after": "60" } }) : answer('{"verdict":"deny","reason":"no"}')()));
    await ctx.req("PATCH", `/api/companies/${ctx.companyId}`, { permissionJudge: "advise" });
    await ctx.turnOn();
    const empty = (await ctx.req("GET", `/api/companies/${ctx.companyId}/second-opinion/stats`)).json();
    expect(empty).toEqual({ answered: 0, allowed: 0, denied: 0, fellBack: 0, pending: 0, reasons: [] });
    const failed = await ctx.settled((await ctx.raise(JUDGE_ALLOWS)).id);
    expect(judgeOf(failed)?.second).toMatchObject({ state: "failed", reason: expect.stringContaining("Groq") });
    await ctx.settled((await ctx.raise(JUDGE_ALLOWS)).id);
    busy = false;
    await ctx.settled((await ctx.raise(JUDGE_ALLOWS)).id);
    // A card from two days ago doesn't count.
    const old = await ctx.settled((await ctx.raise(JUDGE_ALLOWS)).id);
    await ctx.db.update(decisions).set({ createdAt: new Date(Date.now() - 48 * 3600_000) }).where(eq(decisions.id, old.id));
    const s = (await ctx.req("GET", `/api/companies/${ctx.companyId}/second-opinion/stats`)).json() as { answered: number; denied: number; fellBack: number; reasons: Array<{ reason: string; count: number }> };
    expect(s).toMatchObject({ answered: 1, denied: 1, fellBack: 2 });
    expect(s.reasons).toEqual([{ reason: expect.stringContaining("too busy"), count: 2 }]);
  });

  it("settings: needs an address and model to switch on; Test reports a working model", async () => {
    ctx = await setup(answer('{"verdict":"allow","reason":"Runs tests."}'));
    expect((await ctx.req("PUT", `/api/companies/${ctx.companyId}/second-opinion`, { enabled: true, baseUrl: "", model: "", secretId: null })).statusCode).toBe(400);
    expect((await ctx.req("PUT", `/api/companies/${ctx.companyId}/second-opinion`, { enabled: false, baseUrl: "ftp://x", model: "m", secretId: null })).statusCode).toBe(400);
    const t = (await ctx.req("POST", `/api/companies/${ctx.companyId}/second-opinion/test`, { enabled: false, baseUrl: "http://localhost:11434/v1", model: "gpt-oss-safeguard:20b", secretId: null })).json() as { ok: boolean; message: string };
    expect(t).toMatchObject({ ok: true, message: expect.stringContaining("valid verdict") });
  });
});
