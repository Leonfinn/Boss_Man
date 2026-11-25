import { describe, expect, it } from "vitest";
import { boardBuilds, BOARD_BUILD_TTL_MS } from "../src/services/board-build.js";

describe("boardBuilds", () => {
  it("asks the host once per card in 5 minutes, again after, and fresh on new activity", async () => {
    let calls = 0;
    let clock = 0;
    const get = boardBuilds(async () => (calls++, { state: "failed" as const, failing: ["test"], sha: "abc" }), () => clock);
    expect((await get([{ id: "a", activityKey: "1" }])).get("a")).toEqual({ state: "failed", failing: ["test"] });
    await get([{ id: "a", activityKey: "1" }]);
    expect(calls).toBe(1);
    await get([{ id: "a", activityKey: "2" }]);
    expect(calls).toBe(2);
    clock += BOARD_BUILD_TTL_MS;
    await get([{ id: "a", activityKey: "2" }]);
    expect(calls).toBe(3);
  });

  it("says unavailable on a host error and gives no entry without a host", async () => {
    const bad = boardBuilds(async () => { throw new Error("rate limited"); });
    expect((await bad([{ id: "a", activityKey: "1" }])).get("a")).toEqual({ state: "unavailable", failing: [] });
    const none = boardBuilds(async () => null);
    expect((await none([{ id: "a", activityKey: "1" }])).size).toBe(0);
  });

  // BOS-2495: 25 cards in Review waiting on a cold host held "Loading tasks" for 9 s+.
  it("doesn't wait for a slow host: answers without the tag, asks once, and shows it on the next poll", async () => {
    let calls = 0;
    let answer: (v: { state: "passed"; failing: string[]; sha: string }) => void = () => {};
    const get = boardBuilds(() => (calls++, new Promise((r) => (answer = r))), () => 0, 0);
    expect((await get([{ id: "a", activityKey: "1" }])).size).toBe(0);
    // A poll while the host is still answering doesn't ask it again.
    expect((await get([{ id: "a", activityKey: "1" }])).size).toBe(0);
    expect(calls).toBe(1);
    answer({ state: "passed", failing: [], sha: "abc" });
    await Promise.resolve();
    await Promise.resolve();
    expect((await get([{ id: "a", activityKey: "1" }])).get("a")).toEqual({ state: "passed", failing: [] });
    expect(calls).toBe(1);
  });

  it("keeps showing the last answer while a newer one is out", async () => {
    let clock = 0;
    let slow = false;
    const get = boardBuilds(() => (slow ? new Promise(() => {}) : Promise.resolve({ state: "failed" as const, failing: ["test"], sha: "abc" })), () => clock, 0);
    expect((await get([{ id: "a", activityKey: "1" }])).get("a")?.state).toBe("failed");
    slow = true;
    clock += BOARD_BUILD_TTL_MS;
    expect((await get([{ id: "a", activityKey: "1" }])).get("a")?.state).toBe("failed");
    expect((await get([{ id: "a", activityKey: "2" }])).get("a")?.state).toBe("failed");
    // A card that left Review is forgotten.
    expect((await get([])).size).toBe(0);
    expect((await get([{ id: "a", activityKey: "2" }])).size).toBe(0);
  });

  it("calls pending running", async () => {
    const get = boardBuilds(async () => ({ state: "pending" as const, failing: [], sha: "x" }));
    expect((await get([{ id: "a", activityKey: "1" }])).get("a")?.state).toBe("running");
  });
});
