// The close gate for after-merge criteria that name a host fact (BOS-1586): the host's own newest report decides,
// never a "pass" in the note or an owner card answer. These tests pin the gate's pure helpers.
import { describe, expect, it } from "vitest";
import type { Criterion } from "@boss-man/shared";
import { CARD_CITE_REFUSAL, citedOpenCard, hostFactRefusal, outsideServiceEvidenceRefusal, uncitedCardPasses } from "../src/services/host-fact-gate.js";
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
});
