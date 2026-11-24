import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { eq } from "drizzle-orm";
import { companies, deploys } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";
import { currentHold, openHold } from "../src/services/owner-holds.js";

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.app.close();
  await ctx?.close();
  ctx = undefined;
});

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const base = `127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const mk = async (name: string) => {
    const { company } = (await req("POST", "/api/companies", { name })).json() as { company: { id: string } };
    const agent = (await req("POST", `/api/companies/${company.id}/agents`, { name: `${name} engineer` })).json() as { id: string };
    const target = (await req("POST", `/api/companies/${company.id}/deploy-targets`, { name: "Staging", kind: "docker", endpoint: "tcp://socket-proxy:2375" })).json() as { id: string };
    return { company, agent, target };
  };
  const mcp = async (x: { company: { id: string }; agent: { id: string } }) => {
    const token = await issueRunToken(db, { companyId: x.company.id, agentId: x.agent.id, runId: "00000000-0000-4000-8000-000000000001" });
    const c = new Client({ name: "t", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    return c;
  };
  return { ...built, db, close, mk, mcp };
}

const textOf = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? "");

describe("deploy tool: history", () => {
  it("lists a target's deploys newest first, failed ones too, honours the limit, and never shows another company's", async () => {
    const c = (ctx = await setup());
    const a = await c.mk("Alpha");
    const b = await c.mk("Beta");
    const at = (n: number) => new Date(Date.UTC(2026, 10, 20, 10, n));
    await c.db.insert(deploys).values([
      { companyId: a.company.id, targetId: a.target.id, agentId: a.agent.id, ref: "v1", status: "succeeded", commit: "a".repeat(40), createdAt: at(1) },
      { companyId: a.company.id, targetId: a.target.id, agentId: a.agent.id, ref: "v2", status: "failed", createdAt: at(2) },
      { companyId: a.company.id, targetId: a.target.id, agentId: null, ref: "v3", status: "rejected", createdAt: at(3) },
      { companyId: b.company.id, targetId: b.target.id, ref: "secret-ref", status: "succeeded", createdAt: at(4) },
    ]);
    const client = await c.mcp(a);
    const all = textOf(await client.callTool({ name: "deploy", arguments: { action: "history", target: "staging" } })).split("\n");
    expect(all).toHaveLength(3);
    expect(all[0]).toContain("| v3 |");
    expect(all[0]).toContain("by the owner");
    expect(all[0]).toContain("rejected");
    expect(all[1]).toContain("v2");
    expect(all[1]).toContain("failed");
    expect(all[2]).toContain("v1 (aaaaaaa)");
    expect(all[2]).toContain("2026-11-20 10:01 UTC");
    const one = textOf(await client.callTool({ name: "deploy", arguments: { action: "history", target: a.target.id, limit: 1 } }));
    expect(one.split("\n")).toHaveLength(1);
    // Another company's target is not found, and its deploys never appear.
    const other = await client.callTool({ name: "deploy", arguments: { action: "history", target: b.target.id } });
    expect(textOf(other)).toContain("No deploy target");
    expect(all.join("\n")).not.toContain("secret-ref");
    expect(textOf(await client.callTool({ name: "deploy", arguments: { action: "history" } }))).toContain("Give the target");
    await client.close();
  });
});

describe("deploy tool: release_hold (BOS-2554, DR-076 A)", () => {
  it("releases a held update for Boss Man's own company only, with an outcome and the agent's words", async () => {
    const c = (ctx = await setup());
    const home = await c.mk("Home"); // the oldest company is Boss Man's own
    const other = await c.mk("Other");
    // Two companies made in the same millisecond would tie on createdAt: make the home one plainly older.
    await c.db.update(companies).set({ createdAt: new Date("2026-01-01T00:00:00Z") }).where(eq(companies.id, home.company.id));
    const call = async (x: typeof home, args: Record<string, unknown>) => {
      const client = await c.mcp(x);
      const r = (await client.callTool({ name: "deploy", arguments: { action: "release_hold", ...args } })) as { isError?: boolean };
      await client.close();
      return { error: !!r.isError, text: textOf(r) };
    };
    const ok = { outcome: "retry_safe", ownerText: "fine" };
    expect(await call(home, ok)).toMatchObject({ error: true, text: expect.stringContaining("Nothing is held") });
    await openHold(c.db, { subject: "server_deploy", commit: "b".repeat(40), result: "failed", reason: "Building green failed." });
    expect(await call(other, ok)).toMatchObject({ error: true, text: expect.stringContaining("Only Boss Man's own company") });
    expect(await call(home, { ownerText: "fine" })).toMatchObject({ error: true, text: expect.stringContaining("Give outcome") });
    expect(await call(home, { outcome: "retry_safe" })).toMatchObject({ error: true, text: expect.stringContaining("Give ownerText") });
    expect((await currentHold(c.db, "server_deploy"))?.releasedAt).toBeNull();
    expect(await call(home, { outcome: "retry_safe", ownerText: "Disk was full; freed." })).toMatchObject({ error: false, text: expect.stringContaining("Released.") });
    expect(await currentHold(c.db, "server_deploy")).toMatchObject({ releasedBy: "Home engineer", outcome: "retry_safe", ownerText: "Disk was full; freed." });
    // Already released: a second call says so and changes nothing.
    expect(await call(home, { outcome: "do_not_retry", ownerText: "x" })).toMatchObject({ error: true, text: expect.stringContaining("Nothing is held") });
  });

  it("asks which one when both the server and the runner update are held", async () => {
    const c = (ctx = await setup());
    const home = await c.mk("Home");
    await openHold(c.db, { subject: "server_deploy", commit: "b".repeat(40), result: "failed", reason: "x" });
    await openHold(c.db, { subject: "runner_update", commit: "c".repeat(40), result: "failed", reason: "y" });
    const client = await c.mcp(home);
    const both = (await client.callTool({ name: "deploy", arguments: { action: "release_hold", outcome: "retry_safe", ownerText: "ok" } })) as { isError?: boolean };
    expect(both.isError).toBe(true);
    expect(textOf(both)).toContain("Name the one you diagnosed");
    const one = (await client.callTool({ name: "deploy", arguments: { action: "release_hold", subject: "runner_update", outcome: "do_not_retry", ownerText: "Bad image." } })) as { isError?: boolean };
    await client.close();
    expect(one.isError).toBeFalsy();
    expect((await currentHold(c.db, "runner_update"))?.outcome).toBe("do_not_retry");
    expect((await currentHold(c.db, "server_deploy"))?.releasedAt).toBeNull();
  });
});

describe("deploy summary and status filter (BOS-2409)", () => {
  it("counts the last 30 days, takes the median of succeeded ones, and filters the list", async () => {
    const c = (ctx = await setup());
    const a = await c.mk("Gamma");
    const day = 86_400_000;
    // One clock read for every row: createdAt and finishedAt are built from the same `now`, so a duration is exactly
    // `secs` however slow the machine is (two Date.now() calls could differ by a few ms and make the median 120.003).
    const now = Date.now();
    const ago = (d: number, secs = 0) => new Date(now - d * day + secs * 1000);
    const mkRow = (status: string, d: number, secs: number) => ({ companyId: a.company.id, targetId: a.target.id, ref: `r${d}${status}`, status: status as "succeeded", createdAt: ago(d), finishedAt: ago(d, secs) });
    await c.db.insert(deploys).values([mkRow("succeeded", 1, 60), mkRow("succeeded", 2, 180), mkRow("failed", 3, 30), mkRow("rejected", 4, 0), mkRow("succeeded", 40, 10)]);
    const base = (await c.app.inject({ method: "POST", url: "/api/login", payload: { username: "leon", password: "correct horse battery" } })).cookies.find((x) => x.name === "bm_session")!.value;
    const get = (url: string) => c.app.inject({ method: "GET", url, headers: { cookie: `bm_session=${base}` } }).then((r) => r.json());
    const s = await get(`/api/deploys/summary?targetId=${a.target.id}`);
    expect(s).toMatchObject({ days: 30, total: 4, succeeded: 2, failedOrRejected: 2, medianSeconds: 120 });
    expect(typeof s.lastSuccessAt).toBe("string");
    const failed = await get(`/api/deploys?targetId=${a.target.id}&status=failed`);
    expect(failed.map((r: { deploy: { status: string } }) => r.deploy.status).sort()).toEqual(["failed", "rejected"]);
    expect(await get(`/api/deploys?targetId=${a.target.id}&status=succeeded`)).toHaveLength(3);
  });
});

describe("deploy targets list: latestAttempt (BOS-2464)", () => {
  it("is set only when the newest deploy is not the last success, and never from another company", async () => {
    const c = (ctx = await setup());
    const a = await c.mk("Zeta");
    const b = await c.mk("Eta");
    const at = (n: number) => new Date(Date.now() - n * 60_000);
    await c.db.insert(deploys).values([
      { companyId: a.company.id, targetId: a.target.id, ref: "ok", status: "succeeded", createdAt: at(5), finishedAt: at(4) },
      { companyId: a.company.id, targetId: a.target.id, ref: "bad", status: "failed", outcome: "boom", createdAt: at(2), finishedAt: at(1) },
      { companyId: b.company.id, targetId: b.target.id, ref: "fine", status: "succeeded", createdAt: at(3), finishedAt: at(2) },
    ]);
    const login = await c.app.inject({ method: "POST", url: "/api/login", payload: { username: "leon", password: "correct horse battery" } });
    const cookie = `bm_session=${login.cookies.find((x) => x.name === "bm_session")!.value}`;
    const list = async (id: string) => (await c.app.inject({ method: "GET", url: `/api/companies/${id}/deploy-targets`, headers: { cookie } })).json() as Array<{ latestAttempt: { status: string; outcome: string | null; at: string } | null }>;
    expect((await list(a.company.id))[0]!.latestAttempt).toMatchObject({ status: "failed", outcome: "boom" });
    expect((await list(b.company.id))[0]!.latestAttempt).toBeNull();
  });
});

describe("deploy summary: companies and paging (BOS-2409)", () => {
  it("never counts another company's deploys, and pages within the status filter", async () => {
    const c = (ctx = await setup());
    const a = await c.mk("Delta");
    const b = await c.mk("Epsilon");
    const at = (n: number) => new Date(Date.now() - n * 60_000);
    await c.db.insert(deploys).values([
      ...[1, 2, 3].map((n) => ({ companyId: a.company.id, targetId: a.target.id, ref: `f${n}`, status: "failed" as const, createdAt: at(n) })),
      { companyId: a.company.id, targetId: a.target.id, ref: "ok", status: "succeeded" as const, createdAt: at(4), finishedAt: at(3) },
      { companyId: b.company.id, targetId: b.target.id, ref: "other", status: "succeeded" as const, createdAt: at(5), finishedAt: at(4) },
    ]);
    const login = await c.app.inject({ method: "POST", url: "/api/login", payload: { username: "leon", password: "correct horse battery" } });
    const cookie = `bm_session=${login.cookies.find((x) => x.name === "bm_session")!.value}`;
    const get = (url: string) => c.app.inject({ method: "GET", url, headers: { cookie } }).then((r) => r.json());
    expect(await get(`/api/deploys/summary?targetId=${a.target.id}`)).toMatchObject({ total: 4, succeeded: 1, failedOrRejected: 3 });
    expect(await get(`/api/deploys/summary?targetId=${b.target.id}`)).toMatchObject({ total: 1, succeeded: 1 });
    const p1 = await get(`/api/deploys?targetId=${a.target.id}&status=failed&limit=2`);
    expect(p1.map((r: { deploy: { ref: string } }) => r.deploy.ref)).toEqual(["f1", "f2"]);
    const p2 = await get(`/api/deploys?targetId=${a.target.id}&status=failed&limit=2&before=${p1[1].deploy.id}`);
    expect(p2.map((r: { deploy: { ref: string } }) => r.deploy.ref)).toEqual(["f3"]);
  });
});
