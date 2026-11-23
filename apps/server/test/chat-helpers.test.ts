// Pure helpers of the owner chat (BOS-2305, the BOS-1770 list): the old "You said" footer stripper
// that list() and prompts still run, and the text the named-things lookup reads.
import { describe, expect, it } from "vitest";
import { namedTexts, stripYouSaidLines } from "../src/services/chat.js";

type Line = { role: string; text: string };

describe("stripYouSaidLines", () => {
  it("leaves a reply with no footer alone", () => {
    expect(stripYouSaidLines("The work is done.")).toBe("The work is done.");
  });

  it("drops one saved footer line under a reply and keeps the reply", () => {
    const text = 'The work is done.\n\nYou said "Add SSO", 2026-11-01, about the SSO ticket, and keep it short.';
    expect(stripYouSaidLines(text)).toBe("The work is done.");
  });

  it("drops every saved footer line, not just the first", () => {
    const text = 'Done.\nYou said "one", 2026-11-01, about a ticket.\nYou said "two", 2026-11-02, about another ticket.';
    expect(stripYouSaidLines(text)).toBe("Done.");
  });

  it("keeps a line that only looks like a footer but has no date and 'about'", () => {
    const text = 'You said "hello"\nand the owner answered.';
    expect(stripYouSaidLines(text)).toBe(text);
  });

  it("trims trailing whitespace even when there is no footer", () => {
    expect(stripYouSaidLines("Done.\n\n")).toBe("Done.");
  });
});

describe("namedTexts", () => {
  it("gives the last reply and the owner's messages after it", () => {
    const recent: Line[] = [
      { role: "owner", text: "first" },
      { role: "assistant", text: "reply one" },
      { role: "owner", text: "second" },
      { role: "owner", text: "third" },
    ];
    expect(namedTexts(recent)).toEqual(["reply one", "second", "third"]);
  });

  it("uses only the last reply, never an earlier one", () => {
    const recent: Line[] = [
      { role: "assistant", text: "older reply" },
      { role: "owner", text: "question" },
      { role: "assistant", text: "newest reply" },
      { role: "owner", text: "follow-up" },
    ];
    expect(namedTexts(recent)).toEqual(["newest reply", "follow-up"]);
  });

  it("gives every owner message when there is no reply yet", () => {
    const recent: Line[] = [
      { role: "owner", text: "a" },
      { role: "owner", text: "b" },
    ];
    expect(namedTexts(recent)).toEqual(["a", "b"]);
  });

  it("gives just the reply when the owner has not written since it", () => {
    const recent: Line[] = [
      { role: "owner", text: "q" },
      { role: "assistant", text: "a" },
    ];
    expect(namedTexts(recent)).toEqual(["a"]);
  });

  it("skips non-owner lines after the reply and keeps the owner's", () => {
    const recent: Line[] = [
      { role: "owner", text: "q" },
      { role: "assistant", text: "a" },
      { role: "system", text: "a note" },
      { role: "owner", text: "follow-up" },
    ];
    expect(namedTexts(recent)).toEqual(["a", "follow-up"]);
  });

  it("gives nothing for an empty conversation", () => {
    expect(namedTexts([])).toEqual([]);
  });
});
