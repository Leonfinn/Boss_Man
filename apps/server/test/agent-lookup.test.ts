import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { RunnerCommand, RunnerEvent } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { projects, runners } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.app.close();
  await ctx?.close();
  ctx = undefined;
});

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, workspaceRoot: "/ws" });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const base = `127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } };
  const worker = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Engineer" })).json() as { id: string };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Site" })).json() as { id: string };
  const reg = (await req("POST", `/api/companies/${company.id}/runner`)).json() as { runnerId: string };
  const [runnerRow] = await db.select().from(runners).where(eq(runners.id, reg.runnerId));
  const sent: RunnerCommand[] = [];
  built.runners.connect(reg.runnerId, (c) => {
    sent.push(c);
    // Stands in for the runner reading a file from a ticket's branch.
    if (c.type === "workspace.file")
      queueMicrotask(() =>
        built.runners.resolveReply(c.path === "docs/04-research.md" ? { requestId: c.requestId, ok: true, data: { text: "# Findings\n25 products.", truncated: false, from: "branch" } } : { requestId: c.requestId, ok: false, error: `There's no ${c.path} on that ticket's branch.` }),
      );
    return true;
  });
  let seq = 0;
  const emit = (event: RunnerEvent) => built.runners.ingest(runnerRow!, { seq: ++seq, at: new Date().toISOString(), event });
  const starts = () => sent.filter((c): c is Extract<RunnerCommand, { type: "run.start" }> => c.type === "run.start");
  const mcp = async (runId: string) => {
    const token = await issueRunToken(db, { companyId: company.id, agentId: worker.id, runId });
    const c = new Client({ name: "t", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    return c;
  };
  return { ...built, db, close, req, company, worker, project, sent, emit, starts, mcp };
}

const textOf = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? "");

describe("agents look tickets up (R77)", () => {
  it("finds and reads any ticket in the company, with its outputs and files from its branch", async () => {
    const c = (ctx = await setup());
    await c.db.update(projects).set({ repoUrl: "git@example.com:acme/app.git" });
    const research = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "Research orchestration apps", body: "Write docs/04-research.md" })).json() as { id: string };
    await c.wiki.attach(c.company.id, { ticketId: research.id, title: "Research", path: "docs/04-research.md", ref: "c996308", agentId: c.worker.id, runId: null });
    await c.req("POST", `/api/tickets/${research.id}/messages`, { text: "Please also cover licences." });
    await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "Tidy the wiki", assigneeAgentId: c.worker.id });
    await c.scheduler.tick();
    const client = await c.mcp(c.starts()[0]!.runId);

    const found = JSON.parse(textOf(await client.callTool({ name: "tickets", arguments: { action: "find", q: "orchestration" } })));
    expect(found).toEqual([expect.objectContaining({ id: research.id, title: "Research orchestration apps", state: "backlog" })]);
    const read = textOf(await client.callTool({ name: "tickets", arguments: { action: "read", ticketId: research.id } }));
    expect(read).toContain("# Research orchestration apps");
    expect(read).toContain("Write docs/04-research.md");
    expect(read).toContain("- repo file docs/04-research.md at c996308 (read it with tickets file)");
    expect(read).toContain("Owner: Please also cover licences.");
    expect(textOf(await client.callTool({ name: "tickets", arguments: { action: "file", ticketId: research.id, path: "docs/04-research.md" } }))).toBe("docs/04-research.md (from the ticket's branch):\n\n# Findings\n25 products.");
    expect(c.sent.find((x) => x.type === "workspace.file")).toMatchObject({ projectId: c.project.id, ticketId: research.id, path: "docs/04-research.md" });
    expect(await client.callTool({ name: "tickets", arguments: { action: "file", ticketId: research.id, path: "nope.md" } })).toMatchObject({ isError: true });
    await client.close();
  });

  it("gives chat runs the wiki, tickets and skills tools", async () => {
    const c = (ctx = await setup());
    await c.req("POST", `/api/companies/${c.company.id}/chat`, { text: "What's in the wiki?", agentId: c.worker.id });
    await c.scheduler.tick();
    const chatRun = c.starts().find((s) => s.boardToolsOnly)!;
    const client = await c.mcp(chatRun.runId);
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(expect.arrayContaining(["board", "create_ticket", "skills", "tickets", "wiki"]));
    expect(chatRun.prompt).toContain("wiki (read, write and file the company's pages)");
    expect(chatRun.prompt).toContain("Use your tools before saying you can't see something");
    await client.close();
  });
});
