// BOS-1024: agents can see whether a merged ticket is live, and a "is live" reply on one that isn't gets a warning.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openPglite } from "../src/db/client.js";
import { companies, settings } from "../src/db/schema.js";
import { goLiveLine, liveClaimWarning } from "../src/services/go-live-wait.js";

let db: Awaited<ReturnType<typeof openPglite>>["db"];
let close: () => Promise<void>;
const COMPANY = "00000000-0000-4000-8000-000000000001";
/** A company made later, in its own repository: it puts its own work live (BOS-1345). */
const OTHER = "00000000-0000-4000-8000-000000000002";
const MERGE = "b".repeat(40);

beforeAll(async () => {
  ({ db, close } = await openPglite());
  // The oldest company is the home one, whose work goes live with the Boss Man server update.
  await db.insert(companies).values({ id: COMPANY, name: "Home", createdAt: new Date("2026-01-01T00:00:00Z") });
  await db.insert(companies).values({ id: OTHER, name: "Elsewhere", createdAt: new Date("2026-06-01T00:00:00Z") });
});
afterAll(async () => close());

const ticket = { companyId: COMPANY, mergeCommit: MERGE, touchesRunner: false, liveMarkedAt: null };

describe("go-live line and the not-live warning", () => {
  it("says nothing for an unmerged ticket", async () => {
    expect(await goLiveLine(db, { ...ticket, mergeCommit: null })).toBeNull();
    expect(await liveClaimWarning(db, { ...ticket, mergeCommit: null }, "It is live now.")).toBeNull();
  });

  it("says the server runs the merge when it does, and does not warn", async () => {
    await db.insert(settings).values({ key: `live_release:${COMPANY}`, value: { old: MERGE, new: MERGE } });
    expect(await goLiveLine(db, ticket)).toContain("live on the server: yes");
    expect(await liveClaimWarning(db, ticket, "The change is live.")).toBeNull();
  });

  it("says no and warns when the server runs something older", async () => {
    const other = "d".repeat(40);
    await db.insert(settings).values({ key: `live_release:${COMPANY}`, value: { old: other, new: other } }).onConflictDoUpdate({ target: settings.key, set: { value: { old: other, new: other } } });
    expect(await goLiveLine(db, ticket)).toContain("live on the server: no");
    expect(await goLiveLine(db, { ...ticket, touchesRunner: true })).toContain("runners rebuilt:");
    const w = await liveClaimWarning(db, ticket, "Good news: this is live on the server.");
    expect(w).toContain("not live yet");
    expect(w).toContain("the server update");
    // Wording that makes no claim is left alone.
    expect(await liveClaimWarning(db, ticket, "I will tell you when it goes live.")).toBeNull();
  });

  // BOS-1345: our server's commit is recorded for every company, but it says nothing about another company's repo.
  it("for a company that puts its own work live: waits for the CEO's mark, never for our server", async () => {
    const theirs = { ...ticket, companyId: OTHER };
    // With no live commit recorded at all (a fresh install), nothing waits, as before go-live waits existed.
    expect(await liveClaimWarning(db, theirs, "This is live now.")).toBeNull();
    await db.insert(settings).values({ key: `live_release:${OTHER}`, value: { old: MERGE, new: MERGE } });
    const line = await goLiveLine(db, theirs);
    expect(line).toContain("puts its own work live; not marked live yet");
    expect(line).not.toContain("live on the server");
    const w = await liveClaimWarning(db, theirs, "This is live now.");
    expect(w).toContain("the CEO to mark it live");
    const marked = { ...theirs, liveMarkedAt: new Date("2026-11-13T09:30:00Z"), liveEvidence: "deployed 1a2b3c4d" };
    expect(await goLiveLine(db, marked)).toContain("the CEO marked this merge live at 2026-11-13 09:30 UTC (evidence: deployed 1a2b3c4d)");
    expect(await liveClaimWarning(db, marked, "This is live now.")).toBeNull();
  });
});
