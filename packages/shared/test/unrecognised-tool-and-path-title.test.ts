import { describe, expect, it } from "vitest";
import { isUnrecognisedTool, titleIsPath, type PermissionInfo } from "../src/policy.js";

const info = (over: Partial<PermissionInfo> = {}): PermissionInfo => ({ title: "Mystery", kind: null, rawInput: {}, ...over });

describe("isUnrecognisedTool (BOS-295)", () => {
  it("is true with no kind, kind other, or a kind Boss Man doesn't know", () => {
    expect(isUnrecognisedTool(info({ kind: null }))).toBe(true);
    expect(isUnrecognisedTool(info({ kind: "other" }))).toBe(true);
    expect(isUnrecognisedTool(info({ kind: "frobnicate" }))).toBe(true);
  });

  it("is false for every kind Boss Man knows", () => {
    for (const kind of ["read", "edit", "delete", "move", "search", "execute", "think", "fetch"]) {
      expect(isUnrecognisedTool(info({ kind })), kind).toBe(false);
    }
  });

  it("is false when the request carries a command", () => {
    expect(isUnrecognisedTool(info({ kind: "other", rawInput: { command: "ls" } }))).toBe(false);
    expect(isUnrecognisedTool(info({ kind: null, rawInput: { cmd: ["ls", "-l"] } }))).toBe(false);
  });

  it("is false for each path-like key, however it is spelled", () => {
    for (const key of ["filepath", "file_path", "filePath", "FILEPATH", "work-dir", "workdir", "parentDir", "path", "paths", "cwd", "file", "directory", "dir"]) {
      expect(isUnrecognisedTool(info({ kind: "other", rawInput: { [key]: "/home/x" } })), key).toBe(false);
    }
  });

  it("does not count a key that only contains 'path'", () => {
    expect(isUnrecognisedTool(info({ kind: "other", rawInput: { xpathy: "/home/x" } }))).toBe(true);
  });

  it("has no path when rawInput isn't an object", () => {
    expect(isUnrecognisedTool(info({ kind: null, rawInput: "ls" }))).toBe(true);
    expect(isUnrecognisedTool(info({ kind: "other", rawInput: null }))).toBe(true);
  });
});

describe("titleIsPath (BOS-495)", () => {
  it("is true for absolute, home, relative and Windows paths, with kind other or none", () => {
    for (const title of ["/home/x", "~", "~/x", "./x", "../x", "C:\\x", "c:/x"]) {
      expect(titleIsPath({ title, kind: "other", rawInput: {} }), title).toBe(true);
      expect(titleIsPath({ title, kind: null, rawInput: {} }), `${title} with no kind`).toBe(true);
    }
  });

  it("is false for a home name, a bare relative path, and an empty or blank title", () => {
    for (const title of ["~x", "x/y", "", "   ", null]) {
      expect(titleIsPath({ title, kind: "other", rawInput: {} }), String(title)).toBe(false);
    }
  });

  it("is false for execute and read kinds, whose titles aren't tool names", () => {
    expect(titleIsPath({ title: "/home/x", kind: "execute", rawInput: {} })).toBe(false);
    expect(titleIsPath({ title: "/home/x", kind: "read", rawInput: {} })).toBe(false);
  });

  it("is false when the request carries a command", () => {
    expect(titleIsPath({ title: "/home/x", kind: "other", rawInput: { command: "ls /tmp" } })).toBe(false);
  });

  it("trims leading spaces before deciding", () => {
    expect(titleIsPath({ title: "  /home/x", kind: "other", rawInput: {} })).toBe(true);
    expect(titleIsPath({ title: "\t~/x", kind: "other", rawInput: {} })).toBe(true);
    expect(titleIsPath({ title: "   ", kind: "other", rawInput: {} })).toBe(false);
  });
});
