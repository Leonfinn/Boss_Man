// BOS-1531 (DR-061 F1): every copy of "has this blocker finished?" answers like ticketBlockerFinished.
// Each case uses a blocker that is merged but not done, on a link that waits "until merged": the shape the old copies got wrong.
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { decisions, ticketDependencies, tickets } from "../src/db/schema.js";
import { closeCardBySystem } from "../src/services/card-validity.js";
import { cantMoveFor } from "../src/services/agent-wip.js";
import { ticketBlockerFinished, ticketBlockerOpenSql } from "../src/services/ticket-links.js";

const SHA = "c".repeat(40);

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
  const ticket = async (patch: Partial<typeof tickets.$inferInsert>) => (await db.insert(tickets).values({ companyId: co.company.id, projectId: project.id, title: "T", systemState: "in_progress", ...patch }).returning())[0]!;
  const link = async (blocked: string, blocker: string, until: "merged" | "done") => void (await db.insert(ticketDependencies).values({ blockedTicketId: blocked, blockerTicketId: blocker, until }));
  return { ...built, db, close, ticket, link, companyId: co.company.id };
}

describe("ticketBlockerOpenSql parity", () => {
  it("agrees with ticketBlockerFinished on every state / merge / until combination", async () => {
    ctx = await setup();
    for (const state of ["in_progress", "review", "blocked", "done"] as const) {
      for (const merged of [false, true]) {
        for (const until of ["merged", "done"] as const) {
          const blocked = await ctx.ticket({ systemState: "blocked", title: "W" });
          const blocker = await ctx.ticket({ systemState: state, mergeCommit: merged ? SHA : null, title: "B" });
          await ctx.link(blocked.id, blocker.id, until);
          const rows = await ctx.db.execute(sql`select ${ticketBlockerOpenSql("d", "b")} as open from ticket_dependencies d join tickets b on b.id = d.blocker_ticket_id where d.blocked_ticket_id = ${blocked.id}`);
          const open = (rows as unknown as { rows?: Array<{ open: boolean }> }).rows?.[0]?.open ?? (rows as unknown as Array<{ open: boolean }>)[0]?.open;
          expect(open, `${state} merged=${merged} until=${until}`).toBe(!ticketBlockerFinished({ ticketState: state, mergeCommit: merged ? SHA : null, until }));
          // The wip rule's copy reads the same twin.
          const t = await ctx.db.execute(sql`select ${cantMoveFor(tickets)} as stuck from tickets where id = ${blocked.id}`);
          const stuck = (t as unknown as { rows?: Array<{ stuck: boolean }> }).rows?.[0]?.stuck ?? (t as unknown as Array<{ stuck: boolean }>)[0]?.stuck;
          expect(stuck, `wip ${state} merged=${merged} until=${until}`).toBe(open);
        }
      }
    }
  });
});

describe("a card closing by itself releases a ticket whose blocker merged", () => {
  it("moves a Blocked ticket to ready when its last card closes and the other blocker is merged, not done", async () => {
    ctx = await setup();
    const waiting = await ctx.ticket({ systemState: "blocked", title: "Waiting" });
    const train = await ctx.ticket({ systemState: "blocked", title: "Train", mergeCommit: SHA });
    await ctx.link(waiting.id, train.id, "merged");
    const [card] = await ctx.db.insert(decisions).values({ companyId: ctx.companyId, kind: "approval", question: "Q?", options: ["Yes", "No"], recommendedOption: "Yes", context: { type: "question" } }).returning();
    await ctx.db.insert(ticketDependencies).values({ blockedTicketId: waiting.id, blockerDecisionId: card!.id });
    await closeCardBySystem(ctx.db, { id: card!.id, companyId: ctx.companyId, question: "Q?" }, "test", { markRead: async () => undefined });
    const [after] = await ctx.db.select({ state: tickets.systemState }).from(tickets).where(sql`${tickets.id} = ${waiting.id}`);
    expect(after!.state).toBe("ready");
  });
});
