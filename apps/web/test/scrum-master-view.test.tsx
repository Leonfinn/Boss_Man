// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenIssues } from "../src/components/OpenIssues";
import { actionHeading, actionSummary, ScrumMasterLog, type SmAction } from "../src/components/ScrumMasterLog";
import { healthLine, WatchdogHealth } from "../src/components/WatchdogHealth";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const now = Date.parse("2026-10-27T10:00:00Z");
const on = { settings: { enabled: true }, lastSweepAt: "2026-10-27T09:57:00Z", trippedAt: null, trippedReason: null, openFlags: 2 };

describe("watchdog health line (BOS-60)", () => {
  it("shows the last check and the open issues, without claiming anyone is on them (BOS-2609)", () => {
    expect(healthLine(on, now)).toEqual({ text: "Watchdog: last check 3 min ago · 2 open issues", tone: "green" });
    expect(healthLine({ ...on, openFlags: 1 }, now).text).toContain("1 open issue");
    expect(healthLine({ ...on, openFlags: 0 }, now).text).toContain("no open issues");
  });
  it("says the last check in age.ts's words, floored like the rest of the page (BOS-888)", () => {
    // Four and a bit minutes: the line used to round to 5.
    expect(healthLine({ ...on, lastSweepAt: "2026-10-27T09:55:40Z" }, now).text).toContain("last check 4 min ago");
    expect(healthLine({ ...on, lastSweepAt: "2026-10-27T08:00:00Z" }, now).text).toContain("last check 2h ago");
  });
  it("is clear when off, tripped, or not checking", () => {
    expect(healthLine({ ...on, settings: { enabled: false } }, now).text).toBe("Watchdog: off");
    expect(healthLine({ ...on, settings: { enabled: false }, trippedAt: "2026-10-27T09:00:00Z" }, now)).toMatchObject({ tone: "red", text: expect.stringContaining("stopped itself") });
    expect(healthLine({ ...on, trippedAt: "2026-10-27T09:30:00Z", pausedUntil: "2026-10-27T10:30:00Z" }, now)).toMatchObject({ tone: "amber", text: expect.stringContaining("back in 30 min") });
    expect(healthLine({ ...on, lastSweepAt: "2026-10-27T09:30:00Z" }, now).tone).toBe("amber");
  });
  it("says when it is only rehearsing (BOS-166)", () => {
    const line = healthLine({ ...on, settings: { enabled: true, recordOnly: true } }, now);
    expect(line.text).toBe("Watchdog: record only (not acting) · last check 3 min ago · 2 open issues");
    expect(line.tone).toBe("");
  });
});

describe("a failed load says so, with Retry (BOS-2249)", () => {
  const failing = () => vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "boom" }), { status: 500, headers: { "content-type": "application/json" } })));

  it("Open now shows the error and Retry instead of loading for ever", async () => {
    failing();
    render(<OpenIssues companyId="c1" />);
    expect(await screen.findByText(/Couldn't load the open issues/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.queryByText("Loading open issues")).toBeNull();
  });

  it("keeps the last good rows when a later poll fails", async () => {
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        n += 1;
        if (n > 1) return new Response(JSON.stringify({ error: "boom" }), { status: 500, headers: { "content-type": "application/json" } });
        return new Response(JSON.stringify([{ id: "f1", source: "flag", ticketId: "t1", ticketRef: "BOS-149", ticketTitle: "Fix the merge", warning: "w", rule: null, holder: "ceo", since: "2026-10-27T09:16:00Z", done: [], nextAt: null, nextText: "Checks again", openedAt: "2026-10-27T09:00:00Z" }]), { status: 200, headers: { "content-type": "application/json" } });
      }),
    );
    render(<OpenIssues companyId="c1" />);
    expect(await screen.findByText("Fix the merge")).toBeTruthy();
    // Returning to the tab polls again; that poll fails.
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.waitFor(() => expect(n).toBeGreaterThan(1));
    await new Promise((r) => setTimeout(r, 50)); // test-lines-ok: let the failed poll settle; the assertion is that nothing changes
    expect(screen.getByText("Fix the merge")).toBeTruthy();
    expect(screen.queryByText(/Couldn't load/)).toBeNull();
  });

  it("the log shows the error and Retry, in full and folded", async () => {
    failing();
    render(<ScrumMasterLog companyId="c1" />);
    expect(await screen.findByText(/Couldn't load the log/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    cleanup();
    render(<ScrumMasterLog companyId="c1" ticketId="t1" folded />);
    expect(await screen.findByText(/Couldn't load the log/)).toBeTruthy();
  });

  it("the health line shows the error and Retry instead of vanishing", async () => {
    failing();
    render(<WatchdogHealth companyId="c1" />);
    expect(await screen.findByText(/couldn't load its state/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });
});

describe("Open now and the timeline (BOS-199)", () => {
  it("names the person a warning went to once, not twice", () => {
    expect(actionHeading({ kind: "alert_hop", targetName: "Scrum Master", targetIsScrumMaster: true, warning: "Review looks stuck" })).toBe("Warning passed to the Scrum Master: Review looks stuck");
    expect(actionHeading({ kind: "alert_hop", targetName: "Sam", targetIsScrumMaster: true, warning: null })).toBe("Warning passed to the Scrum Master (Sam)");
  });

  it("lists each open issue with its ticket, who has it, what was done and what happens next", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify([
            {
              id: "f1",
              source: "flag",
              ticketId: "t1",
              ticketRef: "BOS-149",
              ticketTitle: "Fix the merge",
              warning: "Zippy - no movement in progress",
              rule: "stale_in_progress",
              holder: "scrum_master",
              since: "2026-10-27T09:16:00Z",
              done: [{ label: "Re-woke", reason: "Carry on from the merge.", at: "2026-10-27T09:16:00Z" }],
              nextAt: "2026-10-27T09:31:00Z",
              nextText: "Checks again",
              openedAt: "2026-10-27T09:00:00Z",
            },
          ]),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    render(<OpenIssues companyId="c1" />);
    expect(await screen.findByText("BOS-149")).toBeTruthy();
    expect(screen.getByText("Fix the merge")).toBeTruthy();
    expect(screen.getByText(/With the Scrum Master since/)).toBeTruthy();
    expect(screen.getByText(/Re-woke at/)).toBeTruthy();
    expect(screen.getByText(/Next: Checks again at/)).toBeTruthy();
  });
});

describe("Scrum Master activity (BOS-60)", () => {
  it("lists each action with its reason, and undo calls the undo route", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(`${init?.method ?? "GET"} ${url}`);
        const body = init?.method === "POST" ? {} : [
          { id: "a1", kind: "nudge", ticketId: "t1", reason: "No movement for 3 h", actorName: "Scrum Master", createdAt: "2026-10-27T09:00:00Z", undoable: true, undoneAt: null, after: null },
        ];
        return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      }),
    );
    render(<ScrumMasterLog companyId="c1" />);
    expect(await screen.findByText("No movement for 3 h")).toBeTruthy();
    expect(calls[0]).toContain("excludeKind=sweep_wake");
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await vi.waitFor(() => expect(calls).toContain("POST /api/watchdog-actions/a1/undo"));
  });

  it("marks a record-only entry as not sent and offers no undo (BOS-166)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify([
            { id: "a2", kind: "record_sweep_wake", ticketId: null, reason: "2 problems found (record only)", actorName: "Boss Man", createdAt: "2026-10-27T09:00:00Z", undoable: false, undoneAt: null, after: null, recorded: true },
          ]),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    render(<ScrumMasterLog companyId="c1" />);
    expect(await screen.findByText("Would have woken the Scrum Master")).toBeTruthy();
    expect(screen.getByText("Not sent")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });
});

describe("a ticket page's folded Scrum Master section (BOS-251)", () => {
  const warning = (id: string, at: string, status: "open" | "settled", label: string, reason: string, extra: Partial<SmAction> = {}): SmAction => ({
    ...extra,
    id,
    kind: "alert_hop",
    ticketId: "t1",
    ticketRef: "BOS-251",
    reason,
    actorName: "Boss Man",
    createdAt: at,
    undoable: false,
    undoneAt: null,
    after: null,
    warning: "Developer has sent nothing for 5 minutes",
    issueKey: `alert:${id}`,
    issueStatus: status,
    issueLabel: label,
    targetIsCeo: true,
  });
  const stub = (rows: SmAction[]) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(rows), { status: 200, headers: { "content-type": "application/json" } })),
    );
  const openStates = (container: HTMLElement) => [...container.querySelectorAll("details")].map((d) => d.open);

  it("summarises the day's warnings, shows the last 3 newest first and keeps an older open one in view", async () => {
    stub([
      warning("a4", "2026-10-27T23:27:00Z", "settled", "4th warning on BOS-251 today", "Run ended, the ticket is in review."),
      warning("a3", "2026-10-27T21:10:00Z", "settled", "3rd warning on BOS-251 today", "Review looks stuck."),
      warning("a2", "2026-10-27T20:40:00Z", "settled", "2nd warning on BOS-251 today", "Nudged the reviewer."),
      warning("a1", "2026-10-27T19:00:00Z", "settled", "1st warning on BOS-251 today", "Nudged the developer."),
      warning("a0", "2026-10-27T09:00:00Z", "open", "1st warning on BOS-251 today", "Passed on at the hourly limit."),
    ]);
    const { container } = render(<ScrumMasterLog companyId="c1" ticketId="t1" folded />);
    expect(await screen.findByText("5 warnings today · 1 open")).toBeTruthy();
    const lines = [...container.querySelectorAll("summary")].map((s) => s.textContent ?? "");
    // The open one from this morning, then the newest 3 settled: the last 3 plus the open one, never more.
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain("Open");
    expect(lines[0]).toContain("Passed to the CEO: Passed on at the hourly limit.");
    expect(lines[1]).toContain("Passed to the CEO: Run ended, the ticket is in review.");
    expect(lines[2]).toContain("Review looks stuck.");
    expect(lines[3]).toContain("Nudged the reviewer.");
    expect(lines[1]).toContain("Settled");
    // The ticket you're on isn't named again, and the long title isn't repeated.
    expect(container.textContent).not.toContain("BOS-251");
    // Folded: nothing expanded yet, and the hidden ones are one click away.
    expect(openStates(container)).toEqual([false, false, false, false]);
    fireEvent.click(screen.getByRole("button", { name: /Show all 5 actions/ }));
    expect(openStates(container)).toHaveLength(5);
    expect(openStates(container).every(Boolean)).toBe(true);
  });

  it("opens one line on its own, and the heading opens every action", async () => {
    stub([
      { ...warning("a2", "2026-10-27T21:27:00Z", "settled", "2nd warning on BOS-251 today", "Run ended."), kind: "alert_resolved", actorName: "Scrum Master" },
      warning("a3", "2026-10-27T21:10:00Z", "settled", "1st warning on BOS-251 today", "Review looks stuck."),
    ]);
    const { container } = render(<ScrumMasterLog companyId="c1" ticketId="t1" folded />);
    expect(await screen.findByText("2 warnings today · all settled")).toBeTruthy();
    expect(screen.getByText("Settled by Scrum Master: Run ended.")).toBeTruthy();
    container.querySelector("details")!.open = true;
    expect(openStates(container)).toEqual([true, false]);
    fireEvent.click(screen.getByRole("button", { name: /Scrum Master/ }));
    expect(openStates(container)).toEqual([true, true]);
  });

  it("names who a warning went to when it is the Scrum Master, and lists plain actions one line each", async () => {
    expect(actionSummary({ kind: "alert_resolved", actorName: "Scrum Master" })).toBe("Settled by Scrum Master");
    expect(actionSummary({ kind: "alert_hop", targetIsScrumMaster: true, targetName: "Scrum Master" })).toBe("Passed to the Scrum Master");
    expect(actionSummary({ kind: "alert_hop", targetIsCeo: true, targetName: "Ada" })).toBe("Passed to the CEO");
    expect(actionSummary({ kind: "nudge", targetName: "Sam" })).toBe("Nudged");

    stub([
      { id: "a2", kind: "nudge", ticketId: "t1", reason: "No movement for 3 h", actorName: "Scrum Master", createdAt: "2026-10-27T21:00:00Z", undoable: true, undoneAt: null, after: null },
      { id: "a1", kind: "rewake", ticketId: "t1", reason: "Carry on from the merge", actorName: "Scrum Master", createdAt: "2026-10-27T09:00:00Z", undoable: false, undoneAt: null, after: null },
    ]);
    render(<ScrumMasterLog companyId="c1" ticketId="t1" folded />);
    expect(await screen.findByText("2 actions · all settled")).toBeTruthy();
    expect(screen.getByText("Nudged: No movement for 3 h")).toBeTruthy();
    expect(screen.getByText("Re-woke: Carry on from the merge")).toBeTruthy();
  });
});
