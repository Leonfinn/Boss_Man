// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScrumMasterLog } from "../src/components/ScrumMasterLog";
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
  });
  it("is clear when off, tripped, or not checking", () => {
    expect(healthLine({ ...on, settings: { enabled: false } }, now).text).toBe("Watchdog: off");
    expect(healthLine({ ...on, trippedAt: "2026-10-27T09:00:00Z" }, now)).toMatchObject({ tone: "red", text: expect.stringContaining("stopped itself") });
    expect(healthLine({ ...on, lastSweepAt: "2026-10-27T09:30:00Z" }, now).tone).toBe("amber");
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
