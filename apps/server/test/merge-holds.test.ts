// DR-061 Q2b (BOS-1533): one "held at the merge gate" answer, mergeHolds, for the merge paths, the sweeps and the screen.
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { decisions, reviewRequests, ticketDependencies, tickets } from "../src/db/schema.js";
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
  const req = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Site" })).json() as { id: string };
  const approvedTicket = async (title: string) => {
    const t = (await req("POST", `/api/projects/${project.id}/tickets`, { title })).json() as { id: string };
    await db.update(tickets).set({ systemState: "review" }).where(eq(tickets.id, t.id));
    await db.insert(reviewRequests).values({ ticketId: t.id, kind: "code", round: 1, status: "approved" });
    return t.id;
  };
  const linkedCard = async (ticketId: string, context: Record<string, unknown>) => {
    const [d] = await db
      .insert(decisions)
      .values({ companyId: company.id, kind: "question", question: "A card?", options: ["Yes"], recommendedOption: "Yes", tier: "ceo", context })
      .returning({ id: decisions.id });
    await db.insert(ticketDependencies).values({ blockedTicketId: ticketId, blockerDecisionId: d!.id });
    return d!.id;
  };
  return { ...built, db, close, req, company, project, approvedTicket, linkedCard };
}

describe("mergeHolds (DR-061 Q2b)", () => {
  it("is empty for an approved ticket nothing holds", async () => {
    const c = (ctx = await setup());
    const id = await c.approvedTicket("Plain");
    expect(await mergeHolds(c.db, id)).toEqual([]);
  });

  it("counts a card that holds the merge, not a plain question linked to the ticket", async () => {
    const c = (ctx = await setup());
    const plain = await c.approvedTicket("Plain question");
    await c.linkedCard(plain, { type: "question" });
    expect(await mergeHolds(c.db, plain)).toEqual([]);
    const held = await c.approvedTicket("Held by a card");
    const cardId = await c.linkedCard(held, { type: "question", holdsMerge: "true" });
    expect(await mergeHolds(c.db, held)).toEqual([{ kind: "card", id: cardId }]);
  });

  it("counts the owner's sign-off card first", async () => {
    const c = (ctx = await setup());
    const id = await c.approvedTicket("Needs sign-off");
    const [d] = await c.db
      .insert(decisions)
      .values({ companyId: c.company.id, kind: "question", question: "Merge it?", options: ["Approve"], recommendedOption: "Approve", tier: "owner", context: { type: "risk_review", ticketId: id } })
      .returning({ id: decisions.id });
    expect(await mergeHolds(c.db, id)).toEqual([{ kind: "signoff", id: d!.id }]);
  });

  it("counts a wait on an open ticket that fixes the merge check, and the queue shows it as waiting", async () => {
    const c = (ctx = await setup());
    const id = await c.approvedTicket("Waits on the fix");
    const fix = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "Fix the gate" })).json() as { id: string };
    await c.db.update(tickets).set({ fixesMergeCheck: true }).where(eq(tickets.id, fix.id));
    expect(await mergeHolds(c.db, id)).toEqual([{ kind: "waits", ids: [fix.id] }]);
    // The fix itself never waits on another such ticket.
    expect(await mergeHolds(c.db, fix.id)).toEqual([]);
    const data = (await c.req("GET", `/api/companies/${c.company.id}/merge-queue`)).json() as { waiting: Array<{ ticketId: string; state: string; stuck: boolean }> };
    const row = data.waiting.find((r) => r.ticketId === id);
    expect(row).toMatchObject({ state: "waiting_for_other_ticket", stuck: false });
  });
});
