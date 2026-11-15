import { describe, expect, it } from "vitest";
import { optionVerdictsRefusal } from "../src/acceptance.js";

// A card that settles an after-merge check tells Boss Man what each of its options means for
// that check (BOS-1155). optionVerdictsRefusal is the gate: every option must say pass, fail or
// none, and the map must not name anything the card does not offer. It never guesses from the
// option's own words. These cases pin the function directly, not through raise_decision.

const OPTIONS = ["Close it on the tests", "Keep it open", "It failed"];

// The exact how-to sentence every refusal text ends with, so a test can check it is carried.
const HOW = 'A card that settles an after-merge check needs optionVerdicts: for each option, whether choosing it means the check passed ("pass"), failed ("fail") or says nothing about it ("none"), e.g. {"Close it on the tests": "pass", "Keep it open": "none"}. Boss Man never guesses this from the option\'s words.';

describe("optionVerdictsRefusal", () => {
  describe("a missing map", () => {
    it.each([
      ["undefined", undefined],
      ["null", null],
      ["an empty object", {}],
    ])("asks for the map when it is %s", (_label, map) => {
      const refusal = optionVerdictsRefusal(OPTIONS, map);
      expect(refusal).toBe(HOW);
      expect(refusal).toMatch(/needs optionVerdicts/);
      expect(refusal).toContain('{"Close it on the tests": "pass", "Keep it open": "none"}');
    });
  });

  describe("a full map", () => {
    it("gives null when every option says pass, fail or none", () => {
      expect(optionVerdictsRefusal(OPTIONS, { "Close it on the tests": "pass", "Keep it open": "none", "It failed": "fail" })).toBeNull();
    });

    it("gives null whatever order the map is in", () => {
      expect(optionVerdictsRefusal(OPTIONS, { "It failed": "fail", "Keep it open": "none", "Close it on the tests": "pass" })).toBeNull();
    });

    it("gives null for a card with a single option", () => {
      expect(optionVerdictsRefusal(["Done"], { Done: "pass" })).toBeNull();
    });
  });

  describe("an option left out", () => {
    it("names the missing option in quotes and gives the how-to text", () => {
      const refusal = optionVerdictsRefusal(OPTIONS, { "Close it on the tests": "pass", "Keep it open": "none" });
      expect(refusal).toContain('has no pass, fail or none for "It failed"');
      expect(refusal).toContain(HOW);
    });

    it("names every missing option, two of them, each in quotes", () => {
      const refusal = optionVerdictsRefusal(OPTIONS, { "Keep it open": "none" });
      expect(refusal).toContain('has no pass, fail or none for "Close it on the tests", "It failed"');
      expect(refusal).toContain(HOW);
    });
  });

  describe("a word that is not pass, fail or none", () => {
    it("names an option given \"maybe\"", () => {
      const refusal = optionVerdictsRefusal(OPTIONS, { "Close it on the tests": "maybe", "Keep it open": "none", "It failed": "fail" });
      expect(refusal).toContain('has no pass, fail or none for "Close it on the tests"');
      expect(refusal).toContain(HOW);
    });

    it("names an option given \"PASS\": the words are case-sensitive", () => {
      const refusal = optionVerdictsRefusal(OPTIONS, { "Close it on the tests": "pass", "Keep it open": "none", "It failed": "PASS" });
      expect(refusal).toContain('has no pass, fail or none for "It failed"');
      expect(refusal).toContain(HOW);
    });

    it("names two bad options, the left-out one and the wrong-worded one", () => {
      const refusal = optionVerdictsRefusal(OPTIONS, { "Close it on the tests": "pass", "Keep it open": "maybe" });
      expect(refusal).toContain('has no pass, fail or none for "Keep it open", "It failed"');
      expect(refusal).toContain(HOW);
    });
  });

  describe("an option the card does not have", () => {
    it("says a single extra name is not an option", () => {
      const refusal = optionVerdictsRefusal(OPTIONS, { "Close it on the tests": "pass", "Keep it open": "none", "It failed": "fail", "Close it anyway": "pass" });
      expect(refusal).toContain('names "Close it anyway", which is not an option on the card');
      expect(refusal).toContain("Use each option's exact text.");
      expect(refusal).not.toContain("has no pass, fail or none");
    });

    it("says two extra names are not options", () => {
      const refusal = optionVerdictsRefusal(OPTIONS, { "Close it on the tests": "pass", "Keep it open": "none", "It failed": "fail", Other: "pass", "One more": "none" });
      expect(refusal).toContain('names "Other", "One more", which are not an option on the card');
      expect(refusal).not.toContain("has no pass, fail or none");
    });

    it("catches a near-miss: an option's words with different case are still not the option", () => {
      const refusal = optionVerdictsRefusal(OPTIONS, { "close it on the tests": "pass", "Keep it open": "none", "It failed": "fail" });
      expect(refusal).toContain('has no pass, fail or none for "Close it on the tests"');
      expect(refusal).not.toContain("which is not an option");
    });
  });

  describe("both a missing option and an extra name", () => {
    it("reports the missing option, because that check comes first", () => {
      const refusal = optionVerdictsRefusal(OPTIONS, { "Close it on the tests": "pass", "Keep it open": "none", "Close it anyway": "fail" });
      expect(refusal).toContain('has no pass, fail or none for "It failed"');
      expect(refusal).not.toContain("which is not an option");
    });
  });
});
