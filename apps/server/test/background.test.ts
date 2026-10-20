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
