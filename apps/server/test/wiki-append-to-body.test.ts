import { describe, expect, it } from "vitest";
import { appendToBody, WikiError } from "../src/services/wiki.js";

// Pins appendToBody on its own (BOS-1848). wiki.test.ts covers the append service end to end;
// this file pins the exact text the pure helper hands back for every position it supports.
const LOG = [
  "# Release log",
  "",
  "Standing notes.",
  "",
  "## 2026-11-03",
  "",
  "- 23:15: shipped v1.2.0",
  "- 17:00: shipped v1.1.9",
  "",
  "### Detail",
  "",
  "older detail",
  "",
  "## 2026-11-02",
  "",
  "- 12:00: shipped v1.1.8",
].join("\n");

const newestUnderLog = (text: string) => LOG.replace("Standing notes.\n\n## 2026-11-03", `Standing notes.\n\n${text}\n\n## 2026-11-03`);
const newestUnderDay = (text: string) => LOG.replace("## 2026-11-03\n\n- 23:15", `## 2026-11-03\n\n${text}\n\n- 23:15`);
const oldestUnderDay = (text: string) => LOG.replace("- 17:00: shipped v1.1.9\n\n### Detail", `- 17:00: shipped v1.1.9\n${text}\n\n### Detail`);
const bottomUnderDay = (text: string) => LOG.replace("older detail\n\n## 2026-11-02", `older detail\n\n${text}\n\n## 2026-11-02`);

describe("appendToBody, no heading", () => {
  it("puts an entry at the top, below the page's # Title and above everything else", () => {
    expect(appendToBody(LOG, "Newest", undefined, "top")).toBe(`# Release log\n\nNewest\n\n${LOG.slice("# Release log\n\n".length)}`);
  });

  it("puts an entry at the very end, after the last section's own text", () => {
    expect(appendToBody(LOG, "Oldest", undefined, "bottom")).toBe(`${LOG.trimEnd()}\n\nOldest\n`);
  });

  it("treats oldest with no heading as the end of the page too", () => {
    expect(appendToBody(LOG, "Oldest", undefined, "oldest")).toBe(`${LOG.trimEnd()}\n\nOldest\n`);
  });
});

describe("appendToBody under a heading", () => {
  it("adds newest first after the heading's intro text and before its first sub-heading", () => {
    expect(appendToBody(LOG, "New note", "Release log", "top")).toBe(newestUnderLog("New note"));
  });

  it("adds newest first at the top of a section that is only a list", () => {
    expect(appendToBody(LOG, "- 09:00: shipped v1.3.0", "2026-11-03", "top")).toBe(newestUnderDay("- 09:00: shipped v1.3.0"));
  });

  it("adds oldest at the end of the heading's own text, before its sub-headings", () => {
    expect(appendToBody(LOG, "- 08:00: late", "2026-11-03", "oldest")).toBe(oldestUnderDay("- 08:00: late"));
  });

  it("adds bottom at the end of the whole section, after its sub-headings", () => {
    expect(appendToBody(LOG, "- 10:00: bottom", "2026-11-03", "bottom")).toBe(bottomUnderDay("- 10:00: bottom"));
  });

  it("matches a heading by its path as well as by its own text", () => {
    expect(appendToBody(LOG, "Detail note", "2026-11-03 > Detail", "oldest")).toBe(LOG.replace("older detail\n\n## 2026-11-02", "older detail\n\nDetail note\n\n## 2026-11-02"));
  });

  it("leaves every other character alone", () => {
    const out = appendToBody(LOG, "New note", "Release log", "top");
    expect(out).toContain("## 2026-11-02\n\n- 12:00: shipped v1.1.8");
    expect(out).toContain("### Detail\n\nolder detail");
    expect(out).toContain("- 23:15: shipped v1.2.0\n- 17:00: shipped v1.1.9");
  });
});

describe("appendToBody with a heading that is missing or repeated", () => {
  it("refuses a heading that isn't on the page and names the headings it has", () => {
    let error: unknown;
    try {
      appendToBody(LOG, "- x", "No such heading", "top");
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(WikiError);
    expect((error as WikiError).status).toBe(404);
    expect((error as Error).message).toMatch(/no heading "No such heading"/);
    expect((error as Error).message).toContain('"Release log"');
    expect((error as Error).message).toContain('"Release log > 2026-11-03 > Detail"');
  });

  it("refuses intro, the text above the first heading, as if the heading were missing", () => {
    expect(() => appendToBody(LOG, "- x", "intro", "top")).toThrow(/no heading "intro"/);
  });

  it("adds under the first of two headings with the same name and leaves the second alone", () => {
    const dup = "# Log\n\n## Notes\n\nfirst body\n\n## Notes\n\nsecond body\n";
    const out = appendToBody(dup, "new entry", "Notes", "top");
    expect(out).toBe("# Log\n\n## Notes\n\nfirst body\n\nnew entry\n\n## Notes\n\nsecond body\n");
    expect(out.split("new entry")).toHaveLength(2);
    expect(out.indexOf("new entry")).toBeLessThan(out.lastIndexOf("## Notes"));
  });
});

describe("appendToBody with a code fence in the entry", () => {
  it("refuses an entry whose fence never closes", () => {
    let error: unknown;
    try {
      appendToBody(LOG, "```ts\ncode", "Release log", "top");
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(WikiError);
    expect((error as WikiError).status).toBe(400);
    expect((error as Error).message).toMatch(/never closes/);
  });

  it("accepts a closed fence and keeps the page's later headings readable", () => {
    const out = appendToBody(LOG, "```ts\ncode\n```", "Release log", "top");
    expect(out).toContain("```ts\ncode\n```");
    expect(out).toContain("## 2026-11-02\n\n- 12:00: shipped v1.1.8");
  });
});
