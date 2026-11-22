// BOS-1691 (cock-ups log, 16 Nov ~20:20 "card disappeared"): the owner answered a sign-off, which hid the CEO's question
// card on the same ticket for a re-check, and a minute later the CEO withdrew it. Neither step told the owner why. Every
// way a card leaves the owner's list now says who and why, a re-check leaves a line in its place, an owner who had the
// card open gets a feed note, and the CEO's decisions read takes a short id.
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { decisions } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";
import { closeCardBySystem, RECHECK_AUTHOR_MS, RECHECK_CEO_MS } from "../src/services/card-validity.js";
import { recentClosedNotices, recheckBackBy, recheckLine } from "../src/services/closed-notice.js";
import type { NotifyInput } from "../src/services/notifications.js";
import { ownerActed } from "../src/services/stale-requests.js";

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
  const req = (method: "GET" | "POST", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company, ceo } = (await req("POST", "/api/companies", { name: "Shop Co" })).json() as { company: { id: string }; ceo: { id: string } };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Shop" })).json() as { id: string };
  const brian = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Brian" })).json() as { id: string };
  const clients: Client[] = [];
  const mcp = async (agentId: string) => {
    const token = await issueRunToken(db, { companyId: company.id, agentId, runId: randomUUID() });
    const c = new Client({ name: "t", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    clients.push(c);
    return c;
  };
  const ticket = async (title: string) => (await req("POST", `/api/projects/${project.id}/tickets`, { title, assigneeAgentId: brian.id })).json() as { id: string };
  /** An agent's question card on the owner's list (past the CEO handover), or still with the CEO when `rung` is "ceo". */
  const card = async (ticketId: string, o: { question?: string; rung?: string; opened?: Date; id?: string } = {}) => {
    const [row] = await db
      .insert(decisions)
      .values({
        ...(o.id ? { id: o.id } : {}),
        companyId: company.id,
        kind: "question",
        question: o.question ?? "Which payment provider for the shop?",
        options: ["Stripe", "PayPal"],
        recommendedOption: "Stripe",
        raisedByAgentId: brian.id,
        tier: "owner",
        context: { type: "question", ticketId, ...(o.rung ? { ladder: { rung: o.rung, since: new Date().toISOString(), hops: [] } } : {}), ...(o.opened ? { ownerOpenedAt: o.opened.toISOString() } : {}) },
      })
      .returning();
    return row!;
  };
  return { ...built, db, close, req, company, ceo, brian, mcp, clients, ticket, card };
}

const feedLog = () => {
  const sent: NotifyInput[] = [];
  return { sent, notify: async (n: NotifyInput) => void sent.push(n) };
};
const textOf = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? "");
const isError = (r: unknown) => (r as { isError?: boolean }).isError === true;
const noticeOf = async (db: Awaited<ReturnType<typeof setup>>["db"], id: string) =>
  ((await db.select().from(decisions).where(eq(decisions.id, id)))[0]!.context as { closedNotice?: { why: string; text: string; until: string; newer?: { decisionId: string; label: string } } }).closedNotice;

describe("the re-check line (pure)", () => {
  it("names who checks it, after which of the owner's actions, and the latest time it is back", () => {
    const at = new Date("2026-11-16T20:18:00Z");
    expect(recheckBackBy({ recheckStage: "author", recheckStageAt: at }, RECHECK_AUTHOR_MS, RECHECK_CEO_MS)!.toISOString()).toBe("2026-11-16T21:18:00.000Z");
    expect(recheckBackBy({ recheckStage: "ceo", recheckStageAt: at }, RECHECK_AUTHOR_MS, RECHECK_CEO_MS)!.toISOString()).toBe("2026-11-16T20:48:00.000Z");
    expect(recheckBackBy({ recheckStage: "lapsed", recheckStageAt: at }, RECHECK_AUTHOR_MS, RECHECK_CEO_MS)).toBeNull();
    const line = recheckLine({ by: "the CEO", reason: 'the owner answered "Sign off BOS-1641?"', backBy: new Date("2026-11-16T21:18:00Z") });
    expect(line).toBe('Being re-checked by the CEO after you answered "Sign off BOS-1641?". Back on your list by 21:18 UTC unless it is confirmed or closed first; if it closes, this list says why.');
    expect(recheckLine({ by: "Brian", reason: "the runners were rebuilt", backBy: null })).toMatch(/^Being re-checked by Brian because the runners were rebuilt\. Back on your list within the hour/);
  });
});

describe("a card Boss Man closes by itself says why (BOS-1691)", () => {
  it("leaves a 'closed because' notice for 2 hours and lists it in Decisions; no feed note when the owner wasn't on it", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("Payments");
    const d = await c.card(t.id);
    const feed = feedLog();
    const now = new Date();
    expect(await closeCardBySystem(c.db, d, `its ticket "Payments" is finished`, { now: () => now, notify: feed.notify })).toBe(true);
    const n = await noticeOf(c.db, d.id);
    expect(n?.why).toBe("closed");
    expect(n?.text).toBe('Closed by Boss Man because its ticket "Payments" is finished. It needs nothing from you any more.');
    expect(Date.parse(n!.until) - now.getTime()).toBe(2 * 3_600_000);
    expect((await recentClosedNotices(c.db)).map((r) => r.id)).toContain(d.id);
    expect(feed.sent).toHaveLength(0);
  });

  it("a superseded card points to the newer one, and an owner who had it open gets a feed note", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("Payments");
    const old = await c.card(t.id, { opened: new Date(Date.now() - 60_000) });
    const newer = await c.card(t.id, { question: "Which payment provider, now that PayPal is out?" });
    const feed = feedLog();
    expect(await closeCardBySystem(c.db, old, `superseded by ${newer.id}`, { notify: feed.notify })).toBe(true);
    const n = await noticeOf(c.db, old.id);
    expect(n).toMatchObject({ why: "newer", newer: { decisionId: newer.id, label: "Which payment provider, now that PayPal is out?" } });
    expect(n?.text).toMatch(/^Replaced by a newer card: "Which payment provider, now that PayPal is out\?"\. Answer that one instead/);
    expect(feed.sent).toEqual([expect.objectContaining({ level: "flag", title: "A card you had open was replaced", link: "#/decisions", body: expect.stringContaining("Which payment provider for the shop?") })]);
  });

  it("a card still with the CEO in its handover never reached the owner, so it leaves no notice", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("Payments");
    const d = await c.card(t.id, { rung: "ceo", opened: new Date() });
    const feed = feedLog();
    expect(await closeCardBySystem(c.db, d, `its ticket "Payments" is finished`, { notify: feed.notify })).toBe(true);
    expect(await noticeOf(c.db, d.id)).toBeUndefined();
    expect(feed.sent).toHaveLength(0);
  });
});

describe("a card hidden for a re-check leaves a line in its place (BOS-1691)", () => {
  it("the list says who re-checks it after which answer and when it is back; an owner who had it open is told", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("Payments");
    const opened = await c.card(t.id, { opened: new Date(Date.now() - 5 * 60_000) });
    const untouched = await c.card(t.id, { question: "Ship the receipts email too?" });
    const feed = feedLog();
    const now = new Date();
    await ownerActed(c.db, { companyId: c.company.id, ticketIds: [t.id], reason: 'the owner answered "Sign off BOS-1641?"', now, notify: feed.notify });
    const listed = (await c.decisions.queue({ includeAll: true })) as unknown as Array<{ id: string; waiting?: string; rechecking?: { by: string; backBy?: string; hidden?: boolean } }>;
    const row = listed.find((d) => d.id === opened.id)!;
    const back = new Date(now.getTime() + RECHECK_AUTHOR_MS + RECHECK_CEO_MS);
    const hhmm = `${String(back.getUTCHours()).padStart(2, "0")}:${String(back.getUTCMinutes()).padStart(2, "0")} UTC`;
    expect(row.waiting).toBe(`Being re-checked by Brian after you answered "Sign off BOS-1641?". Back on your list by ${hhmm} unless it is confirmed or closed first; if it closes, this list says why.`);
    expect(row.rechecking).toMatchObject({ by: "Brian", hidden: true, backBy: back.toISOString() });
    // Only the card the owner had open sends a feed note.
    expect(feed.sent).toHaveLength(1);
    expect(feed.sent[0]).toMatchObject({ level: "flag", title: "A card you had open is being re-checked", link: "#/decisions" });
    expect(feed.sent[0]!.body).toContain("Which payment provider for the shop?");
    expect(feed.sent[0]!.body).not.toContain(untouched.question);
  });

  it("opening any card by its link marks it opened, not only hand-apply cards", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("Payments");
    const d = await c.card(t.id);
    const r = await c.req("POST", `/api/decisions/${d.id}/opened`, {});
    expect(r.json()).toEqual({ ok: true });
    const [row] = await c.db.select().from(decisions).where(eq(decisions.id, d.id));
    expect((row!.context as { ownerOpenedAt?: string }).ownerOpenedAt).toBeTruthy();
  });
});

// The resolver itself is BOS-1695's (services/card-id.ts, tested in card-short-id.test.ts); this pins the read case.
describe("decisions read takes a short id (BOS-1691)", () => {
  it("reads a card by its first 8 characters and says when a prefix is ambiguous or unknown", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("Payments");
    const a = await c.card(t.id, { id: "a65d0309-1111-4111-8111-111111111111", question: "Card A" });
    await c.card(t.id, { id: "ff1f7a1b-2222-4222-8222-222222222222", question: "Card B" });
    await c.card(t.id, { id: "ff1f7a1b-3333-4333-8333-333333333333", question: "Card C" });
    const ceo = await c.mcp(c.ceo.id);
    const one = await ceo.callTool({ name: "decisions", arguments: { action: "read", id: "a65d0309" } });
    expect(isError(one), textOf(one)).toBe(false);
    expect(textOf(one)).toContain(a.id);
    expect(textOf(one)).toContain("Card A");
    const both = await ceo.callTool({ name: "decisions", arguments: { action: "read", id: "ff1f7a1b" } });
    expect(isError(both)).toBe(true);
    expect(textOf(both)).toMatch(/ff1f7a1b matches more than one card/);
    expect(textOf(both)).toContain("ff1f7a1b-2222-4222-8222-222222222222");
    expect(textOf(both)).toContain("ff1f7a1b-3333-4333-8333-333333333333");
    const none = await ceo.callTool({ name: "decisions", arguments: { action: "read", id: "0badc0de" } });
    expect(isError(none)).toBe(true);
    expect(textOf(none)).toMatch(/No card in your company starts with 0badc0de/);
    const full = await ceo.callTool({ name: "decisions", arguments: { action: "read", id: a.id } });
    expect(isError(full)).toBe(false);
  });
});
