import { describe, expect, it } from "vitest";
import { checkFailureSentence, checkLogFacts, fullLogPointer, prepareFullLog, withCheckFacts } from "../src/check-log.js";

describe("check failure sentence, edge cases (BOS-1317)", () => {
  it("says plainly when a check timed out", () => {
    expect(checkFailureSentence({ timedOut: true, output: "" })).toBe("timed out");
  });

  it("adds the facts in brackets after a timeout", () => {
    expect(checkFailureSentence({ timedOut: true, output: "FAIL  typecheck\n" })).toBe('timed out (step that failed: "typecheck")');
  });

  it("adds the facts after an exit code", () => {
    expect(checkFailureSentence({ exitCode: 2, output: "FAIL  typecheck\n" })).toBe('failed (exit code 2; step that failed: "typecheck")');
  });

  it("gives the reason first when a check was stopped, then the facts in brackets", () => {
    expect(checkFailureSentence({ exitCode: undefined, reason: "killed", output: "FAIL  typecheck\n" })).toBe(
      'was stopped before it reported: killed (step that failed: "typecheck")',
    );
  });
});

describe("full log pointer, edge cases (BOS-1317)", () => {
  it("leaves out the size when the byte count is unknown or zero", () => {
    expect(fullLogPointer("job-1", "ticket-1", null)).not.toContain("KB");
    expect(fullLogPointer("job-1", "ticket-1", 0)).not.toContain("KB");
    expect(fullLogPointer("job-1", "ticket-1", null)).not.toContain("kept 14 days");
    expect(fullLogPointer("job-1", "ticket-1", 0)).not.toContain("kept 14 days");
  });

  it("never says 0 KB for a log smaller than 1 KB", () => {
    expect(fullLogPointer("job-1", "ticket-1", 100)).toContain("(1 KB, kept 14 days)");
  });
});

describe("check log facts, edge cases (BOS-1317)", () => {
  it("lists a repeated FAIL step only once", () => {
    expect(checkLogFacts("FAIL  typecheck\nFAIL  typecheck\n").steps).toEqual(["typecheck"]);
  });

  it("cuts a step name to 200 characters", () => {
    const step = "s".repeat(250);
    expect(checkLogFacts(`FAIL  ${step}\n`).steps).toEqual(["s".repeat(200)]);
  });

  it("cuts a failing-test identifier to 300 characters", () => {
    const path = `${"d".repeat(320)}.test.ts`;
    const facts = checkLogFacts(`FAIL  ${path} > suite > name\n`);
    expect(facts.test).toHaveLength(300);
    expect(facts.test).toBe("d".repeat(300));
  });

  it("reads the vitest multiplication-sign and angle form as a test", () => {
    expect(checkLogFacts("× test/a.test.ts › suite › name\n").test).toBe("test/a.test.ts > suite › name");
  });

  it("handles CRLF line ends", () => {
    expect(checkLogFacts("FAIL  typecheck\r\nFAIL  test/a.test.ts > suite > first\r\n")).toEqual({
      steps: ["typecheck"],
      test: "test/a.test.ts > suite > first",
    });
  });

  it("keeps only the first failing test", () => {
    expect(checkLogFacts("FAIL  test/a.test.ts > suite > first\nFAIL  test/b.test.ts > second\n").test).toBe("test/a.test.ts > suite > first");
  });
});

describe("withCheckFacts, edge cases (BOS-1317)", () => {
  it("adds a header when the tail shows every step but has lost the test", () => {
    const full = `FAIL  test/a.test.ts > suite > name\n${"y".repeat(400)}\nFAIL  typecheck (exit 2)\n`;
    const out = withCheckFacts(full, 200);
    expect(out.startsWith("[Earlier in the log:")).toBe(true);
    expect(out).toContain("first failing test: test/a.test.ts > suite > name");
    expect(out).toContain('step that failed: "typecheck (exit 2)"');
    expect(out.length).toBeLessThanOrEqual(200);
  });
});

describe("prepareFullLog, edge cases (BOS-1317)", () => {
  it("keeps a head of max / 6 and stays within max", () => {
    const raw = `${"H".repeat(100)}${"x".repeat(5000)}${"T".repeat(100)}`;
    const cut = prepareFullLog(raw, 600);
    expect(cut.truncated).toBe(true);
    expect(cut.log.length).toBeLessThanOrEqual(600);
    expect(cut.log.startsWith("H".repeat(100))).toBe(true);
    expect(cut.log).toContain("characters cut from the middle");
  });
});
