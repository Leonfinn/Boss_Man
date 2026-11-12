// raise_decision's holdsMerge (BOS-1078): blocksTicketId links a card to a ticket; only holdsMerge makes it hold
// that ticket's approved merge. These go through the real MCP tool, as an agent calls it.
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { decisions, tickets } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";
import { openHoldingCard } from "../src/services/ticket-links.js";

let s: Awaited<ReturnType<typeof boot>>;

async function boot() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const base = `127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  const setup = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${setup.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "POST", url: string, payload: unknown) => built.app.inject({ method, url, headers: { cookie }, payload: payload as object });
  const co = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } };
  const dev = (await req("POST", `/api/companies/${co.company.id}/agents`, { name: "Dev" })).json() as { id: string };
  const project = (await req("POST", `/api/companies/${co.company.id}/projects`, { name: "Customer app" })).json() as { id: string };
  const token = await issueRunToken(db, { companyId: co.company.id, agentId: dev.id, runId: randomUUID() });
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  const ticket = async () => (await db.insert(tickets).values({ companyId: co.company.id, projectId: project.id, title: "Payments", systemState: "review" }).returning())[0]!;
  return { built, db, close, client, ticket };
}

beforeAll(async () => {
  s = await boot();
});
afterAll(async () => {
  await s.client.close();
  await s.built.app.close();
  await s.close();
});

const textOf = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? "");
const ask = (args: Record<string, unknown>) =>
  s.client.callTool({ name: "raise_decision", arguments: { options: ["Stripe", "Mollie"], recommended: "Stripe", triedFirst: "Compared both providers' fees and docs", ...args } });
const idOf = (text: string) => /Decision ([0-9a-f-]{36})/.exec(text)?.[1];

describe("raise_decision holdsMerge (BOS-1078)", () => {
  it("a card with only blocksTicketId is linked but doesn't hold the merge", async () => {
    const t = await s.ticket();
    const id = idOf(textOf(await ask({ question: "Which payment provider?", blocksTicketId: t.id })));
    expect(id).toBeTruthy();
    expect(await openHoldingCard(s.db, t.id)).toBeNull();
  });

  it("holdsMerge: true makes the card hold the ticket's merge, and is stored on the card", async () => {
    const t = await s.ticket();
    const id = idOf(textOf(await ask({ question: "Which payment provider, before this goes in?", blocksTicketId: t.id, holdsMerge: true })));
    expect(await openHoldingCard(s.db, t.id)).toBe(id);
    const [d] = await s.db.select({ context: decisions.context }).from(decisions).where(eq(decisions.id, id!));
    expect((d!.context as { holdsMerge?: boolean }).holdsMerge).toBe(true);
  });

  it("refuses holdsMerge without a ticket, and on a card that settles an after-merge check", async () => {
    const r1 = await ask({ question: "Hold what?", holdsMerge: true });
    expect(r1.isError).toBe(true);
    expect(textOf(r1)).toMatch(/goes with blocksTicketId/);
    const t = await s.ticket();
    const r2 = await ask({ question: "Does it work live?", blocksTicketId: t.id, holdsMerge: true, criterion: 1 });
    expect(r2.isError).toBe(true);
    expect(textOf(r2)).toMatch(/can't hold the merge/);
  });
});
