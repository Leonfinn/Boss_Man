// BOS-2135: the pure line helpers in owner-record.ts. The brief/status tests reach ownerSetupLines through
// ownerSetupFacts; this file pins the lines and the small helpers directly, with made-up facts (no database).
// Every worker, runner and address here is an example; nothing is read from a real host.
import { describe, expect, it } from "vitest";
import { kindsOf, ownerSetupLines, recordHeadLine, usesOwnerSetupToken, type OwnerRecordFacts } from "../src/services/owner-record.js";

const facts = (over: Partial<OwnerRecordFacts> = {}): OwnerRecordFacts => ({
  checkWorkers: { added: 0, everConnected: 0, online: 0 },
  runner: { registered: false, everConnected: false },
  publicAddress: { set: false },
  ...over,
});

describe("ownerSetupLines", () => {
  it("no workers, no runner and no public address: says none of them exist and never calls a worker set up", () => {
    expect(ownerSetupLines(facts())).toEqual([
      "- Check workers: 0 added · 0 ever connected · 0 online. A worker is installed only once it has connected; with 0 ever connected, never call one set up, existing or idle.",
      "- Runner: none registered.",
      "- Public address: not set; never ask the owner to open Boss Man from outside their network.",
    ]);
  });

  it("counts added, ever-connected and online workers separately", () => {
    const lines = ownerSetupLines(facts({ checkWorkers: { added: 2, everConnected: 1, online: 1 } }));
    expect(lines[0]).toBe("- Check workers: 2 added · 1 ever connected · 1 online. A worker is installed only once it has connected; with 0 ever connected, never call one set up, existing or idle.");
  });

  it("a worker added but never connected still reads as 0 ever connected", () => {
    const lines = ownerSetupLines(facts({ checkWorkers: { added: 3, everConnected: 0, online: 0 } }));
    expect(lines[0]).toContain("3 added · 0 ever connected · 0 online");
  });

  it("runner: registered but never connected is its own state", () => {
    expect(ownerSetupLines(facts({ runner: { registered: true, everConnected: false } }))[1]).toBe("- Runner: registered, never connected.");
  });

  it("runner: has connected once", () => {
    expect(ownerSetupLines(facts({ runner: { registered: true, everConnected: true } }))[1]).toBe("- Runner: has connected.");
  });

  it("public address: set drops the warning", () => {
    expect(ownerSetupLines(facts({ publicAddress: { set: true } }))[2]).toBe("- Public address: set.");
  });
});

describe("kindsOf", () => {
  it.each([
    ["merge only", { takes: "merge", mergeKept: 0 }, "merge checks only"],
    ["quick checks only", { takes: "checks", mergeKept: 0 }, "quick checks only"],
    ["all checks, no kept slots", { takes: "all", mergeKept: 0 }, "all checks"],
    ["all checks, one slot kept", { takes: "all", mergeKept: 1 }, "all checks, 1 slot kept for merges"],
    ["all checks, several slots kept", { takes: "all", mergeKept: 3 }, "all checks, 3 slots kept for merges"],
  ])("%s", (_name, worker, expected) => {
    expect(kindsOf(worker)).toBe(expected);
  });

  it("an unknown takes value with no kept slots is still all checks", () => {
    expect(kindsOf({ takes: "", mergeKept: 0 })).toBe("all checks");
  });
});

describe("recordHeadLine", () => {
  const settled = { kind: "settled" as const, line: "the public address is https://example.com", message: "unused here" };
  const stale = { kind: "stale" as const, line: "the phone reached Boss Man at https://example.com", message: "unused here" };

  it("a settled answer with no stillNeeded is just the record line", () => {
    expect(recordHeadLine(settled)).toBe("Boss Man's record says: the public address is https://example.com.");
  });

  it("a settled answer raised again carries the author's reason", () => {
    expect(recordHeadLine(settled, "the owner says the address changed")).toBe("Boss Man's record says: the public address is https://example.com. Asked because: the owner says the address changed");
  });

  it("a stale answer says the record may be out of date", () => {
    expect(recordHeadLine(stale)).toBe("Boss Man's record says: the phone reached Boss Man at https://example.com. The record may be out of date, so this is asked.");
  });

  it("a stale answer with a stillNeeded reason shows the reason instead", () => {
    expect(recordHeadLine(stale, "a new phone was bought")).toBe("Boss Man's record says: the phone reached Boss Man at https://example.com. Asked because: a new phone was bought");
  });

  it("a blank stillNeeded counts as absent and is trimmed when present", () => {
    expect(recordHeadLine(settled, "   ")).toBe("Boss Man's record says: the public address is https://example.com.");
    expect(recordHeadLine(settled, "  see the note  ")).toContain("Asked because: see the note");
  });
});

describe("usesOwnerSetupToken", () => {
  it.each([
    ["no steps", []],
    ["a plain step", ["Open Settings → Server and runner → Checks."]],
    ["a host token, which is not a worker fact", ["Read {{host.env.file}}."]],
    ["an empty worker key", ["{{checkWorkers.}}"]],
    ["a worker key with no dot", ["{{checkWorkers}}"]],
    ["another kind of token", ["{{company.example.deployTarget.name}}"]],
  ])("%s: false", (_name, steps) => {
    expect(usesOwnerSetupToken(steps)).toBe(false);
  });

  it.each([
    ["one worker token", ["It lists {{checkWorkers.added}} workers."]],
    ["spacing inside the braces", ["It lists {{ checkWorkers.online }} workers."]],
    ["a token in the second of several steps", ["Open Settings → Server and runner.", "It lists {{checkWorkers.everConnected}} workers."]],
  ])("%s: true", (_name, steps) => {
    expect(usesOwnerSetupToken(steps)).toBe(true);
  });
});
