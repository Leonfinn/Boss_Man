// DR-058 (BOS-1323): an owner card an agent or the CEO withdraws before the owner answered it leaves a notice on
// Decisions and one quiet feed note, and the withdraw tools refuse a call that doesn't say why and what replaces it.
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { decisions, notifications, tickets } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";
import { parseReplacedBy, recentClosedNotices, withdrawnNotice } from "../src/services/closed-notice.js";

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
  const { company, ceo } = (await req("POST", "/api/companies", { name: "Web Co" })).json() as { company: { id: string }; ceo: { id: string } };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Website" })).json() as { id: string };
  const brian = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Brian" })).json() as { id: string };
  const clients: Client[] = [];
  const mcp = async (agentId: string) => {
    const token = await issueRunToken(db, { companyId: company.id, agentId, runId: randomUUID() });
    const c = new Client({ name: "t", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    clients.push(c);
    return c;
  };
  const ticket = async (title: string) => (await req("POST", `/api/projects/${project.id}/tickets`, { title, assigneeAgentId: brian.id })).json() as { id: string; ref: string };
  /** An agent's question card, on the owner's queue (past the CEO handover), optionally in the middle of the handover. */
  const card = async (ticketId: string, o: { question?: string; rung?: string; context?: object } = {}) => {
    const [row] = await db
      .insert(decisions)
      .values({
        companyId: company.id,
        kind: "question",
        question: o.question ?? "Publish the website launch announcement?",
        options: ["Yes", "No"],
        recommendedOption: "Yes",
        raisedByAgentId: brian.id,
        tier: "owner",
        context: { type: "question", ticketId, ...(o.rung ? { ladder: { rung: o.rung, since: new Date().toISOString(), hops: [] } } : {}), ...(o.context ?? {}) },
      })
      .returning();
    return row!;
  };
  const feed = async () => (await db.select().from(notifications)).filter((n) => n.title.startsWith("Withdrawn by"));
  return { ...built, db, close, req, company, ceo, project, brian, mcp, clients, ticket, card, feed };
}

const textOf = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? "");
const isError = (r: unknown) => (r as { isError?: boolean }).isError === true;
const WHY = "The launch moved to next week, so this question is no longer needed now.";

describe("withdrawn owner cards tell the owner (DR-058)", () => {
  it("an agent withdraws a card that reached the owner: the notice says why, and the feed gets one quiet note", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("Website launch");
    const d = await c.card(t.id);
    const mcp = await c.mcp(c.brian.id);
    const r = await mcp.callTool({ name: "withdraw_decision", arguments: { decisionId: d.id, reason: "Jane's scan has not passed yet.", replacedBy: "ticket:BOS-83", when: "Brian raises one fresh card after the scan passes" } });
    expect(isError(r), textOf(r)).toBe(false);

    const [after] = await c.db.select().from(decisions).where(eq(decisions.id, d.id));
    expect(after!.status).toBe("withdrawn");
    const notice = (after!.context as { closedNotice?: { why: string; text: string; until: string } }).closedNotice;
    expect(notice?.why).toBe("withdrawn");
    expect(notice?.text).toMatch(/^Withdrawn by Brian on [A-Z]+-\d+: Jane's scan has not passed yet\./);
    expect(notice?.text).toContain("BOS-83: Brian raises one fresh card after the scan passes");
    expect(notice?.text).toContain("You don't need to do anything for this card.");
    // Decisions shows it where the card was.
    expect((await recentClosedNotices(c.db)).map((n) => n.id)).toContain(d.id);
    // One feed note, at info level ("note": no phone push), with the same text.
    const feed = await c.feed();
    expect(feed).toHaveLength(1);
    expect(feed[0]!.level).toBe("note");
    expect(feed[0]!.pushedAt).toBeNull();
    expect(feed[0]!.body).toBe(notice!.text);
  });

  it("the CEO's withdraw does the same, and card:<id> links straight to the newer card", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("Website launch");
    const old = await c.card(t.id);
    // The same question twice, so the CEO may clear the older one as a duplicate.
    const fresh = await c.card(t.id);
    const ceo = await c.mcp(c.ceo.id);
    const r = await ceo.callTool({ name: "decisions", arguments: { action: "withdraw", id: old.id, note: "A better-worded card replaces this one.", replacedBy: `card:${fresh.id}` } });
    expect(isError(r), textOf(r)).toBe(false);
    const [after] = await c.db.select().from(decisions).where(eq(decisions.id, old.id));
    const notice = (after!.context as { closedNotice?: { why: string; newer?: { decisionId: string; label: string }; text: string } }).closedNotice!;
    expect(notice.why).toBe("withdrawn");
    expect(notice.newer).toEqual({ decisionId: fresh.id, label: "Publish the website launch announcement?" });
    expect(notice.text).toContain("Withdrawn by ");
    expect(await c.feed()).toHaveLength(1);
  });

  it("refuses a withdraw with no 'replaced by' or no reason, naming both fields, and leaves the card open", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("Website launch");
    const d = await c.card(t.id);
    const mcp = await c.mcp(c.brian.id);
    for (const args of [{ reason: WHY }, { replacedBy: "none" }, { reason: WHY, replacedBy: "maybe" }, { reason: WHY, replacedBy: "ticket:BOS-83" }, { reason: "too short for none", replacedBy: "none" }]) {
      const r = await mcp.callTool({ name: "withdraw_decision", arguments: { decisionId: d.id, ...args } });
      expect(isError(r)).toBe(true);
      expect(textOf(r)).toMatch(/reason/);
      expect(textOf(r)).toMatch(/replacedBy/);
    }
    // The CEO's tool too, on a card it may clear (its ticket is done).
    await c.db.update(tickets).set({ systemState: "done" }).where(eq(tickets.id, t.id));
    const ceo = await c.mcp(c.ceo.id);
    const r2 = await ceo.callTool({ name: "decisions", arguments: { action: "withdraw", id: d.id, note: WHY } });
    expect(isError(r2)).toBe(true);
    expect(textOf(r2)).toMatch(/replacedBy/);
    expect(textOf(r2)).toMatch(/reason|note/);
    const [after] = await c.db.select().from(decisions).where(eq(decisions.id, d.id));
    expect(after!.status).toBe("open");
    expect(await c.feed()).toHaveLength(0);
  });

  it("a withdraw whose ticket is already done leaves the notice but no feed note", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("Website launch");
    await c.db.update(tickets).set({ systemState: "done" }).where(eq(tickets.id, t.id));
    const d = await c.card(t.id);
    const mcp = await c.mcp(c.brian.id);
    const r = await mcp.callTool({ name: "withdraw_decision", arguments: { decisionId: d.id, reason: WHY, replacedBy: "none" } });
    expect(textOf(r)).toMatch(/^Withdrew decision/);
    const [after] = await c.db.select().from(decisions).where(eq(decisions.id, d.id));
    expect((after!.context as { closedNotice?: { why: string } }).closedNotice?.why).toBe("withdrawn");
    expect(await c.feed()).toHaveLength(0);
  });

  it("a withdraw during the CEO's handover gets neither a notice nor a feed note", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("Website launch");
    const d = await c.card(t.id, { rung: "ceo" });
    const mcp = await c.mcp(c.brian.id);
    const r = await mcp.callTool({ name: "withdraw_decision", arguments: { decisionId: d.id, reason: WHY, replacedBy: "none" } });
    expect(textOf(r)).toMatch(/^Withdrew decision/);
    const [after] = await c.db.select().from(decisions).where(eq(decisions.id, d.id));
    expect(after!.status).toBe("withdrawn");
    expect((after!.context as { closedNotice?: unknown }).closedNotice).toBeUndefined();
    expect(await c.feed()).toHaveLength(0);
  });

  it("an owner who was part-way through the card gets a flag, not a note", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("Website launch");
    const d = await c.card(t.id, { context: { ownerOpenedAt: new Date().toISOString() } });
    const mcp = await c.mcp(c.brian.id);
    const r = await mcp.callTool({ name: "withdraw_decision", arguments: { decisionId: d.id, reason: WHY, replacedBy: "none" } });
    expect(textOf(r)).toMatch(/^Withdrew decision/);
    const feed = await c.feed();
    expect(feed).toHaveLength(1);
    expect(feed[0]!.level).toBe("flag");
  });

  it("several withdraws by one agent within two minutes become one feed note listing each", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("Website launch");
    const a = await c.card(t.id, { question: "Publish the announcement?" });
    const b = await c.card(t.id, { question: "Publish the pricing page?" });
    const mcp = await c.mcp(c.brian.id);
    for (const [d, why] of [[a, "The announcement moved to next week for good."], [b, "The pricing page moved to next week for good."]] as const) {
      expect(isError(await mcp.callTool({ name: "withdraw_decision", arguments: { decisionId: d.id, reason: why, replacedBy: "none" } }))).toBe(false);
    }
    const feed = await c.feed();
    expect(feed).toHaveLength(1);
    expect(feed[0]!.body).toContain("announcement moved");
    expect(feed[0]!.body).toContain("pricing page moved");
    // Each card still has its own notice.
    for (const d of [a, b]) {
      const [row] = await c.db.select().from(decisions).where(eq(decisions.id, d.id));
      expect((row!.context as { closedNotice?: { why: string } }).closedNotice?.why).toBe("withdrawn");
    }
  });

  it("adds the undo wording when the card had steps", () => {
    const n = withdrawnNotice({ agent: "Brian", ticket: "BOS-83", reason: "Not needed.", replacedBy: { kind: "none" }, steps: ["Run it"], now: new Date("2026-11-12T20:30:00Z") });
    expect(n.text).toContain("Nothing you ran needs undoing.");
    expect(n.until).toBe("2026-11-12T22:30:00.000Z");
  });

  it("parseReplacedBy accepts exactly one form", () => {
    const id = randomUUID();
    expect(parseReplacedBy({ reason: WHY, replacedBy: `card:${id}` })).toMatchObject({ ok: true, replacedBy: { kind: "card", id } });
    expect(parseReplacedBy({ reason: WHY, replacedBy: "ticket:BOS-9", when: "next week" })).toMatchObject({ ok: true, replacedBy: { kind: "ticket", ref: "BOS-9", when: "next week" } });
    expect(parseReplacedBy({ reason: WHY, replacedBy: "none" }).ok).toBe(true);
    expect(parseReplacedBy({ reason: "short none", replacedBy: "none" }).ok).toBe(false);
    expect(parseReplacedBy({ reason: WHY, replacedBy: "card:nope" }).ok).toBe(false);
  });
});
