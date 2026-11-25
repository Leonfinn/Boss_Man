import { describe, expect, it } from "vitest";
import { tellOnce } from "../src/services/tell-once.js";

// BOS-2632: a sweep's tell counts as told only when it resolves with the row it made.
describe("tellOnce", () => {
  const rig = () => {
    const logs: string[] = [];
    return { logs, log: (m: string) => logs.push(m) };
  };

  it("returns the row id of a wake or notification that got through, and logs nothing", async () => {
    const r = rig();
    expect(await tellOnce("k", async () => ({ id: "w1", outcome: "queued" }), r.log)).toBe("w1");
    expect(await tellOnce("k", async () => ({ id: "w2", outcome: "merged" }), r.log)).toBe("w2");
    expect(await tellOnce("k", async () => ({ id: "n1" }), r.log)).toBe("n1");
    expect(r.logs).toEqual([]);
  });

  it("a throw, a null (no CEO, not saved) or a dropped wake is not told, and each is logged with the key", async () => {
    const r = rig();
    expect(await tellOnce("merge stall CEO p1", async () => Promise.reject(new Error("connection reset")), r.log)).toBeNull();
    expect(await tellOnce("priority watch owner t1", async () => null, r.log)).toBeNull();
    expect(await tellOnce("check idle CEO m:j", async () => ({ id: "w3", outcome: "dropped" }), r.log)).toBeNull();
    expect(await tellOnce("log only", async () => undefined, r.log)).toBeNull();
    expect(r.logs).toHaveLength(4);
    expect(r.logs[0]).toContain('"merge stall CEO p1"');
    expect(r.logs[0]).toContain("connection reset");
    expect(r.logs[1]).toContain("nothing was sent");
    expect(r.logs[2]).toContain("dropped");
  });

  it("redacts a secret in the error, and a broken logger does not throw", async () => {
    const r = rig();
    const token = `ghp_${"a1B2".repeat(9)}`;
    await tellOnce("k", async () => Promise.reject(new Error(`push failed: ${token}`)), r.log);
    expect(r.logs[0]).not.toContain(token);
    const broken = () => {
      throw new Error("logger down");
    };
    expect(await tellOnce("k", async () => null, broken)).toBeNull();
  });
});
