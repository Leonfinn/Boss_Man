import { afterAll, describe, expect, it } from "vitest";
import type { WorkspaceDiff } from "@boss-man/shared";
import { openPglite } from "../src/db/client.js";
import { agents, checkJobs, companies, projects, runners, settings, tickets } from "../src/db/schema.js";
import { CHECK_QUEUE_MODE_KEY } from "../src/services/check-queue.js";
import { checkRequestService, CheckRequestError } from "../src/services/check-request.js";

const shared = openPglite();
afterAll(async () => (await shared).close());

const diff = (over: Partial<WorkspaceDiff> = {}): WorkspaceDiff => ({ baseCommit: "b", head: "headcommit1", tree: "tree1", commits: [{ sha: "headcommit1", subject: "x" }], files: [], diff: "", truncated: false, ...over });

async function setup(d: WorkspaceDiff = diff(), mode: "server" | "legacy" = "server") {
  const { db } = await shared;
  await db.delete(checkJobs);
  await db.delete(settings);
  if (mode === "server") await db.insert(settings).values({ key: CHECK_QUEUE_MODE_KEY, value: "server" });
  const [co] = await db.insert(companies).values({ name: `Co ${Math.random()}` }).returning();
  const [p] = await db.insert(projects).values({ companyId: co!.id, name: "Dev" }).returning();
  await db.insert(runners).values({ companyId: co!.id, name: "r", tokenHash: `h${Math.random()}` } as never);
  const [a] = await db.insert(agents).values({ companyId: co!.id, name: "A", role: "worker", agentKind: "claude" } as never).returning();
  const [t] = await db.insert(tickets).values({ companyId: co!.id, projectId: p!.id, title: "T", number: 1, assigneeAgentId: a!.id, systemState: "in_progress" } as never).returning();
  const svc = checkRequestService(db, { diff: async () => d });
  return { svc, db, co: co!.id, agent: a!.id, ticket: t!.id };
}

describe("request_check", () => {
  it("queues a quick pre-review job on the committed head and tree, and says its place", async () => {
    const s = await setup();
    const msg = await s.svc.request({ companyId: s.co, agentId: s.agent, ticketId: s.ticket });
    expect(msg).toMatch(/quick check of commit headcomm is queued/);
    expect(msg).toMatch(/number 1 in line/);
    const [job] = await s.db.select().from(checkJobs);
    expect(job).toMatchObject({ kind: "pre_review", scope: "quick", commit: "headcommit1", tree: "tree1", requestedBy: s.agent, state: "queued" });
  });
  it("asking twice for the same code queues one job", async () => {
    const s = await setup();
    await s.svc.request({ companyId: s.co, agentId: s.agent, ticketId: s.ticket });
    await s.svc.request({ companyId: s.co, agentId: s.agent, ticketId: s.ticket });
    expect(await s.db.select().from(checkJobs)).toHaveLength(1);
  });
  it("refuses while the queue is off, for another agent, and with nothing committed", async () => {
    const off = await setup(diff(), "legacy");
    await expect(off.svc.request({ companyId: off.co, agentId: off.agent, ticketId: off.ticket })).rejects.toThrow(/not switched on/);
    const s = await setup();
    await expect(s.svc.request({ companyId: s.co, agentId: "00000000-0000-4000-8000-000000000000", ticketId: s.ticket })).rejects.toBeInstanceOf(CheckRequestError);
    const dirty = await setup(diff({ commits: [], files: [{ path: "a", added: 1, removed: 0 }] }));
    await expect(dirty.svc.request({ companyId: dirty.co, agentId: dirty.agent, ticketId: dirty.ticket })).rejects.toThrow(/commit your work first/);
  });
});
