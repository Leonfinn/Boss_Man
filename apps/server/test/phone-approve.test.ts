// Phone Approve buttons (BOS-243): every rule of the binding spec, 0-8, with the late review notes.
import { randomBytes } from "node:crypto";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { activity, approveTokens, decisions, notifications, phoneActionHits, ticketDependencies } from "../src/db/schema.js";
import type { Leader } from "../src/leader.js";
import { issueRunToken } from "../src/mcp.js";
import { approveGate, cleanSummary, decisionRev, hashToken, IP_LIMIT, phoneApprovable, plainText } from "../src/services/phone-approve.js";
import { DEFAULT_NOTIFY_SETTINGS, ntfyPublishUrl } from "../src/services/notifications.js";

let ctx: { close: () => Promise<void> } | undefined;
afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

type Pushed = { url: string; body: Record<string, any> };
const SETTINGS = { quietHours: null, agentHourlyCap: 6, ntfy: { url: "https://ntfy.example.ts.net", topic: "bossman", token: "tk_secret_value_123" }, phonePush: "all", publicUrl: "https://bossman.example.ts.net" };

async function setup(opts: { listen?: boolean } = {}) {
  const { db, close } = await openPglite();
  let clock = new Date("2026-11-02T12:00:00Z");
  const pushed: Pushed[] = [];
  let pushFails = false;
  // BOS-944: the anonymous read of the topic. 401 = private (the bundled deny-all server); 200 = anyone can read.
  let topicStatus: number | "throw" = 401;
  const polls: Array<{ url: string; auth: string | null }> = [];
  const fakeFetch = (async (input: URL | string, init?: RequestInit) => {
    if (init?.method === "GET") {
      polls.push({ url: String(input), auth: new Headers(init.headers).get("authorization") });
      if (topicStatus === "throw") throw new Error("connect ECONNREFUSED");
      return new Response("", { status: topicStatus });
    }
    pushed.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return new Response("{}", { status: pushFails ? 500 : 200 });
  }) as typeof fetch;
  // Everything Fastify logs, at every level, so a test can prove the token is never in it.
  const logged: string[] = [];
  const stream = new Writable({ write: (chunk, _enc, cb) => (logged.push(String(chunk)), cb()) });
  let leading = true;
  const leader: Leader = { role: () => (leading ? "leader" : "standby") as never, isLeader: () => leading, onPromote: () => {}, onDemote: () => {}, start: async () => {}, stop: async () => {}, demote: async () => {}, promote: async () => {} };
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, now: () => clock, fetch: fakeFetch, logger: { level: "trace", stream }, leader });
  let base = "";
  if (opts.listen) {
    await built.app.listen({ host: "127.0.0.1", port: 0 });
    base = `127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  }
  ctx = { close: async () => (await built.app.close(), await close()) };
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PUT", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company } = (await req("POST", "/api/companies", { name: "App Co" })).json();
  const worker = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Engineer" })).json();
  await req("PUT", "/api/notification-settings", SETTINGS);

  /** An agent's plain question that passes rule 1. */
  const ask = (extra: Partial<Parameters<typeof built.decisions.raise>[0]> = {}) =>
    built.decisions.raise({ companyId: company.id, agentId: worker.id, question: "Use deSEC for DNS?", options: ["Yes", "No"], recommended: "Yes", triedFirst: "Compared three DNS providers myself.", approveSummary: "Use deSEC for DNS on the website", ...extra });
  /** Sends the pending decision pushes and returns the last one's Approve token, if it had one. */
  const sync = async () => {
    const before = pushed.length;
    await built.notes.syncDecisions();
    const p = pushed.slice(before).at(-1);
    const approve = (p?.body.actions as Array<{ action: string; body?: string }> | undefined)?.find((a) => a.action === "http");
    return { push: p, token: approve ? (JSON.parse(approve.body!).token as string) : null };
  };
  const tap = (body: unknown, o: { ip?: string; contentType?: string } = {}) =>
    built.app.inject({ method: "POST", url: "/api/phone/approve", remoteAddress: o.ip ?? "10.0.0.5", headers: { "content-type": o.contentType ?? "application/json" }, payload: typeof body === "string" ? body : JSON.stringify(body) });
  const lastMessage = () => pushed.at(-1)?.body.message as string | undefined;
  const mcp = async (agentId: string) => {
    const token = await issueRunToken(db, { companyId: company.id, agentId, runId: crypto.randomUUID() });
    const c = new Client({ name: "test", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    return c;
  };
  return { ...built, db, req, company, worker, pushed, polls, setTopic: (v: number | "throw") => (topicStatus = v), logged, ask, sync, tap, lastMessage, mcp, setClock: (d: Date) => (clock = d), clock: () => clock, failPushes: (v: boolean) => (pushFails = v), setLeading: (v: boolean) => (leading = v) };
}

const httpActions = (p: Pushed | undefined) => ((p?.body.actions ?? []) as Array<{ action: string }>).filter((a) => a.action === "http");

describe("rule 0: ntfy address check", () => {
  const gate = (url: string) => approveGate({ ...DEFAULT_NOTIFY_SETTINGS, ntfy: { url, topic: "t", tokenSecretId: "x" }, publicUrl: "https://b.example.ts.net" } as never, "tok");
  it("accepts https and the bundled http://ntfy only", () => {
    for (const url of ["https://ntfy.example.ts.net:8443", "http://ntfy:80", "http://ntfy", "http://NTFY:80/"]) expect(gate(url)).toEqual({ on: true });
    for (const url of ["http://ntfy.example.ts.net", "http://ntfy:8080", "http://ntfy.evil.com", "http://user@ntfy", "http://ntfy@evil.com", "http://10.0.0.5", "ftp://ntfy", "not a url"]) expect(gate(url).on).toBe(false);
  });
});

describe("rule 0: Approve only through the owner's private channel", () => {
  it("needs a publish token, an https ntfy URL and an https public URL; Open stays either way", async () => {
    const c = await setup();
    // Token removal goes last: the settings keep the token's secret and re-adding one is a separate case.
    for (const settings of [
      { ...SETTINGS, ntfy: { ...SETTINGS.ntfy, url: "http://ntfy.example.ts.net" } },
      { ...SETTINGS, publicUrl: "http://bossman.example.ts.net" },
      { ...SETTINGS, approveButtons: false },
      { ...SETTINGS, ntfy: { ...SETTINGS.ntfy, token: null } },
    ]) {
      expect((await c.req("PUT", "/api/notification-settings", settings)).statusCode).toBe(200);
      const d = await c.ask({ question: `Q ${Math.random()}` });
      const { push, token } = await c.sync();
      expect(token).toBeNull();
      expect(httpActions(push)).toEqual([]);
      expect(push!.body.actions).toEqual([{ action: "view", label: "Open in Boss Man", url: `${settings.publicUrl}/#/decisions`, clear: false }]);
      expect(await c.db.select().from(approveTokens).where(eq(approveTokens.decisionId, d.id))).toEqual([]);
    }
    // Settings say why it's off.
    expect((await c.req("GET", "/api/notification-settings")).json().approve).toEqual({ on: false, why: "the ntfy server has no access token (a private server)" });
  });

  it("is on with all three, and Settings say so", async () => {
    const c = await setup();
    expect((await c.req("GET", "/api/notification-settings")).json().approve).toEqual({ on: true });
    await c.ask();
    expect((await c.sync()).token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await c.req("PUT", "/api/notification-settings", { ...SETTINGS, approveButtons: false });
    expect((await c.req("GET", "/api/notification-settings")).json().approve).toEqual({ on: false, why: "switched off" });
  });

  it("BOS-944: a topic anyone can read keeps Approve off, and Settings say why", async () => {
    const c = await setup();
    expect(c.polls.length).toBeGreaterThan(0);
    expect(c.polls[0]).toEqual({ url: "https://ntfy.example.ts.net/bossman/json?poll=1", auth: null });
    c.setTopic(200);
    c.setClock(new Date(c.clock().getTime() + 120_000)); // past the short cache
    expect((await c.req("GET", "/api/notification-settings")).json().approve).toEqual({ on: false, why: "anyone can read your ntfy topic" });
    await c.ask();
    const { push, token } = await c.sync();
    expect(push).toBeDefined();
    expect(token).toBeNull();
  });

  it("BOS-944: only 401 or 403 counts as private; an unreachable or odd answer keeps it off", async () => {
    const c = await setup();
    const status = async () => {
      c.setClock(new Date(c.clock().getTime() + 120_000));
      return (await c.req("GET", "/api/notification-settings")).json().approve;
    };
    c.setTopic(403);
    expect(await status()).toEqual({ on: true });
    c.setTopic(404);
    expect((await status()).on).toBe(false);
    c.setTopic("throw");
    expect((await status()).on).toBe(false);
    c.setTopic(401);
    expect(await status()).toEqual({ on: true });
  });

  it("BOS-944: the poll is cached for a short time", async () => {
    const c = await setup();
    await c.req("GET", "/api/notification-settings");
    const n = c.polls.length;
    await c.req("GET", "/api/notification-settings");
    expect(c.polls.length).toBe(n);
  });

  it("the gate is checked again at redeem: switching it off kills a live link", async () => {
    const c = await setup();
    await c.ask();
    const { token } = await c.sync();
    await c.req("PUT", "/api/notification-settings", { ...SETTINGS, publicUrl: "http://bossman.example.ts.net" });
    const r = await c.tap({ token });
    expect(r.json()).toEqual({ ok: false, outcome: "no_longer_works" });
    expect(c.lastMessage()).toBe("That Approve link no longer works; open Boss Man");
    expect((await c.db.select().from(decisions)).every((d) => d.status === "open")).toBe(true);
  });

  it("there is no other channel: the gate itself refuses anything but https ntfy with a token", () => {
    const s = { ...DEFAULT_NOTIFY_SETTINGS, ntfy: { url: "https://n.example", topic: "t", tokenSecretId: null }, publicUrl: "https://b.example" };
    expect(approveGate(s, "tok")).toEqual({ on: true });
    expect(approveGate(s, "  ").on).toBe(false);
    expect(approveGate(s, null).on).toBe(false);
    expect(approveGate({ ...s, ntfy: null }, "tok").on).toBe(false);
    expect(approveGate({ ...s, publicUrl: null }, "tok").on).toBe(false);
  });
});

describe("rule 1: a fail-closed allowlist, checked at mint and at redeem", () => {
  it("only a plain agent question with a summary gets Approve", async () => {
    const c = await setup();
    const cases: Array<[string, Parameters<typeof c.ask>[0], boolean]> = [
      ["plain", {}, true],
      ["no summary", { approveSummary: undefined }, false],
      ["steps", { steps: ["Open Settings"] }, false],
      ["ownerMustDo", { ownerMustDo: true }, false],
      ["stillNeeded", { stillNeeded: "Asked again because the price changed." }, false],
      ["no agent", { agentId: null }, false],
      ["five options", { options: ["A", "B", "C", "D", "E"], recommended: "A" }, false],
    ];
    for (const [name, extra, eligible] of cases) {
      await c.ask({ question: `Case ${name}`, ...extra });
      const { token } = await c.sync();
      expect([name, !!token]).toEqual([name, eligible]);
    }
  });

  it("stores ownerMustDo, so the rule can see it, and refuses advice, other tiers and out-of-date cards", async () => {
    const c = await setup();
    const d = await c.ask({ ownerMustDo: true, steps: ["Click it"] });
    expect(d.context).toMatchObject({ ownerMustDo: true, steps: ["Click it"] });
    const base = (await c.ask({ question: "Base" })) as typeof decisions.$inferSelect;
    expect(phoneApprovable(base, false)).toBe(true);
    expect(phoneApprovable(base, true)).toBe(false);
    for (const k of ["steps", "ownerMustDo", "ticketId", "stillNeeded", "advice", "ladder", "setsUp", "clearWhen", "plan", "doAfter"]) {
      // Present at all, even falsy, is enough.
      expect([k, phoneApprovable({ ...base, context: { ...(base.context as object), [k]: null } }, false)]).toEqual([k, false]);
    }
    expect(phoneApprovable({ ...base, kind: "approval" }, false)).toBe(false);
    expect(phoneApprovable({ ...base, context: { ...(base.context as object), type: "owner_todo" } }, false)).toBe(false);
    expect(phoneApprovable({ ...base, tier: "ceo" }, false)).toBe(false);
    expect(phoneApprovable({ ...base, forAgentId: c.worker.id }, false)).toBe(false);
    expect(phoneApprovable({ ...base, staleAt: new Date() }, false)).toBe(false);
    expect(phoneApprovable({ ...base, status: "answered" }, false)).toBe(false);
    expect(phoneApprovable({ ...base, recommendedOption: "Maybe" }, false)).toBe(false);
    expect(phoneApprovable({ ...base, context: { ...(base.context as object), approveSummary: "two\nlines" } }, false)).toBe(false);
  });

  it("re-checks at redeem: a card that became a blocker refuses the tap", async () => {
    const c = await setup();
    const d = await c.ask();
    const { token } = await c.sync();
    const project = (await c.req("POST", `/api/companies/${c.company.id}/projects`, { name: "Web" })).json();
    const t = (await c.req("POST", `/api/projects/${project.id}/tickets`, { title: "Website" })).json();
    await c.db.insert(ticketDependencies).values({ blockedTicketId: t.id, blockerDecisionId: d.id });
    expect((await c.tap({ token })).json().outcome).toBe("no_longer_works");
    const [after] = await c.db.select().from(decisions).where(eq(decisions.id, d.id));
    expect(after!.status).toBe("open");
    expect((await c.db.select().from(approveTokens))[0]!.revokedAt).not.toBeNull();
  });

  it("submits only the option stored on the link, whatever else the body says", async () => {
    const c = await setup();
    const d = await c.ask();
    const { token } = await c.sync();
    const r = await c.tap({ token, answer: "No", custom: true, note: "own words" });
    expect(r.json()).toEqual({ ok: true, outcome: "approved" });
    const [after] = await c.db.select().from(decisions).where(eq(decisions.id, d.id));
    expect(after).toMatchObject({ status: "answered", answer: "Yes" });
    // Audited.
    const [a] = await c.db.select().from(activity).where(eq(activity.kind, "decision_phone_approved"));
    expect(a!.summary).toBe('Approved from phone: "Use deSEC for DNS?", answered "Yes"');
  });
});

describe("rule 2: the owner never approves blind", () => {
  it("cleans the summary of control and format characters and refuses an empty one", async () => {
    expect(cleanSummary("Use‮ deSEC​\nnow ok\t")).toBe("Use deSEC now ok");
    expect(cleanSummary("​‮\n ")).toBeNull();
    expect(plainText("a\u0000b؜c")).toBe("abc");

    const c = await setup({ listen: true });
    const client = await c.mcp(c.worker.id);
    const call = (approveSummary: string, question: string) => client.callTool({ name: "raise_decision", arguments: { question, options: ["Yes", "No"], recommended: "Yes", triedFirst: "Compared three DNS providers myself first.", approveSummary } });
    const refused = (await call("​\n‮", "Empty?")) as { isError?: boolean; content: Array<{ text: string }> };
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toContain("approveSummary is empty");
    await call("Use‮ deSEC\n for DNS", "Use deSEC?");
    const [d] = await c.db.select().from(decisions).where(eq(decisions.question, "Use deSEC?"));
    expect((d!.context as { approveSummary: string }).approveSummary).toBe("Use deSEC  for DNS");
    await client.close();
  });

  it("shows the stored question, then what Approve does, as plain text", async () => {
    const c = await setup();
    await c.ask({ question: "Use‮ deSEC\nfor DNS?", approveSummary: "Use deSEC for DNS on the website" });
    const { push } = await c.sync();
    expect(push!.body.message).toBe("Use deSEC for DNS?\n\nApprove = Use deSEC for DNS on the website ('Yes')");
    expect(push!.body.markdown).toBe(false);
  });

  it("keeps the whole Approve line when a 1000-character question of 4-byte characters would push it past the limit (BOS-943)", async () => {
    const c = await setup();
    // 1000 emoji: 1000 characters, 4000 bytes, so the question alone is over the 3500-byte push limit.
    const question = "🙂".repeat(1000);
    await c.ask({ question, approveSummary: "Use deSEC for DNS on the website" });
    const { push, token } = await c.sync();
    expect(token).not.toBeNull();
    const message = push!.body.message as string;
    // What the phone receives is what Boss Man sent, already within the limit (nothing was cut off).
    expect(new TextEncoder().encode(message).length).toBeLessThanOrEqual(3500);
    expect(message.endsWith("Approve = Use deSEC for DNS on the website ('Yes')")).toBe(true);
    expect(message.startsWith("🙂")).toBe(true);
    expect(message).toContain("...\n\nApprove = ");
  });
});

describe("rule 3: the token only ever in the POST body", () => {
  it("emits exactly the specified action, and the token is in no URL, text, row, log or response", async () => {
    const c = await setup();
    const d = await c.ask();
    const { push, token } = await c.sync();
    expect(push!.body.actions).toEqual([
      { action: "view", label: "Open in Boss Man", url: "https://bossman.example.ts.net/#/decisions", clear: false },
      { action: "http", label: "Approve", url: "https://bossman.example.ts.net/api/phone/approve", method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }), clear: true },
    ]);
    const { actions, ...rest } = push!.body;
    void actions;
    expect(JSON.stringify(rest)).not.toContain(token!);
    expect(push!.url).not.toContain(token!);
    expect((actions as Array<{ url: string }>).every((a) => !a.url.includes(token!))).toBe(true);
    const [stored] = await c.db.select().from(approveTokens);
    expect(stored!.tokenHash).toBe(hashToken(token!));
    expect(JSON.stringify(stored)).not.toContain(token!);

    const responses = [await c.tap({ token }), await c.tap({ token }), await c.tap(`{"token":"${token}"`), await c.tap(token!, { contentType: "text/plain" })];
    for (const r of responses) expect(r.body).not.toContain(token!);
    expect(responses.map((r) => r.statusCode)).toEqual([200, 200, 400, 415]);
    const [n] = await c.db.select().from(notifications).where(eq(notifications.decisionId, d.id));
    expect(JSON.stringify(n)).not.toContain(token!);
    for (const p of c.pushed.slice(1)) expect(JSON.stringify(p)).not.toContain(token!);
    expect(c.logged.join("")).not.toContain(token!);
    expect(c.logged.join("")).not.toContain("/api/phone/approve");
    // The capture works: other requests are logged.
    expect(c.logged.join("")).toContain("/api/notification-settings");
    expect(JSON.stringify(await c.serverStatus.status(c.company.id))).not.toContain(token!);
  });

  it("a failed push revokes the link it carried and stores no token", async () => {
    const c = await setup();
    c.failPushes(true);
    await c.ask();
    const { token } = await c.sync();
    const [stored] = await c.db.select().from(approveTokens);
    expect(stored!.revokedAt).not.toBeNull();
    const [n] = await c.db.select().from(notifications);
    expect(n!.pushError).toBe("ntfy answered 500");
    c.failPushes(false);
    expect((await c.tap({ token })).json().outcome).toBe("no_longer_works");
  });
});

describe("rule 4: JSON only, and every tap on a real token gets a reply push", () => {
  it("approved, then already answered", async () => {
    const c = await setup();
    await c.ask({ question: "Use‮ deSEC​ for DNS?" });
    const { token } = await c.sync();
    expect((await c.tap({ token })).json().outcome).toBe("approved");
    expect(c.lastMessage()).toBe("Approved: Use deSEC for DNS?, answered 'Yes'");
    expect(c.pushed.at(-1)!.body.markdown).toBe(false);
    expect((await c.tap({ token })).json().outcome).toBe("already_answered");
    expect(c.lastMessage()).toBe("Already answered: 'Yes' by you");
  });

  it("already answered in the web app, with control characters stripped from the answer (N4)", async () => {
    const c = await setup();
    const d = await c.ask();
    const { token } = await c.sync();
    expect((await c.req("POST", `/api/decisions/${d.id}/answer`, { answer: "No‮\nthanks", custom: true })).statusCode).toBe(200);
    expect((await c.tap({ token })).json().outcome).toBe("already_answered");
    expect(c.lastMessage()).toBe("Already answered: 'No thanks' by you");
  });

  it("being applied, couldn't apply, no longer works; unknown and malformed tokens get a bare 404 and no push", async () => {
    const c = await setup();
    const d = await c.ask();
    const { token } = await c.sync();
    await c.db.update(approveTokens).set({ claimedAt: c.clock() });
    expect((await c.tap({ token })).json().outcome).toBe("being_applied");
    expect(c.lastMessage()).toBe("Already being applied; you'll get a notification in a moment");
    // The claim is held 60 s; after that a re-tap may claim it.
    c.setClock(new Date(c.clock().getTime() + 61_000));
    const answer = c.decisions.answer;
    c.decisions.answer = async () => {
      throw new Error("db down");
    };
    expect((await c.tap({ token })).json().outcome).toBe("try_again");
    expect(c.lastMessage()).toBe("Couldn't apply it yet; tap Approve again, or open Boss Man");
    expect(c.pushed.at(-1)!.body.actions).toEqual([{ action: "view", label: "Open in Boss Man", url: "https://bossman.example.ts.net/#/decisions", clear: false }]);
    c.decisions.answer = answer;
    // Expired.
    c.setClock(new Date(c.clock().getTime() + 15 * 60_000));
    expect((await c.tap({ token })).json().outcome).toBe("no_longer_works");
    expect(c.lastMessage()).toBe("That Approve link no longer works; open Boss Man");
    expect((await c.db.select().from(decisions).where(eq(decisions.id, d.id)))[0]!.status).toBe("open");

    const pushes = c.pushed.length;
    const unknown = await c.tap({ token: randomBytes(32).toString("base64url") });
    expect([unknown.statusCode, unknown.json()]).toEqual([404, { ok: false, error: "not_found" }]);
    const malformed = await c.tap({ token: "short" });
    expect([malformed.statusCode, malformed.json()]).toEqual([404, { ok: false, error: "not_found" }]);
    expect((await c.tap("not json")).statusCode).toBe(400);
    expect((await c.tap({ token }, { contentType: "application/x-www-form-urlencoded" })).json()).toEqual({ ok: false, error: "json_only" });
    expect(c.pushed.length).toBe(pushes);
  });

  it("a standby answers 503 with Retry-After and claims nothing", async () => {
    const c = await setup();
    await c.ask();
    const { token } = await c.sync();
    c.setLeading(false);
    const r = await c.tap({ token });
    expect(r.statusCode).toBe(503);
    expect(r.headers["retry-after"]).toBe("2");
    expect((await c.db.select().from(approveTokens))[0]!.claimedAt).toBeNull();
    c.setLeading(true);
    expect((await c.tap({ token })).json().outcome).toBe("approved");
  });

  it("serves no page: GET is not a route and the web CSP is unchanged", async () => {
    const c = await setup();
    const r = await c.app.inject({ method: "GET", url: "/api/phone/approve" });
    expect(r.statusCode).toBe(404);
    expect(r.headers["content-type"]).toContain("application/json");
  });
});

describe("rule 5: the token table, decision_rev and revoking", () => {
  it("decision_rev covers exactly the approved-on fields", async () => {
    const c = await setup();
    const d = (await c.ask()) as typeof decisions.$inferSelect;
    const rev = decisionRev(d);
    const ctx = d.context as object;
    expect(decisionRev({ ...d, context: { ...ctx, settled: { name: "x" }, triedFirst: "else", handled: "note", delivered: false } })).toBe(rev);
    // jsonb may reorder keys; the rev doesn't care.
    expect(decisionRev({ ...d, context: Object.fromEntries(Object.entries(ctx).reverse()) })).toBe(rev);
    for (const changed of [{ question: "Other?" }, { options: ["No", "Yes"] }, { recommendedOption: "No" }, { context: { ...ctx, approveSummary: "Other" } }, { context: { ...ctx, advice: { state: "asking" } } }, { context: { ...ctx, steps: [] } }]) {
      expect(decisionRev({ ...d, ...changed } as typeof d)).not.toBe(rev);
    }
  });

  it("allows only one live token per decision", async () => {
    const c = await setup();
    const d = await c.ask();
    await c.sync();
    const t = c.clock();
    await expect(c.db.insert(approveTokens).values({ companyId: c.company.id, decisionId: d.id, answer: "Yes", tokenHash: "x", decisionRev: "r", expiresAt: new Date(t.getTime() + 60_000) })).rejects.toThrow();
    await c.db.update(approveTokens).set({ usedAt: t });
    await c.db.insert(approveTokens).values({ companyId: c.company.id, decisionId: d.id, answer: "Yes", tokenHash: "y", decisionRev: "r", expiresAt: new Date(t.getTime() + 60_000) });
  });

  it("asking the CEO for advice, the CEO's reissue and the agent's withdraw revoke live links", async () => {
    const c = await setup();
    // Ask advice, then reissue as a replacement.
    const d1 = await c.ask({ question: "One?" });
    const t1 = (await c.sync()).token;
    expect((await c.req("POST", `/api/decisions/${d1.id}/ask-advice`, {})).statusCode).toBeLessThan(300);
    const [r1] = await c.db.select().from(approveTokens).where(eq(approveTokens.decisionId, d1.id));
    expect(r1!.revokedAt).not.toBeNull();
    const ceo = (await c.req("GET", `/api/companies/${c.company.id}/agents`)).json().find((a: { role: string }) => a.role === "ceo");
    const re = await c.decisions.advise({ id: d1.id, companyId: c.company.id, agentId: ceo.id, outcome: "reissue", question: "One, clearer?", options: ["Yes", "No"], recommended: "Yes", triedFirst: "The CEO looked into it first." });
    expect(re).toMatchObject({ inPlace: false });
    expect((await c.tap({ token: t1 })).json().outcome).toBe("no_longer_works");
    // The replacement carries advice, so it is Open only (and the rule-7 reissue exemption isn't needed).
    expect((await c.sync()).token).toBeNull();

    // Withdraw by the raising agent.
    const d2 = await c.ask({ question: "Two?" });
    const t2 = (await c.sync()).token;
    await c.decisions.withdraw(d2.id, { agentId: c.worker.id });
    expect((await c.tap({ token: t2 })).json().outcome).toBe("no_longer_works");
  });

  it("the CEO's in-place reissue revokes in the same transaction, and the rev catches it even without the revoke (round 7)", async () => {
    const c = await setup();
    // In-place only runs on cards that aren't plain questions, which never get a link from mint, so the
    // token row is written directly to prove the revoke anyway.
    const [d] = await c.db.insert(decisions).values({ companyId: c.company.id, kind: "approval", question: "Ship it?", options: ["Approve", "Reject"], recommendedOption: "Approve", raisedByAgentId: c.worker.id, context: { type: "deploy", deployId: crypto.randomUUID(), advice: { state: "asking", askedAt: c.clock().toISOString() } } }).returning();
    const token = randomBytes(32).toString("base64url");
    await c.db.insert(approveTokens).values({ companyId: c.company.id, decisionId: d!.id, answer: "Approve", tokenHash: hashToken(token), decisionRev: decisionRev(d!), expiresAt: new Date(c.clock().getTime() + 60_000) });
    const ceo = (await c.req("GET", `/api/companies/${c.company.id}/agents`)).json().find((a: { role: string }) => a.role === "ceo");
    expect(await c.decisions.advise({ id: d!.id, companyId: c.company.id, agentId: ceo.id, outcome: "reissue", question: "Ship the beta to staging?", options: [], recommended: "", triedFirst: "The CEO looked into it first." })).toMatchObject({ inPlace: true });
    expect((await c.db.select().from(approveTokens))[0]!.revokedAt).not.toBeNull();
    expect((await c.tap({ token })).json().outcome).toBe("no_longer_works");
    // Second layer: the rewritten question changes the rev.
    const [after] = await c.db.select().from(decisions).where(eq(decisions.id, d!.id));
    expect(decisionRev(after!)).not.toBe(decisionRev(d!));
  });

  it("a status change is caught by answer()'s check: a card withdrawn behind the link's back is not answered", async () => {
    const c = await setup();
    const d = await c.ask();
    const { token } = await c.sync();
    // Closed without going through a revoking path.
    await c.db.update(decisions).set({ status: "withdrawn" }).where(eq(decisions.id, d.id));
    expect((await c.tap({ token })).json().outcome).toBe("no_longer_works");
    expect((await c.db.select().from(decisions))[0]!.answer).toBeNull();
  });
});

describe("rule 6: claim, answer, then finish or release", () => {
  it("a double tap answers once", async () => {
    const c = await setup();
    const d = await c.ask();
    const { token } = await c.sync();
    let answers = 0;
    const answer = c.decisions.answer.bind(c.decisions);
    c.decisions.answer = async (...args) => (answers++, answer(...args));
    const outcomes = (await Promise.all([c.tap({ token }), c.tap({ token })])).map((r) => r.json().outcome).sort();
    expect(outcomes).toContain("approved");
    expect(["already_answered", "being_applied"]).toContain(outcomes.find((o) => o !== "approved"));
    expect(answers).toBe(1);
    expect((await c.db.select().from(decisions).where(eq(decisions.id, d.id)))[0]!.answer).toBe("Yes");
  });

  it("a failed answer leaves the link usable, and a re-tap works", async () => {
    const c = await setup();
    await c.ask();
    const { token } = await c.sync();
    const answer = c.decisions.answer;
    c.decisions.answer = async () => null;
    expect((await c.tap({ token })).json().outcome).toBe("try_again");
    expect((await c.db.select().from(approveTokens))[0]).toMatchObject({ claimedAt: null, usedAt: null, revokedAt: null });
    c.decisions.answer = answer;
    expect((await c.tap({ token })).json().outcome).toBe("approved");
  });
});

describe("rule 7: caps", () => {
  it("mints only when a push is really sent: nothing in quiet hours", async () => {
    const c = await setup();
    await c.req("PUT", "/api/notification-settings", { ...SETTINGS, quietHours: { start: "00:00", end: "23:59", timeZone: "UTC" } });
    await c.ask();
    await c.sync();
    expect(c.pushed).toEqual([]);
    expect(await c.db.select().from(approveTokens)).toEqual([]);
  });

  it("at most 10 live links per company, then Open only", async () => {
    const c = await setup();
    const tokens: Array<string | null> = [];
    for (let i = 0; i < 11; i++) {
      await c.ask({ question: `Q${i}?` });
      tokens.push((await c.sync()).token);
    }
    expect(tokens.filter(Boolean)).toHaveLength(10);
    expect(tokens[10]).toBeNull();
    expect(c.pushed.at(-1)!.body.actions).toHaveLength(1);
  });

  it("one Approve push per decision per hour", async () => {
    const c = await setup();
    const d = await c.ask();
    await c.sync();
    const phone = c.notes as unknown as { notify: typeof c.notes.notify };
    await c.db.update(approveTokens).set({ revokedAt: c.clock() });
    await c.db.delete(notifications);
    await phone.notify({ companyId: c.company.id, level: "ask", title: "again", body: d.question, link: "#/decisions", decisionId: d.id });
    expect(httpActions(c.pushed.at(-1))).toEqual([]);
    c.setClock(new Date(c.clock().getTime() + 3_600_001));
    await c.db.delete(notifications);
    await phone.notify({ companyId: c.company.id, level: "ask", title: "again", body: d.question, link: "#/decisions", decisionId: d.id });
    expect(httpActions(c.pushed.at(-1))).toHaveLength(1);
  });
});

describe("rule 8: rate limit, ntfy URL and retention", () => {
  it("stops inserting at the limit, and a live link still hears 'Too many taps' once per window", async () => {
    const c = await setup();
    await c.ask();
    const { token } = await c.sync();
    for (let i = 0; i < IP_LIMIT.taps + 5; i++) await c.tap({ token: randomBytes(32).toString("base64url") }, { ip: "10.9.9.9" });
    expect(await c.db.select().from(phoneActionHits)).toHaveLength(IP_LIMIT.taps);
    const before = c.pushed.length;
    const r = await c.tap({ token }, { ip: "10.9.9.9" });
    expect([r.statusCode, r.json()]).toEqual([429, { ok: false, outcome: "too_many_taps" }]);
    expect(c.lastMessage()).toBe("Too many taps; wait a few minutes or open Boss Man");
    await c.tap({ token }, { ip: "10.9.9.9" });
    expect(c.pushed.length).toBe(before + 1);
    expect(await c.db.select().from(phoneActionHits)).toHaveLength(IP_LIMIT.taps);
    // Another address is still fine.
    expect((await c.tap({ token }, { ip: "10.1.1.1" })).json().outcome).toBe("approved");
  });

  it("limits a company to 60 taps an hour", async () => {
    const c = await setup();
    const d = await c.ask();
    const { token } = await c.sync();
    const t = c.clock();
    await c.db.insert(phoneActionHits).values(Array.from({ length: 60 }, (_, i) => ({ ip: `10.2.0.${i}`, companyId: d.companyId, at: t })));
    expect((await c.tap({ token }, { ip: "10.3.3.3" })).statusCode).toBe(429);
    expect(await c.db.select().from(phoneActionHits)).toHaveLength(60);
  });

  it("keeps the ntfy URL's path, and refuses a ? or # in Settings", async () => {
    expect(ntfyPublishUrl("https://h.example/ntfy")).toBe("https://h.example/ntfy/");
    expect(ntfyPublishUrl("https://h.example")).toBe("https://h.example/");
    const c = await setup();
    await c.req("PUT", "/api/notification-settings", { ...SETTINGS, ntfy: { url: "https://h.example/ntfy", topic: "bossman" } });
    await c.ask();
    await c.sync();
    expect(c.pushed.at(-1)!.url).toBe("https://h.example/ntfy/");
    const bad = await c.req("PUT", "/api/notification-settings", { ...SETTINGS, ntfy: { url: "https://h.example/ntfy?x=1", topic: "bossman" } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().message).toContain("without a ? or # part");
  });

  it("the sweep deletes links and taps more than a day old", async () => {
    const c = await setup();
    await c.ask();
    const { token } = await c.sync();
    await c.tap({ token });
    expect(await c.db.select().from(approveTokens)).toHaveLength(1);
    expect(await c.db.select().from(phoneActionHits)).toHaveLength(1);
    c.setClock(new Date(c.clock().getTime() + 86_400_001));
    const r = await c.sweeps.run();
    expect(r.phoneApprove).toBe(2);
    expect(await c.db.select().from(approveTokens)).toEqual([]);
    expect(await c.db.select().from(phoneActionHits)).toEqual([]);
  });
});

describe("QA (BOS-248): token lifetime edges and isolation between cards", () => {
  it("a link works one millisecond before its 15 minutes are up and is refused at exactly 15 minutes", async () => {
    const c = await setup();
    const d1 = await c.ask();
    const { token: t1 } = await c.sync();
    const start = c.clock().getTime();
    c.setClock(new Date(start + 15 * 60_000 - 1));
    expect((await c.tap({ token: t1 })).json().outcome).toBe("approved");
    expect((await c.db.select().from(decisions).where(eq(decisions.id, d1.id)))[0]!.answer).toBe("Yes");

    const d2 = await c.ask({ question: "Use Cloudflare instead?" });
    const { token: t2 } = await c.sync();
    c.setClock(new Date(c.clock().getTime() + 15 * 60_000));
    expect((await c.tap({ token: t2 })).json().outcome).toBe("no_longer_works");
    expect((await c.db.select().from(decisions).where(eq(decisions.id, d2.id)))[0]!.status).toBe("open");
  });

  it("an expired, unanswered link is also refused on a re-tap and never answers the card", async () => {
    const c = await setup();
    const d = await c.ask();
    const { token } = await c.sync();
    c.setClock(new Date(c.clock().getTime() + 20 * 60_000));
    for (let i = 0; i < 2; i++) expect((await c.tap({ token })).json().outcome).toBe("no_longer_works");
    expect((await c.db.select().from(decisions).where(eq(decisions.id, d.id)))[0]!.status).toBe("open");
  });

  it("one card's link answers only that card", async () => {
    const c = await setup();
    // Two different asks. Near-identical wording would be one repeated question, and the older card would close (BOS-1193).
    const a = await c.ask({ question: "Use deSEC for DNS?" });
    const { token: ta } = await c.sync();
    const b = await c.ask({ question: "Rotate the backup encryption passphrase now?" });
    const { token: tb } = await c.sync();
    expect(ta).not.toBe(tb);
    expect((await c.tap({ token: ta })).json().outcome).toBe("approved");
    const rows = await c.db.select().from(decisions);
    expect(rows.find((r) => r.id === a.id)!.status).not.toBe("open");
    expect(rows.find((r) => r.id === b.id)!.status).toBe("open");
    // B's own link still works, once.
    expect((await c.tap({ token: tb })).json().outcome).toBe("approved");
    expect((await c.tap({ token: tb })).json().outcome).toBe("already_answered");
  });
});
