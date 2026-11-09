// BOS-1024: agents can see whether a merged ticket is live, and a "is live" reply on one that isn't gets a warning.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openPglite } from "../src/db/client.js";
import { settings } from "../src/db/schema.js";
import { goLiveLine, liveClaimWarning } from "../src/services/go-live-wait.js";

let db: Awaited<ReturnType<typeof openPglite>>["db"];
let close: () => Promise<void>;
const COMPANY = "00000000-0000-4000-8000-000000000001";
const MERGE = "b".repeat(40);

beforeAll(async () => {
  ({ db, close } = await openPglite());
});
afterAll(async () => close());

const ticket = { companyId: COMPANY, mergeCommit: MERGE, touchesRunner: false };

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
});
