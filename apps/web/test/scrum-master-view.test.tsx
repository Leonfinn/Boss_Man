// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenIssues } from "../src/components/OpenIssues";
import { actionHeading, ScrumMasterLog } from "../src/components/ScrumMasterLog";
import { healthLine } from "../src/components/WatchdogHealth";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const now = Date.parse("2026-10-27T10:00:00Z");
const on = { settings: { enabled: true }, lastSweepAt: "2026-10-27T09:57:00Z", trippedAt: null, trippedReason: null, openFlags: 2 };

describe("watchdog health line (BOS-60)", () => {
  it("shows the last check and the issues being handled", () => {
    expect(healthLine(on, now)).toEqual({ text: "Watchdog: last check 3 min ago · 2 issues being handled", tone: "green" });
    expect(healthLine({ ...on, openFlags: 1 }, now).text).toContain("1 issue being handled");
    expect(healthLine({ ...on, openFlags: 0 }, now).text).toContain("no open issues");
  });
  it("is clear when off, tripped, or not checking", () => {
    expect(healthLine({ ...on, settings: { enabled: false } }, now).text).toBe("Watchdog: off");
    expect(healthLine({ ...on, trippedAt: "2026-10-27T09:00:00Z" }, now)).toMatchObject({ tone: "red", text: expect.stringContaining("stopped itself") });
    expect(healthLine({ ...on, lastSweepAt: "2026-10-27T09:30:00Z" }, now).tone).toBe("amber");
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
});
