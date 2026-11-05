// BOS-502: the owner's message boxes take long pastes (logs) whole. Every route those boxes post to
// stores and delivers 200,000 characters unchanged, an agent can read it all back through its ticket
// tools, and a text file sent in place of an over-long message opens whole, in parts.
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { OWNER_MESSAGE_MAX } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { decisions, runners } from "../src/db/schema.js";
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
  const req = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company, ceo } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string }; ceo: { id: string } };
  const worker = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Engineer" })).json() as { id: string };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Site" })).json() as { id: string };
  const reg = (await req("POST", `/api/companies/${company.id}/runner`)).json() as { runnerId: string };
  const [runnerRow] = await db.select().from(runners).where(eq(runners.id, reg.runnerId));
  const sent: Array<Record<string, unknown>> = [];
  built.runners.connect(reg.runnerId, (c) => (sent.push(c as unknown as Record<string, unknown>), true));
  let seq = 0;
  const emit = (event: unknown) => built.runners.ingest(runnerRow!, { seq: ++seq, at: new Date().toISOString(), event: event as never });
  const mcp = async (runId: string) => {
    const token = await issueRunToken(db, { companyId: company.id, agentId: worker.id, runId });
    const c = new Client({ name: "t", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    return c;
  };
  return { ...built, db, close, req, company, ceo, worker, project, sent, emit, mcp };
}

const textOf = (r: unknown) => ((r as { content: Array<{ text: string }> }).content.map((c) => c.text).join("\n") ?? "");

/** A log of exactly `n` characters, with a marker at each end so a cut is visible. */
const log = (n: number) => { const head = "START\n"; const tail = "\nEND"; return `${head}${"0123456789abcdefghij".repeat(Math.ceil(n / 20)).slice(0, n - head.length - tail.length)}${tail}`; };

describe("long owner messages (BOS-502)", () => {
  it("is the same limit everywhere: at least 200,000 characters", () => {
    expect(OWNER_MESSAGE_MAX).toBeGreaterThanOrEqual(200_000);
  });

  it("stores a 200k message on a ticket whole and delivers it whole to a woken agent and to tickets read", async () => {
    const c = (ctx = await setup());
    const big = log(200_000);
    expect(big).toHaveLength(200_000);
    const t = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "Read the log", assigneeAgentId: c.worker.id })).json() as { id: string };
    const post = await c.req("POST", `/api/tickets/${t.id}/messages`, { text: big });
    expect(post.statusCode).toBe(201);
    // Stored unchanged
    const items = (await c.req("GET", `/api/tickets/${t.id}/messages`)).json().items as Array<{ text: string }>;
    expect(items[0]!.text).toBe(big);

    // Delivered whole into the run the message woke
    await c.scheduler.tick();
    const started = c.sent.find((m) => m.type === "run.start") as { runId: string; prompt: string } | undefined;
    expect(started).toBeDefined();
    const inPrompt = started!.prompt.slice(started!.prompt.indexOf("Owner: START"));
    expect(inPrompt).toContain(big);
    expect(inPrompt.slice(0, big.length + 7)).toBe(`Owner: ${big}`);

    // An agent reads it in full through tickets read; paging follows rather than silently cutting
    const client = await c.mcp(started!.runId);
    const read = textOf(await client.callTool({ name: "tickets", arguments: { action: "read", ticketId: t.id } }));
    const at = read.indexOf("Owner: START");
    expect(at, read.slice(0, 1500)).toBeGreaterThanOrEqual(0);
    // The first page carries the start of it, then says where to continue rather than cutting it short.
    expect(read.slice(at, at + 30_000)).toBe(`Owner: ${big}`.slice(0, 30_000));
    expect(read).toMatch(/continue with tickets read ticketId=/);
    const more = await client.callTool({ name: "tickets", arguments: { action: "read", ticketId: t.id, offset: at + "Owner: ".length + 100_000 } });
    const page2 = textOf(more);
    // Paging by offset gives the next part of the same log, not a snippet or a restart.
    expect(page2.slice(0, 2000)).toBe(big.slice(100_000, 102_000));
    await client.close();
  });

  it("takes a 200k message on a live run and in the CEO chat", async () => {
    const c = (ctx = await setup());
    const big = log(200_000);
    const t = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "Steer me", assigneeAgentId: c.worker.id })).json() as { id: string };
    await c.scheduler.tick();
    const run = c.sent.find((m) => m.type === "run.start") as { runId: string };
    const msg = await c.req("POST", `/api/runs/${run.runId}/message`, { text: big });
    expect(msg.statusCode, msg.body.slice(0, 400)).toBe(200);
    expect(c.sent.at(-1)).toMatchObject({ type: "run.message", runId: run.runId, text: `Message from the owner: ${big}` });

    const chat = await c.req("POST", `/api/companies/${c.company.id}/chat`, { text: big });
    expect(chat.statusCode).toBe(201);
    const thread = (await c.req("GET", `/api/companies/${c.company.id}/chat`)).json().items as Array<{ text: string; role: string }>;
    expect(thread.find((m) => m.role === "owner")!.text).toBe(big);
  });

  it("takes a 200k ticket description whole", async () => {
    const c = (ctx = await setup());
    const big = log(200_000);
    const t = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "Describe it" })).json() as { id: string };
    const r = await c.req("PATCH", `/api/tickets/${t.id}`, { body: big });
    expect(r.statusCode, r.body.slice(0, 400)).toBe(200);
    const read = (await c.req("GET", `/api/tickets/${t.id}`)).json() as { body: string };
    expect(read.body).toBe(big);
  });

  it("takes a 200k decision answer whole", async () => {
    const c = (ctx = await setup());
    const big = log(200_000);
    const t = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "What now?", assigneeAgentId: c.worker.id })).json() as { id: string };
    const [d] = await c.db
      .insert(decisions)
      .values({ companyId: c.company.id, kind: "question", tier: "owner", status: "open", question: "What now?", options: ["Yes", "No"], recommendedOption: "Yes", raisedByAgentId: c.worker.id } as never)
      .returning();
    const r = await c.req("POST", `/api/decisions/${d!.id}/answer`, { answer: big, custom: true });
    expect(r.statusCode, r.body.slice(0, 400)).toBe(200);
    const [after] = await c.db.select().from(decisions).where(eq(decisions.id, d!.id));
    expect(after!.answer).toBe(big);
    expect(t.id).toBeTruthy();
  });

  it("refuses a message past the limit with a clear answer (the box warns first)", async () => {
    const c = (ctx = await setup());
    const t = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "Too much" })).json() as { id: string };
    const r = await c.req("POST", `/api/tickets/${t.id}/messages`, { text: "x".repeat(OWNER_MESSAGE_MAX + 1) });
    expect(r.statusCode).toBe(400);
  });

  it("lets an agent open a .txt sent in place of a long message whole, in parts", async () => {
    const c = (ctx = await setup());
    // The text file goes through the same upload the box's Attach file uses.
    const body = log(200_000);
    const up = await c.req("POST", `/api/companies/${c.company.id}/images`, { data: Buffer.from(body, "utf8").toString("base64"), name: "message.txt" });
    expect(up.statusCode).toBe(201);
    const { markdown } = up.json() as { markdown: string };
    const id = /\/api\/ticket-images\/([0-9a-f-]{36})/.exec(markdown)?.[1];
    expect(id).toBeTruthy();
    const client = await c.mcp(randomUUID());
    const first = textOf(await client.callTool({ name: "open_attachment", arguments: { id } }));
    expect(first).toContain(body.slice(0, 39_000));
    expect(first).toMatch(/continue with open_attachment id=/);
    const rest = textOf(await client.callTool({ name: "open_attachment", arguments: { id, offset: 40_000 } }));
    expect(rest).toContain(body.slice(40_000, 79_000));
    await client.close();
  });
});
