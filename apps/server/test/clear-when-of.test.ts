// Reading the conditions stored on a card Boss Man raised itself (BOS-1312): clearWhenOf decides which
// of the 14 kinds are well formed. Anything dropped is a card that never closes by itself; anything
// let through malformed can break the sweep. addonRunning is covered in alert-clearing.test.ts.
import { describe, expect, it } from "vitest";
import { clearWhenOf } from "../src/services/alert-clearing.js";

const one = (clearWhen: unknown) => clearWhenOf({ clearWhen });

describe("clearWhenOf: a value that isn't a list of conditions", () => {
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["an object without clearWhen", {}],
    ["clearWhen as a string", { clearWhen: "x" }],
    ["clearWhen as an object", { clearWhen: {} }],
  ])("gives [] for %s", (_name, context) => {
    expect(clearWhenOf(context)).toEqual([]);
  });

  it("reads a missing clearWhen as []", () => {
    expect(one(undefined)).toEqual([]);
  });
});

describe("clearWhenOf: every well-formed kind is kept exactly as given", () => {
  it.each([
    ["runActive", { kind: "runActive", runId: "run-1" }],
    ["agentRanOk", { kind: "agentRanOk", agentId: "agent-1" }],
    ["ticketDone", { kind: "ticketDone", ticketId: "ticket-1" }],
    ["ticketMerged", { kind: "ticketMerged", ticketId: "ticket-1" }],
    ["signoffNotWaiting", { kind: "signoffNotWaiting", ticketId: "ticket-1" }],
    ["ticketLeft", { kind: "ticketLeft", ticketId: "ticket-1", state: "blocked" }],
    ["featureHasTicket", { kind: "featureHasTicket", featureId: "feature-1" }],
    ["limitReset", { kind: "limitReset", fundingSourceId: "funding-1" }],
    ["accountRanOk", { kind: "accountRanOk", fundingSourceId: "funding-1" }],
    ["companyRanOk", { kind: "companyRanOk", companyId: "company-1" }],
  ])("keeps %s", (_kind, condition) => {
    expect(one([condition])).toEqual([condition]);
  });
});

describe("clearWhenOf: ticketLeft needs both a ticket and a state", () => {
  it("drops a ticketLeft without state", () => {
    expect(one([{ kind: "ticketLeft", ticketId: "ticket-1" }])).toEqual([]);
  });
});

describe("clearWhenOf: runnerRebuilt", () => {
  it("keeps from when it is null", () => {
    expect(one([{ kind: "runnerRebuilt", companyId: "company-1", from: null }])).toEqual([
      { kind: "runnerRebuilt", companyId: "company-1", from: null },
    ]);
  });

  it("keeps from when it is a string", () => {
    expect(one([{ kind: "runnerRebuilt", companyId: "company-1", from: "abc" }])).toEqual([
      { kind: "runnerRebuilt", companyId: "company-1", from: "abc" },
    ]);
  });

  it("drops it when from is missing", () => {
    expect(one([{ kind: "runnerRebuilt", companyId: "company-1" }])).toEqual([]);
  });

  it("drops it when from is a number", () => {
    expect(one([{ kind: "runnerRebuilt", companyId: "company-1", from: 7 }])).toEqual([]);
  });
});

describe("clearWhenOf: serverHasCommit", () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";

  it("lower-cases a 40-character hex sha written in upper case", () => {
    expect(one([{ kind: "serverHasCommit", commit: sha.toUpperCase() }])).toEqual([{ kind: "serverHasCommit", commit: sha }]);
  });

  it.each([
    ["39 characters", sha.slice(0, 39)],
    ["41 characters", `${sha}0`],
    ["a non-hex letter", `${sha.slice(0, 39)}g`],
  ])("drops a sha with %s", (_name, commit) => {
    expect(one([{ kind: "serverHasCommit", commit }])).toEqual([]);
  });
});

describe("clearWhenOf: runnerConnected", () => {
  it("has no wakeId key at all when wakeId is absent", () => {
    const [kept] = one([{ kind: "runnerConnected", companyId: "company-1" }]);
    expect(kept).toEqual({ kind: "runnerConnected", companyId: "company-1" });
    expect(kept && Object.prototype.hasOwnProperty.call(kept, "wakeId")).toBe(false);
  });

  it("keeps a string wakeId", () => {
    expect(one([{ kind: "runnerConnected", companyId: "company-1", wakeId: "wake-1" }])).toEqual([
      { kind: "runnerConnected", companyId: "company-1", wakeId: "wake-1" },
    ]);
  });

  it("leaves a numeric wakeId out but keeps the condition", () => {
    const [kept] = one([{ kind: "runnerConnected", companyId: "company-1", wakeId: 7 }]);
    expect(kept).toEqual({ kind: "runnerConnected", companyId: "company-1" });
    expect(kept && Object.prototype.hasOwnProperty.call(kept, "wakeId")).toBe(false);
  });
});

describe("clearWhenOf: serverCalm", () => {
  it("keeps memory and freezes", () => {
    expect(one([{ kind: "serverCalm", rule: "memory" }])).toEqual([{ kind: "serverCalm", rule: "memory" }]);
    expect(one([{ kind: "serverCalm", rule: "freezes" }])).toEqual([{ kind: "serverCalm", rule: "freezes" }]);
  });

  it("drops any other rule", () => {
    expect(one([{ kind: "serverCalm", rule: "cpu" }])).toEqual([]);
  });
});

describe("clearWhenOf: malformed entries are skipped, valid ones keep their order", () => {
  it("skips a field of the wrong type, an unknown kind, and null, string and number entries", () => {
    expect(
      one([
        { kind: "ticketDone", ticketId: 5 },
        { kind: "notAKind", ticketId: "ticket-1" },
        null,
        "x",
        7,
      ]),
    ).toEqual([]);
  });

  it("keeps the valid entries of a mixed list in their original order", () => {
    const first = { kind: "ticketDone", ticketId: "ticket-1" };
    const second = { kind: "runActive", runId: "run-1" };
    const third = { kind: "companyRanOk", companyId: "company-1" };
    expect(one([null, first, { kind: "ticketDone", ticketId: 5 }, "x", second, 7, third])).toEqual([first, second, third]);
  });
});
