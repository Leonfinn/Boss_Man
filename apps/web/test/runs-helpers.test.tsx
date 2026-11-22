// @vitest-environment jsdom
// Pins the pure helpers exported from pages/Runs.tsx (BOS-1766): whyRun, tokens, usage, outcomeTag, when.
// BOS-1851 fills in every reason whyRun maps and checks outcomeTag without rendering.
import { describe, expect, it } from "vitest";
import type { RunRow } from "../src/api";
import { outcomeTag, tokens, usage, when, whyRun } from "../src/pages/Runs";

const run = (over: Partial<RunRow> = {}) => ({ id: "r1", ticketId: "t1", ...over }) as unknown as RunRow;

// Every reason the page's own table maps, so changing or dropping a word shows up here.
const REASONS: Array<[reason: string, words: string]> = [
  ["assigned", "Was given the task"],
  ["woken by owner", "You woke it"],
  ["message", "Your message"],
  ["owner_chat", "Chat with you"],
  ["chat", "Chat with you"],
  ["decision", "Answering a decision"],
  ["decision answered", "Your answer to its question"],
  ["feedback", "New feedback to triage"],
  ["chased", "Chased: something is waiting on it"],
  ["unblocked", "Its task was unblocked"],
  ["resume", "Picking up after a restart"],
  ["engagement", "Another company's request"],
  ["deploy rejected", "You rejected its deploy"],
  ["review", "Review feedback"],
  ["reviewer", "Asked to review"],
  ["changes requested", "Changes requested"],
  ["verify failed", "Its merge check failed"],
  ["deploy approved", "You approved its deploy"],
];

describe("whyRun", () => {
  it("maps every reason the page knows to its words", () => {
    for (const [reason, words] of REASONS) {
      expect(whyRun(run({ reason })), reason).toBe(words);
    }
  });
  it("capitalises a reason it has no words for, and touches nothing else", () => {
    expect(whyRun(run({ reason: "something new" }))).toBe("Something new");
    expect(whyRun(run({ reason: "some_reason" }))).toBe("Some_reason");
  });
  it("is empty with a ticket and no reason", () => {
    expect(whyRun(run({ reason: null }))).toBe("");
    expect(whyRun(run({ reason: undefined }))).toBe("");
    expect(whyRun(run({ reason: "" }))).toBe("");
  });
  it("says chat runs by whether they ended", () => {
    expect(whyRun(run({ purpose: "chat", endedAt: null }))).toBe("Answering the owner in chat");
    expect(whyRun(run({ purpose: "chat", endedAt: "2026-01-01T00:00:00Z" }))).toBe("Answered the owner in chat");
    // A chat run answers even when a reason was also recorded.
    expect(whyRun(run({ purpose: "chat", reason: "assigned", endedAt: null }))).toBe("Answering the owner in chat");
  });
  it("reads a recorded reason when the purpose is not chat", () => {
    expect(whyRun(run({ purpose: null, reason: "feedback" }))).toBe("New feedback to triage");
    expect(whyRun(run({ purpose: "ticket", reason: "verify failed" }))).toBe("Its merge check failed");
  });
  it("uses the shared label for a run without a ticket", () => {
    expect(whyRun(run({ ticketId: null, reason: null }))).toBe("Run without a ticket (reason not recorded)");
    expect(whyRun(run({ ticketId: null, purpose: "chat", endedAt: null }))).toBe("Answering the owner in chat");
    expect(whyRun(run({ ticketId: null, origin: "nudge", originFrom: "CEO", originNote: "take this on" }))).toBe("Nudged by CEO: take this on");
    expect(whyRun(run({ ticketId: null, reason: "some_reason" }))).toBe("Some reason");
  });
});

describe("tokens", () => {
  it("prints small numbers as they are", () => {
    expect(tokens(0)).toBe("0");
    expect(tokens(999)).toBe("999");
  });
  it("uses k from 1000 and M from a million", () => {
    expect(tokens(1000)).toBe("1.0k");
    expect(tokens(1234)).toBe("1.2k");
    expect(tokens(1_000_000)).toBe("1.0M");
    expect(tokens(2_560_000)).toBe("2.6M");
  });
});

describe("usage", () => {
  it("shows dollars for API-funded runs, zero when cost is missing", () => {
    expect(usage(run({ fundingKind: "api" as never, costMicros: 1_500_000 }))).toEqual({ text: "$1.50", title: undefined });
    expect(usage(run({ fundingKind: "api" as never, costMicros: undefined }))).toEqual({ text: "$0.00", title: undefined });
  });
  it("says Subscription when tokens weren't recorded", () => {
    const u = usage(run({ fundingKind: "subscription" as never, inputTokens: undefined, outputTokens: 5 }));
    expect(u.text).toBe("Subscription");
    expect(u.title).toMatch(/wasn't recorded/);
  });
  it("shows tokens in and out with a cache breakdown", () => {
    const u = usage(run({ fundingKind: "subscription" as never, inputTokens: 1500, outputTokens: 20, cachedReadTokens: 1000, cachedWriteTokens: undefined }));
    expect(u.text).toBe("1.5k in · 20 out");
    expect(u.title).toBe(`${(1500).toLocaleString()} input and 20 output tokens; ${(1000).toLocaleString()} read from the cache and 0 written to it.`);
  });
});

describe("outcomeTag", () => {
  // The element is inspected as returned: no React render is needed to pin the tag and its words.
  const tag = (o: string | null | undefined) => {
    const el = outcomeTag(o) as unknown as { props: { className?: string; children?: string } };
    return `${el.props.className}|${el.props.children}`;
  };
  it("covers every outcome, including null and unknown values", () => {
    expect(tag(null)).toBe("tag blue|Running");
    expect(tag(undefined)).toBe("tag blue|Running");
    expect(tag("")).toBe("tag blue|Running");
    expect(tag("error: boom")).toBe("tag red|Failed");
    expect(tag("error")).toBe("tag red|Failed");
    expect(tag("interrupted")).toBe("tag amber|Interrupted");
    expect(tag("cancelled")).toBe("tag|Stopped");
    expect(tag("stopped by owner")).toBe("tag|Stopped");
    expect(tag("lost on restart")).toBe("tag amber|Lost");
    expect(tag("completed")).toBe("tag green|Finished");
    expect(tag("end_turn")).toBe("tag green|Finished");
    expect(tag("something new")).toBe("tag green|Finished");
  });
});

describe("when", () => {
  it("is empty for missing times", () => {
    expect(when(null)).toBe("");
    expect(when(undefined)).toBe("");
    expect(when("")).toBe("");
  });
  it("formats a real time and matches the same locale call", () => {
    const iso = "2026-03-05T14:07:00Z";
    expect(when(iso)).toBe(new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }));
    expect(when(iso)).not.toBe("");
  });
});
