// BOS-1516: a company with no update card and no deploy target is paged once, by a note, when its Priority 1 work merges.
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WorkspaceDiff } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { notifications, tickets } from "../src/db/schema.js";
import { approveAndWait } from "./helpers.js";

const REAL: WorkspaceDiff = { baseCommit: "a".repeat(40), head: "b".repeat(40), commits: [{ sha: "b".repeat(40), subject: "Add limiter" }], files: [{ path: "src/a.ts", added: 1, removed: 0 }], diff: "diff --git a/src/a.ts b/src/a.ts", truncated: false };

let ctx: Awaited<ReturnType<typeof setup>>;

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const co = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } };
  const dev = (await req("POST", `/api/companies/${co.company.id}/agents`, { name: "Dev" })).json() as { id: string };
  const project = (await req("POST", `/api/companies/${co.company.id}/projects`, { name: "Customer app" })).json() as { id: string };
  await req("PATCH", `/api/projects/${project.id}`, { repoUrl: "https://github.com/Leonfinn/customer-app.git" });
  const reg = (await req("POST", `/api/companies/${co.company.id}/runner`)).json() as { runnerId: string };
  built.runners.connect(reg.runnerId, (c) => {
    if (c.type === "workspace.diff") queueMicrotask(() => built.runners.resolveReply({ requestId: c.requestId, ok: true, data: REAL }));
    if (c.type === "workspace.merge") queueMicrotask(() => built.runners.resolveReply({ requestId: c.requestId, ok: true, data: { status: "merged", commit: "c".repeat(40) } }));
    if (c.type === "workspace.migrations") queueMicrotask(() => built.runners.resolveReply({ requestId: c.requestId, ok: true, data: { needed: false, reason: "No other branch uses this ticket's migration numbers." } }));
    return true;
  });
  const ticket = async (patch: Partial<typeof tickets.$inferInsert> = {}) =>
    (await db.insert(tickets).values({ companyId: co.company.id, projectId: project.id, title: "Add rate limiting", systemState: "review", assigneeAgentId: dev.id, branch: "bossman/x", ...patch }).returning())[0]!;
  return { ...built, db, close, req, ticket };
}

beforeEach(async () => {
  ctx = await setup();
});
afterEach(async () => {
  await ctx.app.close();
  await ctx.close();
});

const pages = async () => (await ctx.db.select().from(notifications)).filter((n) => n.title.startsWith("Priority 1 work merged"));

describe("Priority 1 work merging in a company with no card", () => {
  it("pages once with the next step when the owner's Priority 1 ticket merges", async () => {
    const t = await ctx.ticket({ urgent: true, urgentByOwner: true, ownerSetup: "Open Settings and tick the new box.\nThen restart." });
    expect((await approveAndWait(ctx.req, t.id)).json()).toMatchObject({ outcome: "merged" });
    const sent = await pages();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ level: "page" });
    expect(sent[0]!.title).toContain("Add rate limiting");
    expect(sent[0]!.body).toContain("Open Settings and tick the new box.");
    expect(sent[0]!.body).not.toContain("Then restart.");
  });

  it("says nothing more is needed when the ticket names no next step", async () => {
    const t = await ctx.ticket({ urgent: true, urgentByOwner: true });
    await approveAndWait(ctx.req, t.id);
    const sent = await pages();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toContain("Nothing more is needed");
  });

  it("does not page for an urgent mark the owner did not set, or for an ordinary ticket", async () => {
    const ceoUrgent = await ctx.ticket({ urgent: true });
    const plain = await ctx.ticket({ title: "Tidy up" });
    await approveAndWait(ctx.req, ceoUrgent.id);
    await approveAndWait(ctx.req, plain.id);
    expect(await pages()).toHaveLength(0);
  });
});
