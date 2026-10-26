import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { RunnerCommand, RunnerEvent } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { projects, runners, tickets } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";

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
  const req = (method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } };
  const worker = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Engineer" })).json() as { id: string };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Site" })).json() as { id: string };
  const reg = (await req("POST", `/api/companies/${company.id}/runner`)).json() as { runnerId: string };
  const [runnerRow] = await db.select().from(runners).where(eq(runners.id, reg.runnerId));
  const sent: RunnerCommand[] = [];
  built.runners.connect(reg.runnerId, (c) => {
    sent.push(c);
    // Stands in for the runner reading a screenshot from the ticket's working folder.
    if (c.type === "workspace.image")
      queueMicrotask(() =>
        built.runners.resolveReply(c.path in IMAGES ? { requestId: c.requestId, ok: true, data: { base64: IMAGES[c.path]!.toString("base64"), size: IMAGES[c.path]!.length } } : { requestId: c.requestId, ok: false, error: `There's no ${c.path} in this ticket's working folder.` }),
      );
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

// A real PNG's first bytes, and a file that only claims to be an image.
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("rest of the picture")]);
const IMAGES: Record<string, Buffer> = { "shots/step-2.png": PNG, "shots/fake.png": Buffer.from("<svg onload=alert(1)>") };

const textOf = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? "");

describe("ticket images", () => {
  it("attaches a screenshot from the ticket's working folder by reference, refuses a non-image, and serves it to the owner", async () => {
    const c = (ctx = await setup());
    const t = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "Test the calculator", assigneeAgentId: c.worker.id })).json() as { id: string };
    await c.scheduler.tick();
    const client = await c.mcp(c.starts()[0]!.runId);
    expect(textOf(await client.callTool({ name: "attach_image", arguments: { ticketId: "APP-1", path: "shots/step-2.png", caption: "Leap year shows 28.1 days" } }))).toMatch(/^Attached shots\/step-2\.png to the ticket\. To show it in a wiki page, write: !\[Leap year shows 28\.1 days\]\(\/api\/ticket-images\/[0-9a-f-]{36}\)$/);
    expect(textOf(await client.callTool({ name: "attach_image", arguments: { ticketId: t.id, path: "shots/fake.png" } }))).toBe("shots/fake.png isn't a PNG, JPEG or WebP image.");
    expect(textOf(await client.callTool({ name: "attach_image", arguments: { ticketId: t.id, path: "shots/missing.png" } }))).toContain("There's no shots/missing.png");
    expect(textOf(await client.callTool({ name: "attach_image", arguments: { ticketId: "APP-9", path: "shots/step-2.png" } }))).toBe("No ticket APP-9 in your company.");
    // tickets read lists the image with the Markdown a wiki page uses.
    expect(textOf(await client.callTool({ name: "tickets", arguments: { action: "read", ticketId: t.id } }))).toMatch(/## Images[^\n]*\n- !\[Leap year shows 28\.1 days\]\(\/api\/ticket-images\/[0-9a-f-]{36}\)/);
    await client.close();

    const list = (await c.req("GET", `/api/tickets/${t.id}/images`)).json() as Array<{ id: string; name: string; caption: string; size: number }>;
    expect(list).toEqual([expect.objectContaining({ name: "step-2.png", caption: "Leap year shows 28.1 days", size: PNG.length })]);
    const img = await c.req("GET", `/api/ticket-images/${list[0]!.id}`);
    expect(img.headers["content-type"]).toBe("image/png");
    expect(img.headers["x-content-type-options"]).toBe("nosniff");
    expect(img.rawPayload.equals(PNG)).toBe(true);
  });
});

describe("archived projects", () => {
  it("archives a project with no open tasks: hidden from menus and agents, no new tasks, history kept, and it can come back", async () => {
    const c = (ctx = await setup());
    const old = (await c.req("POST", `/api/companies/${c.company.id}/projects`, { name: "LLM Wiki" })).json() as { id: string };
    const t = (await c.req("POST", `/api/projects/${old.id}/tickets`, { title: "Old setup" })).json() as { id: string };
    expect((await c.req("PATCH", `/api/projects/${old.id}`, { archived: true })).json()).toMatchObject({ message: "This project has 1 open task. Finish or cancel it before archiving." });
    await c.db.update(tickets).set({ systemState: "done" }).where(eq(tickets.id, t.id));
    expect((await c.req("PATCH", `/api/projects/${old.id}`, { archived: true })).json()).toMatchObject({ archivedAt: expect.any(String), starred: false });

    const listed = (await c.req("GET", "/api/companies")).json() as Array<{ projects: Array<{ name: string }> }>;
    expect(listed[0]!.projects.map((p) => p.name)).toEqual(["Site"]);
    expect((await c.req("POST", `/api/projects/${old.id}/tickets`, { title: "More" })).statusCode).toBe(409);
    expect((await c.req("GET", `/api/tickets/${t.id}`)).json()).toMatchObject({ title: "Old setup" });

    await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "Work", assigneeAgentId: c.worker.id });
    await c.scheduler.tick();
    const client = await c.mcp(c.starts()[0]!.runId);
    expect(textOf(await client.callTool({ name: "create_ticket", arguments: { title: "Sneak in", project: "LLM Wiki" } }))).toContain("Name the project: one of Site.");
    await client.close();

    expect((await c.req("PATCH", `/api/projects/${old.id}`, { archived: false })).json()).toMatchObject({ archivedAt: null });
    expect((await c.req("POST", `/api/projects/${old.id}/tickets`, { title: "More" })).statusCode).toBe(201);
  });
});

describe("agents look tickets up (R77)", () => {
  it("numbers tickets per company as PREFIX-n, and finds and reads one by its reference", async () => {
    const c = (ctx = await setup());
    const first = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "First" })).json() as { id: string };
    const other = (await c.req("POST", `/api/companies/${c.company.id}/projects`, { name: "Docs" })).json() as { id: string };
    const second = (await c.req("POST", `/api/projects/${other.id}/tickets`, { title: "Second", assigneeAgentId: c.worker.id })).json() as { id: string };
    // One sequence across the company's projects; the prefix comes from the company's name.
    expect((await c.req("GET", `/api/tickets/${first.id}`)).json()).toMatchObject({ number: 1, ref: "APP-1" });
    expect((await c.req("GET", `/api/tickets/${second.id}`)).json()).toMatchObject({ number: 2, ref: "APP-2" });
    await c.scheduler.tick();
    expect(c.starts()[0]!.prompt).toContain(`Ticket APP-2 (id ${second.id})`);

    const client = await c.mcp(c.starts()[0]!.runId);
    expect(JSON.parse(textOf(await client.callTool({ name: "tickets", arguments: { action: "find", q: "app-1" } })))).toEqual([expect.objectContaining({ id: first.id, ref: "APP-1" })]);
    expect(textOf(await client.callTool({ name: "tickets", arguments: { action: "read", ticketId: "APP-2" } }))).toContain(`Ticket APP-2 (id ${second.id})`);
    expect(textOf(await client.callTool({ name: "tickets", arguments: { action: "read", ticketId: "APP-9" } }))).toContain("No ticket APP-9 in your company.");
    await client.close();

    // The owner can change the prefix; the numbers stay.
    expect((await c.req("PATCH", `/api/companies/${c.company.id}`, { ticketPrefix: "x y" })).statusCode).toBe(400);
    expect((await c.req("PATCH", `/api/companies/${c.company.id}`, { ticketPrefix: "web" })).json()).toMatchObject({ ticketPrefix: "WEB" });
    expect((await c.req("GET", `/api/tickets/${first.id}`)).json()).toMatchObject({ ref: "WEB-1" });
  });

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
