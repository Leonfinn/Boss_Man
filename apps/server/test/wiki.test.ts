import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { RunnerCommand, RunnerEvent } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { agents, notifications, runners, tickets, wakes } from "../src/db/schema.js";
import { and, eq as eqq } from "drizzle-orm";
import { issueRunToken } from "../src/mcp.js";

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.app.close();
  await ctx?.close();
  ctx = undefined;
});

async function setup(wikiBatchMs = 0) {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0, wikiBatchMs }, workspaceRoot: "/ws" });
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
    const read = textOf(await client.callTool({ name: "wiki", arguments: { action: "read", slug: "research/2026-agent-landscape" } }));
    expect(read).toContain("# 2026 Agent Landscape!\n\nUpdated.");
    // read, like write, gives the exact app link so an agent pastes it rather than guessing (BOS-356).
    expect(read).toContain(`Link: #/wiki/${c.company.id}/research/2026-agent-landscape`);
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
    // A sub-task shows its parent's pages too, naming where they came from, so the owner needn't look for them.
    const kid = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "Part 2" })).json() as { id: string };
    await c.db.update(tickets).set({ parentTicketId: t.id }).where(eq(tickets.id, kid.id));
    expect((await c.req("GET", `/api/tickets/${kid.id}/artifacts`)).json()).toEqual([
      expect.objectContaining({ kind: "wiki_page", slug: "research/2026-agent-landscape", ticketId: t.id }),
      expect.objectContaining({ kind: "repo_file", ticketId: t.id }),
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
  it("holds the wiki maintainer's upkeep wake so a busy spell of finished tickets starts one run", async () => {
    const c = (ctx = await setup(15 * 60_000));
    const [keeper] = await c.db.select().from(agents).where(and(eqq(agents.companyId, c.company.id), eqq(agents.duty, "wiki")));
    for (const title of ["One", "Two", "Three"]) {
      const t = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title })).json() as { id: string };
      await c.req("PATCH", `/api/tickets/${t.id}`, { state: "done" });
    }
    const upkeep = await c.db.select().from(wakes).where(and(eqq(wakes.agentId, keeper!.id), eqq(wakes.reason, "wiki upkeep")));
    expect(upkeep).toHaveLength(1);
    expect(upkeep[0]).toMatchObject({ status: "deferred" });
    expect(upkeep[0]!.notBefore!.getTime() - Date.now()).toBeGreaterThan(14 * 60_000);
  });

  it("has a wiki maintainer that starts paused, needs a model, and files finished work (R73)", async () => {
    const c = (ctx = await setup());
    const [keeper] = await c.db.select().from(agents).where(and(eqq(agents.companyId, c.company.id), eqq(agents.duty, "wiki")));
    expect(keeper).toMatchObject({ name: "Wiki Maintainer", paused: true, model: null });
    const t = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "Research the landscape" })).json() as { id: string };
    await c.wiki.write(c.company.id, { folder: "Research", title: "Landscape", body: "25 products. See [[research/pricing]].", ticketId: t.id, agentId: c.worker.id, runId: null });
    await c.wiki.write(c.company.id, { title: "Index", body: "- [[research/landscape]]", agentId: c.worker.id, runId: null });
    await c.wiki.write(c.company.id, { title: "Old notes", body: "Nobody links here.", agentId: c.worker.id, runId: null });
    await c.wiki.write(c.company.id, { title: "Log", body: "- 2026-10-24: nothing to do", agentId: c.worker.id, runId: null });
    await c.wiki.write(c.company.id, { title: "Pricing notes", body: "Terms are in [[glossary]].", agentId: c.worker.id, runId: null });
    await c.wiki.write(c.company.id, { title: "Licence notes", body: "See [[glossary]] and [[pricing-notes]].", agentId: c.worker.id, runId: null });
    const t2 = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "Pick a licence" })).json() as { id: string };
    await c.req("PATCH", `/api/tickets/${t.id}`, { state: "done" });
    await c.req("PATCH", `/api/tickets/${t2.id}`, { state: "done" });
    // One waiting run covers both tickets; while paused it waits.
    const upkeep = () => c.db.select().from(wakes).where(and(eqq(wakes.agentId, keeper!.id), eqq(wakes.reason, "wiki upkeep")));
    expect(await upkeep()).toHaveLength(1);
    await c.scheduler.tick();
    expect(c.starts()).toEqual([]);
    expect((await upkeep())[0]).toMatchObject({ status: "queued", statusReason: "agent paused" });

    const refused = await c.req("PATCH", `/api/agents/${keeper!.id}`, { paused: false });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().message).toBe("Choose a model for Wiki Maintainer before starting it.");
    expect((await c.req("PATCH", `/api/agents/${keeper!.id}`, { paused: false, model: "claude-sonnet-5-5" })).json()).toMatchObject({ paused: false, model: "claude-sonnet-5-5" });
    await c.scheduler.tick();
    const start = c.starts().find((s) => s.agentId === keeper!.id)!;
    expect(start.prompt).toContain("You are the company's wiki maintainer.");
    expect(start.prompt).toContain("Product/Features");
    expect(start.prompt).toContain(`- ${t.id} "Research the landscape" (completed): produced wiki page research/landscape`);
    expect(start.prompt).toContain(`- ${t2.id} "Pick a licence" (completed): nothing attached; status page: status-${c.project.id}`);
    // A corrected fact is marked, never silently overwritten; each project keeps a today-status page.
    expect(start.prompt).toContain("> Changed <date>: <what it said before> → <what it says now>");
    expect(start.prompt).toContain("Status page (slug status-<project id>");
    // The health check names the broken link and the orphan; Index and the linked page are not orphans.
    // A missing page linked from several pages is wanted; one linked once is a broken link. Log, like Index, is never an orphan.
    expect(start.prompt).toContain("Wanted pages (missing, linked from several pages):\n- glossary (2 pages)\nBroken links (page → missing page):\n- research/landscape → research/pricing\nPages nothing links to:\n- old-notes\n- licence-notes\n");
    expect(start.prompt).toContain('Keep a "Log" page at the top level (slug log)');

    // Any agent can be paused; its work waits.
    await c.req("PATCH", `/api/agents/${c.worker.id}`, { paused: true });
    await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "More", assigneeAgentId: c.worker.id });
    await c.scheduler.tick();
    expect(c.starts().some((s) => s.agentId === c.worker.id)).toBe(false);
  });
});

describe("wiki shrink guard (BOS-430)", () => {
  const long = ["## Releases", ...Array.from({ length: 30 }, (_, i) => `- v${i}: ${"x".repeat(100)}`), "## Cock-ups", "- 2026-11-03: an entry"].join("\n");

  it("refuses a write that would wipe most of a page or a heading, and names what would go", async () => {
    const c = (ctx = await setup());
    const base = `/api/companies/${c.company.id}/wiki`;
    await c.wiki.write(c.company.id, { title: "Index", body: long, agentId: c.worker.id, runId: null });
    const wiped = await c.req("PUT", `${base}/index`, { title: "Index", body: "## Releases\n\n- v30: one entry" });
    expect(wiped.statusCode).toBe(409);
    expect(wiped.json().message).toContain("would replace a page of");
    expect(wiped.json().message).toContain('"Cock-ups"');
    expect(wiped.json().message).toContain("append");
    // The page and its history are unchanged: the guard runs before the write.
    const page = (await c.req("GET", `${base}/index`)).json();
    expect(page.body).toBe(long);
    expect(page.revisions).toHaveLength(1);
  });

  it("lets the same rewrite through with replace: true, and a small edit needs no flag", async () => {
    const c = (ctx = await setup());
    const base = `/api/companies/${c.company.id}/wiki`;
    await c.wiki.write(c.company.id, { title: "Index", body: long, agentId: c.worker.id, runId: null });
    // Dropping 200+ characters but no heading and under a quarter of the text is a normal edit.
    const small = long.replace("- v0: ", "- v0 (edited): ");
    expect((await c.req("PUT", `${base}/index`, { title: "Index", body: small })).statusCode).toBe(200);
    const t = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "t", assigneeAgentId: c.worker.id })).json() as { id: string };
    await c.scheduler.tick();
    const client = await c.mcp(c.starts()[0]!.runId);
    const denied = textOf(await client.callTool({ name: "wiki", arguments: { action: "write", slug: "index", title: "Index", body: "## Releases\n\n- v30: one entry", ticketId: t.id } }));
    expect(denied).toContain("would replace a page of");
    const replaced = textOf(await client.callTool({ name: "wiki", arguments: { action: "write", slug: "index", title: "Index", body: "## Releases\n\n- v30: one entry", replace: true, ticketId: t.id } }));
    expect(replaced).toContain("Updated");
    await client.close();
  });

  it("refuses section and offset on write instead of ignoring them", async () => {
    const c = (ctx = await setup());
    const t = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "t", assigneeAgentId: c.worker.id })).json() as { id: string };
    await c.scheduler.tick();
    const client = await c.mcp(c.starts()[0]!.runId);
    await c.wiki.write(c.company.id, { title: "Log", body: "## Entries\n\n- one", agentId: c.worker.id, runId: null });
    const withSection = textOf(await client.callTool({ name: "wiki", arguments: { action: "write", slug: "log", title: "Log", body: "- two", section: "Entries" } }));
    expect(withSection).toContain("no section argument");
    const withOffset = textOf(await client.callTool({ name: "wiki", arguments: { action: "write", slug: "log", title: "Log", body: "- two", offset: 0 } }));
    expect(withOffset).toContain("no offset argument");
    await client.close();
    expect((await c.req("GET", `/api/companies/${c.company.id}/wiki/log`)).json().body).toBe("## Entries\n\n- one");
  });

  it("refuses a replace on another agent's page unless the caller is the CEO", async () => {
    const c = (ctx = await setup());
    // The worker created the page; a different agent may not replace it, but the CEO may.
    await c.wiki.write(c.company.id, { title: "Index", body: long, agentId: c.worker.id, runId: null });
    const other = (await c.req("POST", `/api/companies/${c.company.id}/agents`, { name: "Second" })).json() as { id: string };
    await expect(c.wiki.write(c.company.id, { slug: "index", title: "Index", body: "## Releases\n\n- v30", replace: true, agentId: other.id, runId: null })).rejects.toThrow(/another agent created/);
    const [ceo] = await c.db.select().from(agents).where(and(eqq(agents.companyId, c.company.id), eqq(agents.role, "ceo")));
    await expect(c.wiki.write(c.company.id, { slug: "index", title: "Index", body: "## Releases\n\n- v30", replace: true, isCeo: true, agentId: ceo!.id, runId: null })).resolves.toMatchObject({ created: false });
  });
});

describe("wiki append, history and restore (BOS-430)", () => {
  const log = ["# Release log", "", "## 2026-11-03", "", "- 23:15: shipped v1.2.0", "- 17:00: shipped v1.1.9", "", "## 2026-11-02", "", "- 12:00: shipped v1.1.8"].join("\n");

  it("append adds one entry under a heading (newest first) and leaves every other character alone", async () => {
    const c = (ctx = await setup());
    await c.wiki.write(c.company.id, { title: "Release log", body: log, agentId: c.worker.id, runId: null });
    const r = await c.wiki.append(c.company.id, { slug: "release-log", entry: "- 09:00: shipped v1.3.0", heading: "2026-11-03", agentId: c.worker.id, runId: null });
    expect(r.page.body).toBe(log.replace("## 2026-11-03\n\n- 23:15", "## 2026-11-03\n\n- 09:00: shipped v1.3.0\n\n- 23:15"));
    // Older entries are untouched, and the append keeps a version like any save.
    const after = await c.wiki.get(c.company.id, "release-log");
    expect(after.revisions).toHaveLength(2);
    expect((await c.wiki.revision(c.company.id, after.revisions[0]!.id)).body).toBe(r.page.body);
  });

  it("append at the top or the end, and a clear error for a heading that isn't there", async () => {
    const c = (ctx = await setup());
    await c.wiki.write(c.company.id, { title: "Log", body: log, agentId: c.worker.id, runId: null });
    expect((await c.wiki.append(c.company.id, { slug: "log", entry: "Newest", position: "top", agentId: c.worker.id, runId: null })).page.body).toBe(`# Release log\n\nNewest\n\n${log.slice("# Release log\n\n".length)}`);
    expect((await c.wiki.append(c.company.id, { slug: "log", entry: "Oldest", position: "bottom", agentId: c.worker.id, runId: null })).page.body).toBe(`# Release log\n\nNewest\n\n${log.slice("# Release log\n\n".length)}\n\nOldest\n`);
    // A list entry at a section's end joins the list, and one under a heading opens that section's list.
    const ended = (await c.wiki.append(c.company.id, { slug: "log", entry: "- 08:00: x", heading: "2026-11-02", position: "oldest", agentId: c.worker.id, runId: null })).page.body;
    expect(ended).toContain("## 2026-11-02\n\n- 12:00: shipped v1.1.8\n\nOldest\n\n- 08:00: x");
    expect(ended.endsWith("- 08:00: x\n")).toBe(true);
    await expect(c.wiki.append(c.company.id, { slug: "log", entry: "- x", heading: "No such heading", agentId: c.worker.id, runId: null })).rejects.toThrow(/no heading "No such heading".*headings are/);
    // append never creates a page, so a typo in the slug can't start a partial one.
    await expect(c.wiki.append(c.company.id, { slug: "nope", entry: "- x", agentId: c.worker.id, runId: null })).rejects.toThrow(/no wiki page/);
    expect((await c.wiki.get(c.company.id, "log")).revisions).toHaveLength(4);
  });

  it("history lists every version with its size, past the 100 the page screen used to show", async () => {
    const c = (ctx = await setup());
    await c.wiki.write(c.company.id, { title: "Busy", body: "v0", agentId: c.worker.id, runId: null });
    for (let i = 1; i <= 120; i++) await c.wiki.write(c.company.id, { slug: "busy", title: "Busy", body: `v${i}`, agentId: c.worker.id, runId: null });
    const screen = await c.wiki.get(c.company.id, "busy");
    const h = await c.wiki.history(c.company.id, "busy");
    expect(h.revisions).toHaveLength(121);
    expect(screen.revisions).toHaveLength(121);
    expect(h.revisions[0]).toMatchObject({ size: 4 });
    expect(h.revisions.at(-1)).toMatchObject({ size: 2 });
    expect(h.size).toBe(4);
  });

  it("restore puts an old version back as a new version; only the CEO or the page's last writer may", async () => {
    const c = (ctx = await setup());
    await c.wiki.write(c.company.id, { title: "Release log", body: log, agentId: c.worker.id, runId: null });
    const [full] = (await c.wiki.history(c.company.id, "release-log")).revisions;
    // An agent wipes it with an explicit replace (which history lets it do on its own page).
    await c.wiki.write(c.company.id, { slug: "release-log", title: "Release log", body: "- 23:15: shipped v1.2.0", replace: true, agentId: c.worker.id, runId: null });
    const other = (await c.req("POST", `/api/companies/${c.company.id}/agents`, { name: "Other" })).json() as { id: string };
    await expect(c.wiki.restore(c.company.id, { slug: "release-log", revisionId: full!.id, agentId: other.id, runId: null })).rejects.toThrow(/last writer/);
    const back = await c.wiki.restore(c.company.id, { slug: "release-log", revisionId: full!.id, agentId: c.worker.id, runId: null });
    expect(back.page.body).toBe(log);
    const h = await c.wiki.history(c.company.id, "release-log");
    expect(h.revisions).toHaveLength(3);
    expect((await c.wiki.revision(c.company.id, h.revisions[0]!.id)).body).toBe(log);
    // A version of another page is refused, even in the same company.
    await c.wiki.write(c.company.id, { title: "Other page", body: "x", agentId: c.worker.id, runId: null });
    const [elsewhere] = (await c.wiki.history(c.company.id, "other-page")).revisions;
    await expect(c.wiki.restore(c.company.id, { slug: "release-log", revisionId: elsewhere!.id, agentId: c.worker.id, runId: null })).rejects.toThrow(/one of this page's/);
  });

  it("the wiki tool exposes append, history and restore, and restore is the CEO's or the last writer's", async () => {
    const c = (ctx = await setup());
    const t = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "t", assigneeAgentId: c.worker.id })).json() as { id: string };
    await c.scheduler.tick();
    const client = await c.mcp(c.starts()[0]!.runId);
    expect(textOf(await client.callTool({ name: "wiki", arguments: { action: "write", slug: "release-log", title: "Release log", body: log, ticketId: t.id } }))).toContain("Created");
    expect(textOf(await client.callTool({ name: "wiki", arguments: { action: "append", slug: "release-log", entry: "- 09:00: shipped v1.3.0", heading: "2026-11-03", ticketId: t.id } }))).toContain('under "2026-11-03"');
    const listed = textOf(await client.callTool({ name: "wiki", arguments: { action: "history", slug: "release-log" } }));
    expect(listed).toContain("versions");
    expect(listed).toMatch(/\d+ chars|characters/);
    expect(textOf(await client.callTool({ name: "wiki", arguments: { action: "append", slug: "release-log", entry: "- x", heading: "Nope" } }))).toContain("no heading");
    await client.close();
    // The last writer (the worker) may restore it through the tool; the page comes back whole.
    const [first] = (await c.wiki.history(c.company.id, "release-log")).revisions.slice(-1);
    const client2 = await c.mcp(c.starts()[0]!.runId);
    expect(textOf(await client2.callTool({ name: "wiki", arguments: { action: "restore", slug: "release-log", revisionId: first!.id } }))).toContain("Restored");
    await client2.close();
    expect((await c.wiki.get(c.company.id, "release-log")).body).toBe(log);
  });

  it("the owner's restore route brings a version back, and refuses one from another page", async () => {
    const c = (ctx = await setup());
    await c.wiki.write(c.company.id, { title: "Release log", body: log, agentId: c.worker.id, runId: null });
    const [full] = (await c.wiki.history(c.company.id, "release-log")).revisions;
    await c.wiki.write(c.company.id, { slug: "release-log", title: "Release log", body: "- 23:15: shipped v1.2.0", replace: true, agentId: c.worker.id, runId: null });
    const res = await c.req("POST", `/api/companies/${c.company.id}/wiki-restore`, { slug: "release-log", revisionId: full!.id });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ body: log });
    expect((await c.req("POST", `/api/companies/${c.company.id}/wiki-restore`, { slug: "log-not-there", revisionId: full!.id })).statusCode).toBe(404);
  });
});

describe("wiki history is never lost by import (BOS-430)", () => {
  it("an imported page starts with a version, so its first edit keeps the imported text", async () => {
    const c = (ctx = await setup());
    await c.wiki.write(c.company.id, { folder: "Runbooks", title: "Deploy", body: "Thursday 23:00.", agentId: c.worker.id, runId: null });
    const zip = Buffer.from((await c.req("GET", `/api/companies/${c.company.id}/export?wiki=1&tickets=none`)).rawPayload).toString("base64");
    const imported = await c.req("POST", "/api/companies/import", { zip, name: "Copy Co" });
    expect(imported.statusCode).toBe(201);
    const { companyId } = imported.json() as { companyId: string };
    const page = (await c.req("GET", `/api/companies/${companyId}/wiki/runbooks/deploy`)).json();
    expect(page.body).toBe("Thursday 23:00.");
    expect(page.revisions).toHaveLength(1);
    expect(page.revisions[0].size).toBe("Thursday 23:00.".length);
    expect((await c.req("GET", `/api/companies/${companyId}/wiki-revisions/${page.revisions[0].id}`)).json().body).toBe("Thursday 23:00.");
  });
});

describe("the words that stop a wipe (BOS-430)", () => {
  // Step 6: agents must be told to use append for logs and never send a partial body to write, in the
  // tool itself and in the instructions of the two agents who write long-running logs.
  it("the wiki tool description and the log-writing agents' instructions name append and warn off partial writes", async () => {
    const c = (ctx = await setup());
    const t = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "t", assigneeAgentId: c.worker.id })).json() as { id: string };
    await c.scheduler.tick();
    const client = await c.mcp(c.starts()[0]!.runId);
    const { tools } = await client.listTools();
    await client.close();
    const desc = tools.find((x) => x.name === "wiki")!.description!;
    for (const word of ["append", "history", "restore", "replace: true", "quarter"]) expect(desc).toContain(word);

    const { AGENT_TEMPLATES } = await import("@boss-man/shared");
    const release = AGENT_TEMPLATES.find((x) => x.id === "release-manager")!;
    expect(release.instructions).toContain("append");
    expect(release.instructions).toContain("write replaces the whole page");

    // The wiki maintainer's prompt (built by the scheduler) says the same for its own Log page.
    const [keeper] = await c.db.select().from(agents).where(and(eqq(agents.companyId, c.company.id), eqq(agents.duty, "wiki")));
    await c.req("PATCH", `/api/agents/${keeper!.id}`, { paused: false, model: "claude-sonnet-5-5" });
    await c.req("PATCH", `/api/tickets/${t.id}`, { state: "done" });
    await c.scheduler.tick();
    const prompt = c.starts().find((s) => s.agentId === keeper!.id)!.prompt;
    expect(prompt).toContain("append");
    expect(prompt).toContain("never send a partial body to write");
  });
});
