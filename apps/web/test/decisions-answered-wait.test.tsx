// @vitest-environment jsdom
// BOS-2488: each answered card says how long it waited; one summary line gives the median and the slowest kind.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnsweredList, answeredSummary, answeredToCsv, waitText } from "../src/pages/Decisions";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const row = (n: number, minutes: number, over: Record<string, unknown> = {}) => ({
  id: `d${n}`, question: `Question ${n}`, status: "answered", answer: "Yes", by: "owner", byName: null, companyName: "App Co", note: null,
  at: new Date(Date.UTC(2026, 10, 1, 12) ).toISOString(), askedAt: new Date(Date.UTC(2026, 10, 1, 12) - minutes * 60_000).toISOString(), ticket: null, kind: "merge", ...over,
});

describe("answered wait", () => {
  it("words the wait: minutes under an hour, hours under two days, then days", () => {
    expect(waitText(5)).toBe("5 min");
    expect(waitText(180)).toBe("3 h");
    expect(waitText(47 * 60)).toBe("47 h");
    expect(waitText(3 * 1440)).toBe("3 days");
  });

  it("summarises the rows: count, median, slowest kind with its median", () => {
    const rows = [row(1, 60), row(2, 120), row(3, 180, { kind: "permission" }), row(4, 540, { kind: "permission" }), row(5, 1, { status: "withdrawn" })];
    // Waits 60, 120, 180, 540 (withdrawn left out): median 150 min = 3 h; permission median 360 min = 6 h.
    expect(answeredSummary(rows as never)).toBe("4 answered · median wait 3 h · slowest: Permission cards (median 6 h)");
    expect(answeredSummary([row(1, 60, { status: "withdrawn" })] as never)).toBeNull();
  });

  it("shows 'answered after' on answered rows only, with the summary above, and adds a CSV column", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ items: [row(1, 180), row(2, 0, { status: "withdrawn", by: "withdrawn", answer: null })], next: null }), { status: 200, headers: { "content-type": "application/json" } })));
    const { container } = render(<AnsweredList />);
    const details = container.querySelector("details")!;
    details.open = true;
    fireEvent(details, new Event("toggle"));
    await screen.findByText("Question 1");
    expect(screen.getAllByTestId("answered-wait").map((e) => e.textContent)).toEqual([" · answered after 3 h"]);
    expect(screen.getByTestId("answered-summary").textContent).toBe("1 answered · median wait 3 h");
    const csv = answeredToCsv([row(1, 180), row(2, 0, { status: "withdrawn" })] as never);
    const lines = csv.trim().split(/\r?\n/);
    expect(lines[0]).toMatch(/Waited \(minutes\)$/);
    expect(lines[1]).toMatch(/,180$/);
    expect(lines[2]).toMatch(/,$/);
  });
});
