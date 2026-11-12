// The skill-file safety helpers (BOS-1099): a silent change here could let a disguised command through
// skill review, so name each helper and each kind of input that must be caught.
import { describe, expect, it } from "vitest";
import {
  hasForeignLetters,
  hasHiddenChars,
  skillChangeEntry,
  unreadableFile,
  type SkillSide,
} from "../src/services/skill-files.js";
import type { SkillFile } from "../src/services/skills.js";

const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64");
const file = (path: string, content: Buffer | string): SkillFile => ({ path, content: b64(content) });

describe("hasHiddenChars", () => {
  it("catches invisible characters: a zero-width space, a soft hyphen and a combining mark", () => {
    expect(hasHiddenChars("run\u200Bthis")).toBe(true);
    expect(hasHiddenChars("run\u00ADthis")).toBe(true);
    expect(hasHiddenChars("cafe\u0301")).toBe(true);
  });

  it("catches a word mixing Latin and Cyrillic letters", () => {
    // "pаypal": the "а" after the p is Cyrillic, not the Latin a.
    expect(hasHiddenChars("p\u0430ypal")).toBe(true);
  });

  it("allows an all-Cyrillic word and plain ASCII", () => {
    expect(hasHiddenChars("привет")).toBe(false);
    expect(hasHiddenChars("curl https://example.com")).toBe(false);
  });
});

describe("hasForeignLetters", () => {
  it("catches a dotless i and a word spelled entirely in Cyrillic lookalikes", () => {
    expect(hasForeignLetters("\u0131")).toBe(true);
    expect(hasForeignLetters("\u0455\u0441\u0440")).toBe(true); // "ѕср", reads as "scp"
  });

  it("allows ASCII, digits and emoji on their own", () => {
    expect(hasForeignLetters("curl -sSL https://example.com")).toBe(false);
    expect(hasForeignLetters("12345")).toBe(false);
    expect(hasForeignLetters("😀🎉")).toBe(false);
  });
});

describe("unreadableFile", () => {
  it("returns the path of a file holding a NUL byte", () => {
    expect(unreadableFile([file("SKILL.md", "fine"), file("payload.bin", Buffer.from([0x61, 0x00, 0x62]))])).toBe("payload.bin");
  });

  it("returns the path of a file that is not valid UTF-8", () => {
    expect(unreadableFile([file("SKILL.md", Buffer.from([0xff, 0xfe, 0xfd]))])).toBe("SKILL.md");
  });

  it("returns null for valid UTF-8, including multi-byte text", () => {
    expect(unreadableFile([file("SKILL.md", "Hello, world\n"), file("notes.md", "héllo — 日本語 😀")])).toBeNull();
  });
});

describe("skillChangeEntry", () => {
  const side = (name: string, skillMd: string, paths: string[]): SkillSide => ({
    name,
    description: `${name} description`,
    bundleHash: name === "old-name" ? "aaaaaaaaaaaaaaaaaaaaaaaa" : "bbbbbbbbbbbbbbbbbbbbbbbb",
    skillMd,
    paths,
  });

  it("shows a renamed and an edited file", () => {
    const before = side("old-name", "line one\nline two\n", ["SKILL.md", "old.txt"]);
    const after = side("new-name", "line one\nline TWO\n", ["SKILL.md", "new.txt"]);
    const entry = skillChangeEntry(
      "skill-1",
      before,
      after,
      (from, to, was) => `Dev edited the skill (${from} to ${to})${was}`,
      " Details kept.",
    );

    // The rename shows in the summary, and the changed region shows both sides of the edit.
    expect(entry.summary).toContain("(was old-name)");
    expect(entry.summary).toContain('Old: "two"');
    expect(entry.summary).toContain('New: "TWO"');
    expect(entry.summary).toContain("Details kept.");

    expect(entry.detail.name).toEqual({ before: "old-name", after: "new-name" });
    expect(entry.detail.changedRegion).toEqual({ before: "two", after: "TWO" });
    // A path that disappears counts as a removed file, so a renamed file leaves a trace too.
    expect(entry.detail.removedFiles).toEqual(["old.txt"]);
  });
});
