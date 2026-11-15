// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Decision } from "../src/api";
import { NeedsYou, RightNow, healthLines, needsKind } from "../src/components/DashboardPanels";
import { MergesStuckBanner, stuckSummary, type MergeHealthView } from "../src/components/MergesStuckBanner";

// BOS-1507 (design BOS-1490): the Dashboard's Needs you and Right now panels and the stuck-merges banner.

afterEach(cleanup);

const card = (n: number, extra: Partial<Decision> = {}): Decision =>
  ({ id: `00000000-0000-4000-8000-00000000000${n}`, companyId: "c1", kind: "question", question: `Question ${n}`, options: ["Yes", "No"], recommendedOption: "Yes", tier: "owner", createdAt: new Date(Date.now() - (10 - n) * 3_600_000).toISOString(), companyName: "Co", agentName: "Fern", blocks: [], about: [], score: 0, parts: { blocking: 0, urgency: 0, age: 0, liveRun: 0 }, reasons: [], ageReason: "", dueDate: null, ...extra }) as Decision;

const view = (extra: Partial<MergeHealthView> = {}): MergeHealthView => ({ waitingCount: 0, stuckCount: 0, running: [], waiting: [], ...extra });
const stuckWaiting = { ref: "FERN-10", title: "Ten", minutes: 960, label: "waiting: no runner is connected", next: null, stuck: true, actor: "system", decisionId: null };

describe("Needs you", () => {
  it("shows the 5 oldest with their own button, then the shared count and Open Decisions", () => {
    const all = [1, 2, 3, 4, 5, 6, 7].map((n) => card(n));
    render(<NeedsYou decisions={[...all].reverse()} tally={{ open: 9, waiting: 2 }} />);
    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(5);
    expect(within(rows[0]!).getByText("Question 1")).toBeTruthy();
    expect(screen.getByRole("heading", { name: /Needs you/ }).textContent).toContain("9");
    expect(screen.getByText(/4 more need you/)).toBeTruthy();
    expect(screen.getByText(/2 with the team, nothing to do yet/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open Decisions (all 9)" })).toBeTruthy();
    expect(within(rows[0]!).getByRole("link", { name: /Answer: Question 1/ }).getAttribute("href")).toBe(`#/decisions/${all[0]!.id}`);
  });

  it("says nothing needs you, with a tick and words, when the queue is empty", () => {
    render(<NeedsYou decisions={[]} tally={{ open: 0, waiting: 2 }} />);
    expect(screen.getByText("Nothing needs you.")).toBeTruthy();
    expect(screen.getByText(/2 cards are with the team/)).toBeTruthy();
  });

  it("keeps its size while loading", () => {
    render(<NeedsYou decisions={null} tally={null} />);
    expect(screen.getByText("Checking…")).toBeTruthy();
  });

  it("names the button by kind", () => {
    expect(needsKind(card(1, { kind: "signoff" }))).toEqual({ tag: "Sign-off", button: "Sign off" });
    expect(needsKind(card(1, { options: ["Approve plan", "Change"] }))).toEqual({ tag: "Review", button: "Review" });
    expect(needsKind(card(1))).toEqual({ tag: "Card", button: "Answer" });
  });
});

describe("Right now", () => {
  const ok = { runner: { registered: true, connected: true, lastSeenAt: null }, usage: { agents: 0, accounts: [], firstResetAt: null }, update: { waiting: false, phase: null, deadline: null } };

  it("always lists Runner, Merges, Usage limits, Update, in that order", () => {
    const lines = healthLines({ health: ok, merges: view(), stuck: null, running: 2, companyId: "c1" });
    expect(lines.map((l) => l.key)).toEqual(["runner", "merges", "usage", "update"]);
    expect(lines.every((l) => l.tone === "ok")).toBe(true);
    expect(lines[0]!.text).toBe("2 agents running now.");
  });

  it("says 'not known' in words, never green, for every line that couldn't be read", () => {
    const lines = healthLines({ health: {}, merges: null, stuck: null, running: 0, companyId: "c1" });
    expect(lines.map((l) => l.tone)).toEqual(["unknown", "unknown", "unknown", "unknown"]);
    expect(lines.map((l) => l.symbol)).toEqual(["?", "?", "?", "?"]);
    expect(lines[1]!.state).toBe("Merges: couldn't check");
    expect(lines[2]!.text).toContain("older than the check");
  });

  it("marks an offline runner, stuck merges, held agents and a waiting update with symbol and words", () => {
    const stuck = stuckSummary(view({ waiting: [stuckWaiting] }));
    const lines = healthLines({
      health: { runner: { registered: true, connected: false, lastSeenAt: new Date(Date.now() - 3 * 3_600_000).toISOString() }, usage: { agents: 2, accounts: ["Claude Max"], firstResetAt: new Date(Date.now() + 3_600_000).toISOString() }, update: { waiting: true, phase: "waiting", deadline: null } },
      merges: view({ waitingCount: 3, waiting: [stuckWaiting] }),
      stuck,
      running: 0,
      companyId: "c1",
    });
    expect(lines.map((l) => l.state)).toEqual(["Runner offline", "Merges stuck", "2 agents held by a usage limit", "Update waiting"]);
    expect(lines.map((l) => l.symbol)).toEqual(["✕", "!", "‖", "↑"]);
    expect(lines[1]!.text).toContain("FERN-10 has waited 16 h to merge");
    render(<RightNow lines={lines} paused={false} companyId="c1" />);
    expect(screen.getAllByRole("listitem")).toHaveLength(4);
    expect(screen.getByRole("heading", { name: /Right now/ })).toBeTruthy();
  });

  it("reports no runner set up, not offline, when none is registered", () => {
    const lines = healthLines({ health: { ...ok, runner: { registered: false, connected: false, lastSeenAt: null } }, merges: view(), stuck: null, running: 0, companyId: "c1" });
    expect(lines[0]!.state).toBe("No runner set up");
  });
});

describe("Stuck-merges banner", () => {
  it("is absent when merges move, and a card-held or owner-turn row doesn't count", () => {
    expect(stuckSummary(view())).toBeNull();
    expect(stuckSummary(view({ waiting: [{ ...stuckWaiting, decisionId: "d1" }, { ...stuckWaiting, actor: "owner" }] }))).toBeNull();
    const { container } = render(<MergesStuckBanner stuck={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("names the oldest stuck item, the real reason and how many wait behind it", () => {
    const stuck = stuckSummary(view({ waiting: [stuckWaiting, { ...stuckWaiting, ref: "FERN-11" }, { ...stuckWaiting, ref: "FERN-12" }] }));
    render(<MergesStuckBanner stuck={stuck} companyId="c1" />);
    const banner = screen.getByRole("status");
    expect(banner.textContent).toContain("Merges are stuck: FERN-10 has waited 16 h to merge");
    expect(banner.textContent).toContain("Waiting: no runner is connected.");
    expect(banner.textContent).toContain("2 more are waiting behind it.");
    expect(within(banner).getByRole("link").getAttribute("href")).toBe("#/merge-queue/c1");
  });

  it("counts a merge check past its limit as stuck", () => {
    const stuck = stuckSummary(view({ running: [{ ref: "FERN-9", title: "Nine", minutes: 130, what: "merge_check", overLimit: true, phase: "checking" }] }));
    expect(stuck?.title).toBe("FERN-9 has been in its check for 2 h 10 min");
  });
});
