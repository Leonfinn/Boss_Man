// BOS-1296: `serverContains` decides whether the commit the server runs already includes a ticket's merge, which
// decides whether its after-merge checks are released. The go-live tests reach it only through a full server with
// real merges, so its edges are pinned here directly. `order` is every merge commit, oldest first, lower case:
// that is what `allMergeOrder` builds. A commit Boss Man can't place is never assumed to be live.
import { describe, expect, it } from "vitest";
import { serverContains, serverHas } from "../src/services/go-live-wait.js";

const order = ["aaa1", "bbb2", "ccc3"]; // oldest merge first

describe("serverContains (BOS-1296)", () => {
  it("is false when nothing is recorded about what the server runs", () => {
    expect(serverContains(null, "aaa1", order)).toBe(false);
  });

  it("is true when the server runs the merge itself", () => {
    expect(serverContains("bbb2", "bbb2", order)).toBe(true);
  });

  it("lower-cases the merge, so an upper-case merge commit still matches", () => {
    expect(serverContains("bbb2", "BBB2", order)).toBe(true);
  });

  it("is true when the server runs a later merge", () => {
    expect(serverContains("ccc3", "aaa1", order)).toBe(true);
  });

  it("is false when the server runs an earlier merge", () => {
    expect(serverContains("aaa1", "ccc3", order)).toBe(false);
  });

  it("is false when the merge is not in merge order", () => {
    expect(serverContains("ccc3", "ddd4", order)).toBe(false);
  });

  it("is false when the server's commit is not in merge order (a hand-applied commit), unless it equals the merge", () => {
    expect(serverContains("ddd4", "aaa1", order)).toBe(false);
    expect(serverContains("ddd4", "ddd4", order)).toBe(true);
  });

  it("is false for an upper-case live commit, because live is not lower-cased", () => {
    // Pinned as today's behaviour (BOS-1296), not a bug: only `merge` is lower-cased here. liveServerCommit
    // already stores the live commit lower-cased, and no caller passes an upper-case `live` to serverContains.
    expect(serverContains("CCC3", "aaa1", order)).toBe(false);
  });
});

// BOS-1644 (R26): "can't tell" is its own answer; only a definite "no" may refuse anything.
describe("serverHas: yes, no or can't tell (BOS-1644)", () => {
  it("yes when the server runs the merge or a later one, or contains it", () => {
    expect(serverHas("bbb2", "bbb2", order).state).toBe("yes");
    expect(serverHas("ccc3", "aaa1", order).state).toBe("yes");
    expect(serverHas("ddd4", "aaa1", order, ["bbb2"]).state).toBe("yes");
  });

  it("no only when both are placed and the merge is later", () => {
    expect(serverHas("aaa1", "ccc3", order).state).toBe("no");
  });

  it("can't tell, with a reason, when nothing is recorded", () => {
    const a = serverHas(null, "aaa1", order);
    expect(a.state).toBe("unknown");
    expect(a.state === "unknown" && a.reason).toContain("nothing is recorded");
  });

  it("can't tell when the merge is not in merge order", () => {
    expect(serverHas("ccc3", "ddd4", order).state).toBe("unknown");
  });

  it("can't tell when the running commit can't be placed (the case that wrongly said no)", () => {
    const a = serverHas("ddd4", "aaa1", order);
    expect(a.state).toBe("unknown");
    expect(a.state === "unknown" && a.reason).toContain("ddd4");
  });
});
