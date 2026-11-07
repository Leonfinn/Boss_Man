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
  const bg = createBackground([
    {
      name: "slow",
      everyMs: 5,
      run: async () => {
        slowStarted++;
        await new Promise((r) => setTimeout(r, 60));
        slowFinished++;
      },
    },
    { name: "fast", everyMs: 5, run: async () => void fast++ },
  ]);
  bg.startBackground();
  await new Promise((r) => setTimeout(r, 40));
  await bg.stopBackground();
  // Twelve ticks fit in 60 ms; the slow pass that was still running skipped all of them.
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
