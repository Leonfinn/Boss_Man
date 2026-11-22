// BOS-2142: a Blocked note that says it waits on another ticket needs that ticket linked.
// ticketsWaitedOn finds the PREFIX-number references a note names after a waiting word,
// skips the ticket's own reference, and reports each one once.
import { describe, expect, it } from "vitest";
import { ticketsWaitedOn } from "../src/services/blocked-who-acts.js";

describe("ticketsWaitedOn", () => {
  it("finds the ticket a note says it waits on", () => {
    expect(ticketsWaitedOn("Waiting on BOS-123 before this moves", null)).toEqual(["BOS-123"]);
  });

  it("finds each ticket named after a waiting word, and reports each once", () => {
    expect(ticketsWaitedOn("blocked until ABC-1 and after XY-22, also waiting on ABC-1", null)).toEqual(["ABC-1", "XY-22"]);
  });

  it("leaves out the ticket's own reference", () => {
    expect(ticketsWaitedOn("This waits on BOS-123", "BOS-123")).toEqual([]);
  });

  it("ignores a lower-case prefix and a ticket name shorter than two letters", () => {
    expect(ticketsWaitedOn("waiting on bos-123", null)).toEqual([]);
    expect(ticketsWaitedOn("waiting on X-1", null)).toEqual([]);
  });

  it("needs a waiting word at hand, with no full stop or newline in between", () => {
    expect(ticketsWaitedOn("See BOS-123 in the backlog", null)).toEqual([]);
    expect(ticketsWaitedOn("Waiting. BOS-123", null)).toEqual([]);
    expect(ticketsWaitedOn("Waiting\nBOS-123", null)).toEqual([]);
  });

  it("ignores a reference more than forty characters after the waiting word", () => {
    expect(ticketsWaitedOn(`waiting ${"x".repeat(41)} BOS-123`, null)).toEqual([]);
    expect(ticketsWaitedOn(`waiting ${"x".repeat(30)} BOS-123`, null)).toEqual(["BOS-123"]);
  });
});
