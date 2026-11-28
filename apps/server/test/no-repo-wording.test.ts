import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { RunnerCommand } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { ticketImages, wakes } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";
import { NO_REPO_RESULT_LINE, reviewReadLine } from "../src/services/no-repo-wording.js";
import { REVIEW_REASON } from "../src/services/review-kinds.js";

// BOS-2820 (F25): in a project with no code repo the agent is told what a result is, and the
// reviewer is pointed at what the ticket produced instead of a diff. Projects with a repo keep their wording.

let ctx: { close: () => Promise<void> } | undefined;
afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

const textOf = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0]?.text ?? "";

async function setup(repo: boolean) {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, workspaceRoot: "/ws" });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const base = `127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  const clients: Client[] = [];
  ctx = { close: async () => (await Promise.all(clients.map((c) => c.close())), await built.app.close(), await close()) };
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company, ceo } = (await req("POST", "/api/companies", { name: "Words Co" })).json() as { company: { id: string }; ceo: { id: string } };
  const writer = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Wren" })).json() as { id: string };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Newsletter" })).json() as { id: string };
  if (repo) await req("PATCH", `/api/projects/${project.id}`, { repoUrl: "https://github.com/example/app.git" });
  const reg = (await req("POST", `/api/companies/${company.id}/runner`)).json() as { runnerId: string };
  const sent: RunnerCommand[] = [];
  built.runners.connect(reg.runnerId, (c) => (sent.push(c), true));
  const ticket = (await req("POST", `/api/projects/${project.id}/tickets`, { title: "Write the March issue", assigneeAgentId: writer.id, state: "in_progress" })).json() as { id: string };
  await db.delete(wakes);
  const mcp = async (agentId: string) => {
    const token = await issueRunToken(db, { companyId: company.id, agentId, runId: randomUUID() });
    const c = new Client({ name: "t", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    clients.push(c);
    return c;
  };
  const starts = () => sent.filter((c): c is Extract<RunnerCommand, { type: "run.start" }> => c.type === "run.start");
  return { ...built, db, req, company, ceo, writer, project, ticket, mcp, starts };
}

describe("a ticket in a project with no code repo (BOS-2820)", () => {
  it("tells the agent what a result is and that its folder is not where it goes", async () => {
    const c = await setup(false);
    await c.scheduler.wake({ agentId: c.writer.id, ticketId: c.ticket.id, reason: "assigned", note: "Go." });
    await c.scheduler.tick();
    const start = c.starts().find((s) => s.agentId === c.writer.id)!;
    expect(start.workspace).toBeUndefined();
    expect(start.prompt).toContain(NO_REPO_RESULT_LINE);
    expect(start.prompt).toContain(`it started in ${start.cwd}, a working folder only. Nothing left there reaches the ticket`);
    expect(start.prompt).not.toContain("Commit your work on the ticket's branch");
    expect(start.prompt).not.toContain("which is not a copy of the repo");
  });

  it("keeps today's wording for a project with a repo", async () => {
    const c = await setup(true);
    await c.scheduler.wake({ agentId: c.writer.id, ticketId: c.ticket.id, reason: "assigned", note: "Go." });
    await c.scheduler.tick();
    const start = c.starts().find((s) => s.agentId === c.writer.id)!;
    expect(start.prompt).toContain("Commit your work on the ticket's branch");
    expect(start.prompt).not.toContain(NO_REPO_RESULT_LINE);
    expect(start.prompt).not.toContain("a working folder only");
  });

  it("wakes the reviewer to read what it produced, and the review tool lists it instead of a diff", async () => {
    const c = await setup(false);
    const writer = await c.mcp(c.writer.id);
    const wrote = textOf(await writer.callTool({ name: "wiki", arguments: { action: "write", title: "March issue", body: "# March\n\nThe draft.", folder: "Newsletter", ticketId: c.ticket.id } }));
    expect(wrote).not.toMatch(/error|refused/i);
    await c.db.insert(ticketImages).values({ companyId: c.company.id, ticketId: c.ticket.id, name: "cover.png", caption: "Cover picture", type: "image/png", size: 4, bytes: Buffer.from("fake") });
    await c.scheduler.onTicketReview(c.ticket.id, c.writer.id);
    const notes = (await c.db.select().from(wakes)).filter((w) => w.reason === REVIEW_REASON).map((w) => w.note ?? "");
    expect(notes.length).toBeGreaterThan(0);
    for (const n of notes) {
      expect(n).toContain(reviewReadLine(false));
      expect(n).not.toContain("Read the changes with the review tool");
    }
    const shown = textOf(await (await c.mcp(c.ceo.id)).callTool({ name: "review", arguments: { action: "diff", ticketId: c.ticket.id } }));
    expect(shown).toContain("## What it produced");
    expect(shown).toMatch(/- wiki page "March issue": wiki read slug="[^"]+"/);
    expect(shown).toMatch(/- picture cover\.png \(Cover picture\): open_attachment id="[0-9a-f-]{36}"/);
    expect(shown).not.toContain("no diff to review");
  });

  it("says plainly when the ticket produced nothing, so the reviewer asks for it", async () => {
    const c = await setup(false);
    await c.scheduler.onTicketReview(c.ticket.id, c.writer.id);
    const shown = textOf(await (await c.mcp(c.ceo.id)).callTool({ name: "review", arguments: { action: "diff", ticketId: c.ticket.id } }));
    expect(shown).toContain("(nothing: no wiki page was written with this ticket's id");
  });

  it("keeps the diff wording on a repo project's review wake", async () => {
    const c = await setup(true);
    await c.scheduler.onTicketReview(c.ticket.id, c.writer.id);
    const notes = (await c.db.select().from(wakes)).filter((w) => w.reason === REVIEW_REASON).map((w) => w.note ?? "");
    expect(notes.length).toBeGreaterThan(0);
    for (const n of notes) expect(n).toContain("Read the changes with the review tool (action diff), then give your verdict with action submit.");
  });
});
