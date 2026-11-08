// A broken query in the no-progress sweep (BOS-593) must not make the whole sweep pass (every 60 s)
// reject (BOS-611): it is caught like the owner replies, and the rest of the pass still returns.
import { afterEach, describe, expect, it } from "vitest";
import { openPglite, type Db } from "../src/db/client.js";
import { sweepService } from "../src/services/sweeps.js";

let ctx: { db: Db; close: () => Promise<void> } | undefined;
afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

async function setup() {
  const { db, close } = await openPglite();
  ctx = { db, close };
  const sweeps = sweepService(db, {
    wake: async () => ({}),
    isConnected: () => true,
    endRun: async () => ({}),
    endUnconfirmedCancels: async () => ({}),
    alert: async () => null,
  });
  return { db, sweeps };
}

describe("a failing no-progress sweep doesn't fail the whole pass (BOS-611)", () => {
  it("swallows the throw and reports nothing raised, with the other steps intact", async () => {
    const { sweeps } = await setup();
    const pass = await sweeps.run(async () => {
      throw new Error("simulated failure_signatures read failure");
    });
    expect(pass.noProgress).toEqual({ raised: 0 });
    expect(pass).toHaveProperty("goalChecks");
    expect(pass).toHaveProperty("stalledRuns");
  });

  it("passes the counts through when the no-progress sweep works", async () => {
    const { sweeps } = await setup();
    const pass = await sweeps.run(async () => ({ raised: 2 }));
    expect(pass.noProgress).toEqual({ raised: 2 });
  });
});
