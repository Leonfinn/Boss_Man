// BOS-2199: alerts to Slack, Discord and webhook destinations. No network: a stub fetch plays the other side, and a
// made-up DNS lookup stands in for the real one. Every test here fails on the old code, which has no such tables, routes or hook.
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { activity, alertRetries, decisions, notifications } from "../src/db/schema.js";
import { addressProblem, formatBody } from "../src/services/webhook-delivery.js";

let ctx: { close: () => Promise<void> } | undefined;
afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

// A made-up address with a made-up secret part, so a leak can be found by searching for it.
const SENTINEL = "SECRETPART9876";
const HOOK = `https://hooks.example.com/services/T000/B000/${SENTINEL}`;
type Call = { url: string; body: Record<string, unknown>; signal: AbortSignal | null | undefined; redirect: string | undefined };

async function setup(answer: (url: string, n: number) => Response | Promise<Response> = () => new Response("ok", { status: 200 }), publicIps: Record<string, string[]> = {}) {
  const { db, close } = await openPglite();
  let clock = new Date("2026-11-20T10:00:00Z");
  const calls: Call[] = [];
  const stub = (async (input: URL | string, init?: RequestInit) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body)), signal: init?.signal, redirect: init?.redirect });
    return answer(String(input), calls.length);
  }) as typeof fetch;
  const lookup = async (host: string) => publicIps[host] ?? ["93.184.216.34"];
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, now: () => clock, fetch: stub, lookup, tickOnWake: false });
  ctx = { close: async () => (await built.app.close(), await close()) };
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company } = (await req("POST", "/api/companies", { name: "App Co" })).json();
  await req("PUT", "/api/notification-settings", { quietHours: null, agentHourlyCap: 6, ntfy: null, publicUrl: "https://bossman.example.ts.net" });
  const add = async (over: Record<string, unknown> = {}) => (await req("POST", "/api/alert-destinations", { type: "slack", name: "Team channel", address: HOOK, ...over })).json();
  return { ...built, db, req, company, calls, add, setClock: (d: Date) => (clock = d), clock: () => clock };
}

describe("alert destinations: saving", () => {
  it("every route is owner-only", async () => {
    const { db, close } = await openPglite(undefined, { fresh: true });
    const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false });
    ctx = { close: async () => (await built.app.close(), await close()) };
    const id = "00000000-0000-4000-8000-000000000001";
    const routes: Array<["GET" | "POST" | "PUT" | "DELETE", string]> = [["GET", "/api/alert-destinations"], ["POST", "/api/alert-destinations"], ["PUT", `/api/alert-destinations/${id}`], ["DELETE", `/api/alert-destinations/${id}`], ["POST", `/api/alert-destinations/${id}/test`]];
    const got = await Promise.all(routes.map(async ([method, url]) => (await built.app.inject({ method, url, payload: method === "GET" || method === "DELETE" ? undefined : {} })).statusCode));
    expect(got).toEqual([401, 401, 401, 401, 401]);
  });

  it("keeps the address as a secret and shows only its last 4 characters, with the two default kinds ticked", async () => {
    const c = await setup();
    const made = await c.add();
    expect(made.kinds).toEqual(["decision_waiting", "merge_stuck"]);
    expect(made.hint).toBe("••••9876");
    const got = await c.req("GET", "/api/alert-destinations");
    expect(got.body).not.toContain(SENTINEL);
    expect(got.body).not.toContain("hooks.example.com");
    expect(JSON.stringify(await c.db.select().from(activity))).not.toContain(SENTINEL);
    // The row itself holds no address, only a pointer into the secrets store.
    const raw = (await c.db.execute(`select * from alert_destinations`)) as unknown;
    expect(JSON.stringify(raw)).not.toContain(SENTINEL);
  });

  it("refuses http, and private or local addresses unless the owner ticks the own-network box", async () => {
    const c = await setup(undefined, { "hooks.lan.example": ["192.168.1.50"] });
    const http = await c.req("POST", "/api/alert-destinations", { type: "webhook", name: "x", address: "http://hooks.example.com/a" });
    expect(http.statusCode).toBe(400);
    expect(http.json().message).toContain("https");
    for (const address of ["https://192.168.1.50/hook", "https://127.0.0.1/hook", "https://169.254.169.254/latest", "https://hooks.lan.example/hook", "https://[::1]/hook"]) {
      const r = await c.req("POST", "/api/alert-destinations", { type: "webhook", name: "x", address });
      expect(`${address} ${r.statusCode}`).toBe(`${address} 400`);
      expect(r.json().message).toContain("own network");
    }
    const ok = await c.req("POST", "/api/alert-destinations", { type: "webhook", name: "lan", address: "https://hooks.lan.example/hook", allowPrivate: true });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().allowPrivate).toBe(true);
  });

  it("addressProblem never repeats the address", async () => {
    const p = await addressProblem(`http://hooks.example.com/${SENTINEL}`, false, async () => ["93.184.216.34"]);
    expect(p).not.toContain(SENTINEL);
  });

  it("a new address replaces the old one and deleting the destination deletes its secret", async () => {
    const c = await setup();
    const made = await c.add();
    const put = await c.req("PUT", `/api/alert-destinations/${made.id}`, { address: "https://hooks.example.com/services/other/ZZZZ1111" });
    expect(put.json().hint).toBe("••••1111");
    expect((await c.req("GET", "/api/secrets")).body).not.toContain("ZZZZ1111");
    expect((await c.req("DELETE", `/api/alert-destinations/${made.id}`)).statusCode).toBe(200);
    expect((await c.req("GET", "/api/alert-destinations")).json().destinations).toEqual([]);
  });
});

describe("alert destinations: delivery", () => {
  it("formats Slack, Discord and a plain webhook, with a link back on the existing app address", () => {
    const p = { kind: "decision_waiting" as const, title: "App Co needs a decision", text: "Ship <the> beta?", url: "https://bossman.example.ts.net/#/decisions", at: "2026-11-20T10:00:00.000Z" };
    expect(formatBody("slack", p)).toEqual({ text: "*App Co needs a decision*\nShip &lt;the&gt; beta?\n<https://bossman.example.ts.net/#/decisions|Open in Boss Man>" });
    const d = formatBody("discord", p) as { content: string; allowed_mentions: unknown };
    expect(d.content).toBe("**App Co needs a decision**\nShip <the> beta?\n<https://bossman.example.ts.net/#/decisions>");
    expect(d.allowed_mentions).toEqual({ parse: [] });
    expect(formatBody("webhook", p)).toEqual({ kind: "decision_waiting", title: "App Co needs a decision", text: "Ship <the> beta?", url: "https://bossman.example.ts.net/#/decisions", at: "2026-11-20T10:00:00.000Z" });
  });

  it("sends a waiting decision to a ticked destination after the card is saved, and skips one that did not tick it", async () => {
    const c = await setup();
    await c.add({ type: "webhook", name: "Mine" });
    await c.add({ type: "webhook", name: "Spend only", address: "https://hooks.example.com/spend", kinds: ["spend_alert"] });
    await c.db.insert(decisions).values({ companyId: c.company.id, kind: "question", question: "Ship the beta?", options: ["Yes", "No"], recommendedOption: "Yes", context: { type: "question" } });
    await c.notes.syncDecisions();
    await vi.waitFor(() => expect(c.calls.length).toBe(1));
    expect(c.calls[0]!.url).toBe(HOOK);
    expect(c.calls[0]!.body).toMatchObject({ kind: "decision_waiting", title: "App Co needs a decision", text: "Ship the beta?", url: "https://bossman.example.ts.net/#/decisions" });
    expect(typeof c.calls[0]!.body.at).toBe("string");
    // The card is saved whatever happens to the send.
    expect((await c.db.select().from(notifications)).length).toBe(1);
  });

  it("a waiting decision reaches a Slack, a Discord and a plain webhook destination, each in its own format, with a link back", async () => {
    const c = await setup();
    await c.add({ type: "slack", name: "S", address: "https://hooks.example.com/slack" });
    await c.add({ type: "discord", name: "D", address: "https://hooks.example.com/discord" });
    await c.add({ type: "webhook", name: "W", address: "https://hooks.example.com/plain" });
    await c.db.insert(decisions).values({ companyId: c.company.id, kind: "question", question: "Ship the beta?", options: ["Yes", "No"], recommendedOption: "Yes", context: { type: "question" } });
    await c.notes.syncDecisions();
    await vi.waitFor(() => expect(c.calls.length).toBe(3));
    const by = (u: string) => c.calls.find((x) => x.url.endsWith(u))!.body;
    expect(by("/slack")).toEqual({ text: "*App Co needs a decision*\nShip the beta?\n<https://bossman.example.ts.net/#/decisions|Open in Boss Man>" });
    expect(by("/discord")).toMatchObject({ content: "**App Co needs a decision**\nShip the beta?\n<https://bossman.example.ts.net/#/decisions>" });
    expect(by("/plain")).toMatchObject({ kind: "decision_waiting", title: "App Co needs a decision", text: "Ship the beta?", url: "https://bossman.example.ts.net/#/decisions" });
  });

  it("an existing install with no destinations sends nothing after the migration, and alerts are saved as before", async () => {
    const c = await setup();
    await c.db.insert(decisions).values({ companyId: c.company.id, kind: "question", question: "Ship the beta?", options: ["Yes", "No"], recommendedOption: "Yes", context: { type: "question" } });
    await c.notes.syncDecisions();
    expect((await c.db.select().from(notifications)).length).toBe(1);
    expect(c.calls).toEqual([]);
    expect((await c.req("GET", "/api/alert-destinations")).json().destinations).toEqual([]);
  });

  it("works out the kind from the card: a stalled run is run_failed, an explicit kind wins, a plain note goes nowhere", async () => {
    const c = await setup();
    await c.add({ type: "webhook", name: "All", kinds: ["run_failed", "daily_summary", "decision_waiting", "merge_stuck", "spend_alert"] });
    await c.db.insert(decisions).values({ companyId: c.company.id, kind: "question", question: "A run stalled", options: ["Got it"], recommendedOption: "Got it", context: { type: "stalled_run", runnerId: "r", runId: "x" } });
    await c.notes.syncDecisions();
    await c.notes.notify({ companyId: c.company.id, level: "note", title: "Scrum Master daily summary", body: "All quiet", link: "#/scrum-master", kind: "daily_summary" });
    await c.notes.notify({ companyId: c.company.id, level: "note", title: "The CEO changed a picture", body: null, link: "#/agents" });
    await c.notes.notify({ companyId: c.company.id, level: "flag", title: "Nothing merged", body: "stuck", link: "#/merge-queue/x", kind: "merge_stuck" });
    await vi.waitFor(() => expect(c.calls.length).toBe(3));
    expect(c.calls.map((x) => x.body.kind).sort()).toEqual(["daily_summary", "merge_stuck", "run_failed"]);
    expect(c.calls.some((x) => x.body.title === "The CEO changed a picture")).toBe(false);
  });

  it("sends with a 5-second limit and without following redirects", async () => {
    const c = await setup();
    await c.add({ type: "webhook" });
    await c.notes.notify({ companyId: c.company.id, level: "ask", title: "t", body: "b", link: "#/decisions", kind: "decision_waiting" });
    await vi.waitFor(() => expect(c.calls.length).toBe(1));
    expect(c.calls[0]!.signal).toBeInstanceOf(AbortSignal);
    expect(c.calls[0]!.redirect).toBe("manual");
  });

  it("a send that never answers never holds up the alert", async () => {
    const c = await setup(() => new Promise<Response>(() => undefined));
    await c.add({ type: "webhook" });
    const row = await c.notes.notify({ companyId: c.company.id, level: "ask", title: "t", body: "b", link: "#/decisions", kind: "decision_waiting" });
    expect(row?.title).toBe("t");
    await vi.waitFor(() => expect(c.calls.length).toBe(1));
  });
});

describe("alert destinations: test button, failures and switch-off", () => {
  it("the test button answers success, or the HTTP status", async () => {
    const c = await setup((_u, n) => new Response("no", { status: n === 1 ? 200 : 404 }));
    const d = await c.add();
    expect((await c.req("POST", `/api/alert-destinations/${d.id}/test`)).json()).toMatchObject({ ok: true });
    const bad = (await c.req("POST", `/api/alert-destinations/${d.id}/test`)).json();
    expect(bad).toMatchObject({ ok: false, status: 404 });
    expect(bad.message).toContain("404");
    expect(c.calls[0]!.body.text).toContain("*Boss Man test*");
  });

  it("a failure shows on the destination, is retried once a minute later, and not a third time", async () => {
    const c = await setup(() => new Response("gone", { status: 404 }));
    const d = await c.add({ type: "webhook" });
    await c.notes.notify({ companyId: c.company.id, level: "ask", title: "t", body: "b", link: "#/decisions", kind: "decision_waiting" });
    await vi.waitFor(async () => expect((await c.db.select().from(alertRetries)).length).toBe(1));
    const shown = (await c.req("GET", "/api/alert-destinations")).json().destinations[0];
    expect(shown.lastFailureNote).toBe("404");
    expect(shown.lastFailedAt).toBe("2026-11-20T10:00:00.000Z");
    expect(shown.enabled).toBe(true);
    // Not due yet: nothing is sent.
    expect(await c.webhooks.sweepRetries()).toBe(0);
    c.setClock(new Date("2026-11-20T10:01:01Z"));
    expect(await c.webhooks.sweepRetries()).toBe(1);
    expect(c.calls.length).toBe(2);
    expect(c.calls[1]!.body).toEqual(c.calls[0]!.body);
    // The retry failed too: it is not queued again.
    expect(await c.db.select().from(alertRetries)).toEqual([]);
    expect(await c.webhooks.sweepRetries()).toBe(0);
    expect(c.calls.length).toBe(2);
    void d;
  });

  it("a timeout shows as a timeout, and a later success clears the failure", async () => {
    let fail = true;
    const c = await setup(() => {
      if (fail) throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
      return new Response("ok", { status: 200 });
    });
    await c.add({ type: "webhook" });
    await c.notes.notify({ companyId: c.company.id, level: "ask", title: "t", body: "b", link: "#/decisions", kind: "decision_waiting" });
    await vi.waitFor(async () => expect((await c.req("GET", "/api/alert-destinations")).json().destinations[0].lastFailureNote).toBe("timed out after 5 s"));
    fail = false;
    c.setClock(new Date("2026-11-20T10:02:00Z"));
    await c.webhooks.sweepRetries();
    const shown = (await c.req("GET", "/api/alert-destinations")).json().destinations[0];
    expect(shown.lastFailureNote).toBeNull();
    expect(shown.lastFailedAt).toBeNull();
  });

  it("three days of failures in a row switch the destination off and tell the owner once", async () => {
    const c = await setup(() => new Response("gone", { status: 410 }));
    const d = await c.add({ type: "webhook", name: "Old hook" });
    const alert = () => c.notes.notify({ companyId: c.company.id, level: "ask", title: `t${c.calls.length}`, body: "b", link: "#/decisions", kind: "decision_waiting" });
    await alert();
    await vi.waitFor(async () => expect((await c.req("GET", "/api/alert-destinations")).json().destinations[0].lastFailureNote).toBe("410"));
    // Two days on: still failing, still on.
    c.setClock(new Date("2026-11-22T10:00:00Z"));
    await alert();
    await vi.waitFor(() => expect(c.calls.length).toBeGreaterThanOrEqual(2));
    expect((await c.req("GET", "/api/alert-destinations")).json().destinations[0].enabled).toBe(true);
    // Past three days since the first failure.
    c.setClock(new Date("2026-11-23T10:00:01Z"));
    await alert();
    await vi.waitFor(async () => expect((await c.req("GET", "/api/alert-destinations")).json().destinations[0].enabled).toBe(false));
    const told = (await c.db.select().from(notifications)).filter((n) => n.title.includes("switched off"));
    expect(told.length).toBe(1);
    expect(JSON.stringify(told)).not.toContain(SENTINEL);
    // Off: further alerts are not sent, and the owner is not told again.
    const before = c.calls.length;
    await alert();
    await c.webhooks.sweepRetries();
    expect(c.calls.length).toBe(before);
    expect((await c.db.select().from(notifications)).filter((n) => n.title.includes("switched off")).length).toBe(1);
    // Switching back on starts the count again.
    const on = (await c.req("PUT", `/api/alert-destinations/${d.id}`, { enabled: true })).json();
    expect(on).toMatchObject({ enabled: true, lastFailureNote: null });
  });

  it("the address never reaches a note, a retry row's text, a notification or an activity line", async () => {
    const c = await setup(() => new Response("gone", { status: 500 }));
    await c.add({ type: "slack" });
    await c.notes.notify({ companyId: c.company.id, level: "ask", title: "t", body: "b", link: "#/decisions", kind: "decision_waiting" });
    await vi.waitFor(async () => expect((await c.db.select().from(alertRetries)).length).toBe(1));
    const shown = (await c.req("GET", "/api/alert-destinations")).body;
    for (const text of [shown, JSON.stringify(await c.db.select().from(notifications)), JSON.stringify(await c.db.select().from(activity)), JSON.stringify(await c.db.select().from(alertRetries)), JSON.stringify(await c.db.select().from(decisions).where(eq(decisions.companyId, c.company.id)))]) expect(text).not.toContain(SENTINEL);
  });
});
