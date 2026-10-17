import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { RunnerCommand, RunnerEvent } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { notifications, runners } from "../src/db/schema.js";
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
  built.runners.connect(reg.runnerId, (c) => (sent.push(c), true));
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

describe("wiki and ticket outputs (R69)", () => {
  it("lets an agent write a page for a ticket, keeps revisions, and shows it on the ticket", async () => {
    const c = (ctx = await setup());
    const t = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "Research the landscape", assigneeAgentId: c.worker.id })).json() as { id: string };
    await c.scheduler.tick();
    const runId = c.starts()[0]!.runId;
    expect(c.starts()[0]!.prompt).toContain("wiki write");
    const client = await c.mcp(runId);
    const wrote = textOf(await client.callTool({ name: "wiki", arguments: { action: "write", folder: "Research", title: "2026 Agent Landscape!", body: "| App | Licence |\n|---|---|\n| Paperclip | MIT |", ticketId: t.id } }));
    expect(wrote).toContain(`Created #/wiki/${c.company.id}/research/2026-agent-landscape`);
    await client.callTool({ name: "wiki", arguments: { action: "write", slug: "research/2026-agent-landscape", title: "2026 Agent Landscape!", body: "Updated.", ticketId: t.id } });
    await client.callTool({ name: "wiki", arguments: { action: "attach", ticketId: t.id, title: "Source notes", path: "docs/04-research.md", ref: "c996308" } });
    expect(await client.callTool({ name: "wiki", arguments: { action: "attach", ticketId: t.id, url: "javascript:alert(1)" } })).toMatchObject({ isError: true });
    expect(textOf(await client.callTool({ name: "wiki", arguments: { action: "read", slug: "research/2026-agent-landscape" } }))).toBe("# 2026 Agent Landscape!\n\nUpdated.");
    // The notification opens the page itself.
    await client.callTool({ name: "notify_owner", arguments: { level: "note", title: "Research ready", ticketId: t.id, link: `#/wiki/${c.company.id}/research/2026-agent-landscape` } });
    expect(await client.callTool({ name: "notify_owner", arguments: { level: "note", title: "x", link: "https://evil.example" } })).toMatchObject({ isError: true });
    await client.close();
    const [note] = await c.db.select().from(notifications);
    expect(note!.link).toBe(`#/wiki/${c.company.id}/research/2026-agent-landscape`);

    const page = (await c.req("GET", `/api/companies/${c.company.id}/wiki/research/2026-agent-landscape`)).json();
    expect(page).toMatchObject({ title: "2026 Agent Landscape!", body: "Updated.", updatedBy: "Engineer", tickets: [{ id: t.id }] });
    expect(page.revisions).toHaveLength(2);
    const first = (await c.req("GET", `/api/companies/${c.company.id}/wiki-revisions/${page.revisions[1].id}`)).json();
    expect(first.body).toContain("| Paperclip | MIT |");

    const made = (await c.req("GET", `/api/tickets/${t.id}/artifacts`)).json();
    expect(made).toEqual([
      expect.objectContaining({ kind: "wiki_page", slug: "research/2026-agent-landscape", agent: "Engineer" }),
      expect.objectContaining({ kind: "repo_file", path: "docs/04-research.md", ref: "c996308" }),
    ]);
  });

  it("lets the owner create, search, edit and delete pages", async () => {
    const c = (ctx = await setup());
    const base = `/api/companies/${c.company.id}/wiki`;
    expect((await c.req("POST", base, { title: "How we deploy", body: "Push to main, then wait." })).statusCode).toBe(201);
    expect((await c.req("POST", base, { title: "How we deploy", body: "again" })).statusCode).toBe(409);
    await c.req("POST", base, { title: "Brand", body: "Blue 100%" });
    expect((await c.req("GET", `${base}?q=wait`)).json().map((p: { slug: string }) => p.slug)).toEqual(["how-we-deploy"]);
    expect((await c.req("GET", `${base}?q=100%25`)).json().map((p: { slug: string }) => p.slug)).toEqual(["brand"]);
    const edited = (await c.req("PUT", `${base}/how-we-deploy`, { title: "How we deploy", body: "Merge, then staging." })).json();
    expect(edited).toMatchObject({ body: "Merge, then staging.", updatedByAgentId: null });
    expect((await c.req("DELETE", `${base}/how-we-deploy`)).statusCode).toBe(204);
    expect((await c.req("GET", `${base}/how-we-deploy`)).statusCode).toBe(404);
  });
  it("files pages in nested folders, and moves them", async () => {
    const c = (ctx = await setup());
    const base = `/api/companies/${c.company.id}/wiki`;
    const made = await c.req("POST", base, { title: "Paperclip", body: "MIT.", folder: " Research / Competitors/ " });
    expect(made.statusCode).toBe(201);
    expect(made.json()).toMatchObject({ slug: "research/competitors/paperclip", folder: "Research/Competitors" });
    expect((await c.req("POST", base, { title: "Paperclip", body: "again", folder: "Research/Competitors" })).statusCode).toBe(409);
    // The same title in another folder is a different page.
    expect((await c.req("POST", base, { title: "Paperclip", body: "Notes.", folder: "Ideas" })).json().slug).toBe("ideas/paperclip");
    expect((await c.req("GET", `${base}/research/competitors/paperclip`)).json()).toMatchObject({ title: "Paperclip", body: "MIT." });

    const moved = await c.req("PUT", `${base}/research/competitors/paperclip`, { title: "Paperclip", body: "MIT.", folder: "Research/Done" });
    expect(moved.json()).toMatchObject({ slug: "research/done/paperclip", folder: "Research/Done" });
    expect((await c.req("GET", `${base}/research/competitors/paperclip`)).statusCode).toBe(404);
    // Moving onto a page that's already there is refused.
    expect((await c.req("PUT", `${base}/ideas/paperclip`, { title: "Paperclip", body: "Notes.", folder: "Research/Done" })).statusCode).toBe(409);
    expect((await c.req("POST", base, { title: "Deep", body: "", folder: "a/b/c/d/e/f/g" })).statusCode).toBe(400);
    expect((await c.req("GET", base)).json().map((p: { folder: string }) => p.folder).sort()).toEqual(["Ideas", "Research/Done"]);
  });
});
