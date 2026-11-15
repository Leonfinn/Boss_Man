// The review-time migration warning (BOS-219) used to tell the agent to rename its migration when
// another *open* branch held the same number. Agents renumbered against unmerged work, which left
// gaps on main (DR-037, BOS-689). Now only a number already on the default branch warns.
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { RunnerCommand } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { projects, tickets } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";

let ctx: Awaited<ReturnType<typeof setup>>;
const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => undefined)));
  await ctx.app.close();
  await ctx.close();
});

/**
 * What the ticket's branch adds, as the runner would report it: "mine" clashes with "others", and
 * main either holds the number or not. The runner is not used; this answers the migrations request
 * directly, since the warning only passes the runner's answer through.
 */
async function setup(answer: "free" | "other-branch" | "main") {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const base = `127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company, ceo } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string }; ceo: { id: string } };
  const [p] = await db.insert(projects).values({ companyId: company.id, name: "Customer app", repoUrl: "https://example.com/app.git" }).returning();
  // This ticket and another open ticket both add 0113; the branch under test has one commit.
  const [mine] = await db.insert(tickets).values({ companyId: company.id, projectId: p!.id, title: "Add a column", branch: "bossman/ticket-under-test", assigneeAgentId: ceo.id }).returning();
  const [other] = await db.insert(tickets).values({ companyId: company.id, projectId: p!.id, title: "Another migration", branch: "bossman/other", assigneeAgentId: ceo.id }).returning();
  const sent: RunnerCommand[] = [];
  const migrationsRequests: RunnerCommand[] = [];
  const reg = (await req("POST", `/api/companies/${company.id}/runner`)).json() as { runnerId: string };
  built.runners.connect(reg.runnerId, (c) => {
    sent.push(c);
    if (c.type === "workspace.diff") queueMicrotask(() => built.runners.resolveReply({ requestId: c.requestId, ok: true, data: { baseCommit: "a".repeat(40), head: "b".repeat(40), commits: [{ sha: "b".repeat(40), subject: "Work" }], files: [{ path: "apps/server/drizzle/0113_x.sql", added: 1, removed: 0 }], diff: "", truncated: false } }));
    if (c.type === "workspace.migrations") {
      migrationsRequests.push(c);
      // Like the runner's checkMigrations: it compares the default branch always, and another
      // open branch only when it was named in `others`. So a clash with an open branch only comes
      // back if the caller asked about that branch.
      const namedOthers = c.others.length > 0;
      const data =
        answer === "other-branch" && namedOthers
          ? { needed: true, number: 113, next: 114, why: ["0113_x shares its number with 0113_other on another branch"], others: [] }
          : answer === "main"
            ? { needed: true, number: 113, next: 114, why: ["0113_x shares its number with 0113_main already on main"], others: [] }
            : { needed: false, reason: "No other branch uses this ticket's migration numbers." };
      queueMicrotask(() => built.runners.resolveReply({ requestId: c.requestId, ok: true, data }));
    }
    return true;
  });
  const token = await issueRunToken(db, { companyId: company.id, agentId: ceo.id, runId: randomUUID() });
  const client = new Client({ name: "t", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  clients.push(client);
  const move = async () => {
    const res = await client.callTool({ name: "set_ticket_state", arguments: { ticketId: mine!.id, state: "review", summary: "Ready for review." } });
    return ((res as { content: Array<{ text: string }> }).content[0]?.text ?? "");
  };
  return { ...built, db, close, company, mine: mine!, other: other!, sent, migrationsRequests, move };
}

describe("review-time migration warning (BOS-689)", () => {
  it("gives no rename advice when only another open branch holds the number", async () => {
    const c = (ctx = await setup("other-branch"));
    const text = await c.move();
    expect(text).toContain("is now review");
    expect(text).not.toMatch(/Rename it/);
    expect(text).not.toContain("0113");
    // The other open branch isn't even compared at review time any more, so a runner that
    // couldn't read it can never advise a rename against it.
    expect(c.migrationsRequests.at(-1)).toMatchObject({ type: "workspace.migrations", others: [] });
  });

  it("still warns when the number is already on the default branch", async () => {
    const c = (ctx = await setup("main"));
    const text = await c.move();
    expect(text).toContain("is now review");
    expect(text).toMatch(/gate renumbers it \(to 0114 or later\).*don't rename it by hand/);
    expect(text).not.toMatch(/Rename it/);
    expect(text).toContain("already taken on the default branch");
  });

  it("says nothing when the numbers are free", async () => {
    const c = (ctx = await setup("free"));
    const text = await c.move();
    expect(text).toContain("is now review");
    expect(text).not.toContain("migration number");
  });
});
