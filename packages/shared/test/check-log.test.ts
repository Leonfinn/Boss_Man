import { describe, expect, it } from "vitest";
import { checkFailureFacts, checkFailureSentence, checkLogFacts, fullLogPointer, prepareFullLog, withCheckFacts } from "../src/check-log.js";

const LOG = "PASS  merge check\nFAIL  typecheck (exit 2)\n      error TS1\nFAIL  related tests (exit 1)\n       FAIL  test/a.test.ts > suite > first\n       FAIL  test/b.test.ts > second\ncheck-quick: FAILED\n";

describe("check log facts (BOS-1220)", () => {
  it("finds the failed steps and the first failing test", () => {
    expect(checkLogFacts(LOG)).toEqual({ steps: ["typecheck (exit 2)", "related tests (exit 1)"], test: "test/a.test.ts > suite > first" });
    expect(checkFailureFacts(LOG)).toBe('steps that failed: "typecheck (exit 2)"; "related tests (exit 1)". first failing test: test/a.test.ts > suite > first');
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
