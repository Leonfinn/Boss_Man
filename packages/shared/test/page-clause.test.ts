// R37 (BOS-1682): a live page is proved by what it shows, not by "200 + title".
import { describe, expect, it } from "vitest";
import { afterMergeLint, namesPage, normQuote, pageClauseProblem, pageClauseRefusal, pageClauses, withoutPageClauses } from "../src/index.js";

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

describe("withoutPageClauses", () => {
  it("leaves text with no clause alone", () => {
    expect(withoutPageClauses("Settings shows the new field")).toBe("Settings shows the new field");
    expect(withoutPageClauses("")).toBe("");
  });

  it("takes out one clause and keeps the words around it", () => {
    const text = 'The roadmap opens (page: https://roadmap.example.com/ shows "Planned next") from the portal.';
    expect(withoutPageClauses(text)).toBe("The roadmap opens  from the portal.");
  });

  it("takes out several clauses, straight and curly quotes alike", () => {
    const text =
      'Roadmap (page: https://roadmap.example.com shows "Planned next") and portal (page: https://example.com/p shows “Your feedback”) both open.';
    expect(withoutPageClauses(text)).toBe("Roadmap  and portal  both open.");
  });

  it("leaves a clause-shaped text with no quotes in it, since it isn't a clause", () => {
    expect(withoutPageClauses("Opens (page: https://example.com)")).toBe("Opens (page: https://example.com)");
  });
});

describe("normQuote", () => {
  it("lowercases and flattens whitespace, trimming the ends", () => {
    expect(normQuote("  Planned\t  NEXT\n")).toBe("planned next");
  });

  it("turns curly double quotes into straight ones", () => {
    expect(normQuote("“Your feedback”")).toBe('"your feedback"');
  });

  it("leaves a string that is already normal as it is", () => {
    expect(normQuote("planned next")).toBe("planned next");
  });
});

describe("pageClauseProblem", () => {
  const problem = (url: string, text: string) => pageClauseProblem({ url, text });

  it("refuses an address that isn't a full URL", () => {
    expect(problem("example.com", "Planned next")).toMatch(/isn't a full address/);
  });

  it("refuses a URL that isn't a web address", () => {
    expect(problem("ftp://example.com/p", "Planned next")).toMatch(/isn't a web address/);
  });

  it("refuses empty text, and text that is only whitespace", () => {
    expect(problem("https://example.com/p", "")).toMatch(/is empty/);
    expect(problem("https://example.com/p", "   ")).toMatch(/is empty/);
  });

  it("refuses a status line and anything shorter than four characters", () => {
    for (const text of ["200", "200 OK", "302 → 200", "OK", "Success", "abc"]) {
      expect(problem("https://example.com/p", text)).toMatch(/is a status/);
    }
  });

  it("refuses the site's own name: the host, its first part, or the address itself", () => {
    expect(problem("https://roadmap.example.com/p", "roadmap.example.com")).toMatch(/site's name/);
    expect(problem("https://roadmap.example.com/p", "Roadmap")).toMatch(/site's name/);
    expect(problem("https://roadmap.example.com/p", "Roadmap.example.com")).toMatch(/site's name/);
    expect(problem("https://roadmap.example.com/p", "Road map")).toMatch(/site's name/);
    expect(problem("https://roadmap.example.com/p", "https://roadmap.example.com/p")).toMatch(/site's name/);
  });

  it("accepts text only the working page shows, on http and https addresses, with or without www", () => {
    expect(problem("https://roadmap.example.com/p", "Planned next")).toBeNull();
    expect(problem("http://example.com/p", "Your feedback")).toBeNull();
    expect(problem("https://www.example.com/p", "Your feedback")).toBeNull();
  });
});
