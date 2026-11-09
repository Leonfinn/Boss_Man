// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WrapUp } from "../src/pages/Settings";

// Settings → Server and runner → "Ask agents to wrap up" (BOS-929): the button, the still-running list, the
// "waiting for an answer" vs "not responding" labels, and per-run Stop. Boss Man never stops a run by itself.

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
const off = { on: false, last: null };
const run = (over: Record<string, unknown> = {}) => ({ runId: "r1", agent: "Zippy", ticket: "APP-7", ticketTitle: "Fix the footer", runningForMinutes: 22, sinceWrapUpMinutes: 12, waitingOn: null, ...over });
const on = { on: true, kind: "wrapup", reason: "asking agents to wrap up", since: new Date().toISOString(), deadline: new Date().toISOString(), runs: 1, companies: 1, chatOpen: true, minutes: 10, notRespondingAfter: 10, runsList: [run()], last: null };

describe("Ask agents to wrap up in Settings", () => {
  it("shows the button when idle and posts to start a wrap-up", async () => {
    const calls: Array<{ method: string; url: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ method: init?.method ?? "GET", url });
        return json(url.includes("/wrapup") ? on : off);
      }),
    );
    render(<WrapUp />);
    fireEvent.click(await screen.findByRole("button", { name: "Ask agents to wrap up" }));
    await vi.waitFor(() => expect(calls.some((c) => c.url.includes("/api/maintenance/wrapup") && c.method === "POST")).toBe(true));
  });

  it("lists a run waiting on a card as waiting for an answer, not stuck, with a Stop for that one", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(`${init?.method ?? "GET"} ${url}`);
        if (url.includes("/runs/r1/cancel")) return json({ cancelled: true });
        if (url.includes("/maintenance/cancel")) return json({ cancelled: true });
        return json({ ...on, runsList: [run({ waitingOn: { question: "May I run the tests?", tier: "ceo" } })] });
      }),
    );
    vi.stubGlobal("confirm", () => true);
    render(<WrapUp />);
    expect(await screen.findByTestId("wrapup-runs")).toBeTruthy();
    expect(screen.getByText("Waiting for an answer")).toBeTruthy();
    expect(screen.queryByText("Not responding")).toBeNull();
    expect(screen.getByTestId("wrapup-runs").textContent).toContain("APP-7");
    fireEvent.click(screen.getByRole("button", { name: "Stop this run" }));
    await vi.waitFor(() => expect(calls.some((c) => c.includes("POST /api/runs/r1/cancel"))).toBe(true));
  });

  it("marks a run that is still going past the shown timeout as not responding, and cancels the wrap-up", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(`${init?.method ?? "GET"} ${url}`);
        if (url.includes("/maintenance/cancel")) return json({ cancelled: true });
        return json(on);
      }),
    );
    render(<WrapUp />);
    expect(await screen.findByText("Not responding")).toBeTruthy();
    expect(screen.getByText(/After 10 minutes/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel wrap-up" }));
    await vi.waitFor(() => expect(calls.some((c) => c.includes("POST /api/maintenance/cancel"))).toBe(true));
  });
});
