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

  it("calls pending running", async () => {
    const get = boardBuilds(async () => ({ state: "pending" as const, failing: [], sha: "x" }));
    expect((await get([{ id: "a", activityKey: "1" }])).get("a")?.state).toBe("running");
  });
});
