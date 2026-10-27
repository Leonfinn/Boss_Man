import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { stateNoteLine } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { decisions, tickets, wakes } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  ctx?.clients.forEach((c) => void c.close());
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
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Customer app" })).json() as { id: string };
  const worker = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Engineer" })).json() as { id: string };
  const other = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Reviewer" })).json() as { id: string };
  const clients: Client[] = [];
  const mcp = async (agentId: string) => {
    const token = await issueRunToken(db, { companyId: company.id, agentId, runId: randomUUID() });
    const c = new Client({ name: "t", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    clients.push(c);
    return c;
  };
  const ticket = async (title: string, assigneeAgentId?: string) =>
    (await req("POST", `/api/projects/${project.id}/tickets`, { title, ...(assigneeAgentId ? { assigneeAgentId } : {}) })).json() as { id: string };
  return { ...built, db, close, req, company, ceo, project, worker, other, mcp, clients, ticket };
}

const textOf = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? "");
const isError = (r: unknown) => (r as { isError?: boolean }).isError === true;

describe("stale requests (BOS-123)", () => {
  it("flags an open card and the state note when the owner answers a related decision, and wakes the author once", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("Fix the footer", c.worker.id);
    await c.work.updateTicket(t.id, { stateNote: "Waiting on the owner to pick a colour." });

    // The card the owner answers, and another open card about the same ticket from the worker.
    const first = await c.decisions.raise({ companyId: c.company.id, agentId: c.other.id, question: "Which colour?", options: ["Blue", "Navy"], recommended: "Blue", blocksTicketId: t.id, triedFirst: "Checked the brand guide" });
    const second = await c.decisions.raise({ companyId: c.company.id, agentId: c.worker.id, question: "Should I also change the header?", options: ["Yes", "No"], recommended: "Yes", blocksTicketId: t.id, triedFirst: "Searched the repo" });

    await c.decisions.answer(first.id, "Blue");

    const [after] = await c.db.select().from(decisions).where(eq(decisions.id, second.id));
    expect(after!.staleAt).toBeInstanceOf(Date);
    expect(after!.staleReason).toMatch(/owner answered/i);
    const [ticketRow] = await c.db.select().from(tickets).where(eq(tickets.id, t.id));
    expect(ticketRow!.stateNoteStaleAt).toBeInstanceOf(Date);

    const stale = (await c.db.select().from(wakes).where(and(eq(wakes.agentId, c.worker.id), eq(wakes.reason, "stale request"))));
    expect(stale).toHaveLength(1);
    expect(stale[0]!.note).toMatch(/out of date/i);
  });

  it("refuses a request the owner already answered, quoting the answer, unless a fresh reason is given", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("Pick a provider");
    const d = await c.decisions.raise({ companyId: c.company.id, agentId: c.worker.id, question: "Stripe or Mollie?", options: ["Stripe", "Mollie"], recommended: "Stripe", blocksTicketId: t.id, triedFirst: "Compared their fees" });
    await c.decisions.answer(d.id, "Mollie");

    const mcp = await c.mcp(c.worker.id);
    const ask = (extra: Record<string, unknown> = {}) =>
      mcp.callTool({
        name: "raise_decision",
        arguments: { question: "Which provider should I use?", options: ["Stripe", "Mollie"], recommended: "Stripe", blocksTicketId: t.id, triedFirst: "Asked again after reading the docs", ...extra },
      });

    const refused = await ask();
    expect(isError(refused)).toBe(true);
    expect(textOf(refused)).toContain("Mollie");
    expect(textOf(refused)).toMatch(/already answered/i);

    const allowed = await ask({ stillNeeded: "The owner chose Mollie, but the Mollie key has expired and they must pick again." });
    expect(isError(allowed)).toBe(false);
    expect(textOf(allowed)).toMatch(/in the owner's queue/i);
  });

  it("flags notes and cards that wait on a ticket when that ticket is done", async () => {
    const c = (ctx = await setup());
    const blocker = await c.ticket("Ship the API");
    const waiting = await c.ticket("Show the new data", c.worker.id);
    await c.work.updateTicket(waiting.id, { stateNote: "Waiting on the API ticket to finish." });
    await c.work.addDependency(waiting.id, { ticketId: blocker.id });
    const card = await c.decisions.raise({ companyId: c.company.id, agentId: c.other.id, question: "Should the data page wait for the API?", options: ["Yes", "No"], recommended: "Yes", blocksTicketId: waiting.id, triedFirst: "Read both tickets" });

    await c.work.updateTicket(blocker.id, { state: "done", outcome: "completed" });

    const [waiter] = await c.db.select().from(tickets).where(eq(tickets.id, waiting.id));
    expect(waiter!.stateNoteStaleAt).toBeInstanceOf(Date);
    const [after] = await c.db.select().from(decisions).where(eq(decisions.id, card.id));
    expect(after!.staleAt).toBeInstanceOf(Date);
    const stale = await c.db.select().from(wakes).where(and(eq(wakes.agentId, c.worker.id), eq(wakes.reason, "stale request")));
    expect(stale.length).toBeGreaterThanOrEqual(1);
  });

  it("stateNoteLine says a note may be out of date when the owner acted after it", () => {
    const now = new Date("2026-10-27T12:00:00Z");
    const note = { stateNote: "Waiting on the owner.", stateNoteAt: new Date("2026-10-27T10:00:00Z"), lastActivityAt: new Date("2026-10-27T09:00:00Z") };
    expect(stateNoteLine(note, now)).not.toContain("(may be out of date)");
    expect(stateNoteLine({ ...note, lastActivityAt: new Date("2026-10-27T11:00:00Z") }, now)).toContain("(may be out of date)");
    expect(stateNoteLine({ ...note, stateNoteStaleAt: new Date("2026-10-27T11:00:00Z") }, now)).toContain("(may be out of date)");
  });
});
