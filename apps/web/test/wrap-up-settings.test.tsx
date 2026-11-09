// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WrapUpAction } from "../src/pages/Settings";

// Settings → Server and runner → the Runner update box → "Ask agents to wrap up" (BOS-929, BOS-988): the button,
// the still-running list, the "waiting for an answer" vs "not responding" labels, per-run Stop, and that pressing
// it while an update waits is allowed (it joins the update's hold). Boss Man never stops a run by itself.

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
const run = (over: Record<string, unknown> = {}) => ({ runId: "r1", agent: "Zippy", ticket: "APP-7", ticketTitle: "Fix the footer", runningForMinutes: 22, sinceWrapUpMinutes: 12, waitingOn: null, ...over });
const off = { on: false as const, last: null };
const wrapOn = { on: true as const, kind: "wrapup" as const, reason: "asking agents to wrap up", since: new Date().toISOString(), deadline: new Date().toISOString(), runs: 1, companies: 1, chatOpen: true, minutes: 10, notRespondingAfter: 10, runsList: [run()], last: null };
const updateWaiting = { on: true as const, kind: "update" as const, reason: "runner update", since: new Date().toISOString(), deadline: new Date().toISOString(), runs: 2, companies: 1, chatOpen: true, last: null };
const wrapDuringUpdate = { on: true as const, kind: "update" as const, reason: "runner update", since: new Date().toISOString(), deadline: new Date().toISOString(), runs: 2, companies: 1, chatOpen: true, wrapAsked: true, notRespondingAfter: 10, runsList: [run(), run({ runId: "r2", agent: "Kit" })], last: null };

describe("Ask agents to wrap up in the Runner update box", () => {
  it("shows a secondary button when idle and posts to start a wrap-up", async () => {
    const calls: Array<{ method: string; url: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ method: init?.method ?? "GET", url });
        return json(off);
      }),
    );
    render(<WrapUpAction m={off} reload={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Ask agents to wrap up" }));
    await vi.waitFor(() => expect(calls.some((c) => c.url.includes("/api/maintenance/wrapup") && c.method === "POST")).toBe(true));
  });

  it("works while an update is waiting: the button is there and posts the wrap-up (BOS-988)", async () => {
    const calls: Array<{ method: string; url: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ method: init?.method ?? "GET", url });
        return json(updateWaiting);
      }),
    );
    render(<WrapUpAction m={updateWaiting} reload={() => {}} />);
    const line = screen.getByTestId("wrapup-waiting");
    expect(line.textContent).toContain("2 agents are still running");
    expect(line.textContent).toContain("The update starts when they have finished");
    expect(line.textContent).not.toContain("above");
    fireEvent.click(screen.getByRole("button", { name: "Ask agents to wrap up" }));
    await vi.waitFor(() => expect(calls.some((c) => c.url.includes("/api/maintenance/wrapup") && c.method === "POST")).toBe(true));
  });

  it("shows the still-running list for a wrap-up asked during an update, and Cancel wrap-up takes back only the ask", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(`${init?.method ?? "GET"} ${url}`);
        return json(wrapDuringUpdate);
      }),
    );
    render(<WrapUpAction m={wrapDuringUpdate} reload={() => {}} />);
    expect(await screen.findByTestId("wrapup-runs")).toBeTruthy();
    expect(screen.getByTestId("wrapup-on").textContent).toContain("2 agents are still running");
    fireEvent.click(screen.getByRole("button", { name: "Cancel wrap-up" }));
    await vi.waitFor(() => expect(calls.some((c) => c.includes("POST /api/maintenance/cancel-wrap"))).toBe(true));
  });

  it("lists a run waiting on a card as waiting for an answer, not stuck, with a Stop for that one", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(`${init?.method ?? "GET"} ${url}`);
        return json({ cancelled: true });
      }),
    );
    vi.stubGlobal("confirm", () => true);
    const waitingOnCard = { ...wrapOn, runsList: [run({ waitingOn: { question: "May I run the tests?", tier: "ceo" } })] };
    render(<WrapUpAction m={waitingOnCard} reload={() => {}} />);
    expect(await screen.findByTestId("wrapup-runs")).toBeTruthy();
    expect(screen.getByText("Waiting for an answer")).toBeTruthy();
    expect(screen.queryByText("Not responding")).toBeNull();
    expect(screen.getByTestId("wrapup-runs").textContent).toContain("APP-7");
    fireEvent.click(screen.getByRole("button", { name: "Stop this run" }));
    await vi.waitFor(() => expect(calls.some((c) => c.includes("POST /api/runs/r1/cancel"))).toBe(true));
  });

  it("marks a run that is still going past the shown timeout as not responding", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(`${init?.method ?? "GET"} ${url}`);
        return json(wrapOn);
      }),
    );
    render(<WrapUpAction m={wrapOn} reload={() => {}} />);
    expect(await screen.findByText("Not responding")).toBeTruthy();
    expect(screen.getByText(/After 10 minutes/)).toBeTruthy();
  });
});
