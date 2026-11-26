// BOS-2720: agents' ticket lookups (tickets find/read, board) show each ticket's size and milestone, and tickets find
// milestone=… lists a milestone's tickets with whether each counts toward its points left.
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { features, milestones, objectives, tickets } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";
import { registerBoard } from "../src/mcp-board.js";
import { notInPointsLeft } from "../src/services/planning.js";

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
  const { company } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } };
  const worker = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Engineer" })).json() as { id: string };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Site" })).json() as { id: string };
  const [obj] = await db.insert(objectives).values({ companyId: company.id, title: "Grow" }).returning();
  const [beta] = await db.insert(milestones).values({ objectiveId: obj!.id, title: "Beta" }).returning();
  const [other] = await db.insert(milestones).values({ objectiveId: obj!.id, title: "Later" }).returning();
  const [feat] = await db.insert(features).values({ companyId: company.id, title: "Search", milestoneId: beta!.id }).returning();
  let n = 7000;
  const mk = async (title: string, extra: Partial<typeof tickets.$inferInsert>) =>
    (await db.insert(tickets).values({ companyId: company.id, projectId: project.id, number: n++, title, ...extra }).returning())[0]!;
  const t = {
    own: await mk("Own sized", { milestoneId: beta!.id, size: 3 }),
    viaFeature: await mk("Via feature unsized", { featureId: feat!.id }),
    live: await mk("Merged and live", { milestoneId: beta!.id, size: 5, systemState: "in_progress", mergeCommit: "abc123" }),
    waiting: await mk("Merged waiting go-live", { milestoneId: beta!.id, size: 2, systemState: "blocked", mergeCommit: "def456", goLiveWait: "server update" }),
    done: await mk("Finished", { milestoneId: beta!.id, size: 8, systemState: "done" }),
    cancelled: await mk("Dropped", { milestoneId: beta!.id, size: 1, systemState: "done", outcome: "cancelled" }),
    elsewhere: await mk("Other milestone", { milestoneId: other!.id, size: 1 }),
    loose: await mk("No milestone", {}),
  };
  const mcp = async () => {
    const token = await issueRunToken(db, { companyId: company.id, agentId: worker.id, runId: "00000000-0000-4000-8000-000000000001" });
    const c = new Client({ name: "t", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    return c;
  };
  return { ...built, db, close, company, beta: beta!, t, mcp };
}

const textOf = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? "");
type Row = { id: string; title: string; size: number | "no size"; milestone: { id: string; title: string } | null; merged?: boolean; countsTowardPointsLeft?: boolean; notCountedBecause?: string };
const split = (t: string) => {
  const i = t.indexOf("\n\n");
  return { rows: JSON.parse(t.slice(0, i)) as Row[], note: t.slice(i + 2) };
};

describe("ticket size and milestone in agents' lookups (BOS-2720)", () => {
  it("tickets find and read show size and milestone, a feature's milestone when the ticket has none of its own", async () => {
    const c = (ctx = await setup());
    const client = await c.mcp();
    const find = async (q: string) => split(textOf(await client.callTool({ name: "tickets", arguments: { action: "find", q } }))).rows[0]!;
    const own = await find("Own sized");
    expect(own.size).toBe(3);
    expect(own.milestone).toEqual({ id: c.beta.id, title: "Beta" });
    expect(own).not.toHaveProperty("countsTowardPointsLeft");
    const via = await find("Via feature unsized");
    expect(via.size).toBe("no size");
    expect(via.milestone).toEqual({ id: c.beta.id, title: "Beta" });
    const loose = await find("No milestone");
    expect(loose.milestone).toBeNull();

    const read = async (id: string) => textOf(await client.callTool({ name: "tickets", arguments: { action: "read", ticketId: id } }));
    expect(await read(c.t.own.id)).toContain(`Size: 3 points. Milestone: "Beta" (id ${c.beta.id}).`);
    expect(await read(c.t.viaFeature.id)).toContain(`Size: no size. Milestone: "Beta" (id ${c.beta.id}).`);
    expect(await read(c.t.loose.id)).toContain("Size: no size. Milestone: none.");
    await client.close();
  });

  it("the board's open tickets carry size and milestone", async () => {
    const c = (ctx = await setup());
    // The board tool is only on the chat and Scrum Master servers, so call its handler directly.
    let handler: (() => Promise<unknown>) | undefined;
    registerBoard({ registerTool: ((_n: string, _c: unknown, cb: () => Promise<unknown>) => void (handler = cb)) as never }, c.db, { companyId: c.company.id, agentId: null, runId: "r" });
    const board = JSON.parse(textOf(await handler!())) as { openTickets: Row[] };
    const byTitle = new Map(board.openTickets.map((r) => [r.title, r]));
    expect(byTitle.get("Own sized")).toMatchObject({ size: 3, milestone: { id: c.beta.id, title: "Beta" } });
    expect(byTitle.get("Via feature unsized")).toMatchObject({ size: "no size", milestone: { id: c.beta.id, title: "Beta" } });
    expect(byTitle.get("No milestone")!.milestone).toBeNull();
    expect(byTitle.has("Finished")).toBe(false);
  });

  it("tickets find milestone lists its open and merged-not-done tickets, each saying whether it counts toward points left", async () => {
    const c = (ctx = await setup());
    const client = await c.mcp();
    const call = async (args: Record<string, unknown>) => textOf(await client.callTool({ name: "tickets", arguments: { action: "find", ...args } }));

    // By title (any case) and by id give the same list.
    const res = split(await call({ milestone: "beta" }));
    expect(split(await call({ milestone: c.beta.id })).rows.map((r) => r.id).sort()).toEqual(res.rows.map((r) => r.id).sort());
    const byTitle = new Map(res.rows.map((r) => [r.title, r]));
    expect([...byTitle.keys()].sort()).toEqual(["Merged and live", "Merged waiting go-live", "Own sized", "Via feature unsized"]);
    expect(byTitle.get("Own sized")).toMatchObject({ size: 3, countsTowardPointsLeft: true });
    expect(byTitle.get("Own sized")).not.toHaveProperty("merged");
    expect(byTitle.get("Via feature unsized")).toMatchObject({ countsTowardPointsLeft: false, notCountedBecause: "no size" });
    expect(byTitle.get("Merged and live")).toMatchObject({ merged: true, countsTowardPointsLeft: false, notCountedBecause: "merged and live: counts as done" });
    expect(byTitle.get("Merged waiting go-live")).toMatchObject({ merged: true, countsTowardPointsLeft: true });
    // 3 + 2: the live one counts as done, the unsized one adds nothing; same rule as the Roadmap's forecast.
    expect(res.note).toContain('Milestone "Beta" (id');
    expect(res.note).toContain("5 points left in 2 sized open tickets; 1 open ticket has no size and adds nothing.");
    expect(res.note).toContain("pass state=done to list them");

    // state=done lists the finished ones, cancelled left out; the points-left line still covers the open set.
    const done = split(await call({ milestone: "Beta", state: "done" }));
    expect(done.rows.map((r) => r.title)).toEqual(["Finished"]);
    expect(done.rows[0]).toMatchObject({ countsTowardPointsLeft: false, notCountedBecause: "done" });
    expect(done.note).toContain("5 points left");

    expect(await call({ milestone: "Nope" })).toContain('No milestone called "Nope"');
    await client.close();
  });

  it("notInPointsLeft follows the forecast's rules", () => {
    const base = { mergeCommit: null, goLiveWait: null };
    expect(notInPointsLeft({ ...base, size: 3, state: "backlog" })).toBeNull();
    expect(notInPointsLeft({ ...base, size: null, state: "backlog" })).toBe("no size");
    expect(notInPointsLeft({ ...base, size: 0, state: "backlog" })).toBe("no size");
    expect(notInPointsLeft({ ...base, size: 3, state: "done" })).toBe("done");
    expect(notInPointsLeft({ size: 3, state: "blocked", mergeCommit: "x", goLiveWait: null })).toBe("merged and live: counts as done");
    expect(notInPointsLeft({ size: 3, state: "blocked", mergeCommit: "x", goLiveWait: "server update" })).toBeNull();
    expect(notInPointsLeft({ size: 3, state: "review", mergeCommit: "x", goLiveWait: null })).toBeNull();
  });
});
