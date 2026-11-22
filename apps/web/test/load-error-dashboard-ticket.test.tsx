// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ApiError } from "../src/api";
import { Dashboard } from "../src/pages/Dashboard";
import { Ticket } from "../src/pages/Ticket";

const apiMock = vi.hoisted(() => vi.fn());
vi.mock("../src/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/api")>()), api: apiMock }));

afterEach(() => {
  cleanup();
  apiMock.mockReset();
});

const company = { id: "c1", name: "Co", paused: false } as never;

describe("BOS-2296: a failed first load says what and offers Retry", () => {
  it("Dashboard", async () => {
    apiMock.mockRejectedValue(new ApiError(500, "boom"));
    render(<Dashboard company={company} />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn't load the dashboard: boom");
    const before = apiMock.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await vi.waitFor(() => expect(apiMock.mock.calls.length).toBeGreaterThan(before));
  });

  it("Ticket 404 still shows Ticket not found with Back to Tickets", async () => {
    apiMock.mockRejectedValue(new ApiError(404, "not found"));
    render(<Ticket id="t1" companies={[company]} />);
    expect(await screen.findByText("Ticket not found")).toBeTruthy();
    expect(screen.getByText("Back to Tickets")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("Ticket (non-404)", async () => {
    apiMock.mockRejectedValue(new ApiError(500, "boom"));
    render(<Ticket id="t1" companies={[company]} />);
    const alert = await screen.findByText(/Couldn't load the ticket: boom/);
    expect(alert).toBeTruthy();
    const before = apiMock.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await vi.waitFor(() => expect(apiMock.mock.calls.length).toBeGreaterThan(before));
  });
});
