// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CheckWorkers, type CheckWorkerView } from "../src/pages/settings/CheckWorkers";

// BOS-2270: the Check workers form says what "Memory limit per check" is and shows the memory the worker reported.

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });

const worker = (over: Partial<CheckWorkerView>): CheckWorkerView => ({
  id: "w1",
  name: "Spare machine",
  enabled: true,
  connected: true,
  slots: 2,
  reportedSlots: 2,
  limit: 2,
  checkThreads: null,
  checkMemoryMb: null,
  imageCommit: null,
  toolchain: null,
  lastSeenAt: null,
  companies: [],
  reason: null,
  ...over,
});

function open(w: CheckWorkerView) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => json(String(url).includes("companies") ? [] : {})));
  render(<CheckWorkers workers={[w]} maxSlots={8} reload={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Change" }));
}

describe("Check workers memory line", () => {
  it("shows the reported memory and what the checks would need", () => {
    open(worker({ reportedMemoryMb: 8192 }));
    expect(screen.getByTestId("check-worker-memory-machine").textContent).toBe("This machine has 8 GB (2 checks × 5 GB would need 10 GB).");
    const warning = screen.getByTestId("check-worker-memory-warning");
    expect(warning.textContent).toContain("mem_limit and memswap_limit");
    const link = warning.querySelector("a") as HTMLAnchorElement;
    expect(link.href).toContain("docs/34-check-workers.md#changing-the-memory-on-any-docker-host");
  });

  it("says it has not reported yet when the worker sent no memory, and shows no warning", () => {
    for (const reportedMemoryMb of [null, undefined]) {
      open(worker({ reportedMemoryMb }));
      expect(screen.getByTestId("check-worker-memory-machine").textContent).toBe("Not reported yet: redeploy the worker once to see it.");
      expect(screen.queryByTestId("check-worker-memory-warning")).toBeNull();
      cleanup();
    }
  });

  it("explains in the Add form that the limit does not give the machine memory", () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => json(String(url).includes("companies") ? [] : {})));
    render(<CheckWorkers workers={[]} maxSlots={8} reload={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Add a check worker" }));
    expect(screen.getByLabelText(/Memory limit per check/)).toBeTruthy();
    expect(screen.getByText(/does not give the machine more memory/)).toBeTruthy();
    expect(screen.getByTestId("check-worker-memory-machine").textContent).toContain("Not reported yet");
  });
});
