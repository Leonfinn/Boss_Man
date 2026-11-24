// BOS-2166: the board sends open tickets plus the newest done ones, and the count of all done tickets.
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { ticketDependencies, tickets } from "../src/db/schema.js";
import { BOARD_DONE_LIMIT } from "../src/services/work.js";
import { registerBoardBuilds } from "../src/services/board-build.js";

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.app.close();
  await ctx?.close();
  ctx = undefined;
});

type Card = { id: string; title: string; parentTitle: string | null; blockedBy: Array<{ ticketTitle: string | null }> };
type BoardBody = { doneTotal: number; columns: Array<{ systemState: string; tickets: Card[] }> };

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Customer app" })).json() as { id: string };
  const make = async (title: string) => (await req("POST", `/api/projects/${project.id}/tickets`, { title })).json() as { id: string };
  const board = async (q = "") => (await req("GET", `/api/projects/${project.id}/board${q}`)).json() as BoardBody;
  const all = (b: BoardBody) => b.columns.flatMap((c) => c.tickets);
  return { ...built, db, close, req, project, make, board, all };
}

describe("board done limit (BOS-2166)", () => {
  it("sends open tickets, the newest done ones and the done count; ?done=all sends every one", async () => {
    ctx = await setup();
    const open = await ctx.make("Still open");
    const total = BOARD_DONE_LIMIT + 5;
    for (let i = 0; i < total; i++) {
      const t = await ctx.make(`Done ${i}`);
      await ctx.db.update(tickets).set({ systemState: "done", lastActivityAt: new Date(Date.UTC(2026, 0, 1, 0, i)) }).where(eq(tickets.id, t.id));
    }
    const b = await ctx.board();
    const cards = ctx.all(b);
    expect(b.doneTotal).toBe(total);
    expect(cards.some((c) => c.id === open.id)).toBe(true);
    expect(cards.filter((c) => c.title.startsWith("Done "))).toHaveLength(BOARD_DONE_LIMIT);
    // The newest 50 are kept: Done 5 .. Done 54 stay, Done 0 .. Done 4 are left out.
    expect(cards.some((c) => c.title === "Done 0")).toBe(false);
    expect(cards.some((c) => c.title === `Done ${total - 1}`)).toBe(true);
    const everything = await ctx.board("?done=all");
    expect(ctx.all(everything).filter((c) => c.title.startsWith("Done "))).toHaveLength(total);
    expect(everything.doneTotal).toBe(total);
  });

  // BOS-2495: thousands of done tickets must not grow what a board load sends (the Kanban tab polls it every 10 s).
  it("sends the same cards and the same size with 3,000 done tickets as with 50", async () => {
    ctx = await setup();
    const open = await ctx.make("Still open");
    const { companyId, projectId } = (await ctx.db.select({ companyId: tickets.companyId, projectId: tickets.projectId }).from(tickets).where(eq(tickets.id, open.id)))[0]!;
    const doneRows = (from: number, n: number, year: number) =>
      Array.from({ length: n }, (_, i) => ({ companyId, projectId, title: `Done ${from + i}`, body: "A long description. ".repeat(50), systemState: "done" as const, outcome: "completed", lastActivityAt: new Date(Date.UTC(year, 0, 1, 0, 0, i)) }));
    await ctx.db.insert(tickets).values(doneRows(0, BOARD_DONE_LIMIT, 2026));
    const before = await ctx.req("GET", `/api/projects/${ctx.project.id}/board`);
    for (let i = 0; i < 6; i++) await ctx.db.insert(tickets).values(doneRows(BOARD_DONE_LIMIT + i * 500, 500, 2020));
    const after = await ctx.req("GET", `/api/projects/${ctx.project.id}/board`);
    const b = after.json() as BoardBody;
    expect(b.doneTotal).toBe(BOARD_DONE_LIMIT + 3000);
    expect(ctx.all(b).map((c) => c.id).sort()).toEqual(ctx.all(before.json() as BoardBody).map((c) => c.id).sort());
    // Only the done count's digits differ.
    expect(Math.abs(after.payload.length - before.payload.length)).toBeLessThan(10);
  });

  // BOS-2495: the board answered only after every Review card's git host lookup; a hung host held "Loading tasks" until its timeouts.
  it("answers while the git host never does", async () => {
    ctx = await setup();
    const t = await ctx.make("In review");
    await ctx.db.update(tickets).set({ systemState: "review", branch: "bossman/in-review" }).where(eq(tickets.id, t.id));
    registerBoardBuilds(ctx.db, () => new Promise(() => {}));
    const b = await ctx.board();
    expect(ctx.all(b).some((c) => c.id === t.id)).toBe(true);
  });

  it("still names a parent and a blocker that are old done tickets left out of the list", async () => {
    ctx = await setup();
    const oldParent = await ctx.make("Old parent");
    const oldBlocker = await ctx.make("Old blocker");
    await ctx.db.update(tickets).set({ systemState: "done", lastActivityAt: new Date(Date.UTC(2020, 0, 1)) }).where(eq(tickets.id, oldParent.id));
    await ctx.db.update(tickets).set({ systemState: "done", lastActivityAt: new Date(Date.UTC(2020, 0, 2)) }).where(eq(tickets.id, oldBlocker.id));
    for (let i = 0; i < BOARD_DONE_LIMIT; i++) {
      const t = await ctx.make(`Newer done ${i}`);
      await ctx.db.update(tickets).set({ systemState: "done", lastActivityAt: new Date(Date.UTC(2026, 0, 1, 0, i)) }).where(eq(tickets.id, t.id));
    }
    const child = await ctx.make("Child");
    await ctx.db.update(tickets).set({ parentTicketId: oldParent.id }).where(eq(tickets.id, child.id));
    const other = await ctx.make("Waiting");
    await ctx.db.insert(ticketDependencies).values({ blockedTicketId: other.id, blockerTicketId: oldBlocker.id, until: "done" });
    const b = await ctx.board();
    const cards = ctx.all(b);
    expect(cards.some((c) => c.id === oldParent.id)).toBe(false);
    expect(cards.find((c) => c.id === child.id)?.parentTitle).toBe("Old parent");
    // A done blocker no longer holds the card, so it is not listed; the parent title is the proof of the by-id lookup.
    expect(cards.find((c) => c.id === other.id)?.blockedBy).toEqual([]);
  });
});
