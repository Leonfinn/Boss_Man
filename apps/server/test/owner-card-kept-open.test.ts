// BOS-1755: an owner-only card the owner may be reading never vanishes. On 17 Nov a no-code ticket went to done
// with its owner_choice card open, and the stale-card clean-up withdrew the card with no word.
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { issueRunToken } from "../src/mcp.js";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { decisions, tickets } from "../src/db/schema.js";
import { closeInvalidCards } from "../src/services/card-validity.js";
import { mergeHolds } from "../src/services/review-holds.js";

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.app.close();
  await ctx?.close();
  ctx = undefined;
});

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Customer app" })).json() as { id: string };
  const worker = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Engineer" })).json() as { id: string };
  const ticket = async (title: string, noCode: boolean) => {
    const t = (await req("POST", `/api/projects/${project.id}/tickets`, { title, assigneeAgentId: worker.id })).json() as { id: string };
    await db.update(tickets).set({ noCode }).where(eq(tickets.id, t.id));
    return t;
  };
  return { ...built, db, close, company, worker, ticket };
}
type S = Awaited<ReturnType<typeof setup>>;

const cardOf = async (c: S, id: string) => (await c.db.select().from(decisions).where(eq(decisions.id, id)))[0]!;
const ownerChoice = (c: S, ticketId: string) =>
  c.decisions.raise({ companyId: c.company.id, agentId: c.worker.id, question: "Which CI server do we use?", options: ["Jenkins", "GitHub"], recommended: "Jenkins", blocksTicketId: ticketId, triedFirst: "Compared both", ownerOnly: "owner_choice", ownerOnlyWhy: "Product direction" });
const plain = (c: S, ticketId: string) =>
  c.decisions.raise({ companyId: c.company.id, agentId: c.worker.id, question: "Which colour for the footer?", options: ["Blue", "Red"], recommended: "Blue", blocksTicketId: ticketId, triedFirst: "Looked" });

describe("owner-only cards outlive their ticket (BOS-1755)", () => {
  it("keeps an unanswered owner_choice card open when its ticket is done, and labels it; a plain card still closes", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("Research", true);
    const q = await ownerChoice(c, t.id);
    const p = await plain(c, t.id);
    await c.db.update(tickets).set({ systemState: "done" }).where(eq(tickets.id, t.id));
    await closeInvalidCards(c.db);
    const kept = await cardOf(c, q.id);
    expect(kept.status).toBe("open");
    expect((kept.context as { keptOpen?: { note: string } }).keptOpen?.note).toMatch(/stays open until you do/);
    expect((await cardOf(c, p.id)).status).toBe("withdrawn");
  });

  it("a cancelled ticket's owner-only card stays open with a cancelled label, not withdrawn", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("Dropped", false);
    const q = await ownerChoice(c, t.id);
    await c.db.update(tickets).set({ systemState: "done", outcome: "cancelled" }).where(eq(tickets.id, t.id));
    await closeInvalidCards(c.db);
    const kept = await cardOf(c, q.id);
    expect(kept.status).toBe("open");
    expect((kept.context as { keptOpen?: { note: string } }).keptOpen?.note).toMatch(/was cancelled/);
  });

  // Both kinds of ticket: no-code (closes) and code (merges). The gate each path asks is mergeHolds (refuseIfHeld, startLanding, land).
  for (const noCode of [true, false]) {
    it(`end to end, ${noCode ? "no-code" : "code"} ticket: held while the owner-only card is open, sweep leaves it, goes on once answered`, async () => {
      const c = (ctx = await setup());
      const t = await c.ticket("Research", noCode);
      const q = await ownerChoice(c, t.id);
      const p = await plain(c, t.id);
      expect(await mergeHolds(c.db, t.id)).toEqual([{ kind: "card", id: q.id }]);
      await closeInvalidCards(c.db);
      expect((await cardOf(c, q.id)).status).toBe("open");
      expect(await mergeHolds(c.db, t.id)).toEqual([{ kind: "card", id: q.id }]); // still held after the sweep
      await c.db.update(decisions).set({ status: "answered", answer: "Jenkins" }).where(eq(decisions.id, q.id));
      expect(await mergeHolds(c.db, t.id)).toEqual([]); // a plain question never held
      expect(p.id).toBeTruthy();
      // The merge/close then goes ahead; a card on a finished ticket that is already answered is left alone.
      await c.db.update(tickets).set({ systemState: "done", ...(noCode ? {} : { mergeCommit: "abc1234" }) }).where(eq(tickets.id, t.id));
      expect((await cardOf(c, q.id)).status).toBe("answered");
    });
  }

  it("set_ticket_state done is refused while the ticket's own owner-only card is open, and allowed once answered or when cancelled", async () => {
    const c = (ctx = await setup());
    await c.app.listen({ host: "127.0.0.1", port: 0 });
    const t = await c.ticket("Research", true);
    await c.db.update(tickets).set({ systemState: "review" }).where(eq(tickets.id, t.id));
    const q = await ownerChoice(c, t.id);
    const token = await issueRunToken(c.db, { companyId: c.company.id, agentId: c.worker.id, runId: randomUUID() });
    const mcp = new Client({ name: "test", version: "0" });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(c.app.server.address() as { port: number }).port}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    try {
      const text = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0]?.text ?? "";
      const refused = await mcp.callTool({ name: "set_ticket_state", arguments: { ticketId: t.id, state: "done", summary: "Research finished." } });
      expect(text(refused)).toContain(`Card ${q.id} is the owner's question`);
      expect((await c.db.select().from(tickets).where(eq(tickets.id, t.id)))[0]!.systemState).toBe("review");
      // Once the owner has answered, nothing holds the ticket and the same move goes through.
      await c.db.update(decisions).set({ status: "answered", answer: "Jenkins" }).where(eq(decisions.id, q.id));
      const ok = await mcp.callTool({ name: "set_ticket_state", arguments: { ticketId: t.id, state: "done", summary: "Closed on the owner's answer." } });
      expect(text(ok)).not.toContain("is the owner's question");
    } finally {
      await mcp.close();
    }
  });

  // Rex's review: a steps/setsUp card is an after-merge setup card the owner does once the code is live; holding the merge for it would deadlock.
  for (const shape of [{ steps: ["Open the admin page", "Paste the key"] }, { setsUp: "the CI server" }]) {
    it(`an owner-only card with ${Object.keys(shape)[0]} does not hold the merge or refuse done`, async () => {
      const c = (ctx = await setup());
      await c.app.listen({ host: "127.0.0.1", port: 0 });
      const t = await c.ticket("Feature", false);
      await c.db.update(tickets).set({ systemState: "review" }).where(eq(tickets.id, t.id));
      const q = await ownerChoice(c, t.id);
      const row = await cardOf(c, q.id);
      await c.db.update(decisions).set({ context: { ...(row.context as object), ...shape } }).where(eq(decisions.id, q.id));
      expect(await mergeHolds(c.db, t.id)).toEqual([]);
      const token = await issueRunToken(c.db, { companyId: c.company.id, agentId: c.worker.id, runId: randomUUID() });
      const mcp = new Client({ name: "test", version: "0" });
      await mcp.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(c.app.server.address() as { port: number }).port}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
      try {
        const r = await mcp.callTool({ name: "set_ticket_state", arguments: { ticketId: t.id, state: "done", summary: "Built." } });
        expect((r as { content: Array<{ text: string }> }).content[0]?.text ?? "").not.toContain("is the owner's question");
      } finally {
        await mcp.close();
      }
    });
  }

  it("a merged code ticket's unanswered owner-only card is not closed by the 'is merged' row", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("Feature", false);
    const q = await ownerChoice(c, t.id);
    await c.db.update(tickets).set({ mergeCommit: "abc1234" }).where(eq(tickets.id, t.id));
    await closeInvalidCards(c.db);
    expect((await cardOf(c, q.id)).status).toBe("open");
  });
});
