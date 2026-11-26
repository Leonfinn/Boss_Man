// Pure helpers of the owner chat (BOS-2640, the 26 Nov sweep): why a run stopped, in plain words,
// and the owner's unanswered messages that the meaning search reads (BOS-2116).
// Kept apart from chat.test.ts, which opens a database and an MCP client.
import { describe, expect, it } from "vitest";
import { stopWords, unansweredOwnerText } from "../src/services/chat.js";

describe("stopWords", () => {
  it("says no reason was recorded when there is none", () => {
    expect(stopWords(null)).toBe("no stop reason was recorded");
    expect(stopWords("")).toBe("no stop reason was recorded");
  });

  it("puts each known outcome in plain words, keeping the recorded outcome quoted", () => {
    const cases: Array<[string, string]> = [
      ["end_turn", "it ended its turn without writing one"],
      ["max_tokens", "it hit its output limit"],
      ["max_turn_requests", "it hit its step limit"],
      ["refusal", "the model refused"],
      ["cancelled", "it was cancelled"],
      ["interrupted", "it was interrupted"],
    ];
    for (const [outcome, plain] of cases) {
      expect(stopWords(outcome)).toBe(`${plain}; stop reason "${outcome}"`);
    }
  });

  it("reads a Boss Man stop as what it was stopped for, quoted in full", () => {
    expect(stopWords("stopped: the owner changed the model")).toBe(
      'Boss Man stopped it: the owner changed the model; stop reason "stopped: the owner changed the model"',
    );
  });

  it("quotes an unknown outcome and cuts it at 200 characters", () => {
    expect(stopWords("some new outcome")).toBe('stop reason "some new outcome"');
    const long = "z".repeat(250);
    expect(stopWords(long)).toBe(`stop reason "${"z".repeat(200)}"`);
  });
});

describe("unansweredOwnerText", () => {
  type Line = { role: string; text: string };

  it("joins only the owner's messages after the last reply", () => {
    const recent: Line[] = [
      { role: "assistant", text: "reply one" },
      { role: "owner", text: "first" },
      { role: "agent", text: "an aside" },
      { role: "owner", text: "second" },
    ];
    expect(unansweredOwnerText(recent)).toBe("first\nsecond");
  });

  it("uses every owner message when there is no reply yet, leaving other roles out", () => {
    const recent: Line[] = [
      { role: "owner", text: "a" },
      { role: "assistant_other", text: "ignored" },
      { role: "owner", text: "b" },
    ];
    expect(unansweredOwnerText(recent)).toBe("a\nb");
  });

  it("gives nothing when the last reply has no owner message after it", () => {
    expect(
      unansweredOwnerText([
        { role: "owner", text: "answered" },
        { role: "assistant", text: "the reply" },
      ]),
    ).toBe("");
  });

  it("gives nothing for no messages at all", () => {
    expect(unansweredOwnerText([])).toBe("");
  });
});
