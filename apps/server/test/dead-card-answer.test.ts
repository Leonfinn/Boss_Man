// BOS-1535 (DR-061 F5): a dead card is closed, not answered. answer() asks cardInvalidReason; engagement cards close with their engagement.
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { agents, companies, decisions, engagements, tickets } from "../src/db/schema.js";
import { cardInvalidReason } from "../src/services/card-validity.js";

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
  const req = (method: "POST", url: string, payload: unknown) => built.app.inject({ method, url, headers: { cookie }, payload: payload as object });
  const co = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } };
  const project = (await req("POST", `/api/companies/${co.company.id}/projects`, { name: "Customer app" })).json() as { id: string };
  const [agent] = await db.insert(agents).values({ companyId: co.company.id, name: "A", role: "worker", agentKind: "claude" } as never).returning();
  const ticket = async (patch: Partial<typeof tickets.$inferInsert>) => (await db.insert(tickets).values({ companyId: co.company.id, projectId: project.id, title: "T", systemState: "in_progress", ...patch }).returning())[0]!;
  return { ...built, db, close, ticket, agentId: agent!.id, companyId: co.company.id };
}

describe("answering a dead card", () => {
  it("closes a plan card whose ticket is already in review and leaves planApprovedAt alone", async () => {
    ctx = await setup();
    const t = await ctx.ticket({ systemState: "review" });
    const [d] = await ctx.db
      .insert(decisions)
      .values({ companyId: ctx.companyId, kind: "question", question: "Approve this plan?", options: ["Approve", "Reject"], recommendedOption: "Approve", raisedByAgentId: ctx.agentId, context: { type: "question", plan: true, ticketId: t.id } })
      .returning();
    expect(await cardInvalidReason(ctx.db, d!)).toContain("in review");
    // `plan: true` on a question context is not a plan card by the table's rule; use the permission shape the planner raises.
    await ctx.db.update(decisions).set({ context: { type: "permission", plan: true, ticketId: t.id } as never }).where(eq(decisions.id, d!.id));
    await expect(ctx.decisions.answer(d!.id, "Approve")).rejects.toThrow(/no longer valid/);
    const [after] = await ctx.db.select().from(decisions).where(eq(decisions.id, d!.id));
    expect(after!.status).toBe("withdrawn");
    const [tk] = await ctx.db.select().from(tickets).where(eq(tickets.id, t.id));
    expect(tk!.planApprovedAt).toBeNull();
  });
});

describe("engagement cards", () => {
  it("are dead once the engagement is rejected", async () => {
    ctx = await setup();
    const [requester] = await ctx.db.insert(companies).values({ name: "Other Co", ticketPrefix: "OTH" } as never).returning();
    const [other] = (await ctx.db.insert(engagements).values({ requesterCompanyId: requester!.id, providerCompanyId: ctx.companyId, title: "Help", scope: "s", deliverables: "d", acceptanceCriteria: [], status: "rejected" } as never).returning()) as Array<{ id: string }>;
    const [d] = await ctx.db
      .insert(decisions)
      .values({ companyId: ctx.companyId, kind: "engagement", question: "Approve the work?", options: ["Approve", "Reject"], recommendedOption: "Approve", raisedByAgentId: ctx.agentId, context: { type: "engagement", engagementId: other!.id } })
      .returning();
    expect(await cardInvalidReason(ctx.db, d!)).toContain("rejected");
    await expect(ctx.decisions.answer(d!.id, "Approve")).rejects.toThrow(/no longer valid/);
  });
});
