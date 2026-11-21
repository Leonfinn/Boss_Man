// BOS-2166: the board sends open tickets plus the newest done ones, and the count of all done tickets.
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { ticketDependencies, tickets } from "../src/db/schema.js";
import { BOARD_DONE_LIMIT } from "../src/services/work.js";

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
