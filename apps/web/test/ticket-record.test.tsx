// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { TicketRecord } from "../src/components/TicketRecord";

const apiMock = vi.hoisted(() => vi.fn());
vi.mock("../src/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/api")>()), api: apiMock }));

afterEach(() => {
  cleanup();
  apiMock.mockReset();
});

describe("What Boss Man recorded (BOS-2175)", () => {
  it("shows runs, spend against the cap, the last check and the files changed", async () => {
    apiMock.mockResolvedValue({ runs: { total: 3, errored: 1 }, spendMicros: 2_000_000, capMicros: 5_000_000, lastCheck: { result: "pass", scope: "quick", at: new Date().toISOString() }, filesChanged: 4 });
    render(<TicketRecord ticketId="t1" />);
    expect((await screen.findByTestId("record-runs")).textContent).toContain("3, 1 ended in error");
    expect(screen.getByTestId("record-spend").textContent).toContain("$2.00 of $5.00");
    expect(screen.getByTestId("record-check").textContent).toContain("passed");
    expect(screen.getByTestId("record-files").textContent).toContain("4");
  });

  it("says 'No runs yet' and 'none yet' for a ticket nothing has happened on", async () => {
    apiMock.mockResolvedValue({ runs: { total: 0, errored: 0 }, spendMicros: 0, capMicros: null, lastCheck: null, filesChanged: 0 });
    render(<TicketRecord ticketId="t1" />);
    expect((await screen.findByTestId("record-runs")).textContent).toContain("No runs yet");
    expect(screen.getByTestId("record-spend").textContent).toContain("no cap set");
    expect(screen.getByTestId("record-check").textContent).toContain("none yet");
  });
});
