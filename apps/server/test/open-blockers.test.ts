// BOS-1458: one answer to "what still holds this ticket", with a merged blocker counting as finished
// for a link that waits until merged (the 14 Nov train that stayed Blocked after its merge).
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { ticketDependencies, tickets } from "../src/db/schema.js";
import { openBlockers } from "../src/services/ticket-links.js";
import { ticketIsBlocked } from "../src/services/agent-wip.js";

const SHA = "b".repeat(40);

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
  const co = (await req("POST", "/api/companies", { name: "App Co" }, )).json() as { company: { id: string } };
  const project = (await req("POST", `/api/companies/${co.company.id}/projects`, { name: "Customer app" })).json() as { id: string };
  const ticket = async (patch: Partial<typeof tickets.$inferInsert>) => (await db.insert(tickets).values({ companyId: co.company.id, projectId: project.id, title: "T", systemState: "in_progress", ...patch }).returning())[0]!;
  const link = async (blocked: string, blocker: string, until: "merged" | "done") => void (await db.insert(ticketDependencies).values({ blockedTicketId: blocked, blockerTicketId: blocker, until }));
  return { ...built, db, close, ticket, link };
}

describe("openBlockers", () => {
  it("frees a link that waits until merged once the blocker has a merge commit, though it is not done", async () => {
    ctx = await setup();
    const waiting = await ctx.ticket({ systemState: "ready", title: "Waiting" });
    const train = await ctx.ticket({ title: "Merge train", systemState: "blocked", mergeCommit: SHA });
    await ctx.link(waiting.id, train.id, "merged");
    expect(await openBlockers(ctx.db, waiting.id)).toEqual([]);
    expect(await ticketIsBlocked(ctx.db, waiting.id)).toBe(false);
  });

  it("keeps a merged blocker open for a link that waits until done, and an unmerged one for either", async () => {
    ctx = await setup();
    const waiting = await ctx.ticket({ systemState: "ready", title: "Waiting" });
    const merged = await ctx.ticket({ title: "Merged", systemState: "blocked", mergeCommit: SHA });
    const unmerged = await ctx.ticket({ title: "Unmerged", systemState: "review" });
    await ctx.link(waiting.id, merged.id, "done");
    await ctx.link(waiting.id, unmerged.id, "merged");
    const open = await openBlockers(ctx.db, waiting.id);
    expect(open.map((b) => b.title).sort()).toEqual(["Merged", "Unmerged"]);
  });
});
