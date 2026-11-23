import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { decisions, notifications, secrets } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";
import { appUrl, fitBytes } from "../src/services/notifications.js";

let ctx: { close: () => Promise<void> } | undefined;
afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

type Pushed = { url: string; headers: Record<string, string>; body: Record<string, unknown> };

async function setup(opts: { listen?: boolean; pushStatus?: number; clearStatus?: number; deployerDir?: string } = {}) {
  const { db, close } = await openPglite();
  // 23:30 UTC is 00:30 in London (BST) on 16-17 Oct 2026.
  let clock = new Date("2026-10-16T23:30:00Z");
  const pushed: Pushed[] = [];
  const cleared: string[] = [];
  const fakeFetch = (async (input: URL | string, init?: RequestInit) => {
    // A clear (BOS-1097) is a body-less PUT to /<topic>/<sequence id>/clear, not a publish.
    if (init?.method === "PUT" && String(input).endsWith("/clear")) {
      cleared.push(String(input));
      return new Response("{}", { status: opts.clearStatus ?? 200 });
    }
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
  return { ...built, db, req, company, ceo, worker, mcp, pushed, cleared, setClock: (d: Date) => (clock = d) };
}

const SETTINGS = { quietHours: null, agentHourlyCap: 6, ntfy: { url: "https://ntfy.example.ts.net", topic: "bossman", token: "tk_secret_value_123" }, phonePush: "all", publicUrl: "https://bossman.example.ts.net/" };
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
    expect(p!.body).toEqual({ topic: "bossman", sequence_id: rows.find((r) => r.level === "ask")!.id, title: "App Co needs a decision", message: "Ship the beta?", priority: 3, tags: ["question"], click: "https://bossman.example.ts.net/#/decisions", actions: [{ action: "view", label: "Open in Boss Man", url: "https://bossman.example.ts.net/#/decisions", clear: false }] });
    expect(rows.find((r) => r.level === "ask")!.pushedAt).not.toBeNull();

    const feed = (await c.req("GET", "/api/notifications")).json();
    expect(feed.unread).toBe(3);
    expect(feed.items[0]).toMatchObject({ company: "App Co", link: "#/decisions" });
    expect((await c.req("POST", "/api/notifications/read", { ids: [feed.items[0].id] })).json()).toEqual({ unread: 2 });
    expect((await c.req("POST", "/api/notifications/read", { all: true })).json()).toEqual({ unread: 0 });
  });

  it("sends only urgent cards by default: a blocking ask, a live-problem deploy and the test push reach the phone; routine deploy, plan and hire cards do not (BOS-1006)", async () => {
    const c = await setup({ pushStatus: 200 });
    // No phonePush: the default, urgent only.
    await c.req("PUT", "/api/notification-settings", { ...SETTINGS, phonePush: undefined });
    const seen = (await c.req("GET", "/api/notification-settings")).json();
    expect(seen.phonePush).toBe("urgent");

    const project = (await c.req("POST", `/api/companies/${c.company.id}/projects`, { name: "Site" })).json() as { id: string };
    const ticket = (await c.req("POST", `/api/projects/${project.id}/tickets`, { title: "Rate limiting" })).json() as { id: string };

    // Routine: a plain deploy approval, a plan card and a hire card, none blocking a ticket.
    await c.db.insert(decisions).values({ companyId: c.company.id, kind: "question", question: "Deploy Boss Man f0ab92d8 -> ffe89213?", options: ["Deploy", "Not now"], recommendedOption: "Deploy", context: { type: "self_deploy", target: "server", commit: "ffe89213", fromCommit: "f0ab92d8" } });
    await c.db.insert(decisions).values({ companyId: c.company.id, kind: "question", question: "Approve the plan?", options: ["Approve plan", "Keep planning"], recommendedOption: "Approve plan", context: { type: "question", plan: true } });
    await c.db.insert(decisions).values({ companyId: c.company.id, kind: "question", question: "Hire Ada?", options: ["Hire", "No"], recommendedOption: "Hire", context: { type: "hire" } });
    await c.notes.syncDecisions();
    expect(c.pushed).toHaveLength(0);

    // BOS-1097: a card that blocks a ticket is no longer urgent by itself.
    const blocking = await c.decisions.raise({ companyId: c.company.id, agentId: c.worker.id, question: "Which database should I use?", options: ["Postgres", "SQLite"], recommended: "Postgres", blocksTicketId: ticket.id, triedFirst: "Compared both on the docs." });
    expect(blocking.id).toBeTruthy();
    await c.notes.syncDecisions();
    expect(c.pushed).toHaveLength(0);

    // The same kind of card, marked urgent by the CEO: priority 5, with the reason recorded.
    const marked = await c.decisions.raise({ companyId: c.company.id, agentId: c.worker.id, question: "Disk is nearly full, may I delete old backups?", options: ["Yes", "No"], recommended: "Yes", blocksTicketId: ticket.id, triedFirst: "Looked for other space." });
    await c.db.update(decisions).set({ context: { type: "question", urgentPush: { by: "CEO", at: "2026-10-16T23:00:00Z", why: "the disk fills tonight" } } }).where(eq(decisions.id, marked.id));
    await c.notes.syncDecisions();
    const urgentPush = c.pushed.find((p) => p.body.message === "Disk is nearly full, may I delete old backups?");
    expect(urgentPush).toBeDefined();
    expect(urgentPush!.body.priority).toBe(5);
    const [pushedRow] = await c.db.select().from(notifications).where(eq(notifications.decisionId, marked.id));
    expect(pushedRow!.pushReason).toBe("The CEO marked it urgent: the disk fills tonight");

    // A live-problem deploy (fixesLive) is urgent at priority 5; its heading is the push title.
    c.pushed.length = 0;
    await c.db.delete(notifications);
    const deploy = await c.decisions.raise({ companyId: c.company.id, agentId: null, question: "Deploy Boss Man?", options: ["Deploy", "Not now"], recommended: "Deploy" });
    await c.db.update(decisions).set({ context: { type: "self_deploy", target: "server", commit: "abc", fromCommit: "def", urgent: { heading: "Urgent: contains the fix for server freezes as memory climbs (BOS-1)", fixes: [{ symptom: "server freezes as memory climbs", ref: "BOS-1" }], repeat: false } } }).where(eq(decisions.id, deploy.id));
    await c.notes.syncDecisions();
    const fixPush = c.pushed.find((p) => p.body.title === "Urgent: contains the fix for server freezes as memory climbs (BOS-1)");
    expect(fixPush).toBeDefined();
    expect(fixPush!.body.priority).toBe(5);

    // The test button goes to the phone at priority 5 even in urgent-only mode.
    c.pushed.length = 0;
    expect((await c.req("POST", "/api/notification-settings/test")).statusCode).toBe(200);
    expect(c.pushed).toHaveLength(1);
    expect(c.pushed[0]!.body).toMatchObject({ title: "Boss Man test", priority: 5 });
  });

  it("a page goes to the phone at priority 5 by default; a flag waits for the Flags tick", async () => {
    const c = await setup();
    await c.req("PUT", "/api/notification-settings", { ...SETTINGS, phonePush: undefined });
    await c.notes.notify({ companyId: c.company.id, level: "flag", title: "Runner didn't start", link: "#/" });
    expect(c.pushed).toHaveLength(0);
    await c.notes.notify({ companyId: c.company.id, level: "page", title: "Server unusable", link: "#/" });
    expect(c.pushed).toHaveLength(1);
    expect(c.pushed[0]!.body).toMatchObject({ title: "Server unusable", priority: 5 });
    // The Flags tick still works.
    await c.req("PUT", "/api/notification-settings", { ...SETTINGS, phonePush: undefined, pushLevels: ["flag"] });
    await c.notes.notify({ companyId: c.company.id, level: "flag", title: "Runner didn't start", link: "#/runs/2" });
    expect(c.pushed).toHaveLength(2);
    expect(c.pushed[1]!.body).toMatchObject({ title: "Runner didn't start", priority: 3 });
  });

  it("pushes routine cards at priority 3 when the owner chooses All decisions (BOS-1006)", async () => {
    const c = await setup();
    await c.req("PUT", "/api/notification-settings", SETTINGS);
    await c.db.insert(decisions).values({ companyId: c.company.id, kind: "question", question: "Deploy Boss Man f0ab92d8 -> ffe89213?", options: ["Deploy", "Not now"], recommendedOption: "Deploy", context: { type: "self_deploy", target: "server", commit: "ffe89213", fromCommit: "f0ab92d8" } });
    await c.notes.syncDecisions();
    expect(c.pushed).toHaveLength(1);
    expect(c.pushed[0]!.body.priority).toBe(3);
  });

  it("keeps quiet hours unchanged: an urgent ask is not pushed while they last (BOS-1006)", async () => {
    const c = await setup();
    await c.req("PUT", "/api/notification-settings", { ...SETTINGS, phonePush: undefined, quietHours: { start: "22:00", end: "07:00", timeZone: "Europe/London" } });
    const project = (await c.req("POST", `/api/companies/${c.company.id}/projects`, { name: "Site" })).json() as { id: string };
    const ticket = (await c.req("POST", `/api/projects/${project.id}/tickets`, { title: "Rate limiting" })).json() as { id: string };
    const q = await c.decisions.raise({ companyId: c.company.id, agentId: c.worker.id, question: "Which database?", options: ["Postgres", "SQLite"], recommended: "Postgres", blocksTicketId: ticket.id, triedFirst: "Compared both." });
    await c.db.update(decisions).set({ context: { type: "question", urgentPush: { by: "CEO", at: "2026-10-16T23:00:00Z", why: "needed now" } } }).where(eq(decisions.id, q.id));
    // 00:30 in London: quiet hours, so the urgent ask becomes a flag and doesn't reach the phone.
    await c.notes.syncDecisions();
    expect(c.pushed).toHaveLength(0);
    const row = (await c.db.select().from(notifications)).find((n) => n.body === "Which database?");
    expect(row).toMatchObject({ requested: "ask", level: "flag", demotedBy: "quiet hours", pushedAt: null });
  });

  it("never pushes a card still with the CEO, a Got it notice, or one settled before the send, even when marked urgent (BOS-1097)", async () => {
    const c = await setup();
    await c.req("PUT", "/api/notification-settings", { ...SETTINGS, phonePush: undefined });
    const urgentPush = { by: "CEO", at: "2026-10-16T23:00:00Z", why: "needed now" };
    await c.db.insert(decisions).values({ companyId: c.company.id, kind: "question", tier: "ceo", question: "CEO-tier card", options: ["Yes", "No"], recommendedOption: "Yes", context: { type: "question", urgentPush } });
    await c.db.insert(decisions).values({ companyId: c.company.id, kind: "question", question: "Disk is full.", options: ["Got it"], recommendedOption: "Got it", context: { type: "question", urgentPush } });
    await c.notes.syncDecisions();
    expect(c.pushed).toHaveLength(0);

    // Re-check before sending: the card was answered between being picked and being sent.
    const [settled] = await c.db.insert(decisions).values({ companyId: c.company.id, kind: "question", question: "Already answered", options: ["Yes", "No"], recommendedOption: "Yes", status: "answered", answer: "Yes", context: { type: "question", urgentPush } }).returning();
    await c.notes.notify({ companyId: c.company.id, level: "ask", title: "x", body: "Already answered", link: "#/decisions", decisionId: settled!.id, urgentReason: "The CEO marked it urgent: needed now" });
    expect(c.pushed).toHaveLength(0);
    const [row] = await c.db.select().from(notifications).where(eq(notifications.decisionId, settled!.id));
    expect(row!.pushedAt).toBeNull();
  });

  it("a CEO escalation with urgent:true stores the mark and the card pushes; without it the same card stays off the phone (BOS-1097)", async () => {
    const c = await setup({ listen: true });
    await c.req("PUT", "/api/notification-settings", { ...SETTINGS, phonePush: undefined });
    const ceo = await c.mcp(c.ceo.id);
    const alert = (question: string) => c.alerts.raise({ companyId: c.company.id, kind: "owner", question, from: "scrum_master", options: ["Got it", "Keep waiting"] });
    const plain = await alert("Plain alert the CEO could not settle");
    const urgent = await alert("Urgent alert the CEO could not settle");
    const triedFirst = "Looked at both agents' last runs and the host";
    // urgent:true without a reason is refused and nothing moves.
    expect(textOf(await ceo.callTool({ name: "decisions", arguments: { action: "escalate", id: urgent!.id, triedFirst, urgent: true } }))).toMatch(/urgentWhy/);
    expect((await c.db.select().from(decisions).where(eq(decisions.id, urgent!.id)))[0]!.tier).toBe("ceo");

    expect((await ceo.callTool({ name: "decisions", arguments: { action: "escalate", id: plain!.id, triedFirst } }) as { isError?: boolean }).isError).toBeFalsy();
    expect((await ceo.callTool({ name: "decisions", arguments: { action: "escalate", id: urgent!.id, triedFirst, urgent: true, urgentWhy: "The runner is down and nothing can ship" } }) as { isError?: boolean }).isError).toBeFalsy();
    const [row] = await c.db.select().from(decisions).where(eq(decisions.id, urgent!.id));
    expect(row!.tier).toBe("owner");
    expect((row!.context as { urgentPush?: { why: string } }).urgentPush).toMatchObject({ why: "The runner is down and nothing can ship" });

    await c.notes.syncDecisions();
    expect(c.pushed.map((p) => p.body.message)).toEqual(["Urgent alert the CEO could not settle"]);
    expect(c.pushed[0]!.body.priority).toBe(5);
    const [n] = await c.db.select().from(notifications).where(eq(notifications.decisionId, urgent!.id));
    expect(n!.pushReason).toBe("The CEO marked it urgent: The runner is down and nothing can ship");
    await ceo.close();
  });

  it("a CEO reissue with urgent:true marks the new card and it pushes; without the mark it stays off the phone; a short reason is refused (BOS-1110)", async () => {
    const c = await setup({ listen: true });
    await c.req("PUT", "/api/notification-settings", { ...SETTINGS, phonePush: undefined });
    const ceo = await c.mcp(c.ceo.id);
    const asked = async (question: string) => (await c.db.insert(decisions).values({ companyId: c.company.id, kind: "question", question, options: ["Yes", "No"], recommendedOption: "Yes", raisedByAgentId: c.worker.id, context: { type: "question", advice: { state: "asking", askedAt: new Date().toISOString() } } }).returning())[0]!;
    const plain = await asked("Plain question from an agent");
    const urgent = await asked("Urgent question from an agent");
    const reissue = (id: string, extra: Record<string, unknown>) => ceo.callTool({ name: "decisions", arguments: { action: "advise", outcome: "reissue", id, question: "Clearer question?", options: ["Yes", "No"], recommended: "Yes", triedFirst: "Looked at the ticket and the agent's last run", ...extra } }) as Promise<{ isError?: boolean }>;
    // A reason under 10 characters is refused and the card is left as it was.
    expect(textOf(await reissue(urgent.id, { urgent: true, urgentWhy: "now" }))).toMatch(/urgentWhy/);
    expect((await c.db.select().from(decisions).where(eq(decisions.id, urgent.id)))[0]!.status).toBe("open");
    // "handled" settles the card, so an urgent mark on it is refused.
    expect(textOf(await ceo.callTool({ name: "decisions", arguments: { action: "advise", outcome: "handled", id: urgent.id, urgent: true, urgentWhy: "The runner is down and nothing can ship", summary: "Did the work and picked the answer." } }))).toMatch(/urgent/);

    expect((await reissue(plain.id, {})).isError).toBeFalsy();
    expect((await reissue(urgent.id, { urgent: true, urgentWhy: "The runner is down and nothing can ship" })).isError).toBeFalsy();
    const open = await c.db.select().from(decisions).where(eq(decisions.status, "open"));
    expect(open).toHaveLength(2);
    expect(open.filter((d) => (d.context as { urgentPush?: { why: string } }).urgentPush?.why === "The runner is down and nothing can ship")).toHaveLength(1);

    await c.notes.syncDecisions();
    expect(c.pushed).toHaveLength(1);
    expect(c.pushed[0]!.body.priority).toBe(5);
    const marked = open.find((d) => (d.context as { urgentPush?: unknown }).urgentPush)!;
    const [n] = await c.db.select().from(notifications).where(eq(notifications.decisionId, marked.id));
    expect(n!.pushReason).toBe("The CEO marked it urgent: The runner is down and nothing can ship");
    await ceo.close();
  });

  it("clears a pushed card from the phone when it is answered, and a failed or unsupported clear never fails the answer (BOS-1097)", async () => {
    for (const clearStatus of [200, 404]) {
      const c = await setup({ clearStatus });
      await c.req("PUT", "/api/notification-settings", { ...SETTINGS, phonePush: undefined });
      const d = await c.decisions.raise({ companyId: c.company.id, agentId: c.worker.id, question: "Delete old backups?", options: ["Yes", "No"], recommended: "Yes", triedFirst: "Looked for other space." });
      await c.db.update(decisions).set({ context: { type: "question", urgentPush: { by: "CEO", at: "2026-10-16T23:00:00Z", why: "disk fills tonight" } } }).where(eq(decisions.id, d.id));
      await c.notes.syncDecisions();
      expect(c.pushed).toHaveLength(1);
      const [n] = await c.db.select().from(notifications).where(eq(notifications.decisionId, d.id));
      expect(c.pushed[0]!.body.sequence_id).toBe(n!.id);

      // The answer goes through; the clear runs after it, in the background.
      expect(await c.decisions.answer(d.id, "Yes")).toBeTruthy();
      await vi.waitFor(async () => {
        const [after] = await c.db.select().from(notifications).where(eq(notifications.id, n!.id));
        expect(after!.pushClearedAt !== null || after!.pushClearNote !== null).toBe(true);
      });
      expect(c.cleared).toEqual([`https://ntfy.example.ts.net/bossman/${n!.id}/clear`]);
      const [after] = await c.db.select().from(notifications).where(eq(notifications.id, n!.id));
      if (clearStatus === 200) expect(after).toMatchObject({ pushClearNote: null });
      else expect(after!.pushClearNote).toContain("too old");
      const recent = (await c.req("GET", "/api/notifications/pushes")).json().items;
      expect(recent).toHaveLength(1);
      expect(recent[0]).toMatchObject({ reason: "The CEO marked it urgent: disk fills tonight", state: "settled" });
      // A second sweep does not try again (cleared, or an old server that can't).
      await c.notes.clearSettledPushes();
      expect(c.cleared).toHaveLength(1);
      await ctx?.close();
      ctx = undefined;
    }
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
    // BOS-1797: the record keeps the address the tap went to, so a later address change can't reuse this proof.
    expect(st.phoneTest.url).toBe("https://bossman.example.ts.net");
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
    // The counts are unread notices by level and company, whatever the filters say (BOS-1277).
    const filtered = (await c.req("GET", "/api/notifications?level=flag&status=read")).json();
    expect(filtered.counts).toEqual({ level: { note: 1, flag: 1 }, company: { [c.company.id]: 1, none: 1 } });
  });

  it("q finds notices by words in the title or text, any case, with the other filters and paging (BOS-2316)", async () => {
    const c = await setup();
    const row = { requested: "note", level: "note", link: "#/runs" } as const;
    await c.db.insert(notifications).values([
      { ...row, title: "Runner went offline", body: null, createdAt: new Date("2026-11-01T10:00:00Z") },
      { ...row, title: "Deploy done", body: "The RUNNER is back", level: "flag", requested: "flag", createdAt: new Date("2026-11-02T10:00:00Z") },
      { ...row, title: "Budget at 100%", body: "x", createdAt: new Date("2026-11-03T10:00:00Z") },
      { ...row, title: "Budget at 1000", body: "x", createdAt: new Date("2026-11-04T10:00:00Z") },
    ]);
    const titles = async (qs: string) => ((await c.req("GET", `/api/notifications?${qs}`)).json().items as Array<{ title: string }>).map((i) => i.title);
    expect(await titles("q=runner")).toEqual(["Deploy done", "Runner went offline"]);
    expect(await titles("q=runner&level=flag")).toEqual(["Deploy done"]);
    expect(await titles(`q=runner&before=${encodeURIComponent("2026-11-02T00:00:00Z")}`)).toEqual(["Runner went offline"]);
    // A % in the text matches a % and not "anything".
    expect(await titles(`q=${encodeURIComponent("100%")}`)).toEqual(["Budget at 100%"]);
    expect(await titles("q=nothing-like-this")).toEqual([]);
    // Spaces alone are no search; too long is refused.
    expect(await titles(`q=${encodeURIComponent("   ")}`)).toHaveLength(4);
    expect((await c.req("GET", `/api/notifications?q=${"a".repeat(201)}`)).statusCode).toBe(400);
  });
});

describe("appUrl: a link in the app as the phone opens it", () => {
  it("joins a base and a link with exactly one slash, with or without a trailing slash on the base", () => {
    expect(appUrl("https://app.example.com", "#/notifications")).toBe("https://app.example.com/#/notifications");
    expect(appUrl("https://app.example.com/", "#/notifications")).toBe("https://app.example.com/#/notifications");
  });

  it("expects the link without a leading slash: a leading slash is kept as given", () => {
    expect(appUrl("https://app.example.com", "settings/updates")).toBe("https://app.example.com/settings/updates");
    // The callers pass fragment links like "#/..." with no leading slash; one is not stripped, so it doubles the join.
    expect(appUrl("https://app.example.com", "/settings/updates")).toBe("https://app.example.com//settings/updates");
  });

  it("with no base set falls back to a root-relative link", () => {
    expect(appUrl("", "#/notifications")).toBe("/#/notifications");
    expect(appUrl("", "settings/updates")).toBe("/settings/updates");
  });
});
