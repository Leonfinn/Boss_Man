// BOS-1456: owner-tier permission cards grouped by the rule that sent them, across every company.
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { agents, decisions } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";
import { formatPermissionReport, groupCards, permissionReport, routeOf, type CardRow } from "../src/services/permission-report.js";

const T0 = new Date("2026-11-14T16:00:00Z");
const row = (over: Partial<CardRow> & { ctx?: Record<string, unknown> }): CardRow => ({
  id: randomUUID(), companyId: "c1", company: "Example Co", status: "answered", answer: "Allow once",
  createdAt: T0, answeredAt: new Date(T0.getTime() + 90_000), agent: "Ann", ticket: "EX-1",
  context: { rule: "destructive-guard", explain: { title: "Ann wants to run a command", summary: "Deletes files.", ownerWhy: "Sent to you because X.", command: "rm -rf SECRET_PATH" }, ...over.ctx }, ...over,
});

describe("groupCards", () => {
  it("groups by rule, counts per hour, keeps ownerWhy and one example with wait time", () => {
    const rows = [
      row({}),
      row({ createdAt: new Date("2026-11-14T16:30:00Z"), answeredAt: new Date("2026-11-14T16:40:00Z") }),
      row({ createdAt: new Date("2026-11-14T17:05:00Z"), answeredAt: null, status: "open", answer: null }),
      row({ ctx: { rule: "temp-cleanup" } }),
    ];
    const r = groupCards(rows, new Date("2026-11-12T16:00:00Z"), new Date("2026-11-14T18:00:00Z"), 48);
    expect(r.total).toBe(4);
    expect(r.groups.map((g) => [g.rule, g.count])).toEqual([["destructive-guard", 3], ["temp-cleanup", 1]]);
    const g = r.groups[0]!;
    expect(g.perHour).toEqual({ "2026-11-14T16:00:00.000Z": 2, "2026-11-14T17:00:00.000Z": 1 });
    expect(g.ownerWhy).toEqual([{ text: "Sent to you because X.", count: 3 }]);
    // Newest card is the example; it is still open, so no wait time.
    expect(g.example).toMatchObject({ at: "2026-11-14T17:05:00.000Z", waitMinutes: null, status: "open", agent: "Ann", ticket: "EX-1", company: "Example Co" });
    expect(r.groups[1]!.example.waitMinutes).toBe(1.5);
  });

  it("never carries the command, only the card's title and summary", () => {
    const r = groupCards([row({})], T0, T0, 48);
    expect(r.groups[0]!.example.what).toBe("Ann wants to run a command. Deletes files.");
    expect(JSON.stringify(r)).not.toContain("SECRET_PATH");
    expect(formatPermissionReport(r)).not.toContain("SECRET_PATH");
  });

  it("separates a card that went to the CEO first from one sent straight to the owner", () => {
    const ladder = (why: string) => ({ ladder: { hops: [{ to: "ceo", why: "temp-file cleanup goes to the CEO first" }, { to: "owner", why }] } });
    expect(routeOf({})).toBe("direct");
    expect(routeOf(ladder("the CEO didn't settle it in time"))).toBe("ceo_timeout");
    expect(routeOf(ladder("the CEO's wake was dropped (x)"))).toBe("ceo_unavailable");
    expect(routeOf(ladder("the CEO escalated it"))).toBe("ceo_escalated");
    const r = groupCards([row({ ctx: { rule: "temp-cleanup" } }), row({ ctx: { rule: "temp-cleanup", ...ladder("the CEO didn't settle it in time") } })], T0, T0, 48);
    expect(r.groups.map((g) => g.route).sort()).toEqual(["ceo_timeout", "direct"]);
  });
});

let ctx: Awaited<ReturnType<typeof setup>>;
async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, workspaceRoot: "/ws" });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const base = `127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const mk = async (name: string) => (await built.app.inject({ method: "POST", url: "/api/companies", headers: { cookie }, payload: { name } })).json() as { company: { id: string }; ceo: { id: string } };
  return { ...built, db, close, base, cookie, a: await mk("App Co"), b: await mk("Other Co") };
}
beforeEach(async () => { ctx = await setup(); });
afterEach(async () => { await ctx.app.close(); await ctx.close(); });

const card = (companyId: string, over: Record<string, unknown> = {}, context: Record<string, unknown> = {}) =>
  ctx.db.insert(decisions).values({ companyId, kind: "permission", question: "q", options: ["Allow once", "Deny"], recommendedOption: "Deny", tier: "owner", context: { type: "permission", rule: "destructive-guard", explain: { title: "t", summary: "s" }, ...context }, ...over } as never);

describe("permissionReport", () => {
  it("covers every company, defaults to 48 hours, and leaves out CEO-tier, plan and older cards", async () => {
    const ago = (h: number) => new Date(Date.now() - h * 3_600_000);
    await card(ctx.a.company.id, { createdAt: ago(1) });
    await card(ctx.b.company.id, { createdAt: ago(47) });
    await card(ctx.a.company.id, { createdAt: ago(49) });
    await card(ctx.a.company.id, { createdAt: ago(1), tier: "ceo" });
    await card(ctx.a.company.id, { createdAt: ago(1) }, { plan: true });
    const r = await permissionReport(ctx.db);
    expect(r.hours).toBe(48);
    expect(r.total).toBe(2);
    expect(r.groups[0]!.example.company).toMatch(/Co$/);
    expect((await permissionReport(ctx.db, { hours: 500 })).hours).toBe(168);
    expect((await permissionReport(ctx.db, { hours: 2 })).total).toBe(1);
  });

  it("is served read-only to the signed-in owner, rejecting a bad hours value", async () => {
    await card(ctx.a.company.id);
    const ok = await ctx.app.inject({ method: "GET", url: "/api/permission-report?hours=24", headers: { cookie: ctx.cookie } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().total).toBe(1);
    expect((await ctx.app.inject({ method: "GET", url: "/api/permission-report?hours=0", headers: { cookie: ctx.cookie } })).statusCode).toBe(400);
    expect((await ctx.app.inject({ method: "GET", url: "/api/permission-report" })).statusCode).toBe(401);
  });

  it("is a CEO tool that reads across companies", async () => {
    await card(ctx.b.company.id);
    const token = await issueRunToken(ctx.db, { companyId: ctx.a.company.id, agentId: ctx.a.ceo.id, runId: randomUUID() });
    const c = new Client({ name: "t", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://${ctx.base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    const out = (await c.callTool({ name: "permission_report", arguments: { format: "json" } })) as { content: Array<{ text: string }> };
    const r = JSON.parse(out.content[0]!.text) as { total: number; groups: Array<{ example: { company: string } }> };
    expect(r.total).toBe(1);
    expect(r.groups[0]!.example.company).toBe("Other Co");
    await c.close();
  });

  const callAs = async (agentId: string | null) => {
    const token = await issueRunToken(ctx.db, { companyId: ctx.a.company.id, agentId, runId: randomUUID() });
    const c = new Client({ name: "t", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://${ctx.base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    try {
      return (await c.callTool({ name: "permission_report", arguments: { format: "json" } })) as { isError?: boolean; content: Array<{ text: string }> };
    } finally {
      await c.close();
    }
  };

  it("refuses a non-CEO agent token and a token with no agent, and returns no data", async () => {
    await card(ctx.b.company.id);
    const [worker] = await ctx.db.insert(agents).values({ companyId: ctx.a.company.id, name: "Wes", role: "worker", agentKind: "claude" } as never).returning();
    for (const who of [worker!.id, null]) {
      const out = await callAs(who);
      expect(out.isError).toBe(true);
      expect(out.content[0]!.text).toContain("Only the CEO reads the permission report.");
      expect(out.content[0]!.text).not.toContain("Other Co");
      expect(out.content[0]!.text).not.toContain("groups");
    }
  });

  it("keeps secret input, reason and command from the card context out of the JSON and text output", async () => {
    await card(ctx.b.company.id, {}, {
      input: { command: "SECRET_INPUT_CMD" },
      toolInput: "SECRET_TOOL_INPUT",
      reason: "SECRET_REASON",
      command: "SECRET_COMMAND",
      explain: { title: "Ann wants to run a command", summary: "Deletes files.", ownerWhy: "Sent to you because X.", command: "SECRET_EXPLAIN_CMD", reason: "SECRET_EXPLAIN_REASON" },
    });
    const r = await permissionReport(ctx.db);
    const both = JSON.stringify(r) + formatPermissionReport(r);
    expect(r.total).toBe(1);
    expect(both).toContain("Deletes files.");
    expect(both).not.toContain("SECRET_");
    const viaTool = await callAs(ctx.a.ceo.id);
    expect(viaTool.isError).toBeFalsy();
    expect(viaTool.content[0]!.text).not.toContain("SECRET_");
  });
});
