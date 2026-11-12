// The four helpers that read and change a project brief's Lessons section, without a database:
// normalizeLesson folds a lesson to one bounded line, lessonsSection finds the section's text,
// addLesson appends a bullet, and removeLessonLine drops the first matching one.
import { describe, expect, it } from "vitest";
import { LESSON_MAX, addLesson, lessonsFrom, lessonsSection, normalizeLesson, removeLessonLine } from "../src/services/wiki.js";

describe("normalizeLesson", () => {
  it("folds newlines, tabs and runs of spaces to one space and trims both ends", () => {
    expect(normalizeLesson("  Read\tthe\n\nconfig   from\tthe environment.  ")).toBe("Read the config from the environment.");
  });

  it("cuts text past the limit to the limit or fewer with no trailing space", () => {
    expect(normalizeLesson("L".repeat(300))).toBe("L".repeat(LESSON_MAX));
    const folded = normalizeLesson("word ".repeat(60));
    expect(folded.length).toBeLessThanOrEqual(LESSON_MAX);
    expect(folded).not.toMatch(/\s$/);
  });

  it("gives an empty string for spaces only", () => {
    expect(normalizeLesson("   \n\t  ")).toBe("");
  });
});

describe("lessonsSection", () => {
  it("returns null when there is no Lessons heading", () => {
    expect(lessonsSection("## Gotchas\n\nBeware.\n")).toBeNull();
  });

  it("finds the heading in any capitals", () => {
    expect(lessonsSection("## LESSONS\n\n- A\n")).toContain("- A");
    expect(lessonsSection("## lessons\n\n- A\n")).toContain("- A");
  });

  it("ignores a level-3 Lessons heading", () => {
    expect(lessonsSection("### Lessons\n\n- A\n")).toBeNull();
  });

  it("stops at the next level-2 heading, so a later section's bullets are not included", () => {
    const body = "## Lessons\n\n- A\n\n## Gotchas\n\n- not a lesson\n";
    const section = lessonsSection(body);
    expect(section).toContain("- A");
    expect(section).not.toContain("not a lesson");
    expect(lessonsFrom(body)).toEqual(["A"]);
  });
});

describe("addLesson", () => {
  it("adds a Lessons section at the end when there is none", () => {
    const body = addLesson("# Project\n\n## Gotchas\n\nBeware.\n", "Read the config from the environment.");
    expect(body).toContain("## Lessons");
    expect(body.indexOf("## Gotchas")).toBeLessThan(body.indexOf("## Lessons"));
    expect(lessonsFrom(body)).toEqual(["Read the config from the environment."]);
  });

  it("puts the new line after the last existing bullet, leaving the following section unchanged", () => {
    const following = "## Deploy\n\nDo it on Friday.\n";
    const body = addLesson(`## Lessons\n\n- First\n- Second\n\n${following}`, "Third");
    expect(lessonsFrom(body)).toEqual(["First", "Second", "Third"]);
    expect(body.slice(body.indexOf("## Deploy"))).toBe(following);
  });

  it("added twice, keeps both lines in order and lessonsFrom reads them back", () => {
    let body = "## Gotchas\n\nBeware.\n";
    body = addLesson(body, "First");
    body = addLesson(body, "Second");
    expect(lessonsFrom(body)).toEqual(["First", "Second"]);
  });
});

describe("removeLessonLine", () => {
  it("removes only the first matching line when the same lesson appears twice", () => {
    const out = removeLessonLine("## Lessons\n\n- Same\n- Same\n- Other\n", "Same");
    expect(lessonsFrom(out)).toEqual(["Same", "Other"]);
  });

  it("matches a line with extra spaces around it", () => {
    const out = removeLessonLine("## Lessons\n\n   - Same   \n", "Same");
    expect(lessonsFrom(out)).toEqual([]);
  });

  it("leaves the body exactly as it was when the lesson is not on the page", () => {
    const body = "## Lessons\n\n- Same\n- Other\n";
    expect(removeLessonLine(body, "Missing")).toBe(body);
  });
});
