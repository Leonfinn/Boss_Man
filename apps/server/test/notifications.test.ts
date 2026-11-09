import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { decisions, notifications, secrets } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";
import { fitBytes } from "../src/services/notifications.js";

let ctx: { close: () => Promise<void> } | undefined;
afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

type Pushed = { url: string; headers: Record<string, string>; body: Record<string, unknown> };

async function setup(opts: { listen?: boolean; pushStatus?: number; deployerDir?: string } = {}) {
  const { db, close } = await openPglite();
  // 23:30 UTC is 00:30 in London (BST) on 16-17 Oct 2026.
  let clock = new Date("2026-10-16T23:30:00Z");
  const pushed: Pushed[] = [];
  const fakeFetch = (async (input: URL | string, init?: RequestInit) => {
    pushed.push({ url: String(input), headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)), body: JSON.parse(String(init?.body)) });
    return new Response("{}", { status: opts.pushStatus ?? 200 });
  }) as typeof fetch;
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, now: () => clock, fetch: fakeFetch, ...(opts.deployerDir ? { deployerDir: opts.deployerDir } : {}) });
  let base = "";
  if (opts.listen) {
    await built.app.listen({ host: "127.0.0.1", port: 0 });
    base = `127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  }
  ctx = { close: async () => (await built.app.close(), await close()) };
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PUT", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company, ceo } = (await req("POST", "/api/companies", { name: "App Co" })).json();
  const worker = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Engineer" })).json();
  const mcp = async (agentId: string, runId = randomUUID()) => {
    const token = await issueRunToken(db, { companyId: company.id, agentId, runId });
    const c = new Client({ name: "test", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    return c;
  };
  return { ...built, db, req, company, ceo, worker, mcp, pushed, setClock: (d: Date) => (clock = d) };
}

const SETTINGS = { quietHours: null, agentHourlyCap: 6, ntfy: { url: "https://ntfy.example.ts.net", topic: "bossman", token: "tk_secret_value_123" }, pushLevels: ["page", "ask"], publicUrl: "https://bossman.example.ts.net/" };
const textOf = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0]?.text ?? "";

describe("notification ladder (R44)", () => {
  it("cuts phone messages to ntfy's size by bytes, not characters", () => {
    expect(fitBytes("short", 10)).toBe("short");
    const cut = fitBytes("🚨".repeat(20), 20);
    expect(new TextEncoder().encode(cut).length).toBeLessThanOrEqual(20);
    expect(cut).toBe("🚨🚨🚨🚨...");
  });

  it("returns the ntfy address and container the host reports, and null when it reports none (BOS-995)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "bm-phoneaddr-"));
    try {
      await mkdir(path.join(dir, "outbox"), { recursive: true });
      await writeFile(path.join(dir, "outbox", "host.json"), JSON.stringify({ version: 1, name: "box", writtenAt: "2026-11-09T00:00:00Z", ownership: [], ntfy: { baseUrl: "https://ntfy.example.ts.net:8443", container: "bossman-ntfy-1" } }));
      const c = await setup({ deployerDir: dir });
      await c.req("PUT", "/api/notification-settings", SETTINGS);
      const got = (await c.req("GET", "/api/notification-settings")).json();
      expect(got.phoneAddress).toBe("https://ntfy.example.ts.net:8443");
      expect(got.phoneContainer).toBe("bossman-ntfy-1");
      // The host stops reporting the add-on: both go back to null, so the page shows its "can't work out" note.
      await writeFile(path.join(dir, "outbox", "host.json"), JSON.stringify({ version: 1, name: "box", writtenAt: "2026-11-09T00:05:00Z", ownership: [] }));
      const none = (await c.req("GET", "/api/notification-settings")).json();
      expect(none.phoneAddress).toBeNull();
      expect(none.phoneContainer).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps the ntfy token in the secrets store and never returns it", async () => {
    const c = await setup();
    const put = await c.req("PUT", "/api/notification-settings", SETTINGS);
    expect(put.statusCode).toBe(200);
    expect(put.body).not.toContain("tk_secret_value_123");
    expect(put.json().ntfy).toEqual({ url: "https://ntfy.example.ts.net", topic: "bossman", hasToken: true });
    const got = await c.req("GET", "/api/notification-settings");
    expect(got.body).not.toContain("tk_secret_value_123");
    expect(got.body).not.toContain("tokenSecretId");
    expect(await c.db.select({ name: secrets.name }).from(secrets)).toEqual([{ name: "ntfy access token" }]);

    // Saving again without a token keeps it; null removes it.
    expect((await c.req("PUT", "/api/notification-settings", { ...SETTINGS, ntfy: { url: SETTINGS.ntfy.url, topic: "bossman" } })).json().ntfy.hasToken).toBe(true);
    expect((await c.req("PUT", "/api/notification-settings", { ...SETTINGS, ntfy: { url: SETTINGS.ntfy.url, topic: "bossman", token: null } })).json().ntfy.hasToken).toBe(false);
    expect((await c.req("PUT", "/api/notification-settings", { ...SETTINGS, ntfy: { url: SETTINGS.ntfy.url, topic: "no spaces" } })).statusCode).toBe(400);
  });

  it("pushes asks to the phone as ntfy JSON, with the token and a link back", async () => {
    const c = await setup();
    await c.req("PUT", "/api/notification-settings", SETTINGS);
    await c.db.insert(decisions).values({ companyId: c.company.id, kind: "question", question: "Ship the beta?", options: ["Yes", "No"], recommendedOption: "Yes", context: { type: "question" } });
    await c.db.insert(decisions).values({ companyId: c.company.id, kind: "question", question: "Disk is full.", options: ["Got it"], recommendedOption: "Got it", context: { type: "question" } });
    await c.db.insert(decisions).values({ companyId: c.company.id, kind: "question", tier: "ceo", question: "Approve the plan?", options: ["Approve plan", "Keep planning"], recommendedOption: "Approve plan", context: { type: "question" } });

    expect(await c.notes.syncDecisions()).toBe(3);
    // Each decision is told once.
    expect(await c.notes.syncDecisions()).toBe(0);
    const rows = await c.db.select().from(notifications);
    expect(rows.map((r) => [r.body, r.level]).sort()).toEqual([
      ["Approve the plan?", "note"],
      ["Disk is full.", "flag"],
      ["Ship the beta?", "ask"],
    ]);

    expect(c.pushed).toHaveLength(1);
    const [p] = c.pushed;
    expect(p!.url).toBe("https://ntfy.example.ts.net/");
    expect(p!.headers.authorization).toBe("Bearer tk_secret_value_123");
    expect(p!.body).toEqual({ topic: "bossman", title: "App Co needs a decision", message: "Ship the beta?", priority: 4, tags: ["question"], click: "https://bossman.example.ts.net/#/decisions", actions: [{ action: "view", label: "Open in Boss Man", url: "https://bossman.example.ts.net/#/decisions", clear: false }] });
    expect(rows.find((r) => r.level === "ask")!.pushedAt).not.toBeNull();

    const feed = (await c.req("GET", "/api/notifications")).json();
    expect(feed.unread).toBe(3);
    expect(feed.items[0]).toMatchObject({ company: "App Co", link: "#/decisions" });
    expect((await c.req("POST", "/api/notifications/read", { ids: [feed.items[0].id] })).json()).toEqual({ unread: 2 });
    expect((await c.req("POST", "/api/notifications/read", { all: true })).json()).toEqual({ unread: 0 });
  });

  it("records a failed push without losing the notification, and the test button reports it", async () => {
    const c = await setup({ pushStatus: 403 });
    await c.req("PUT", "/api/notification-settings", SETTINGS);
    const n = await c.notes.notify({ companyId: c.company.id, level: "page", title: "Build broke", link: "#/runs/x" });
    expect(n).toMatchObject({ level: "page" });
    const [row] = await c.db.select().from(notifications);
    expect(row).toMatchObject({ pushedAt: null, pushError: "ntfy answered 403" });
    const t = await c.req("POST", "/api/notification-settings/test");
    expect(t.statusCode).toBe(502);
    expect(t.json().message).toContain("403");
  });

  it("proves the phone got the test push only when its Got it button is tapped (BOS-995)", async () => {
    const c = await setup();
    await c.req("PUT", "/api/notification-settings", SETTINGS);
    expect((await c.req("POST", "/api/notification-settings/test")).statusCode).toBe(200);
    const sent = c.pushed.at(-1)!.body as { actions: Array<{ label: string; url: string; body: string }> };
    const act = sent.actions.find((a) => a.label === "Got it")!;
    expect(act.url).toBe("https://bossman.example.ts.net/api/phone/got-it");
    const token = (JSON.parse(act.body) as { token: string }).token;
    // Sent, but not confirmed: nothing says a phone received it.
    let st = (await c.req("GET", "/api/notification-settings")).json();
    expect(st.phoneTest.confirmedAt).toBeNull();
    expect(JSON.stringify(st)).not.toContain(token);
    const tap = (t: string) => c.app.inject({ method: "POST", url: "/api/phone/got-it", headers: { "content-type": "application/json" }, payload: JSON.stringify({ token: t }) });
    expect((await tap(randomBytes(32).toString("base64url"))).statusCode).toBe(404);
    expect((await tap(token)).statusCode).toBe(200);
    st = (await c.req("GET", "/api/notification-settings")).json();
    expect(st.phoneTest.confirmedAt).not.toBeNull();
    // One use only.
    expect((await tap(token)).statusCode).toBe(404);
    // A new test starts unconfirmed again, and the old link is dead.
    await c.req("POST", "/api/notification-settings/test");
    expect((await c.req("GET", "/api/notification-settings")).json().phoneTest.confirmedAt).toBeNull();
    expect((await tap(token)).statusCode).toBe(404);
  });

  it("marks a decision's notification read once the decision is answered", async () => {
    const c = await setup();
    const [d] = await c.db.insert(decisions).values({ companyId: c.company.id, kind: "question", question: "Ship the beta?", options: ["Yes", "No"], recommendedOption: "Yes", context: { type: "question" } }).returning();
    await c.db.insert(decisions).values({ companyId: c.company.id, kind: "question", question: "Rename the app?", options: ["Yes", "No"], recommendedOption: "No", context: { type: "question" } });
    await c.notes.syncDecisions();
    expect((await c.req("GET", "/api/notifications")).json().unread).toBe(2);
    expect((await c.req("POST", `/api/decisions/${d!.id}/answer`, { answer: "Yes" })).statusCode).toBe(200);
    const feed = (await c.req("GET", "/api/notifications")).json();
    expect(feed.unread).toBe(1);
    expect(feed.items.find((n: { body: string }) => n.body === "Ship the beta?").readAt).not.toBeNull();
  });

  it("lowers levels in quiet hours and past an agent's hourly cap", async () => {
    const c = await setup();
    await c.req("PUT", "/api/notification-settings", { ...SETTINGS, quietHours: { start: "22:00", end: "07:00", timeZone: "Europe/London" }, agentHourlyCap: 2 });

    // 00:30 in London: quiet hours, so a page becomes a flag and isn't pushed.
    expect(await c.notes.notify({ companyId: c.company.id, agentId: c.worker.id, level: "page", title: "a", link: "#/" })).toMatchObject({ requested: "page", level: "flag", demotedBy: "quiet hours" });
    expect(c.pushed).toHaveLength(0);

    // 09:00 in London: daytime.
    c.setClock(new Date("2026-10-17T08:00:00Z"));
    expect(await c.notes.notify({ companyId: c.company.id, agentId: c.worker.id, level: "page", title: "b", link: "#/" })).toMatchObject({ level: "page", demotedBy: null });
    expect(c.pushed).toHaveLength(1);
    // Two in the last hour: the third becomes a note.
    expect(await c.notes.notify({ companyId: c.company.id, agentId: c.worker.id, level: "page", title: "c", link: "#/" })).toMatchObject({ level: "page" });
    expect(await c.notes.notify({ companyId: c.company.id, agentId: c.worker.id, level: "page", title: "d", link: "#/" })).toMatchObject({ level: "note", demotedBy: "cap" });
    // The cap is per agent, and notes don't count towards it.
    expect(await c.notes.notify({ companyId: c.company.id, agentId: c.ceo.id, level: "flag", title: "e", link: "#/" })).toMatchObject({ level: "flag" });
    // An hour on, the agent can flag again.
    c.setClock(new Date("2026-10-17T09:30:00Z"));
    expect(await c.notes.notify({ companyId: c.company.id, agentId: c.worker.id, level: "flag", title: "f", link: "#/" })).toMatchObject({ level: "flag" });
  });

  it("lets agents notify the owner through MCP, linking the evidence", async () => {
    const c = await setup({ listen: true });
    const runId = randomUUID();
    const client = await c.mcp(c.worker.id, runId);
    const r = await client.callTool({ name: "notify_owner", arguments: { level: "flag", title: "Tests are flaky on main", body: "3 of 10 runs failed." } });
    expect(textOf(r)).toBe("Sent as a flag.");
    const bad = await client.callTool({ name: "notify_owner", arguments: { level: "flag", title: "x", ticketId: randomUUID() } });
    expect(bad.isError).toBe(true);
    const [row] = await c.db.select().from(notifications);
    expect(row).toMatchObject({ agentId: c.worker.id, companyId: c.company.id, level: "flag", link: `#/runs/${runId}`, body: "3 of 10 runs failed." });
    await client.close();
  });

  it("filters the feed by status, type and company, and the filters combine", async () => {
    const c = await setup();
    const a = await c.notes.notify({ companyId: c.company.id, agentId: null, level: "flag", title: "a", link: "#/" });
    await c.notes.notify({ companyId: c.company.id, agentId: null, level: "note", title: "b", link: "#/" });
    await c.notes.notify({ companyId: null, agentId: null, level: "flag", title: "c", link: "#/" });
    await c.req("POST", "/api/notifications/read", { ids: [a!.id] });
    const titles = async (qs: string) => ((await c.req("GET", `/api/notifications?${qs}`)).json().items as { title: string }[]).map((i) => i.title).sort();
    expect(await titles("status=unread")).toEqual(["b", "c"]);
    expect(await titles("status=read")).toEqual(["a"]);
    expect(await titles("level=flag")).toEqual(["a", "c"]);
    expect(await titles("company=none")).toEqual(["c"]);
    expect(await titles(`company=${c.company.id}`)).toEqual(["a", "b"]);
    expect(await titles(`company=${c.company.id}&level=flag&status=unread`)).toEqual([]);
    expect(await titles("level=flag&status=unread")).toEqual(["c"]);
    expect((await c.req("GET", "/api/notifications?status=bogus")).statusCode).toBe(400);
    expect((await c.req("GET", "/api/notifications?status=unread")).json().unread).toBe(2);
  });
});
