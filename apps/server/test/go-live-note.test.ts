// BOS-1546: a merged ticket that only waits to go live says so in plain words, and a ticket that waits for nothing says nothing.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openPglite } from "../src/db/client.js";
import { isLiveCheckWait } from "@boss-man/shared";
import { companies, decisions, projects, tickets } from "../src/db/schema.js";
import { blockedSplit, goLiveNote, openUpdateCards } from "../src/services/go-live-note.js";

let db: Awaited<ReturnType<typeof openPglite>>["db"];
let close: () => Promise<void>;
const COMPANY = "00000000-0000-4000-8000-000000000001";

beforeAll(async () => {
  ({ db, close } = await openPglite());
  await db.insert(companies).values({ id: COMPANY, name: "Home" });
});
afterAll(async () => close());

// BOS-1636: "N blocked" counts only real blocks; merged work waiting for its live check is counted apart.
describe("blocked split", () => {
  it("counts a blocked ticket with a merge as a live-check wait, not a block", async () => {
    const PROJECT = "00000000-0000-4000-8000-0000000000a1";
    await db.insert(projects).values({ id: PROJECT, companyId: COMPANY, name: "P", repoUrl: "x" });
    const base = { companyId: COMPANY, projectId: PROJECT, systemState: "blocked" as const };
    await db.insert(tickets).values([
      { ...base, title: "stuck" },
      { ...base, title: "merged waiting", mergeCommit: "a".repeat(40) },
      { ...base, title: "merged done", systemState: "done" as const, mergeCommit: "b".repeat(40) },
    ]);
    const split = await blockedSplit(db, COMPANY);
    expect(split).toMatchObject({ blocked: 1, liveCheck: 1 });
    // BOS-2467: the oldest real block is the stuck ticket, never the live-check wait (even if that one is older).
    const [stuck] = await db.select({ id: tickets.id }).from(tickets).where(eq(tickets.title, "stuck"));
    expect(split.oldest?.ticketId).toBe(stuck!.id);
    await db.update(tickets).set({ stateChangedAt: new Date("2020-01-01T00:00:00Z") }).where(eq(tickets.title, "merged waiting"));
    expect((await blockedSplit(db, COMPANY)).oldest?.ticketId).toBe(stuck!.id);
    await db.update(tickets).set({ stateChangedAt: new Date("2020-01-01T00:00:00Z") }).where(eq(tickets.title, "stuck"));
    expect((await blockedSplit(db, COMPANY)).oldest?.at.toISOString()).toBe("2020-01-01T00:00:00.000Z");
    // No real block: nothing.
    await db.update(tickets).set({ systemState: "ready" }).where(eq(tickets.title, "stuck"));
    expect((await blockedSplit(db, COMPANY)).oldest).toBeNull();
    expect(isLiveCheckWait({ systemState: "blocked", mergeCommit: "a" })).toBe(true);
    expect(isLiveCheckWait({ systemState: "blocked", mergeCommit: null })).toBe(false);
    expect(isLiveCheckWait({ systemState: "done", mergeCommit: "a" })).toBe(false);
  });
});

describe("go-live note", () => {
  it("says nothing when nothing waits, so a real stall still looks like one", () => {
    expect(goLiveNote(null, { server: null, runner: null })).toBeNull();
    expect(goLiveNote(undefined, { server: "x", runner: "y" })).toBeNull();
  });

  it("names what it waits for and says nothing is for an agent to do", () => {
    const none = { server: null, runner: null };
    expect(goLiveNote("server", none)!.text).toContain("the server update");
    expect(goLiveNote("runner", none)!.text).toContain("Build and update runners");
    expect(goLiveNote("both", none)!.text).toMatch(/server update and the runner rebuild/);
    expect(goLiveNote("server", none)!.text).toContain("Nothing for an agent to do");
    expect(goLiveNote("server", none)!.cardId).toBeNull();
  });

  it("links the owner's open update card of the right kind", async () => {
    await db.insert(decisions).values([
      { companyId: COMPANY, kind: "approval", question: "Update the server?", recommendedOption: "Update", context: { type: "self_deploy", target: "server" } },
      { companyId: COMPANY, kind: "approval", question: "Update the runners?", recommendedOption: "Update", context: { type: "self_deploy", target: "runner" } },
      { companyId: COMPANY, kind: "approval", question: "Old", recommendedOption: "x", status: "answered", context: { type: "self_deploy", target: "runner" } },
    ]);
    const cards = await openUpdateCards(db, COMPANY);
    expect(cards.server).toBeTruthy();
    expect(cards.runner).toBeTruthy();
    expect(goLiveNote("server", cards)!.cardId).toBe(cards.server);
    expect(goLiveNote("runner", cards)!.cardId).toBe(cards.runner);
  });
});
