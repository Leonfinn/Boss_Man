// @vitest-environment jsdom
// BOS-837: the Runs page's "End all running runs" button. It shows only while a run is live, asks first in
// plain words (uncommitted work is lost, commits are kept), and says how many runs it ended.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company, RunRow } from "../src/api";
import { Runs } from "../src/pages/Runs";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const companies = [{ id: "co-1", name: "App Co", agents: [] } as unknown as Company];

const liveRun = (over: Partial<RunRow> = {}): RunRow => ({
  id: "run-1",
  companyId: "co-1",
  agent: "Engineer",
  agentId: "a-1",
  ticketId: null,
  ticket: null,
  model: null,
  startedAt: "2026-11-08T10:00:00Z",
  endedAt: null,
  outcome: null,
  ...over,
});

/** Serves the two polls and the cancel-all call, recording every request. */
function stub(live: RunRow[], cancelled = live.length) {
  const calls: Array<{ method: string; url: string }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ method: init?.method ?? "GET", url });
      if (url === "/api/runs/cancel-all") return json({ cancelled });
      if (url.startsWith("/api/runs/recent")) return json([]);
      if (url.startsWith("/api/runs")) return json(live);
      return json({});
    }),
  );
  return calls;
}

describe("the Runs page's 'End all running runs' button (BOS-837)", () => {
  it("is hidden while nothing is running", async () => {
    stub([]);
    render(<Runs companies={companies} />);
    expect(await screen.findByText("No agents are running.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "End all running runs" })).toBeNull();
  });

  it("shows the count, asks first naming the lost uncommitted work, and says how many it ended", async () => {
    const calls = stub([liveRun(), liveRun({ id: "run-2", agent: "Designer" }), liveRun({ id: "run-3", agent: "QA" })], 3);
    let asked = "";
    vi.stubGlobal("confirm", vi.fn((text: string) => ((asked = text), true)));
    render(<Runs companies={companies} />);
    const button = await screen.findByRole("button", { name: "End all running runs" });
    fireEvent.click(button);
    // The confirm says it in plain words: they stop now, uncommitted work is lost, commits are kept.
    expect(asked).toMatch(/End all 3 running runs/);
    expect(asked).toMatch(/stop now/);
    expect(asked).toMatch(/haven't committed is lost/);
    expect(asked).toMatch(/commits .* are kept/);
    expect(await screen.findByText("Ended 3 runs.")).toBeTruthy();
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.url === "/api/runs/cancel-all")).toBe(true));
  });

  it("cancelling the confirmation ends nothing", async () => {
    const calls = stub([liveRun()]);
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    render(<Runs companies={companies} />);
    fireEvent.click(await screen.findByRole("button", { name: "End all running runs" }));
    expect(confirm).toHaveBeenCalledTimes(1);
    // Give the poll a moment; the POST must never be sent.
    await new Promise((r) => setTimeout(r, 30));
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    expect(screen.queryByText(/Ended \d+ run/)).toBeNull();
  });

  it("says one run, not one runs", async () => {
    stub([liveRun()], 1);
    const asked = vi.fn(() => true);
    vi.stubGlobal("confirm", asked);
    render(<Runs companies={companies} />);
    fireEvent.click(await screen.findByRole("button", { name: "End all running runs" }));
    expect(asked.mock.calls[0]![0]).toMatch(/End all 1 running run,/);
    expect(await screen.findByText("Ended 1 run.")).toBeTruthy();
  });
});
