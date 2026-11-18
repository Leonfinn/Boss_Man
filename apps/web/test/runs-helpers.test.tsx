// @vitest-environment jsdom
// Pins the pure helpers exported from pages/Runs.tsx (BOS-1766): whyRun, tokens, usage, outcomeTag, when.
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { RunRow } from "../src/api";
import { outcomeTag, tokens, usage, when, whyRun } from "../src/pages/Runs";

const run = (over: Partial<RunRow> = {}) => ({ id: "r1", ticketId: "t1", ...over }) as unknown as RunRow;

describe("whyRun", () => {
  it("maps a known reason to its words", () => {
    expect(whyRun(run({ reason: "assigned" }))).toBe("Was given the task");
    expect(whyRun(run({ reason: "woken by owner" }))).toBe("You woke it");
  });
  it("capitalises an unknown reason", () => {
    expect(whyRun(run({ reason: "something new" }))).toBe("Something new");
  });
  it("is empty with a ticket and no reason", () => {
    expect(whyRun(run({ reason: null }))).toBe("");
    expect(whyRun(run({ reason: "" }))).toBe("");
  });
  it("says chat runs by whether they ended", () => {
    expect(whyRun(run({ purpose: "chat" as never, endedAt: null }))).toBe("Answering the owner in chat");
    expect(whyRun(run({ purpose: "chat" as never, endedAt: "2026-01-01T00:00:00Z" }))).toBe("Answered the owner in chat");
  });
  it("uses the shared label for a run without a ticket", () => {
    expect(whyRun(run({ ticketId: null, reason: null }))).toBe("Run without a ticket (reason not recorded)");
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
    expect(usage(run({ fundingKind: "api" as never, costMicros: null }))).toEqual({ text: "$0.00", title: undefined });
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
  const tag = (o: string | null | undefined) => {
    const { container } = render(outcomeTag(o));
    const el = container.firstElementChild!;
    return `${el.className}|${el.textContent}`;
  };
  it("covers every outcome", () => {
    expect(tag(null)).toBe("tag blue|Running");
    expect(tag(undefined)).toBe("tag blue|Running");
    expect(tag("")).toBe("tag blue|Running");
    expect(tag("error: boom")).toBe("tag red|Failed");
    expect(tag("interrupted")).toBe("tag amber|Interrupted");
    expect(tag("cancelled")).toBe("tag|Stopped");
    expect(tag("stopped by owner")).toBe("tag|Stopped");
    expect(tag("lost on restart")).toBe("tag amber|Lost");
    expect(tag("completed")).toBe("tag green|Finished");
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
