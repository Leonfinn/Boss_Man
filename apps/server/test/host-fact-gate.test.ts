// The close gate for after-merge criteria that name a host fact (BOS-1586): the host's own newest report decides,
// never a "pass" in the note or an owner card answer. These tests pin the gate's pure helpers.
import { describe, expect, it } from "vitest";
import type { Criterion } from "@boss-man/shared";
import { CARD_CITE_REFUSAL, citedOpenCard, hostFactRefusal, namesOutsideService, noCriteriaOutsideServiceRefusal, outsideServiceEvidenceRefusal, ownLine, ownSiteHosts, pageShotRefusal, uncitedCardPasses } from "../src/services/host-fact-gate.js";
import type { HostFact } from "../src/services/host-facts.js";

const after = (text: string): Criterion => ({ text, after: "merge" });

const fact = (value: string): HostFact => ({ value, source: "host", at: "2026-11-16T12:00:00.000Z" });

const rec = (facts: Record<string, string> = {}, reportedAt: string | null = "2026-11-16T12:00:00.000Z") => ({
  facts: Object.fromEntries(Object.entries(facts).map(([k, v]) => [k, fact(v)])),
  reportedAt,
});

const LIVE = new Date("2026-11-16T11:00:00.000Z");
const PROBE_TEXT = "The host says the code host is reachable (fact: repo.probe = ok)";
const PROBE = after(PROBE_TEXT);

describe("hostFactRefusal", () => {
  it("ignores criteria that are not checked after merge", () => {
    expect(hostFactRefusal(["The host says it works (fact: repo.probe = ok)"], rec({ "repo.probe": "fail" }), LIVE, "")).toBeNull();
  });

  it("ignores after-merge criteria with no fact clause", () => {
    expect(hostFactRefusal([after("The page loads and shows the panel")], rec({ "repo.probe": "fail" }), LIVE, "")).toBeNull();
  });

  it("refuses when the host has sent no report yet", () => {
    const out = hostFactRefusal([PROBE], rec({}, null), LIVE, "");
    expect(out).toContain(`"${PROBE_TEXT}": the host has sent no report yet.`);
    expect(out).toContain("The host's own report doesn't show this ticket's after-merge fact checks as met:");
    expect(out).toContain("Ways out:");
  });

  it("refuses when the newest report is from before the ticket went live", () => {
    const out = hostFactRefusal([PROBE], rec({ "repo.probe": "ok" }, "2026-11-16T10:30:00.000Z"), LIVE, "");
    expect(out).toContain("is from before this ticket went live");
    expect(out).toContain("(2026-11-16 10:30 UTC)");
    expect(out).toContain("2026-11-16 11:00 UTC");
    expect(out).toContain("this isn't a failure");
  });

  it("accepts a report taken at the go-live moment", () => {
    expect(hostFactRefusal([PROBE], rec({ "repo.probe": "ok" }, "2026-11-16T11:00:00.000Z"), LIVE, "")).toBeNull();
  });

  it("does no staleness check when there is no go-live time", () => {
    expect(hostFactRefusal([PROBE], rec({ "repo.probe": "ok" }, "2026-11-01T00:00:00.000Z"), null, "")).toBeNull();
  });

  it("refuses when the reported fact does not match the clause", () => {
    const out = hostFactRefusal([PROBE], rec({ "repo.probe": "fail" }), LIVE, "");
    expect(out).toContain(`"${PROBE_TEXT}": the host reports repo.probe = fail (host report 2026-11-16 12:00 UTC).`);
  });

  it("treats a fact the host has not reported as missing", () => {
    const out = hostFactRefusal([PROBE], rec({}), LIVE, "");
    expect(out).toContain("the host reports repo.probe = (not reported)");
  });

  it("treats a reported but empty fact as empty, not ok", () => {
    const out = hostFactRefusal([PROBE], rec({ "repo.probe": "  " }), LIVE, "");
    expect(out).toContain("the host reports repo.probe = (empty)");
  });

  it("accepts a no-failing-check clause when every check is fine", () => {
    expect(hostFactRefusal([after("Nothing is failing (fact: no failing check)")], rec({ "check.health": "ok" }), LIVE, "")).toBeNull();
  });

  it("refuses a no-failing-check clause and names the failing check", () => {
    const out = hostFactRefusal([after("Nothing is failing (fact: no failing check)")], rec({ "check.health": "fail" }), LIVE, "");
    expect(out).toContain("the host reports check.health = fail");
  });

  it("lets the author's own fail verdict through", () => {
    expect(hostFactRefusal([PROBE], rec({ "repo.probe": "fail" }), LIVE, "1 fail")).toBeNull();
  });

  it("does not let a pass in the note override the host", () => {
    const out = hostFactRefusal([PROBE], rec({ "repo.probe": "fail" }), LIVE, "1 pass");
    expect(out).toContain("the host reports repo.probe = fail");
  });

  it("lists every unmet criterion and clause", () => {
    const criteria = [PROBE, after("The deployer matches (fact: deployer.scriptSha = abc) and nothing is failing (fact: no failing check)")];
    const out = hostFactRefusal(criteria, rec({ "check.health": "fail" }), LIVE, "");
    expect(out).toContain(`"${PROBE_TEXT}"`);
    expect(out).toContain("deployer.scriptSha = (not reported)");
    expect(out).toContain("check.health = fail");
  });
});

describe("citedOpenCard", () => {
  const id = "12345678-aaaa-bbbb-cccc-dddddddddddd";

  it("finds the whole id, ignoring case", () => {
    expect(citedOpenCard(`closes with ${id.toUpperCase()}`, [id])).toBe(id);
  });

  it("finds the first eight characters of the id", () => {
    expect(citedOpenCard("covered by card 12345678", [id])).toBe(id);
  });

  it("does not count a shorter prefix", () => {
    expect(citedOpenCard("covered by card 1234567", [id])).toBeNull();
  });

  it("returns null when no note cites any open card", () => {
    expect(citedOpenCard("no card here", ["99999999-aaaa-bbbb-cccc-dddddddddddd", id])).toBeNull();
  });

  it("returns the first open card in the list that the note cites", () => {
    const other = "99999999-aaaa-bbbb-cccc-dddddddddddd";
    expect(citedOpenCard(`cites ${other.slice(0, 8)} and 12345678`, [id, other])).toBe(id);
  });
});

describe("uncitedCardPasses", () => {
  const id = "12345678-aaaa-bbbb-cccc-dddddddddddd";

  it("returns an after-merge pass that allows a card but cites none", () => {
    const text = "The panel is shown, or a card was raised for it";
    expect(uncitedCardPasses([after(text)], "1 pass", [])).toEqual([text]);
  });

  it("accepts the pass once an open card is cited", () => {
    const text = "The panel is shown, or a card was raised for it";
    expect(uncitedCardPasses([after(text)], `1 pass, card ${id.slice(0, 8)}`, [id])).toEqual([]);
  });

  it("leaves a criterion with a fact clause to the host gate", () => {
    const text = "The host says ok (fact: repo.probe = ok), or a card was raised for it";
    expect(uncitedCardPasses([after(text)], "1 pass", [])).toEqual([]);
  });

  it("ignores criteria not checked after merge", () => {
    expect(uncitedCardPasses(["The panel is shown, or a card was raised for it"], "1 pass", [])).toEqual([]);
  });

  it("ignores a criterion reported as fail", () => {
    expect(uncitedCardPasses([after("The panel is shown, or a card was raised for it")], "1 fail", [])).toEqual([]);
  });

  it("ignores a criterion with no verdict in the note", () => {
    expect(uncitedCardPasses([after("The panel is shown, or a card was raised for it")], "nothing said yet", [])).toEqual([]);
  });

  it("returns only the uncited pass when several criteria are listed", () => {
    const first = "The panel is shown, or a card was raised for it";
    const second = "The banner is gone, or a card was raised for it";
    expect(uncitedCardPasses([after(first), after(second)], "1 pass; 2 pass", [])).toEqual([first, second]);
    expect(uncitedCardPasses([after(first), after(second)], `1 pass; 2 pass; card ${id}`, [id])).toEqual([]);
  });
});

describe("CARD_CITE_REFUSAL", () => {
  it("quotes every text and names the way out", () => {
    const out = CARD_CITE_REFUSAL(["The panel is shown", "The banner is gone"]);
    expect(out).toContain(`"The panel is shown", "The banner is gone"`);
    expect(out).toContain("its id, in the note");
    expect(out).toContain("raise_decision blocksTicketId");
    expect(out).toContain("counts as a fail");
  });
});

// BOS-2076: BOS-1737 criterion 5 was passed at review while Google knew none of the pages.
describe("outsideServiceEvidenceRefusal", () => {
  const G = after("After the next publish, Bing shows the submitted URLs and Google shows the sitemap read with no errors");
  const crit = [after("The panel loads"), G];
  const img = { id: "abcd1234-0000-0000-0000-000000000000", createdAt: new Date("2026-11-16T12:00:00.000Z") };
  it("refuses a bare pass on an outside-service criterion", () => {
    const out = outsideServiceEvidenceRefusal(crit, [], LIVE, "1 pass; 2 pass");
    expect(out).toContain("needs evidence");
    expect(out).toContain("Google shows the sitemap");
  });
  it("accepts a link, a quoted reading or a fresh screenshot", () => {
    expect(outsideServiceEvidenceRefusal(crit, [], LIVE, "1 pass; 2 pass: https://example.com/search-console-proof")).toBeNull();
    expect(outsideServiceEvidenceRefusal(crit, [], LIVE, '1 pass; 2 pass, it reads "Sitemap read, 12 pages discovered"')).toBeNull();
    expect(outsideServiceEvidenceRefusal(crit, [img], LIVE, "1 pass; 2 pass, shot abcd1234")).toBeNull();
  });
  it("does not count a screenshot from before go-live; leaves a fail and unrelated criteria alone", () => {
    const old = { ...img, createdAt: new Date("2026-11-16T09:00:00.000Z") };
    expect(outsideServiceEvidenceRefusal(crit, [old], LIVE, "1 pass; 2 pass, shot abcd1234")).not.toBeNull();
    expect(outsideServiceEvidenceRefusal(crit, [], LIVE, "1 pass; 2 fail: Google knows no pages")).toBeNull();
    expect(outsideServiceEvidenceRefusal([after("The panel loads")], [], LIVE, "1 pass")).toBeNull();
  });

  // BOS-2598 (G2-G4): BOS-2073 closed on a sitemap submit that returned 204.
  const SITEMAP = "Google Search Console shows the sitemap read with no errors";
  it("refuses a receipt as the outcome and points to Blocked plus schedule_check", () => {
    for (const receipt of ["pending, 0 errors", "submitted ok", "HTTP 204", "accepted", "queued", "processing", "202"]) {
      const out = outsideServiceEvidenceRefusal([SITEMAP], [], LIVE, `1 pass: ${receipt} "Sitemap submitted, 0 errors" https://search.google.com/x`);
      expect(out, receipt).toContain("That's a receipt, not the outcome. Move to Blocked with a dated re-check (schedule_check), or report fail.");
      expect(out).toContain("48 hours");
    }
  });
  it("refuses the BOS-2073 reading and accepts a real one", () => {
    expect(outsideServiceEvidenceRefusal([SITEMAP], [], LIVE, '1 pass: "accepted (pending, 0 errors)" https://bossman.website/sitemap.xml', ["bossman.website"])).toContain("That's a receipt");
    expect(outsideServiceEvidenceRefusal([SITEMAP], [], LIVE, '1 pass: "Success, last read 21 Nov, 7 discovered"', ["bossman.website"])).toBeNull();
  });
  it("checks before-merge criteria too, each on its own line", () => {
    const two = [SITEMAP, "Bing lists the sitemap"];
    expect(outsideServiceEvidenceRefusal(two, [], LIVE, '1 pass: "Sitemap read, 12 pages discovered"; 2 pass')).toContain('"Bing lists the sitemap"');
    // Evidence on line 1 does not cover line 2.
    expect(outsideServiceEvidenceRefusal(two, [], LIVE, '1 pass: "Sitemap read, 12 pages discovered"; 2 pass: "Bing shows 12 URLs indexed"')).toBeNull();
  });
  it("does not count a link to our own site", () => {
    const note = "1 pass: https://example.com/sitemap.xml";
    expect(outsideServiceEvidenceRefusal([SITEMAP], [], LIVE, note, ["example.com"])).toContain("needs evidence");
    expect(outsideServiceEvidenceRefusal([SITEMAP], [], LIVE, "1 pass: https://search.google.com/search-console/sitemaps", ["example.com"])).toBeNull();
  });
  it("finds the own-site hosts in ticket text, leaving out outside services", () => {
    expect(ownSiteHosts("Submit https://example.com/sitemap.xml to https://search.google.com/x", null)).toEqual(["example.com"]);
  });
});

describe("noCriteriaOutsideServiceRefusal (BOS-2598)", () => {
  it("refuses a no-branch ticket that names an outside service and has no criteria", () => {
    const out = noCriteriaOutsideServiceRefusal({ title: "Submit the sitemap to Google", body: null, noCode: true }, []);
    expect(out).toContain("add the outcome as a criterion");
  });
  it("leaves tickets with criteria, with a branch or naming no service alone", () => {
    expect(noCriteriaOutsideServiceRefusal({ title: "Submit the sitemap to Google", body: null, noCode: true }, ["It works"])).toBeNull();
    expect(noCriteriaOutsideServiceRefusal({ title: "Submit the sitemap to Google", body: null, noCode: false }, [])).toBeNull();
    expect(noCriteriaOutsideServiceRefusal({ title: "Tidy the wiki", body: "no service", noCode: true }, [])).toBeNull();
  });
});

// BOS-2266: R37's page-criterion gate, tested directly. A pass on a page clause needs a screenshot of this ticket
// attached since go-live, cited by (first 8 of) its id, and the clause's words quoted in the note.
describe("pageShotRefusal: a page-clause pass needs a fresh screenshot and a quote (BOS-1682)", () => {
  const PAGE_TEXT = 'The roadmap page shows "Your roadmap" (page: https://example.com/roadmap shows "Your roadmap")';
  const PAGE = after(PAGE_TEXT);
  const shot = (createdAt: string, id = "abcd1234-0000-0000-0000-000000000000") => ({ id, createdAt: new Date(createdAt) });

  it("accepts a pass that cites a screenshot taken since go-live and quotes the page text", () => {
    const note = '1 pass: screenshot abcd1234; the page reads "Your roadmap"';
    expect(pageShotRefusal([PAGE], [shot("2026-11-16T12:00:00.000Z")], LIVE, note)).toBeNull();
  });

  it("accepts the whole image id in any case", () => {
    const note = '1 pass: shot ABCD1234-0000-0000-0000-000000000000; page shows "Your roadmap"';
    expect(pageShotRefusal([PAGE], [shot("2026-11-16T12:00:00.000Z")], LIVE, note)).toBeNull();
  });

  it("refuses a bare pass and says a screenshot is needed and the text must be quoted", () => {
    const out = pageShotRefusal([PAGE], [], LIVE, "1 pass");
    expect(out).toContain("A pass on a page criterion needs a screenshot");
    expect(out).toContain("no screenshot of this ticket taken since go-live is cited");
    expect(out).toContain('the note doesn\'t quote "Your roadmap" as seen on the page');
  });

  it("refuses a screenshot attached before go-live, naming the go-live time", () => {
    const old = shot("2026-11-16T10:00:00.000Z");
    const out = pageShotRefusal([PAGE], [old], LIVE, '1 pass: shot abcd1234; page shows "Your roadmap"');
    expect(out).toContain("the screenshot cited was attached before this ticket went live (2026-11-16 11:00 UTC)");
    expect(out).not.toContain("no screenshot of this ticket taken since go-live is cited");
  });

  it("refuses a fresh screenshot when the page text is not quoted", () => {
    const out = pageShotRefusal([PAGE], [shot("2026-11-16T12:00:00.000Z")], LIVE, "1 pass: shot abcd1234");
    expect(out).toContain('the note doesn\'t quote "Your roadmap" as seen on the page');
    expect(out).not.toContain("no screenshot of this ticket taken since go-live is cited");
  });

  it("leaves a fail verdict, a criterion not checked after merge, and one with no page clause alone", () => {
    expect(pageShotRefusal([PAGE], [], LIVE, "1 fail")).toBeNull();
    expect(pageShotRefusal([after("The panel loads")], [], LIVE, "1 pass")).toBeNull();
    expect(pageShotRefusal(['The page loads (page: https://example.com/x shows "Ready")'], [], LIVE, "1 pass")).toBeNull();
  });

  it("counts any screenshot when no go-live time is recorded", () => {
    const note = '1 pass: shot abcd1234; page shows "Your roadmap"';
    expect(pageShotRefusal([PAGE], [shot("2020-01-01T00:00:00.000Z")], null, note)).toBeNull();
  });
});

// BOS-2639: the part of the note about one criterion. A numbered segment wins; otherwise the segment that repeats the
// criterion's words is the best guess, so a note can be checked line by line.
describe("ownLine (BOS-2639)", () => {
  const text = "The sitemap was read and shows no errors";

  it("picks the segment that starts with the criterion's number", () => {
    expect(ownLine("1 pass; 2 pass; 3 fail", 2, text)).toBe("2 pass");
  });

  it("accepts the C2 and 'criterion 2' prefixes", () => {
    expect(ownLine("C2 ok", 2, text)).toBe("C2 ok");
    expect(ownLine("criterion 2 fail", 2, text)).toBe("criterion 2 fail");
  });

  it("does not take a sub-number like 2.1 for criterion 2", () => {
    expect(ownLine("2.1 pass", 2, "Sitemap read")).toBeNull();
  });

  it("skips a numbered segment that says neither pass, ok nor fail", () => {
    expect(ownLine("2 ready; 2 ok", 2, text)).toBe("2 ok");
    expect(ownLine("2 ready", 2, text)).toBeNull();
  });

  it("falls back to the segment repeating at least three of the criterion's words", () => {
    expect(ownLine("something else; sitemap read shows fine", 2, text)).toBe("sitemap read shows fine");
  });

  it("needs all the words when the criterion has fewer than three", () => {
    expect(ownLine("the sitemap was read", 2, "Sitemap read")).toBe("the sitemap was read");
  });

  it("splits segments on semicolons and newlines", () => {
    expect(ownLine("1 pass\n2 pass", 2, text)).toBe("2 pass");
  });

  it("returns null when nothing is close enough", () => {
    expect(ownLine("unrelated; still unrelated", 2, text)).toBeNull();
  });
});

// BOS-2639: a criterion about a service outside Boss Man is recognised by the service's name, not by any word that
// happens to contain it.
describe("namesOutsideService (BOS-2639)", () => {
  it("matches named services in any case", () => {
    expect(namesOutsideService("Google Search Console shows the sitemap read")).toBe(true);
    expect(namesOutsideService("pushed to GitHub")).toBe(true);
    expect(namesOutsideService("A STRIPE payment")).toBe(true);
    expect(namesOutsideService("Docker Hub has the image")).toBe(true);
  });

  it("does not match plain text or a word that only contains a name", () => {
    expect(namesOutsideService("The panel loads and the page shows the roadmap")).toBe(false);
    expect(namesOutsideService("The build writes an npmrc file")).toBe(false);
    expect(namesOutsideService("a bingo card")).toBe(false);
  });
});
