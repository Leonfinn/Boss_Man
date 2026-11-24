import { describe, expect, it } from "vitest";
import { checkFailureFacts, checkFailureSentence, checkLogFacts, failedFilesSentence, failingLines, firstFailingLine, fullLogPointer, prepareFullLog, withCheckFacts } from "../src/check-log.js";

const LOG = "PASS  merge check\nFAIL  typecheck (exit 2)\n      error TS1\nFAIL  related tests (exit 1)\n       FAIL  test/a.test.ts > suite > first\n       FAIL  test/b.test.ts > second\ncheck-quick: FAILED\n";

describe("check log facts (BOS-1220)", () => {
  it("finds the failed steps and the first failing test", () => {
    expect(checkLogFacts(LOG)).toEqual({ steps: ["typecheck (exit 2)", "related tests (exit 1)"], test: "test/a.test.ts > suite > first", files: ["test/a.test.ts", "test/b.test.ts"] });
    expect(checkFailureFacts(LOG)).toBe('2 failed test files: test/a.test.ts; test/b.test.ts. steps that failed: "typecheck (exit 2)"; "related tests (exit 1)". first failing test: test/a.test.ts > suite > first');
  });

  // BOS-2304
  it("names every failed test file first, with the count, even when the tail shows only the last one", () => {
    const log = ["FAIL  test/a.test.ts > x", "FAIL  test/b.test.ts > y", "FAIL  test/b.test.ts > z", "FAIL  test/c.test.ts [ test/c.test.ts ]", "x".repeat(20_000), "FAIL  test/c.test.ts > last"].join("\n");
    expect(checkLogFacts(log).files).toEqual(["test/a.test.ts", "test/b.test.ts", "test/c.test.ts"]);
    const out = withCheckFacts(log, 8192);
    expect(out.startsWith("[Earlier in the log: 3 failed test files: test/a.test.ts; test/b.test.ts; test/c.test.ts")).toBe(true);
    expect(checkFailureFacts("nothing here")).toBe("");
  });

  it("ignores colour codes", () => {
    expect(checkLogFacts("\u001b[31mFAIL\u001b[0m  x\n").steps).toEqual(["x"]);
  });

  it("puts the facts in front of a tail that has lost them", () => {
    const long = LOG + "x".repeat(20_000);
    const out = withCheckFacts(long, 8192);
    expect(out.length).toBeLessThanOrEqual(8192);
    expect(out.startsWith("[Earlier in the log:")).toBe(true);
    expect(out).toContain("related tests (exit 1)");
    // A tail that still shows them is left alone.
    expect(withCheckFacts(LOG, 8192)).toBe(LOG);
  });

  // BOS-1228
  it("cuts a long log in the middle and redacts what is kept", () => {
    const fake = "MY_API_KEY=hunter2fakevalue";
    expect(prepareFullLog(`a\n${fake}\nb`)).toEqual({ log: "a\nMY_API_KEY=[redacted]\nb", truncated: false });
    const big = `HEAD\n${"x".repeat(5000)}\n${fake}\nTAIL`;
    const cut = prepareFullLog(big, 1000);
    expect(cut.truncated).toBe(true);
    expect(cut.log.length).toBeLessThanOrEqual(1000);
    expect(cut.log.startsWith("HEAD")).toBe(true);
    expect(cut.log.endsWith("TAIL")).toBe(true);
    expect(cut.log).toContain("characters cut from the middle");
    expect(cut.log).not.toContain("hunter2fakevalue");
  });

  it("points at the tool, ticket and job that open the full log", () => {
    const s = fullLogPointer("job-1", "ticket-1", 2048);
    expect(s).toContain("check_log");
    expect(s).toContain("ticket-1");
    expect(s).toContain("job-1");
    expect(s).toContain("2 KB, kept 14 days");
  });

  it("says plainly when a check was stopped, never undefined", () => {
    expect(checkFailureSentence({ exitCode: undefined, output: "" })).toBe("was stopped before it reported");
    expect(checkFailureSentence({ exitCode: null, output: "", reason: "killed by the server" })).toBe("was stopped before it reported: killed by the server");
    expect(checkFailureSentence({ exitCode: 1, output: "" })).toBe("failed (exit code 1)");
  });
});

// BOS-1723: one line per failed job for check_log's list, and the failing lines a bounce record keeps.
describe("first failing line and failing lines (BOS-1723)", () => {
  it("prefers the failing test, then the failed step, then an error-looking line", () => {
    expect(firstFailingLine(LOG)).toBe("test/a.test.ts > suite > first");
    expect(firstFailingLine("PASS  lint\nFAIL  typecheck (exit 2)\n")).toBe('step "typecheck (exit 2)" failed');
    expect(firstFailingLine("cloning\nfatal: invalid reference: abc123\n")).toBe("fatal: invalid reference: abc123");
    expect(firstFailingLine("AssertionError: expected 1 to be 2")).toBe("AssertionError: expected 1 to be 2");
    expect(firstFailingLine("Found 0 errors.\nall good\n")).toBeNull();
  });

  it("lists failing lines in order, once each, up to the limit", () => {
    expect(failingLines(LOG)).toEqual(["FAIL  typecheck (exit 2)", "error TS1", "FAIL  related tests (exit 1)", "FAIL  test/a.test.ts > suite > first", "FAIL  test/b.test.ts > second", "check-quick: FAILED"]);
    expect(failingLines("Error: x\nError: x\nError: y\nError: z", 2)).toEqual(["Error: x", "Error: y"]);
  });
});

// BOS-2353: pin the helper's own edges, not checkFailureFacts' wording.
describe("failedFilesSentence (BOS-2353)", () => {
  it("returns nothing when no file failed", () => {
    expect(failedFilesSentence([])).toBe("");
  });

  it("uses the singular for one file and the plural for more", () => {
    expect(failedFilesSentence(["a.test.ts"])).toBe("1 failed test file: a.test.ts");
    expect(failedFilesSentence(["a.test.ts", "b.test.ts"])).toBe("2 failed test files: a.test.ts; b.test.ts");
  });

  it("keeps the full count but shows only max of the files", () => {
    const files = ["a", "b", "c", "d", "e"].map((n) => `${n}.test.ts`);
    expect(failedFilesSentence(files, 3)).toBe("5 failed test files: a.test.ts; b.test.ts; c.test.ts; and 2 more");
  });

  it("does not say 'and more' when the list exactly fills the limit", () => {
    expect(failedFilesSentence(["a.test.ts", "b.test.ts"], 2)).toBe("2 failed test files: a.test.ts; b.test.ts");
  });

  it("shows at most 20 files by default", () => {
    const files = Array.from({ length: 21 }, (_, i) => `f${i}.test.ts`);
    const s = failedFilesSentence(files);
    expect(s.startsWith("21 failed test files: f0.test.ts;")).toBe(true);
    expect(s).toContain("f19.test.ts");
    expect(s).not.toContain("f20.test.ts");
    expect(s.endsWith("; and 1 more")).toBe(true);
  });
});
