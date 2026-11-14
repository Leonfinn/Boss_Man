import { describe, expect, it } from "vitest";
import { deployTagNameProblem } from "../src/protocol.js";

// DR-033: a deploy tag name is one ref component. The server (deploys.ts) and the runner
// (workspace.ts) both call this before handing the name to git, so each rule below is load-bearing:
// a rule that silently stopped working would let a bad name reach `git tag`.
describe("deployTagNameProblem", () => {
  it("accepts ordinary tag names", () => {
    for (const name of ["live", "prod-2026.11", "v1.2.3", "release_candidate"]) {
      expect(deployTagNameProblem(name), name).toBeNull();
    }
  });

  it("asks for a name when it is empty", () => {
    expect(deployTagNameProblem("")).toContain("Give a tag name.");
  });

  it("keeps the name to 100 characters, and allows exactly 100", () => {
    expect(deployTagNameProblem("a".repeat(101))).toContain("100 characters");
    expect(deployTagNameProblem("a".repeat(100))).toBeNull();
  });

  it("refuses a name with '/'", () => {
    expect(deployTagNameProblem("release/1.2")).toContain("can't contain '/'");
  });

  it("refuses a name starting with '-' or '.'", () => {
    expect(deployTagNameProblem("-rc")).toContain("can't start with '-' or '.'");
    expect(deployTagNameProblem(".hidden")).toContain("can't start with '-' or '.'");
  });

  it("refuses a name ending with '.' or '.lock'", () => {
    expect(deployTagNameProblem("live.")).toContain("can't end with '.' or '.lock'");
    expect(deployTagNameProblem("live.lock")).toContain("can't end with '.' or '.lock'");
  });

  it("refuses '@', '..' and '@{'", () => {
    expect(deployTagNameProblem("@")).toContain("can't be '@' or contain '..' or '@{'");
    expect(deployTagNameProblem("a..b")).toContain("can't be '@' or contain '..' or '@{'");
    expect(deployTagNameProblem("a@{b")).toContain("can't be '@' or contain '..' or '@{'");
  });

  it("refuses spaces, tabs, DEL and the characters git keeps for revision syntax", () => {
    const message = "spaces or any of ~ ^ : ? * [ \\";
    for (const bad of ["a b", "a\tb", "a\u007fb", ..."~^:?*[\\"]) {
      expect(deployTagNameProblem(`a${bad}b`), JSON.stringify(bad)).toContain(message);
    }
  });

  it("refuses HEAD in any case", () => {
    for (const name of ["HEAD", "head", "Head"]) {
      expect(deployTagNameProblem(name), name).toContain("can't be HEAD");
    }
  });

  it("checks '/' before the leading-character rule when a name breaks both", () => {
    // Pinned order: `-a/b` starts with '-', but the '/' check runs first and owns the message.
    expect(deployTagNameProblem("-a/b")).toContain("can't contain '/'");
  });
});
