// @vitest-environment jsdom
// BOS-1887: the Runs page says why a run failed, and a failed load never reads as "No agents are running."
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company, RunRow } from "../src/api";
import { Run } from "../src/pages/Run";
import { failureReason, Runs } from "../src/pages/Runs";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const companies = [{ id: "co-1", name: "App Co", agents: [] } as unknown as Company];
const finished = (over: Partial<RunRow>): RunRow => ({
  id: "run-1",
  companyId: "co-1",
  agent: "Engineer",
  agentId: "a-1",
  ticketId: null,
  ticket: null,
  model: null,
  startedAt: "2026-11-08T10:00:00Z",
  endedAt: "2026-11-08T10:05:00Z",
  outcome: "end_turn",
  ...over,
});

describe("failureReason", () => {
  it("is plain words for error, interrupted and lost, and null otherwise", () => {
    expect(failureReason("error: rate limit reached")).toBe("Failed: rate limit reached");
    expect(failureReason("error")).toMatch(/didn't say why/);
    expect(failureReason("interrupted")).toMatch(/^Interrupted/);
    expect(failureReason("lost: runner restarted")).toMatch(/^Lost.*runner restarted/);
    expect(failureReason("end_turn")).toBeNull();
    expect(failureReason(null)).toBeNull();
  });
});

describe("the Runs page (BOS-1887)", () => {
  it("shows the reason under a failed run's tag", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => (url.startsWith("/api/runs/recent") ? json([finished({ outcome: "error: credential expired" })]) : json([]))),
    );
    render(<Runs companies={companies} />);
    expect(await screen.findByText("Failed: credential expired")).toBeTruthy();
  });

  it("says it couldn't load, with Retry, and never 'No agents are running', when the requests fail", async () => {
    const fetchMock = vi.fn(async () => json({ error: "boom", message: "Server is down" }, 500));
    vi.stubGlobal("fetch", fetchMock);
    render(<Runs companies={companies} />);
    const alerts = await screen.findAllByRole("alert");
    expect(alerts.length).toBe(2);
    expect(screen.getAllByRole("button", { name: "Retry" }).length).toBe(2);
    expect(screen.queryByText("No agents are running.")).toBeNull();
    expect(screen.queryByText("No runs have finished yet.")).toBeNull();
    const before = fetchMock.mock.calls.length;
    fireEvent.click(screen.getAllByRole("button", { name: "Retry" })[0]!);
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(before));
  });
});

describe("the Run page (BOS-1887)", () => {
  const stubRun = (outcome: string) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        json(
          url.includes("/transcript")
            ? { run: { id: "r1", companyId: "co-1", agent: "Ada", agentId: "a1", ticketId: null, ticket: null, startedAt: "2026-11-08T10:00:00Z", endedAt: "2026-11-08T10:05:00Z", outcome }, items: [], next: 0, more: false }
            : [],
        ),
      ),
    );
  it("shows the failure reason under the header for an error outcome", async () => {
    stubRun("error: rate limit reached");
    render(<Run runId="r1" companies={companies} />);
    expect((await screen.findByRole("alert")).textContent).toBe("Failed: rate limit reached");
  });
  it("shows a short plain line for a lost run, and nothing for a finished one", async () => {
    stubRun("lost: runner restarted");
    render(<Run runId="r1" companies={companies} />);
    expect(await screen.findByText(/^Lost.*runner restarted/)).toBeTruthy();
    cleanup();
    stubRun("end_turn");
    render(<Run runId="r1" companies={companies} />);
    await screen.findByText(/No events are kept/);
    expect(screen.queryByText(/^(Lost|Failed|Interrupted)/)).toBeNull();
  });
});
