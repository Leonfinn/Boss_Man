// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Decision } from "../src/api";
import { NeedsYou, RightNow, healthLines, needsKind } from "../src/components/DashboardPanels";
import { MergesStuckBanner, slowSummary, stuckSummary, type MergeHealthView, type MergeLine } from "../src/components/MergesStuckBanner";

// BOS-1507 (design BOS-1490): the Dashboard's Needs you and Right now panels and the stuck-merges banner.

afterEach(cleanup);

const card = (n: number, extra: Partial<Decision> = {}): Decision =>
  ({ id: `00000000-0000-4000-8000-00000000000${n}`, companyId: "c1", kind: "question", question: `Question ${n}`, options: ["Yes", "No"], recommendedOption: "Yes", tier: "owner", createdAt: new Date(Date.now() - (10 - n) * 3_600_000).toISOString(), companyName: "Co", agentName: "Fern", blocks: [], about: [], score: 0, parts: { blocking: 0, urgency: 0, age: 0, liveRun: 0 }, reasons: [], ageReason: "", dueDate: null, ...extra }) as Decision;

const view = (extra: Partial<MergeHealthView> = {}): MergeHealthView => ({ waitingCount: 0, stuckCount: 0, ...extra });
// The server's verdicts (merge-line-health.ts, BOS-1594): the banner only draws them.
const stuckLine: MergeLine = { state: "stuck", cause: "gate_fault", title: "FERN-10 has waited 16 h to merge", reason: "Waiting: no runner is connected", fix: "Start the runner container on your host", others: 2 };
const slowLine: MergeLine = { state: "over_capacity", waiting: 17, etaMinutes: 255, lastLandedAt: "2026-11-15T19:03:00.000Z", advice: null };

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

  it("says how long the oldest card has waited and the usual wait, leaving out what is null (BOS-2174)", () => {
    const ago = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
    const { unmount } = render(<NeedsYou decisions={[card(1)]} tally={{ open: 1, waiting: 0, oldestOpenAt: ago(72), medianAnswerMs: 5 * 3_600_000 }} />);
    expect(screen.getByText("Oldest waiting 3 days · usually answered in 5 hours")).toBeTruthy();
    unmount();
    render(<NeedsYou decisions={[card(1)]} tally={{ open: 1, waiting: 0, oldestOpenAt: ago(2), medianAnswerMs: null }} />);
    expect(screen.getByText("Oldest waiting 2 hours")).toBeTruthy();
    cleanup();
    render(<NeedsYou decisions={[]} tally={{ open: 0, waiting: 0, oldestOpenAt: null, medianAnswerMs: 3_600_000 }} />);
    expect(screen.queryByText(/usually answered/)).toBeNull();
    cleanup();
    // An older server sends neither figure: the panel is as before, no line, no error.
    const { container } = render(<NeedsYou decisions={[card(1)]} tally={{ open: 1, waiting: 0 }} />);
    expect(container.querySelector(".dash-needs-wait")).toBeNull();
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

  it("R28: merges held behind the main fix read amber with the fix named, never red", () => {
    const line = { state: "held_behind_fix" as const, held: 6, since: null, fixes: [{ ticketId: "f", ref: "BOS-1641", title: "Fix main", stateText: "in review", ownerUpdate: false }] };
    const merges = view({ waitingCount: 6, line });
    const lines = healthLines({ health: ok, merges, stuck: null, running: 2, companyId: "c1" });
    expect(lines[1]).toMatchObject({ tone: "warn", state: "Merges held behind the main fix" });
    expect(lines[1]!.text).toBe("Merges are held: 6 approved tickets are held behind the fix BOS-1641 (in review). They merge by themselves once it is merged and live.");
  });

  it("says 'not known' in words, never green, for every line that couldn't be read", () => {
    const lines = healthLines({ health: {}, merges: null, stuck: null, running: 0, companyId: "c1" });
    expect(lines.map((l) => l.tone)).toEqual(["unknown", "unknown", "unknown", "unknown"]);
    expect(lines.map((l) => l.symbol)).toEqual(["?", "?", "?", "?"]);
    expect(lines[1]!.state).toBe("Merges: couldn't check");
    expect(lines[2]!.text).toContain("older than the check");
  });

  it("marks an offline runner, stuck merges, held agents and a waiting update with symbol and words", () => {
    const stuck = stuckSummary(view({ line: stuckLine }));
    const lines = healthLines({
      health: { runner: { registered: true, connected: false, lastSeenAt: new Date(Date.now() - 3 * 3_600_000).toISOString() }, usage: { agents: 2, accounts: ["Claude Max"], firstResetAt: new Date(Date.now() + 3_600_000).toISOString() }, update: { waiting: true, phase: "waiting", deadline: null } },
      merges: view({ waitingCount: 3, line: stuckLine }),
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
  it("is absent when merges are healthy, or the server gave no verdict", () => {
    expect(stuckSummary(view({ line: { state: "healthy" } }))).toBeNull();
    expect(slowSummary(view({ line: { state: "healthy" } }))).toBeNull();
    expect(stuckSummary(view())).toBeNull();
    const { container } = render(<MergesStuckBanner stuck={null} slow={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("stuck: names what is stuck, why, the one fix and how many wait behind it", () => {
    render(<MergesStuckBanner stuck={stuckSummary(view({ line: stuckLine }))} companyId="c1" />);
    const banner = screen.getByRole("status");
    expect(banner.textContent).toContain("Merges are stuck: FERN-10 has waited 16 h to merge");
    expect(banner.textContent).toContain("Waiting: no runner is connected.");
    expect(banner.textContent).toContain("Fix: Start the runner container on your host.");
    expect(banner.textContent).toContain("2 more behind it.");
    expect(within(banner).getByRole("link").getAttribute("href")).toBe("#/merge-queue/c1");
  });

  it("BOS-1715: one queue state, badge and banner: 31 in the queue, 21 waiting for Boss Man, no clear time yet", () => {
    const line: MergeLine = { state: "over_capacity", waiting: 21, inQueue: 31, etaMinutes: null, lastLandedAt: null, advice: null };
    const v = view({ waitingCount: 31, lineCount: 31, line });
    render(<MergesStuckBanner stuck={null} slow={slowSummary(v)} companyId="c1" />);
    const text = screen.getByRole("status").textContent ?? "";
    // The sidebar badge shows lineCount (31); the banner names the same 31 under the same label, and its own count under another (R43).
    expect(text).toContain(`21 for Boss Man to merge (${v.lineCount} in the merge line; the rest are merging now or with an agent or you)`);
    expect(text).toContain("estimating the time to clear…");
    expect(text).not.toMatch(/about .* to clear/);
  });

  it("over capacity: says merging slowly in a calm style, never 'stuck'", () => {
    expect(stuckSummary(view({ line: slowLine }))).toBeNull();
    render(<MergesStuckBanner stuck={null} slow={slowSummary(view({ line: slowLine }))} companyId="c1" />);
    const banner = screen.getByRole("status");
    expect(banner.textContent).toContain("Merging, but slowly: 17 for Boss Man to merge, about 4 h 15 min to clear at the current rate, last landed");
    expect(banner.textContent).not.toMatch(/stuck/i);
    expect(banner.className).toContain("merges-banner-slow");
  });

  it("over capacity names a check worker only when the server advises one", () => {
    const slow = slowSummary(view({ line: { ...slowLine, advice: "A check worker would add check slots." } as MergeLine }));
    render(<MergesStuckBanner stuck={null} slow={slow} />);
    expect(screen.getByRole("status").textContent).toContain("A check worker would add check slots.");
  });

  it("the Merges line reads 'Merging, but slowly' with a warn tone, not 'stuck'", () => {
    const lines = healthLines({ health: {}, merges: view({ waitingCount: 17, line: slowLine }), stuck: null, slow: slowSummary(view({ line: slowLine })), running: 0, companyId: "c1" });
    expect(lines[1]!.state).toBe("Merging, but slowly");
    expect(lines[1]!.tone).toBe("warn");
  });
});
