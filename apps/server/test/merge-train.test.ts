// The merge train coordinator (BOS-1366, DR-059): pure rules, no database or runner. Who gets a seat and in what order, where each
// member prepares, when it is stale, and when a failed check counts against it.
import { describe, expect, it } from "vitest";
import { MergeTrain, TRAIN_QUICK_RESTACK_MS, TRAIN_RESTACK_BACKOFF_MAX_MS, TRAIN_RESTACK_BACKOFF_MS, TRAIN_RESTACK_CAP } from "../src/services/merge-train.js";

const train = (seats = 3, clock = { t: 0 }) => new MergeTrain({ seats: () => seats, now: () => clock.t });
const prep = (tr: MergeTrain, id: string, base: string, commit: string) => tr.prepared(id, { base, commit, tree: `tree-${commit}` });

describe("merge train: seats and order", () => {
  it("seats up to one member per check slot, by priority then place, and never pushes a member out", () => {
    const tr = train(2);
    tr.join("a", { priority: 1, place: 100 });
    tr.join("b", { priority: 1, place: 50 });
    tr.join("c", { priority: 1, place: 10 });
    expect(tr.seated("a")).toBe(false); // c and b are earlier in line
    expect(tr.list().map((m) => m.ticketId)).toEqual(["c", "b"]);
    // An urgent ticket arriving later waits for the next free seat, at the front of the queue.
    tr.join("u", { priority: 0, place: 999 });
    expect(tr.seated("u")).toBe(false);
    expect(tr.queue()).toEqual(["u", "a"]);
    tr.landed("c");
    expect(tr.seated("u")).toBe(true);
    expect(tr.list().map((m) => m.ticketId)).toEqual(["b", "u"]);
  });

  it("seats a head-only ticket (a clash with a member ahead) as the head only; later tickets pass it a few times, then it holds the line", () => {
    const tr = train(2);
    tr.join("a", { priority: 1, place: 1 });
    expect(tr.seated("a")).toBe(true);
    tr.join("h", { priority: 1, place: 2, headOnly: true });
    // Later tickets take free seats past it (it keeps its place: still first in the queue)...
    tr.join("y", { priority: 1, place: 3 });
    expect(tr.seated("y")).toBe(true);
    expect(tr.queue()).toEqual(["h"]);
    tr.landed("a");
    tr.join("z", { priority: 1, place: 4 });
    expect(tr.seated("z")).toBe(true); // passed twice now: seats = 2
    tr.landed("y");
    tr.join("w", { priority: 1, place: 5 });
    // ...but no more: it waits for the train to drain, and w waits behind it.
    expect(tr.seated("w")).toBe(false);
    tr.landed("z");
    expect(tr.seated("h")).toBe(true);
    expect(tr.isHead("h")).toBe(true);
    expect(tr.seated("w")).toBe(true);
  });

  it("joining twice keeps the first place", () => {
    const tr = train(1);
    tr.join("a", { priority: 1, place: 10 });
    tr.join("b", { priority: 1, place: 20 });
    tr.join("b", { priority: 0, place: 1 });
    expect(tr.queue()).toEqual(["a", "b"]);
  });
});

describe("merge train: bases and staleness", () => {
  it("prepares the head on main and each member on the one ahead, waiting until it has prepared", () => {
    const tr = train();
    for (const [id, place] of [["a", 1], ["b", 2], ["c", 3]] as const) tr.join(id, { priority: 1, place });
    tr.seated("a");
    expect(tr.baseFor("a")).toEqual({ wait: false, base: null });
    expect(tr.baseFor("b")).toEqual({ wait: true });
    prep(tr, "a", "main0", "A1");
    expect(tr.baseFor("b")).toEqual({ wait: false, base: "A1" });
    prep(tr, "b", "A1", "B1");
    expect(tr.baseFor("c")).toEqual({ wait: false, base: "B1" });
    expect(tr.place("c")).toEqual({ place: 3, ahead: ["a", "b"] });
  });

  it("marks everyone behind stale when a member ahead re-prepares, and the head stale when the member it stacked on left", () => {
    const tr = train();
    for (const [id, place] of [["a", 1], ["b", 2], ["c", 3]] as const) tr.join(id, { priority: 1, place });
    tr.seated("a");
    prep(tr, "a", "main0", "A1");
    prep(tr, "b", "A1", "B1");
    prep(tr, "c", "B1", "C1");
    expect([tr.stale("a"), tr.stale("b"), tr.stale("c")]).toEqual([null, null, null]);
    // A re-prepares (main moved outside the train): B is stale at once; C becomes stale when B restacks.
    tr.restack("a");
    expect(tr.stale("b")).toBe("ahead_changed");
    expect(tr.stale("c")).toBeNull();
    tr.restack("b");
    expect(tr.stale("c")).toBe("ahead_changed");
    // A leaves without landing: B, now the head, was based on nothing that landed.
    const tr2 = train();
    for (const [id, place] of [["a", 1], ["b", 2]] as const) tr2.join(id, { priority: 1, place });
    tr2.seated("a");
    prep(tr2, "a", "main0", "A1");
    prep(tr2, "b", "A1", "B1");
    tr2.leave("a");
    expect(tr2.isHead("b")).toBe(true);
    expect(tr2.stale("b")).toBe("ahead_left");
  });

  it("a landing ahead is not a restack: the member behind is now on main", () => {
    const tr = train();
    for (const [id, place] of [["a", 1], ["b", 2]] as const) tr.join(id, { priority: 1, place });
    tr.seated("a");
    prep(tr, "a", "main0", "A1");
    prep(tr, "b", "A1", "B1");
    tr.passed("a");
    tr.landed("a");
    expect(tr.isHead("b")).toBe(true);
    expect(tr.stale("b")).toBeNull();
  });

  it("caps restacks per landing; the member then gives up its seat and the one behind carries on without it", () => {
    const tr = train();
    for (const [id, place] of [["a", 1], ["b", 2]] as const) tr.join(id, { priority: 1, place });
    tr.seated("a");
    for (let i = 0; i < TRAIN_RESTACK_CAP; i++) expect(tr.restack("a")).toBe(true);
    prep(tr, "a", "main0", "A9");
    prep(tr, "b", "A9", "B1");
    expect(tr.restack("a")).toBe(false);
    tr.leave("a"); // serverMerge's finally
    expect(tr.isHead("b")).toBe(true);
    expect(tr.stale("b")).toBe("ahead_left");
    expect(tr.baseFor("b")).toEqual({ wait: false, base: null });
  });
});

describe("merge train: failure attribution", () => {
  it("a failure counts only once everyone ahead has passed", () => {
    const tr = train();
    for (const [id, place] of [["a", 1], ["b", 2]] as const) tr.join(id, { priority: 1, place });
    tr.seated("a");
    prep(tr, "a", "main0", "A1");
    prep(tr, "b", "A1", "B1");
    tr.failed("b");
    expect(tr.failure("b")).toBe("wait");
    tr.passed("a");
    expect(tr.failure("b")).toBe("stands");
  });

  it("drops the failure of the member behind when the one ahead fails too: it restacks, charged nothing", () => {
    const tr = train();
    for (const [id, place] of [["a", 1], ["b", 2]] as const) tr.join(id, { priority: 1, place });
    tr.seated("a");
    prep(tr, "a", "main0", "A1");
    prep(tr, "b", "A1", "B1");
    tr.failed("b");
    tr.failed("a");
    expect(tr.failure("a")).toBe("stands"); // nobody ahead of the head
    expect(tr.failure("b")).toBe("wait");
    tr.leave("a"); // A is sent back
    expect(tr.failure("b")).toBe("restack");
  });

  it("the one flaky re-run keeps those behind waiting, and is given only once", () => {
    const tr = train();
    for (const [id, place] of [["a", 1], ["b", 2]] as const) tr.join(id, { priority: 1, place });
    tr.seated("a");
    prep(tr, "a", "main0", "A1");
    prep(tr, "b", "A1", "B1");
    tr.failed("b");
    tr.failed("a");
    expect(tr.rerun("a")).toBe(true);
    expect(tr.failure("b")).toBe("wait");
    // The re-run passed: A goes on, B's failure now stands and B is not restacked.
    tr.passed("a");
    expect(tr.failure("b")).toBe("stands");
    expect(tr.stale("b")).toBeNull();
    tr.failed("a");
    expect(tr.rerun("a")).toBe(false);
  });
});

describe("merge train: restart (BOS-1289)", () => {
  it("seats the tickets that had live merge jobs in their old order, whatever order they re-join in", () => {
    const clock = { t: 0 };
    const tr = train(3, clock);
    tr.seedOrder(["x", "y"]);
    tr.join("new", { priority: 1, place: 0 }); // a newcomer earlier in line still waits for the old train
    tr.join("y", { priority: 1, place: 5 });
    expect(tr.seated("y")).toBe(false); // x was ahead of y and hasn't re-joined yet
    tr.join("x", { priority: 1, place: 9 });
    expect(tr.seated("y")).toBe(true);
    expect(tr.list().map((m) => m.ticketId)).toEqual(["x", "y", "new"]);
  });

  it("never holds a merge-line fix (priority 0) for the restart's old order", () => {
    const tr = train(3, { t: 0 });
    tr.seedOrder(["x", "y"]);
    tr.join("fix", { priority: 0, place: 99 });
    expect(tr.seated("fix")).toBe(true);
    tr.join("other", { priority: 1, place: 1 });
    expect(tr.seated("other")).toBe(false); // ordinary tickets still wait for x and y
  });

  it("stops waiting for a seeded ticket after the deadline, or once it has left", () => {
    const clock = { t: 0 };
    const tr = train(3, clock);
    tr.seedOrder(["x", "y"], 1000);
    tr.join("y", { priority: 1, place: 5 });
    expect(tr.seated("y")).toBe(false);
    clock.t = 1000;
    expect(tr.seated("y")).toBe(true);

    const tr2 = train(3, { t: 0 });
    tr2.seedOrder(["x", "y"]);
    tr2.join("y", { priority: 1, place: 5 });
    tr2.leave("x"); // x left review while the server was down
    expect(tr2.seated("y")).toBe(true);
  });
});

describe("merge train: what the check queue holds back (BOS-1504)", () => {
  it("withholds a ticket waiting for a seat, and a seeded one not seated yet; never a member, a leaver or a stranger", () => {
    const clock = { t: 0 };
    const tr = train(1, clock);
    tr.seedOrder(["x", "y"], 1000);
    expect(tr.withheld("x")).toBe(true); // seeded, its landing hasn't re-joined yet
    expect(tr.withheld("stranger")).toBe(false); // never joined: the queue serves it as before
    tr.join("x", { priority: 1, place: 1 });
    tr.join("y", { priority: 1, place: 2 });
    expect(tr.seated("x")).toBe(true);
    expect(tr.seated("y")).toBe(false); // one seat
    expect(tr.withheld("x")).toBe(false);
    expect(tr.withheld("y")).toBe(true);
    expect(tr.seatedIds()).toEqual(["x"]);
    tr.leave("y");
    expect(tr.withheld("y")).toBe(false);

    // The seed stops holding back once its deadline has passed.
    const tr2 = train(3, clock);
    tr2.seedOrder(["a"], 1000);
    expect(tr2.withheld("a")).toBe(true);
    clock.t = 1000;
    expect(tr2.withheld("a")).toBe(false);
  });

  it("lists seated tickets head first", () => {
    const tr = train(3);
    tr.join("b", { priority: 1, place: 20 });
    tr.join("a", { priority: 1, place: 10 });
    tr.join("c", { priority: 2, place: 0 });
    tr.seated("a");
    expect(tr.seatedIds()).toEqual(["a", "b", "c"]);
    tr.landed("a");
    expect(tr.seatedIds()).toEqual(["b", "c"]);
  });
});

describe("merge train: background lane ages up (BOS-1803)", () => {
  const H = 60 * 60_000;
  it("a lane ticket yields to newer ordinary ones until it has waited the lane age, then ranks by when it joined", () => {
    const clock = { t: 10 * H };
    let age = 2 * H;
    const tr = new MergeTrain({ seats: () => 1, now: () => clock.t, laneAgeMs: () => age });
    tr.join("head", { priority: 1, place: 9 * H });
    expect(tr.seated("head")).toBe(true);
    tr.join("lane", { priority: 2, place: 9 * H }); // joined 1 h ago
    tr.join("new", { priority: 1, place: 10 * H - 5 * 60_000 });
    expect(tr.queue()).toEqual(["new", "lane"]);
    clock.t = 11 * H; // waited 2 h: ordinary now, and it joined first
    expect(tr.queue()).toEqual(["lane", "new"]);
    tr.join("urgent", { priority: 0, place: 11 * H });
    expect(tr.queue()).toEqual(["urgent", "lane", "new"]); // urgent still first
    age = 0; // the owner turned ageing off: back to last
    expect(tr.queue()).toEqual(["urgent", "new", "lane"]);
  });

  it("with no lane age given (older callers) nothing ages", () => {
    const clock = { t: 100 * H };
    const tr = train(1, clock);
    tr.join("head", { priority: 1, place: 0 });
    tr.seated("head");
    tr.join("lane", { priority: 2, place: 0 });
    tr.join("new", { priority: 1, place: 99 * H });
    expect(tr.queue()).toEqual(["new", "lane"]);
  });
});

describe("merge train: re-tier (BOS-1516)", () => {
  it("moves a waiting ticket up, never a seated one, and never down", () => {
    const tr = train(1);
    tr.join("a", { priority: 1, place: 1 });
    tr.join("b", { priority: 1, place: 2 });
    tr.join("c", { priority: 1, place: 3 });
    expect(tr.seated("a")).toBe(true);
    expect(tr.queue()).toEqual(["b", "c"]);
    expect(tr.retier("c", 0)).toBe(true); // Priority 1 set after joining
    expect(tr.queue()).toEqual(["c", "b"]);
    expect(tr.retier("a", 0)).toBe(false); // seated: untouched
    expect(tr.retier("b", 2)).toBe(false); // lower tier never pushes down
    expect(tr.retier("nobody", 0)).toBe(false);
    expect(tr.list().map((m) => m.ticketId)).toEqual(["a"]);
    tr.landed("a");
    expect(tr.seated("c")).toBe(true);
  });
});

describe("merge train: a landing cut off after its push (BOS-1604, 15 Nov)", () => {
  it("a commit that is main's tip is never lost: the next head is not stale", () => {
    const tr = train(2);
    tr.join("a", { priority: 1, place: 1 });
    tr.join("b", { priority: 1, place: 2 });
    tr.seated("b");
    tr.prepared("a", { base: "m0", commit: "A", tree: "tA", onMain: true });
    prep(tr, "b", "A", "B");
    // a's push reached main (main = A), but the runner update cut off the answer: its landing ends as a failure and leaves.
    tr.leave("a");
    // b was stacked on A: it is now the head on a lost base, so it restacks once...
    expect(tr.stale("b")).toBe("ahead_left");
    tr.restack("b");
    // ...and prepares on main, whose tip is A. Before the fix it was "ahead_left" again at every poll, for over an hour.
    tr.prepared("b", { base: "A", commit: "B2", tree: "tB", onMain: true });
    expect(tr.stale("b")).toBeNull();
    // A new ticket stacked behind b is fine too.
    tr.join("c", { priority: 1, place: 3 });
    tr.seated("c");
    prep(tr, "c", "B2", "C");
    expect(tr.stale("c")).toBeNull();
  });

  it("a member leaving whose commit is already seen as main's tip doesn't mark it lost", () => {
    const tr = train(2);
    tr.join("a", { priority: 1, place: 1 });
    tr.join("b", { priority: 1, place: 2 });
    tr.seated("b");
    tr.prepared("a", { base: "m0", commit: "A", tree: "tA", onMain: true });
    tr.onMain("A"); // seen on main (another prepare on main fetched it) before a's landing gave up
    tr.leave("a");
    tr.prepared("b", { base: "A", commit: "B", tree: "tB", onMain: true });
    expect(tr.stale("b")).toBeNull();
  });

  it("a landed commit is main's tip: a later prepare can't be stale on it", () => {
    const tr = train(2);
    tr.join("a", { priority: 1, place: 1 });
    tr.seated("a");
    tr.prepared("a", { base: "m0", commit: "A", tree: "tA", onMain: true });
    tr.restack("a"); // A lost
    tr.prepared("a", { base: "m0", commit: "A", tree: "tA", onMain: true }); // the same commit again (same tree, same parents)
    tr.landed("a");
    tr.join("b", { priority: 1, place: 2 });
    tr.seated("b");
    tr.prepared("b", { base: "A", commit: "B", tree: "tB" });
    expect(tr.stale("b")).toBeNull();
  });

  it("a member restacking faster than a check can run backs off, and the train reports thrash once; a landing clears it", () => {
    const clock = { t: 0 };
    const tr = train(2, clock);
    tr.join("a", { priority: 1, place: 1 });
    tr.seated("a");
    const loop = () => {
      tr.prepared("a", { base: "m", commit: `c${clock.t}`, tree: `t${clock.t}`, onMain: true });
      clock.t += 3_000; // stale at the first poll
      tr.restack("a");
    };
    loop();
    expect(tr.backoffMs("a")).toBe(0); // one quick restack: the member ahead really changed
    expect(tr.facts().thrashSince).toBeNull();
    loop();
    expect(tr.backoffMs("a")).toBe(TRAIN_RESTACK_BACKOFF_MS);
    loop();
    expect(tr.backoffMs("a")).toBe(TRAIN_RESTACK_BACKOFF_MS * 2);
    const since = tr.facts().thrashSince;
    expect(since).not.toBeNull();
    for (let i = 0; i < 5; i++) loop();
    expect(tr.backoffMs("a")).toBe(TRAIN_RESTACK_BACKOFF_MAX_MS); // capped
    expect(tr.facts().thrashSince).toBe(since); // one episode, not one per restack
    // A restack after a check had time to run is not quick: no back-off.
    tr.prepared("a", { base: "m", commit: "slow", tree: "tslow", onMain: true });
    clock.t += TRAIN_QUICK_RESTACK_MS;
    tr.restack("a");
    expect(tr.backoffMs("a")).toBe(0);
    tr.prepared("a", { base: "m", commit: "L", tree: "tL", onMain: true });
    tr.landed("a");
    expect(tr.facts().thrashSince).toBeNull();
  });
});

// BOS-2360: with GitHub CI gating, each member's stacked commit runs on GitHub, and a pass further back covers the members ahead.
describe("merge train: GitHub CI coverage (BOS-2360)", () => {
  /** Three members a, b, c in an unbroken stack on main m: a on m, b on A, c on B. */
  const three = () => {
    const tr = train(3);
    for (const [id, place] of [["a", 1], ["b", 2], ["c", 3]] as const) {
      tr.join(id, { priority: 1, place });
      tr.seated(id);
    }
    tr.prepared("a", { base: "m", commit: "A", tree: "tA", onMain: true });
    prep(tr, "b", "A", "B");
    prep(tr, "c", "B", "C");
    for (const [id, c] of [["a", "A"], ["b", "B"], ["c", "C"]] as const) tr.ciState(id, c, "pending");
    return tr;
  };

  it("a pass on the tail covers every member ahead of it; nothing is cleared before that", () => {
    const tr = three();
    expect(["a", "b", "c"].map((id) => tr.ciCleared(id))).toEqual([false, false, false]);
    tr.ciState("c", "C", "passed");
    expect(["a", "b", "c"].map((id) => tr.ciCoveredBy(id))).toEqual([{ ticketId: "c", commit: "C" }, { ticketId: "c", commit: "C" }, { ticketId: "c", commit: "C" }]);
    expect(["a", "b", "c"].map((id) => tr.ciCleared(id))).toEqual([true, true, true]);
  });

  it("a pass in the middle covers the head and itself, not the tail", () => {
    const tr = three();
    tr.ciState("b", "B", "passed");
    expect(tr.ciCoveredBy("a")).toEqual({ ticketId: "b", commit: "B" });
    expect(tr.ciCleared("b")).toBe(true);
    expect(tr.ciCleared("c")).toBe(false);
  });

  it("a broken stack covers nothing past the break, and a report for an old commit is dropped", () => {
    const tr = three();
    tr.restack("b"); // b prepares again: c's base (B) no longer holds
    tr.ciState("c", "C", "passed");
    expect(tr.ciCoveredBy("a")).toBeNull();
    // b's old run passing after its restack says nothing about its new commit.
    tr.ciState("b", "B", "passed");
    expect(tr.ciCleared("b")).toBe(false);
    prep(tr, "b", "A", "B2");
    expect(tr.ciCoveredBy("a")).toBeNull(); // c is still on B
  });

  it("a new prepare resets the member's GitHub state; the same commit keeps it", () => {
    const tr = three();
    tr.ciState("a", "A", "passed");
    tr.prepared("a", { base: "m", commit: "A", tree: "tA", onMain: true });
    expect(tr.ciCleared("a")).toBe(true);
    tr.prepared("a", { base: "m2", commit: "A2", tree: "tA2", onMain: true });
    expect(tr.ciCleared("a")).toBe(false);
  });

  it("accepted (known red, no run) lets a member land but covers nobody ahead", () => {
    const tr = three();
    tr.ciState("b", "B", "accepted");
    expect(tr.ciCleared("b")).toBe(true);
    expect(tr.ciCleared("a")).toBe(false);
  });

  it("ciFailure: covered by a pass behind, wait for one ahead, restack once it left, stands when all ahead are through", () => {
    // The head fails once and the tail passes: covered, it lands.
    let tr = three();
    tr.ciState("a", "A", "failed");
    expect(tr.ciFailure("a")).toBe("stands"); // nobody ahead, nobody behind passed yet
    tr.ciState("c", "C", "passed");
    expect(tr.ciFailure("a")).toBe("covered");

    // The tail fails while the head is still running: it waits.
    tr = three();
    tr.ciState("c", "C", "failed");
    expect(tr.ciFailure("c")).toBe("wait");
    // The head fails for real and leaves: the tail restacks without it (uncharged).
    tr.ciState("a", "A", "failed");
    expect(tr.ciFailure("c")).toBe("wait"); // a failed member ahead hasn't left yet
    tr.leave("a");
    expect(tr.ciFailure("b")).toBe("restack");
    expect(tr.ciFailure("c")).toBe("wait"); // b, ahead of it, is still not through

    // The middle fails, the head passed: the failure is the middle's own.
    tr = three();
    tr.ciState("a", "A", "passed");
    tr.ciState("b", "B", "failed");
    expect(tr.ciFailure("b")).toBe("stands");
    // A failed tail behind it waits for the middle to leave, then restacks.
    tr.ciState("c", "C", "failed");
    expect(tr.ciFailure("c")).toBe("wait");
    tr.leave("b");
    expect(tr.ciFailure("c")).toBe("restack");
  });
});
