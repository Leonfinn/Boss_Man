// BOS-1296: `serverContains` decides whether the commit the server runs already includes a ticket's merge, which
// decides whether its after-merge checks are released. The go-live tests reach it only through a full server with
// real merges, so its edges are pinned here directly. `order` is every merge commit, oldest first, lower case:
// that is what `allMergeOrder` builds. A commit Boss Man can't place is never assumed to be live.
import { describe, expect, it } from "vitest";
import { serverContains } from "../src/services/go-live-wait.js";

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
