import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { RunnerCommand } from "@boss-man/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { activity, agentAvatars, agents, decisions, notifications, ticketImages } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";

// A 1x1 PNG, and a bar of extra bytes so a "too large" picture can be built from it.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const bigPng = () => Buffer.concat([PNG, Buffer.alloc(300 * 1024, 1)]);
const notAPicture = Buffer.from("%PDF-1.4 fake\n");

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, workspaceRoot: "/ws" });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const base = `127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PUT" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company, ceo } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string }; ceo: { id: string } };
  const other = (await req("POST", "/api/companies", { name: "Other Co" })).json().company as { id: string };
  const engineer = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Engineer - Developer", template: "engineer" })).json() as { id: string };
  const qa = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Quinn - QA", template: "qa" })).json() as { id: string };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "App" })).json() as { id: string };
  const ticket = (await req("POST", `/api/projects/${project.id}/tickets`, { title: "Ship it" })).json() as { id: string };
  const mcp = async (agentId: string) => {
    const c = new Client({ name: "t", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${await issueRunToken(db, { companyId: company.id, agentId, runId: randomUUID() })}` } } }));
    return c;
  };
  return { ...built, db, req, close: async () => (await built.app.close(), await close()), company, ceo, other, engineer, qa, project, ticket, mcp };
}

const textOf = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0]?.text ?? "";

describe("the CEO renames an agent (BOS-265)", () => {
  it("renames from a run, keeps tickets and history to the id, and names the colleagues that still say the old name", async () => {
    const c = (ctx = await setup());
    // Quinn's instructions quote the old name.
    await c.req("PATCH", `/api/agents/${c.qa.id}`, { instructions: "Pair with Engineer - Developer on every build." });
    const client = await c.mcp(c.ceo.id);
    const r = await client.callTool({ name: "rename_agent", arguments: { agent: "Engineer - Developer", newName: "Zippy", reason: "The owner wants real names." } });
    const text = textOf(r);
    expect(text).toContain("Engineer - Developer is now Zippy.");
    expect(text).toContain("Quinn - QA (instructions)");
    expect(await c.db.select().from(agents).where(eq(agents.id, c.engineer.id))).toEqual([expect.objectContaining({ name: "Zippy" })]);
    // The ticket still points at the same agent row.
    const t = (await c.req("GET", `/api/tickets/${c.ticket.id}`)).json();
    expect(t.assigneeAgentId ?? null).toBeNull();
    const history = (await c.req("GET", `/api/agents/${c.engineer.id}/history`)).json() as Array<{ c: { id: string; field: string; before: unknown; after: unknown; byAgentId: string } }>;
    expect(history[0]!.c).toMatchObject({ field: "name", before: "Engineer - Developer", after: "Zippy", byAgentId: c.ceo.id });
    // Logged with the reason, and the owner gets a note.
    const logged = await c.db.select().from(activity).where(and(eq(activity.companyId, c.company.id), eq(activity.kind, "agent_renamed")));
    expect(logged[0]!.summary).toContain("Engineer - Developer was renamed to Zippy: The owner wants real names.");
    expect(await c.db.select().from(notifications).where(eq(notifications.companyId, c.company.id))).toEqual([expect.objectContaining({ title: "The CEO renamed Engineer - Developer to Zippy" })]);
    // The owner can undo it on the Agents page.
    const undo = await c.req("POST", `/api/agent-changes/${history[0]!.c.id}/undo`);
    expect(undo.statusCode).toBeLessThan(300);
    expect(await c.db.select().from(agents).where(eq(agents.id, c.engineer.id))).toEqual([expect.objectContaining({ name: "Engineer - Developer" })]);
    await client.close();
  });

  it("refuses a duplicate, empty or over-long name, and never renames the CEO", async () => {
    const c = (ctx = await setup());
    const client = await c.mcp(c.ceo.id);
    const call = (args: Record<string, unknown>) => client.callTool({ name: "rename_agent", arguments: { agent: "Engineer - Developer", newName: "Zippy", reason: "Tidy.", ...args } });
    expect(textOf(await call({ newName: "Quinn - QA" }))).toMatch(/already called Quinn - QA/);
    expect(textOf(await call({ newName: "   " }))).toContain("A name can't be empty.");
    expect(textOf(await call({ newName: "x".repeat(81) }))).toMatch(/at most 80/);
    expect(textOf(await call({ agent: "App Co CEO", newName: "Boss" }))).toMatch(/No agent called/);
    const [ceoName] = await c.db.select({ name: agents.name, role: agents.role }).from(agents).where(eq(agents.id, c.ceo.id));
    expect(textOf(await call({ agent: ceoName!.name, newName: "Boss" }))).toMatch(/CEO can't be renamed/);
    expect(await c.db.select().from(agents).where(eq(agents.id, c.engineer.id))).toEqual([expect.objectContaining({ name: "Engineer - Developer" })]);
    await client.close();
  });

  it("is refused for a non-CEO agent", async () => {
    const c = (ctx = await setup());
    const client = await c.mcp(c.engineer.id);
    const r = await client.callTool({ name: "rename_agent", arguments: { agent: "Quinn - QA", newName: "Someone Else", reason: "Tidy." } });
    expect(r).toMatchObject({ isError: true });
    expect(textOf(r)).toMatch(/Only your company's CEO/);
    expect(await c.db.select().from(agents).where(eq(agents.id, c.qa.id))).toEqual([expect.objectContaining({ name: "Quinn - QA" })]);
    await client.close();
  });

  it("waits in Decisions when the owner asked to approve instruction changes, and lands on Apply", async () => {
    const c = (ctx = await setup());
    await c.req("PUT", `/api/companies/${c.company.id}/agent-approvals`, { approvals: "hires_and_edits" });
    const client = await c.mcp(c.ceo.id);
    const r = await client.callTool({ name: "rename_agent", arguments: { agent: "Engineer - Developer", newName: "Zippy", reason: "Real names." } });
    expect(textOf(r)).toMatch(/waiting for the owner's approval \(decision /);
    expect(await c.db.select().from(agents).where(eq(agents.id, c.engineer.id))).toEqual([expect.objectContaining({ name: "Engineer - Developer" })]);
    const [d] = await c.db.select().from(decisions).where(eq(decisions.companyId, c.company.id));
    expect(d).toMatchObject({ tier: "owner", options: ["Apply the change", "Keep them as they are"] });
    expect(d!.question).toContain("rename Engineer - Developer to Zippy");
    // The owner answers in Decisions (the Agents page shows the card).
    expect((await c.req("POST", `/api/decisions/${d!.id}/answer`, { answer: "Apply the change" })).statusCode).toBeLessThan(300);
    expect(await c.db.select().from(agents).where(eq(agents.id, c.engineer.id))).toEqual([expect.objectContaining({ name: "Zippy" })]);
    // Keeping them leaves the name alone.
    expect((await c.req("POST", `/api/companies/${c.company.id}/agent-approvals`, { approvals: "hires_and_edits" })).statusCode).toBeLessThan(500);
    await client.close();
  });
});

describe("the CEO sets an agent's picture (BOS-265)", () => {
  const upload = (c: NonNullable<typeof ctx>, data: Buffer, ticketId: string | null = null, companyId = c.company.id) =>
    c.req("POST", `/api/companies/${companyId}/images`, { data: data.toString("base64"), name: "face.png", ...(ticketId ? { ticketId } : {}) }).then((r) => r.json() as { id: string });

  it("copies an image on this company's ticket, shows it on the agent, and clears it", async () => {
    const c = (ctx = await setup());
    const image = await upload(c, PNG, c.ticket.id);
    const client = await c.mcp(c.ceo.id);
    const r = await client.callTool({ name: "set_agent_picture", arguments: { agent: "Engineer - Developer", imageId: image.id, reason: "The owner asked for a real face." } });
    expect(textOf(r)).toBe("Engineer - Developer now has that picture. It shows on the Agents page, the board and the runs list.");
    // Served on the same route the Agents page and the board use.
    const shown = await c.req("GET", `/api/agents/${c.engineer.id}/avatar`);
    expect(shown.headers["content-type"]).toBe("image/png");
    expect(shown.rawPayload.equals(PNG)).toBe(true);
    expect(await c.db.select().from(agentAvatars).where(eq(agentAvatars.agentId, c.engineer.id))).toEqual([expect.objectContaining({ type: "image/png", imageId: image.id })]);
    // The board's agent list says it has a picture.
    const board = (await c.req("GET", `/api/companies`)).json().find((x: { id: string }) => x.id === c.company.id);
    expect(board.agents.find((a: { id: string }) => a.id === c.engineer.id).avatarAt).toBeTruthy();
    const logged = await c.db.select().from(activity).where(and(eq(activity.companyId, c.company.id), eq(activity.kind, "agent_picture")));
    expect(logged[0]!.summary).toContain("The owner asked for a real face.");

    expect(textOf(await client.callTool({ name: "set_agent_picture", arguments: { agent: "Engineer - Developer", clear: true, reason: "Back to the artwork." } }))).toContain("back to the default");
    expect((await c.req("GET", `/api/agents/${c.engineer.id}/avatar`)).statusCode).toBe(404);
    expect(await c.db.select().from(agentAvatars)).toEqual([]);
    await client.close();
  });

  it("refuses another company's image, a document, and a picture over the limit", async () => {
    const c = (ctx = await setup());
    const theirs = await upload(c, PNG, null, c.other.id);
    const doc = await upload(c, notAPicture, c.ticket.id);
    const big = await upload(c, bigPng(), c.ticket.id);
    const client = await c.mcp(c.ceo.id);
    const call = (args: Record<string, unknown>) => client.callTool({ name: "set_agent_picture", arguments: { agent: "Engineer - Developer", reason: "Try it.", ...args } });
    const other = await call({ imageId: theirs.id });
    expect(other).toMatchObject({ isError: true });
    expect(textOf(other)).toMatch(/No image with that id on a ticket in this company/);
    expect(textOf(await call({ imageId: doc.id }))).toMatch(/aren't a PNG, JPEG or WebP image/);
    expect(textOf(await call({ imageId: big.id }))).toMatch(/at most 256 KB/);
    expect(await c.db.select().from(agentAvatars)).toEqual([]);
    // And a non-CEO isn't allowed at all.
    const worker = await c.mcp(c.engineer.id);
    expect(await worker.callTool({ name: "set_agent_picture", arguments: { agent: "Quinn - QA", imageId: theirs.id, reason: "Try it." } })).toMatchObject({ isError: true });
    await worker.close();
    await client.close();
  });
});

describe("the git author after a rename (BOS-265)", () => {
  it("sends the agent's current display name with each run, so new commits aren't under an old one", async () => {
    const c = (ctx = await setup());
    await c.req("PATCH", `/api/agents/${c.engineer.id}`, { name: "Zippy" });
    const reg = (await c.req("POST", `/api/companies/${c.company.id}/runner`)).json() as { runnerId: string };
    const commands: RunnerCommand[] = [];
    c.runners.connect(reg.runnerId, (x) => (commands.push(x), true));
    await c.scheduler.notify(c.engineer.id, { reason: "feedback", note: "Check the release notes." });
    await c.scheduler.tick();
    const start = commands.filter((x): x is Extract<RunnerCommand, { type: "run.start" }> => x.type === "run.start").at(-1)!;
    expect(start).toMatchObject({ agentId: c.engineer.id, agentName: "Zippy" });
  });
});

describe("ticket images left alone", () => {
  it("keeps the image on the ticket when it becomes a picture", async () => {
    const c = (ctx = await setup());
    const image = (await c.req("POST", `/api/companies/${c.company.id}/images`, { data: PNG.toString("base64"), ticketId: c.ticket.id })).json() as { id: string };
    const client = await c.mcp(c.ceo.id);
    await client.callTool({ name: "set_agent_picture", arguments: { agent: "Quinn - QA", imageId: image.id, reason: "Reuse." } });
    expect((await c.req("GET", `/api/tickets/${c.ticket.id}/images`)).json().map((i: { id: string }) => i.id)).toEqual([image.id]);
    expect((await c.db.select().from(ticketImages).where(eq(ticketImages.id, image.id)))[0]).toMatchObject({ ticketId: c.ticket.id });
    await client.close();
  });
});
