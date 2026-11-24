// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { checkLength, TicketChecks, type TicketCheck } from "../src/components/TicketChecks";
import { ApiError } from "../src/api";

const apiMock = vi.hoisted(() => vi.fn());
vi.mock("../src/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/api")>()), api: apiMock }));

afterEach(() => {
  cleanup();
  apiMock.mockReset();
});

const check = (i: number, extra: Partial<TicketCheck> = {}): TicketCheck => ({
  id: `j${i}`,
  what: "quick",
  state: "passed",
  queuedAt: "2026-11-20T12:00:00.000Z",
  startedAt: "2026-11-20T12:01:00.000Z",
  endedAt: "2026-11-20T12:04:30.000Z",
  machine: "company runner",
  firstLine: null,
  ...extra,
});

describe("ticket Checks list (BOS-2371)", () => {
  it("shows each check's what, result, length, machine and first failing line", async () => {
    apiMock.mockResolvedValue({ checks: [check(1, { what: "merge", state: "failed", machine: "Big box", firstLine: "FAIL test/foo.test.ts > adds up" }), check(2)] });
    render(<TicketChecks ticketId="t1" />);
    const rows = await screen.findAllByTestId("ticket-check-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain("Merge check");
    expect(rows[0]!.textContent).toContain("failed");
    expect(rows[0]!.textContent).toContain("Big box");
    expect(rows[0]!.textContent).toContain("test/foo.test.ts");
    expect(rows[1]!.textContent).toContain("3 min 30 s");
    expect(screen.queryByTestId("ticket-checks-older")).toBeNull();
  });

  it("folds checks past the tenth under 'N older checks'", async () => {
    apiMock.mockResolvedValue({ checks: Array.from({ length: 12 }, (_, i) => check(i)) });
    render(<TicketChecks ticketId="t1" />);
    const older = await screen.findByTestId("ticket-checks-older");
    expect(older.querySelector("summary")!.textContent).toBe("2 older checks");
    expect(older.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(screen.getAllByTestId("ticket-check-row")).toHaveLength(12);
  });

  it("is hidden for a ticket with no checks", async () => {
    apiMock.mockResolvedValue({ checks: [] });
    const { container } = render(<TicketChecks ticketId="t1" />);
    await vi.waitFor(() => expect(apiMock).toHaveBeenCalled());
    await Promise.resolve();
    expect(screen.queryByTestId("ticket-checks")).toBeNull();
    expect(container.querySelector("[role=alert]")).toBeNull();
  });

  it("says when it couldn't load, and Retry loads again", async () => {
    apiMock.mockRejectedValueOnce(new ApiError(500, "boom")).mockResolvedValue({ checks: [check(1)] });
    render(<TicketChecks ticketId="t1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    expect(await screen.findAllByTestId("ticket-check-row")).toHaveLength(1);
  });

  it("measures length from start to end, or to now while running, and leaves a queued one blank", () => {
    expect(checkLength({ startedAt: null, endedAt: null })).toBe("");
    expect(checkLength({ startedAt: "2026-11-20T12:00:00Z", endedAt: "2026-11-20T12:00:42Z" })).toBe("42 s");
    expect(checkLength({ startedAt: "2026-11-20T12:00:00Z", endedAt: "2026-11-20T13:05:00Z" })).toBe("1 h 5 min");
    expect(checkLength({ startedAt: "2026-11-20T12:00:00Z", endedAt: null }, Date.parse("2026-11-20T12:02:00Z"))).toBe("2 min 0 s");
  });
});
