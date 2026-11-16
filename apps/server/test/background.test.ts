import { expect, it } from "vitest";
import { createBackground } from "../src/background.js";

it("runs loops on their interval and stop waits for a pass in flight", async () => {
  let started = 0;
  let finished = false;
  const errors: string[] = [];
  const bg = createBackground(
    [
      { name: "slow", everyMs: 5, run: async () => (started++, await new Promise((r) => setTimeout(r, 50)), (finished = true)) },
      { name: "bad", everyMs: 5, run: async () => { throw new Error("boom"); } },
    ],
    (_e, name) => errors.push(name),
  );
  bg.startBackground();
  await new Promise((r) => setTimeout(r, 20));
  await bg.stopBackground();
  expect(started).toBeGreaterThan(0);
  expect(finished).toBe(true);
  expect(errors).toContain("bad");
  const seen = started;
  await new Promise((r) => setTimeout(r, 20));
  expect(started).toBe(seen); // nothing fires after stop
});

it("skips a loop's ticks while its last pass is still running, and only that loop's (BOS-414)", async () => {
  let slowStarted = 0;
  let slowFinished = 0;
  let fast = 0;
  // The slow pass stays open until the test releases it, so no wall-clock window decides
  // how many ticks it sees: it is held across several of the fast loop's ticks, however slow the machine.
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const bg = createBackground([
    {
      name: "slow",
      everyMs: 5,
      run: async () => {
        slowStarted++;
        await gate;
        slowFinished++;
      },
    },
    { name: "fast", everyMs: 5, run: async () => void fast++ },
  ]);
  bg.startBackground();
  // Wait for the fast loop to tick more than 3 times while the slow pass is still held (deadline, not a fixed sleep).
  const deadline = Date.now() + 30_000;
  while (fast <= 3 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
  release();
  await bg.stopBackground();
  // Several ticks fired while the slow pass was running; it skipped all of them.
  expect(slowStarted).toBe(1);
  expect(slowFinished).toBe(1);
  // The other loop kept its own pace.
  expect(fast).toBeGreaterThan(3);
});

it("runs a loop's first pass after firstAfterMs, long before its interval (BOS-416)", async () => {
  let n = 0;
  const bg = createBackground([{ name: "daily", everyMs: 3_600_000, firstAfterMs: 5, run: async () => void n++ }]);
  bg.startBackground();
  await new Promise((r) => setTimeout(r, 40));
  expect(n).toBe(1);
  await bg.stopBackground();
  // stopping before the first pass cancels it
  const bg2 = createBackground([{ name: "daily", everyMs: 3_600_000, firstAfterMs: 30, run: async () => void n++ }]);
  bg2.startBackground();
  await bg2.stopBackground();
  await new Promise((r) => setTimeout(r, 60));
  expect(n).toBe(1);
});
