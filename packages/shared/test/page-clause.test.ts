// R37 (BOS-1682): a live page is proved by what it shows, not by "200 + title".
import { describe, expect, it } from "vitest";
import { afterMergeLint, namesPage, pageClauseRefusal, pageClauses } from "../src/index.js";

describe("page clauses", () => {
  it("reads the address and the quoted text, straight or curly quotes", () => {
    expect(pageClauses('Roadmap opens (page: https://roadmap.example.com/ shows "Planned next")')).toEqual([{ url: "https://roadmap.example.com/", text: "Planned next" }]);
    expect(pageClauses("Portal works (page: https://example.com/p shows “Your feedback”)")).toEqual([{ url: "https://example.com/p", text: "Your feedback" }]);
    expect(pageClauses("No clause here")).toEqual([]);
  });

  it("refuses empty text, a status line, the site's own name and a mistyped clause when the criterion is written", () => {
    const refuse = (text: string) => pageClauseRefusal([{ text, after: "merge" }]);
    expect(refuse('Opens (page: https://example.com shows "")')).toMatch(/empty/);
    expect(refuse('Opens (page: https://example.com shows "200 OK")')).toMatch(/status/);
    expect(refuse('Opens (page: https://example.com shows "302 → 200")')).toMatch(/status/);
    // The 16 Nov case: the error page had the same title as the working one.
    expect(refuse('Opens (page: https://roadmap.example.com shows "Roadmap")')).toMatch(/<title>/);
    expect(refuse('Opens (page: https://roadmap.example.com shows "roadmap.example.com")')).toMatch(/<title>/);
    expect(refuse("Opens (page: https://example.com)")).toMatch(/is written \(page:/);
    expect(refuse('Opens (page: example.com shows "Planned next")')).toMatch(/https:\/\//);
    expect(refuse('Opens (page: https://roadmap.example.com shows "Planned next")')).toBeNull();
    expect(pageClauseRefusal(["Plain criterion"])).toBeNull();
  });

  it("warns when an after-merge criterion is about a live page with no clause, and stays quiet with one", () => {
    const warn = (text: string) => afterMergeLint([{ text, after: "merge" }]);
    expect(warn("https://roadmap.example.com answers on the live server")).toMatch(/page clause/);
    expect(warn("The roadmap page opens from the portal link")).toMatch(/can close on a status code/);
    expect(warn('The roadmap page opens (page: https://roadmap.example.com shows "Planned next")')).toBe("");
    expect(warn("A push arrives on the owner's phone")).toBe("");
    // Before-merge criteria are checked in review, not by this gate.
    expect(afterMergeLint(["The roadmap page opens"])).not.toMatch(/page clause/);
    expect(namesPage("Settings shows the new field")).toBe(false);
  });
});
