// BOS-2077 (cock-ups F4): an owner's note on a card nobody watches wakes the CEO with "owner hand-back".
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { decisions, tickets, wakes } from "../src/db/schema.js";
import { HAND_BACK_MINUTES, HAND_BACK_NO_TICKET, HAND_BACK_TICKETED, OWNER_HAND_BACK, TODO_DONE, TODO_PARTLY, handBackKey } from "../src/services/decisions.js";
import { WAKE_CLASS } from "../src/services/wake-classes.js";
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
  const clients: Client[] = [];
  const mcp = async (agentId: string) => {
    const token = await issueRunToken(db, { companyId: company.id, agentId, runId: randomUUID() });
    const c = new Client({ name: "t", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    clients.push(c);
    return c;
  };
  const ticket = async (title: string, done: boolean) => {
    const t = (await req("POST", `/api/projects/${project.id}/tickets`, { title })).json() as { id: string };
    if (done) await db.update(tickets).set({ systemState: "done" }).where(eq(tickets.id, t.id));
    return t;
  };
  /** Boss Man's own go-live card: no raising agent. */
  const setupCard = async (ticketId: string) =>
    (
      await db
        .insert(decisions)
        .values({ companyId: company.id, kind: "question", question: "Sitemap is live.\n\nSteps:\n\n1. Add the sitemap in Search Console", options: [TODO_DONE, TODO_PARTLY], recommendedOption: TODO_DONE, tier: "owner", context: { type: "owner_setup", ticketId, steps: ["Add the sitemap in Search Console"], commit: "abc" } })
        .returning()
    )[0]!;
  return { ...built, db, close, req, company, ceo, worker, project, mcp, clients, ticket, setupCard };
}

const handBackWakes = (c: NonNullable<typeof ctx>) => c.db.select().from(wakes).where(and(eq(wakes.agentId, c.ceo.id), eq(wakes.reason, OWNER_HAND_BACK)));
const handBackCards = async (c: NonNullable<typeof ctx>, id: string) => (await c.db.select().from(decisions).where(eq(decisions.dedupeKey, handBackKey(id))));

describe("owner hand-back (BOS-2077)", () => {
  it("is a never-dropped wake class", () => {
    expect(WAKE_CLASS[OWNER_HAND_BACK]).toBe("waiting");
  });

  it("an owner note on a card Boss Man raised itself wakes the CEO and leaves a 2-hour card", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("Sitemap", true);
    const card = await c.setupCard(t.id);
    await c.decisions.answer(card.id, TODO_DONE, { note: "you should be able to add the sitemap" });
    expect((await handBackWakes(c)).length).toBe(1);
    const [hb] = await handBackCards(c, card.id);
    expect(hb!.status).toBe("open");
    expect(hb!.tier).toBe("ceo");
    expect(hb!.question).toContain("you should be able to add the sitemap");
    expect((hb!.context as { ladder: { minutes: number; rung: string } }).ladder).toMatchObject({ rung: "ceo", minutes: HAND_BACK_MINUTES });
    expect(HAND_BACK_MINUTES).toBe(120);
  });

  it("'Partly done / I need help' wakes the CEO even with no note", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("Sitemap", false);
    const card = await c.setupCard(t.id);
    await c.decisions.answer(card.id, TODO_PARTLY, {});
    expect((await handBackWakes(c)).length).toBe(1);
    expect((await handBackCards(c, card.id)).length).toBe(1);
  });

  it("a plain 'Done' with no note wakes nobody", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("Sitemap", true);
    const card = await c.setupCard(t.id);
    await c.decisions.answer(card.id, TODO_DONE, {});
    expect(await handBackWakes(c)).toEqual([]);
    expect(await handBackCards(c, card.id)).toEqual([]);
  });

  it("an agent's card on a ticket still in progress keeps its own wake and gets no hand-back", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("Pick a provider", false);
    const card = await c.decisions.raise({ companyId: c.company.id, agentId: c.worker.id, question: "Which provider?", options: ["Stripe", "Mollie"], recommended: "Stripe", blocksTicketId: t.id, triedFirst: "Compared both" });
    await c.decisions.answer(card.id, "Stripe", { note: "also check fees" });
    expect(await handBackWakes(c)).toEqual([]);
  });

  it("an agent-raised card that outlives its done ticket also goes to the CEO", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("Sitemap", true);
    const card = await c.setupCard(t.id);
    await c.db.update(decisions).set({ raisedByAgentId: c.worker.id }).where(eq(decisions.id, card.id));
    await c.decisions.answer(card.id, TODO_DONE, { note: "also add the second sitemap" });
    expect((await handBackWakes(c)).length).toBe(1);
  });

  it("the CEO closes the hand-back card with either answer", async () => {
    const c = (ctx = await setup());
    for (const answer of [HAND_BACK_TICKETED, HAND_BACK_NO_TICKET]) {
      const t = await c.ticket(`Sitemap ${answer}`, true);
      const card = await c.setupCard(t.id);
      await c.decisions.answer(card.id, TODO_DONE, { note: "please add the sitemap" });
      const [hb] = await handBackCards(c, card.id);
      const r = await (await c.mcp(c.ceo.id)).callTool({ name: "decisions", arguments: { action: "answer", id: hb!.id, answer, note: "Made BOS ticket / replied to the owner." } });
      expect((r as { isError?: boolean }).isError).not.toBe(true);
      expect((await handBackCards(c, card.id))[0]!.status).toBe("answered");
    }
  });
});
