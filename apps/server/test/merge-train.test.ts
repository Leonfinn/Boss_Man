// The merge train coordinator (BOS-1366, DR-059): pure rules, no database or runner. Who gets a seat and in what order, where each
// member prepares, when it is stale, and when a failed check counts against it.
import { describe, expect, it } from "vitest";
import { MergeTrain, TRAIN_RESTACK_CAP } from "../src/services/merge-train.js";

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
