// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WrapUpAction } from "../src/pages/Settings";

// Settings → Server and runner → the Runner update box → "Ask agents to wrap up" (BOS-929, BOS-988): the button,
// the still-running list, the "waiting for an answer", "in a long step", "finishing up" and "still going" labels
// (BOS-1016 replaced "not responding"), per-run Stop, and that pressing
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

  it("marks a run that is still going past the shown timeout as still going, with a Stop, never as not responding", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(`${init?.method ?? "GET"} ${url}`);
        return json(wrapOn);
      }),
    );
    render(<WrapUpAction m={wrapOn} reload={() => {}} />);
    expect(await screen.findByText("Still going after 12 min")).toBeTruthy();
    expect(screen.getByText("Still going after 12 min").getAttribute("title")).toContain("10 minutes");
    expect(screen.queryByText(/not responding/i)).toBeNull();
    expect(screen.getByRole("button", { name: "Stop this run" })).toBeTruthy();
    const note = screen.getByTestId("wrapup-note").textContent ?? "";
    expect(note).not.toMatch(/not responding/i);
    expect(note).toContain("One in a long step, like a full check, may take longer");
    expect(note).toContain("most finish within a few minutes");
    expect(note).toContain("won't stop an agent for you");
    expect(note).toContain("Stop this run");
    expect(note).toContain("anything it hasn't saved yet is lost");
    expect(note).toContain("nothing new starts until you press Cancel wrap-up");
    // Plain words: the old jargon is gone.
    expect(note).not.toContain("on that one only");
    expect(note).not.toMatch(/\ba run still going is marked/i);
  });

  it("says a run in a long step will stop when the step ends, and one that has the message is finishing up, with a Stop on every run before the mark (BOS-1379)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({})));
    const s = {
      ...wrapOn,
      notRespondingAfter: 30,
      runsList: [
        run({ runId: "r1", agent: "Zippy", sinceWrapUpMinutes: 12, step: { title: "scripts/check-all.sh", sinceMinutes: 14 } }),
        run({ runId: "r2", agent: "Kit", sinceWrapUpMinutes: 12, gotMessage: true, step: { title: "pnpm build", sinceMinutes: 3 } }),
        run({ runId: "r3", agent: "Dylan", sinceWrapUpMinutes: 2 }),
      ],
    };
    render(<WrapUpAction m={s} reload={() => {}} />);
    const items = (await screen.findByTestId("wrapup-runs")).querySelectorAll("li");
    expect(items.length).toBe(3);
    expect(items[0]!.textContent).toContain("In a long step: it will stop when this step ends");
    expect(items[0]!.textContent).toContain("running scripts/check-all.sh for 14 min");
    expect(items[1]!.textContent).toContain("Finishing up");
    expect(items[1]!.textContent).not.toContain("In a long step");
    expect(items[2]!.textContent).toContain("Working");
    // BOS-1379: every still-running run offers a Stop, even before the 30-minute mark (the owner had no way to
    // stop an opencode agent inside one long step, so they stopped it by hand).
    expect(screen.getAllByRole("button", { name: "Stop this run" }).length).toBe(3);
    expect(screen.queryByText(/not responding/i)).toBeNull();
    // The long-step label tells the owner Stop is the way to end it now.
    expect(items[0]!.querySelector(".tag")?.getAttribute("title")).toContain("use Stop this run");
  });

  it("an older server without step details still shows Working", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({})));
    const s = { ...wrapOn, notRespondingAfter: 30 };
    render(<WrapUpAction m={s} reload={() => {}} />);
    expect((await screen.findByTestId("wrapup-runs")).textContent).toContain("Working");
  });

  it("tells a wrap-up asked during an update what happens at the deadline if the owner does nothing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(wrapDuringUpdate)));
    render(<WrapUpAction m={wrapDuringUpdate} reload={() => {}} />);
    const note = (await screen.findByTestId("wrapup-note")).textContent ?? "";
    expect(note).toContain("the update keeps waiting");
    expect(note).toMatch(/you'll be asked whether to stop the agents still running/);
    expect(note).not.toContain("Cancel wrap-up");
  });
});
