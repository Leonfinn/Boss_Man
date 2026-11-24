// BOS-2511: set_ticket_state review refuses a screen change without a geometry render test and before/after screenshots,
// unless noVisualChange says why; the reason is kept in the state note for the reviewer.
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { WorkspaceDiff } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { ticketImages, tickets } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";

const BASE: WorkspaceDiff = { baseCommit: "a".repeat(40), head: "b".repeat(40), commits: [{ sha: "b".repeat(40), subject: "Lane age" }], files: [], diff: "", truncated: false };
const BOARD = "apps/web/src/pages/Board.tsx";
const TEST = "apps/web/test/lane-age-render.test.tsx";
const LAYOUT: WorkspaceDiff = { ...BASE, files: [{ path: BOARD, added: 1, removed: 0 }], diff: [`diff --git a/${BOARD} b/${BOARD}`, '+      <span className="mono state-age">{age}</span>'].join("\n") };
const WITH_TEST: WorkspaceDiff = { ...LAYOUT, files: [...LAYOUT.files, { path: TEST, added: 1, removed: 0 }], diff: `${LAYOUT.diff}\ndiff --git a/${TEST} b/${TEST}\n+const box = el.getBoundingClientRect();` };
const HANDLER: WorkspaceDiff = { ...BASE, files: [{ path: BOARD, added: 1, removed: 0 }], diff: [`diff --git a/${BOARD} b/${BOARD}`, "+  const onOpen = () => setOpen(true);"].join("\n") };

let ctx: Awaited<ReturnType<typeof setup>>;
const clients: Client[] = [];

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const base = `127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "POST" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const co = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } };
  const dev = (await req("POST", `/api/companies/${co.company.id}/agents`, { name: "Dev" })).json() as { id: string };
  const withRepo = (await req("POST", `/api/companies/${co.company.id}/projects`, { name: "Customer app" })).json() as { id: string };
  await req("PATCH", `/api/projects/${withRepo.id}`, { repoUrl: "https://github.com/example/customer-app.git" });
  const noRepo = (await req("POST", `/api/companies/${co.company.id}/projects`, { name: "Notes" })).json() as { id: string };
  const reg = (await req("POST", `/api/companies/${co.company.id}/runner`)).json() as { runnerId: string };
  const diff = { current: LAYOUT, failing: false };
  built.runners.connect(reg.runnerId, (c) => {
    if (c.type === "workspace.diff")
      queueMicrotask(() => built.runners.resolveReply(diff.failing ? { requestId: c.requestId, ok: false, error: "no workspace or branch" } : { requestId: c.requestId, ok: true, data: diff.current }));
    if (c.type === "workspace.migrations") queueMicrotask(() => built.runners.resolveReply({ requestId: c.requestId, ok: true, data: { needed: false, reason: "No other branch uses this ticket's migration numbers." } }));
    return true;
  });
  const ticket = async (projectId = withRepo.id) =>
    (await db.insert(tickets).values({ companyId: co.company.id, projectId, title: "Lane age on the board", systemState: "in_progress", assigneeAgentId: dev.id, branch: "bossman/x" }).returning())[0]!;
  const shot = (ticketId: string, caption: string, byAgent = true) =>
    db.insert(ticketImages).values({ companyId: co.company.id, ticketId, name: "shot.png", caption, type: "image/png", size: 4, bytes: Buffer.from("png!"), agentId: byAgent ? dev.id : null });
  return { ...built, db, close, base, co, dev, noRepo, diff, ticket, shot };
}

beforeEach(async () => {
  ctx = await setup();
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  await ctx.app.close();
  await ctx.close();
});

async function agent() {
  const token = await issueRunToken(ctx.db, { companyId: ctx.co.company.id, agentId: ctx.dev.id, runId: randomUUID() });
  const c = new Client({ name: "test", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://${ctx.base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  clients.push(c);
  return c;
}
const textOf = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? "");
const toReview = async (id: string, extra: Record<string, unknown> = {}) => textOf(await (await agent()).callTool({ name: "set_ticket_state", arguments: { ticketId: id, state: "review", summary: "Built it.", ...extra } }));
const stateOf = async (id: string) => (await ctx.db.select().from(tickets).where(eq(tickets.id, id)))[0]!;

describe("BOS-2511: a screen change at the move to review", () => {
  it("is refused with neither the render test nor the screenshots, naming both, the tools and the way out", async () => {
    const t = await ctx.ticket();
    const out = await toReview(t.id);
    expect(out).toContain("real-browser check before review");
    expect(out).toContain(BOARD);
    expect(out).toContain("render test");
    expect(out).toContain("scripts/screenshot.mjs");
    expect(out).toContain("noVisualChange");
    expect((await stateOf(t.id)).systemState).toBe("in_progress");
  });

  it("is refused with the test but only an owner's paste and one agent shot", async () => {
    const t = await ctx.ticket();
    ctx.diff.current = WITH_TEST;
    await ctx.shot(t.id, "Board before");
    await ctx.shot(t.id, "Board after", false);
    expect(await toReview(t.id)).toContain("Missing: before and after screenshots");
  });

  it("moves with a geometry render test and before/after screenshots", async () => {
    const t = await ctx.ticket();
    ctx.diff.current = WITH_TEST;
    await ctx.shot(t.id, "Board before, 1667 px");
    await ctx.shot(t.id, "Board after, 1667 px");
    await toReview(t.id);
    expect((await stateOf(t.id)).systemState).toBe("review");
  });

  it("moves with noVisualChange, keeping the reason in the state note", async () => {
    const t = await ctx.ticket();
    await toReview(t.id, { noVisualChange: "only the aria-label wording changed" });
    const row = await stateOf(t.id);
    expect(row.systemState).toBe("review");
    expect(row.stateNote).toContain("No visual change (author's reason): only the aria-label wording changed");
  });

  it("refuses a too-short noVisualChange and one given with another state", async () => {
    const t = await ctx.ticket();
    expect(await toReview(t.id, { noVisualChange: "n/a" })).toMatch(/at least 10/);
    const out = textOf(await (await agent()).callTool({ name: "set_ticket_state", arguments: { ticketId: t.id, state: "in_progress", noVisualChange: "only the handler changed" } }));
    expect(out).toContain("noVisualChange goes with state review");
  });

  it("leaves a handler-only page edit, a project without a repo and an unreadable diff alone", async () => {
    ctx.diff.current = HANDLER;
    const a = await ctx.ticket();
    await toReview(a.id);
    expect((await stateOf(a.id)).systemState).toBe("review");

    ctx.diff.current = LAYOUT;
    const b = await ctx.ticket(ctx.noRepo.id);
    await toReview(b.id);
    expect((await stateOf(b.id)).systemState).toBe("review");

    ctx.diff.failing = true;
    const c = await ctx.ticket();
    const out = await toReview(c.id);
    expect((await stateOf(c.id)).systemState).toBe("review");
    expect(out).toContain("screen-change check (BOS-2511) was skipped");
  });
});
