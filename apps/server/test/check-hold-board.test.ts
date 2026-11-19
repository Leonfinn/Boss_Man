// BOS-1906: the board shows a ticket handed in and waiting for its quick check as "checking" (its own lane at the top of
// Review) with its place in the check line, and not as the owner's: no review is open on purpose.
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { checkJobs, tickets } from "../src/db/schema.js";

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
  const req = (method: "POST" | "GET", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Customer app" })).json() as { id: string };
  const worker = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Engineer" })).json() as { id: string };
  const ticket = async (title: string) => {
    const t = (await req("POST", `/api/projects/${project.id}/tickets`, { title, assigneeAgentId: worker.id })).json() as { id: string };
    await db.update(tickets).set({ systemState: "review" }).where(eq(tickets.id, t.id));
    return t.id;
  };
  const board = async () => {
    const b = (await req("GET", `/api/projects/${project.id}/board`)).json() as { columns: Array<{ tickets: Array<{ id: string; reviewStage?: string | null; checkLine?: string | null; waitingOnOwner?: boolean }> }> };
    return b.columns.flatMap((c) => c.tickets);
  };
  return { ...built, db, close, company, project, worker, ticket, board };
}

describe("the board's Being checked stage (BOS-1906)", () => {
  it("shows a held ticket as checking, with its place in line, and not as the owner's", async () => {
    ctx = await setup();
    const c = ctx;
    const ahead = await c.ticket("Ahead in line");
    const held = await c.ticket("Held for its check");
    await c.db.update(tickets).set({ checkHoldAt: new Date() }).where(eq(tickets.id, held));
    for (const id of [ahead, held]) await c.db.insert(checkJobs).values({ companyId: c.company.id, projectId: c.project.id, ticketId: id, kind: "pre_review", scope: "quick", commit: "abc", tree: id, state: "queued" });
    const cards = await c.board();
    const card = cards.find((t) => t.id === held)!;
    expect(card).toMatchObject({ reviewStage: "checking", waitingOnOwner: false });
    expect(card.checkLine).toMatch(/in line|running now/);
    // A review ticket with no mark and no reviews is still the owner's, as before.
    expect(cards.find((t) => t.id === ahead)!.waitingOnOwner).toBe(true);
    await c.db.update(checkJobs).set({ state: "running" }).where(eq(checkJobs.ticketId, held));
    expect((await c.board()).find((t) => t.id === held)!.checkLine).toBe("running now");
  });
});
