// BOS-1546: a merged ticket that only waits to go live says so in plain words, and a ticket that waits for nothing says nothing.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openPglite } from "../src/db/client.js";
import { companies, decisions } from "../src/db/schema.js";
import { goLiveNote, openUpdateCards } from "../src/services/go-live-note.js";

let db: Awaited<ReturnType<typeof openPglite>>["db"];
let close: () => Promise<void>;
const COMPANY = "00000000-0000-4000-8000-000000000001";

beforeAll(async () => {
  ({ db, close } = await openPglite());
  await db.insert(companies).values({ id: COMPANY, name: "Home" });
});
afterAll(async () => close());

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
