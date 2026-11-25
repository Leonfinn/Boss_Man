// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { spanText, stateLabel, stays, totals, TicketStateHistory, type StateChange } from "../src/components/TicketStateHistory";
import { ApiError } from "../src/api";

const apiMock = vi.hoisted(() => vi.fn());
vi.mock("../src/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/api")>()), api: apiMock }));

afterEach(() => {
  cleanup();
  apiMock.mockReset();
});

const H = 3_600_000;
const T0 = Date.parse("2026-11-20T08:00:00.000Z");
const at = (h: number) => new Date(T0 + h * H).toISOString();
const list: StateChange[] = [
  { from: null, to: "backlog", at: at(0) },
  { from: "backlog", to: "in_progress", at: at(2) },
  { from: "in_progress", to: "review", at: at(5) },
  { from: "review", to: "in_progress", at: at(6) },
  { from: "in_progress", to: "review", at: at(8) },
  { from: "review", to: "done", at: at(9) },
];

describe("stateLabel (BOS-2596)", () => {
  it("names a known state, reads the start as New, and passes an unknown state through", () => {
    expect(stateLabel("review")).toBe("Review");
    expect(stateLabel(null)).toBe("New");
    expect(stateLabel("sideways")).toBe("sideways");
  });
});

describe("state history sums (BOS-2419)", () => {
  it("adds up time per state, counts bounces and finds first start and finish", () => {
    const t = totals(list, T0 + 20 * H);
    expect(t).toMatchObject({ waiting: 2 * H, inProgress: 5 * H, review: 2 * H, blocked: 0, sentBack: 1, started: at(2), finished: at(9) });
  });
  it("runs the last stay up to now", () => {
    expect(stays(list, T0 + 20 * H).at(-1)).toMatchObject({ ms: 11 * H, last: true });
    expect(spanText(11 * H)).toBe("11 h 0 min");
    expect(spanText(100 * H)).toBe("4 d 4 h");
  });
});

describe("TicketStateHistory", () => {
  it("lists every change with totals, the last stay 'so far'", async () => {
    apiMock.mockResolvedValue({ state: "done", complete: true, transitions: list });
    render(<TicketStateHistory ticketId="t1" />);
    const rows = await screen.findAllByTestId("state-history-row");
    expect(rows).toHaveLength(6);
    expect(rows[1]!.textContent).toContain("Backlog → In progress");
    expect(rows[5]!.textContent).toContain("so far");
    expect(screen.getByTestId("state-history-totals").textContent).toContain("Sent back1 time");
  });
  it("says where the history starts for a ticket older than the records", async () => {
    apiMock.mockResolvedValue({ state: "review", complete: false, transitions: list.slice(2) });
    render(<TicketStateHistory ticketId="t1" />);
    expect((await screen.findByTestId("state-history-partial")).textContent).toContain("History starts on");
    expect(screen.queryByTestId("state-history-totals")).toBeNull();
  });
  it("shows the load error with Retry", async () => {
    apiMock.mockRejectedValue(new ApiError(500, "boom"));
    render(<TicketStateHistory ticketId="t1" />);
    expect(await screen.findByText(/boom/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /retry/i })).toBeTruthy();
  });
});
