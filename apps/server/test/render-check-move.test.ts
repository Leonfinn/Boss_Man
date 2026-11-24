// BOS-2511 (DR-075): set_ticket_state review refuses a screen change without a real-browser render test and seeded
// before/after screenshots, unless noVisualChange says why; the reason is kept in the state note for the reviewer.
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { WorkspaceDiff } from "@boss-man/shared";
import { addPngText, SCREENSHOT_MARKER_KEY, SCREENSHOT_MARKER_SEEDED } from "../../../scripts/png-marker.mjs";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { ticketImages, tickets } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";

const BASE: WorkspaceDiff = { baseCommit: "a".repeat(40), head: "b".repeat(40), commits: [{ sha: "b".repeat(40), subject: "Lane age" }], files: [], diff: "", truncated: false };
const BOARD = "apps/web/src/pages/Board.tsx";
const TEST = "apps/web/test/lane-age-render.test.tsx";
const LAYOUT: WorkspaceDiff = { ...BASE, files: [{ path: BOARD, added: 1, removed: 0 }], diff: [`diff --git a/${BOARD} b/${BOARD}`, '+      <span className="mono state-age">{age}</span>'].join("\n") };
const WITH_TEST: WorkspaceDiff = { ...LAYOUT, files: [...LAYOUT.files, { path: TEST, added: 1, removed: 0 }], diff: `${LAYOUT.diff}\ndiff --git a/${TEST} b/${TEST}\n+  it("one line tall", () => {});` };
const HANDLER: WorkspaceDiff = { ...BASE, files: [{ path: BOARD, added: 1, removed: 0 }], diff: [`diff --git a/${BOARD} b/${BOARD}`, "+  const onOpen = () => setOpen(true);"].join("\n") };
// The test's whole file at the head: the BOS-1078 template counts; a jsdom test with a geometry call doesn't.
const BROWSER_TEST = readFileSync(new URL("../../web/test/merge-queue-held-render.test.tsx", import.meta.url), "utf8");
const JSDOM_TEST = 'import "../src/styles.css";\nit("fits", () => { expect(el.getBoundingClientRect().height).toBe(0); });';
// A 1x1 PNG; the marked copy is what scripts/screenshot.mjs --api writes.
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c626001000000ffff03000006000557bfabd40000000049454e44ae426082", "hex");
const SEEDED = addPngText(PNG, SCREENSHOT_MARKER_KEY, SCREENSHOT_MARKER_SEEDED);

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
  const runner = { diff: LAYOUT, diffFails: false, testText: BROWSER_TEST as string | null };
  built.runners.connect(reg.runnerId, (c) => {
    if (c.type === "workspace.diff")
      queueMicrotask(() => built.runners.resolveReply(runner.diffFails ? { requestId: c.requestId, ok: false, error: "no workspace or branch" } : { requestId: c.requestId, ok: true, data: runner.diff }));
    if (c.type === "workspace.file")
      queueMicrotask(() => built.runners.resolveReply(runner.testText === null ? { requestId: c.requestId, ok: false, error: "no such file" } : { requestId: c.requestId, ok: true, data: { text: runner.testText, truncated: false, from: "branch" } }));
    if (c.type === "workspace.migrations") queueMicrotask(() => built.runners.resolveReply({ requestId: c.requestId, ok: true, data: { needed: false, reason: "No other branch uses this ticket's migration numbers." } }));
    return true;
  });
  const ticket = async (projectId = withRepo.id) =>
    (await db.insert(tickets).values({ companyId: co.company.id, projectId, title: "Lane age on the board", systemState: "in_progress", assigneeAgentId: dev.id, branch: "bossman/x" }).returning())[0]!;
  const shot = (ticketId: string, caption: string, o: { bytes?: Buffer; byAgent?: boolean; createdAt?: Date } = {}) => {
    const bytes = o.bytes ?? SEEDED;
    return db.insert(ticketImages).values({ companyId: co.company.id, ticketId, name: "shot.png", caption, type: "image/png", size: bytes.length, bytes, agentId: o.byAgent === false ? null : dev.id, ...(o.createdAt ? { createdAt: o.createdAt } : {}) });
  };
  return { ...built, db, close, base, co, dev, noRepo, runner, ticket, shot };
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
    for (const s of ["real-browser check before review", BOARD, "render test", "scripts/screenshot.mjs", "docs/28-browser-checks.md", "merge-queue-held-render.test.tsx", "noVisualChange"]) expect(out).toContain(s);
    expect((await stateOf(t.id)).systemState).toBe("in_progress");
  });

  it("moves with a real-browser render test and seeded before/after screenshots", async () => {
    const t = await ctx.ticket();
    ctx.runner.diff = WITH_TEST;
    await ctx.shot(t.id, "Board before, 1667 px");
    await ctx.shot(t.id, "Board after, 1667 px");
    await toReview(t.id);
    expect((await stateOf(t.id)).systemState).toBe("review");
  });

  it("refuses a jsdom test (whole file read at the head), and a test file the runner can't read", async () => {
    const t = await ctx.ticket();
    ctx.runner.diff = WITH_TEST;
    await ctx.shot(t.id, "Board before");
    await ctx.shot(t.id, "Board after");
    ctx.runner.testText = JSDOM_TEST;
    expect(await toReview(t.id)).toContain(`${TEST} doesn't`);
    ctx.runner.testText = null;
    expect(await toReview(t.id)).toContain(`couldn't read ${TEST}`);
    expect((await stateOf(t.id)).systemState).toBe("in_progress");
  });

  it("refuses shots without the screenshot.mjs mark (a mock-up), the owner's paste, or from before the ticket started", async () => {
    const t = await ctx.ticket();
    ctx.runner.diff = WITH_TEST;
    await ctx.shot(t.id, "Board before");
    await ctx.shot(t.id, "Board after", { bytes: PNG });
    expect(await toReview(t.id)).toContain("1 picture attached don't count");
    await ctx.shot(t.id, "Board after", { byAgent: false });
    await ctx.shot(t.id, "Board after", { createdAt: new Date(Date.now() - 24 * 3600_000) });
    expect(await toReview(t.id)).toContain('Missing: "before" and "after" screenshots');
    expect((await stateOf(t.id)).systemState).toBe("in_progress");
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
    ctx.runner.diff = HANDLER;
    const a = await ctx.ticket();
    await toReview(a.id);
    expect((await stateOf(a.id)).systemState).toBe("review");

    ctx.runner.diff = LAYOUT;
    const b = await ctx.ticket(ctx.noRepo.id);
    await toReview(b.id);
    expect((await stateOf(b.id)).systemState).toBe("review");

    ctx.runner.diffFails = true;
    const c = await ctx.ticket();
    const out = await toReview(c.id);
    expect((await stateOf(c.id)).systemState).toBe("review");
    expect(out).toContain("screen-change check (BOS-2511) was skipped");
  });
});
