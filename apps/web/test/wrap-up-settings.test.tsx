// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SelfDeploy } from "../src/pages/Settings";

// Settings → Server and runner → Updates → "Ask agents to wrap up" (BOS-929, BOS-988): the button under Other
// actions, the still-running list, the "waiting for an answer", "in a long step", "finishing up" and "still going"
// labels (BOS-1016), per-run Stop, and (BOS-1238) "Stop N and carry on with the update" once the deadline has
// passed. Boss Man never stops a run by itself.

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
const run = (over: Record<string, unknown> = {}) => ({ runId: "r1", agent: "Zippy", ticket: "APP-7", ticketTitle: "Fix the footer", runningForMinutes: 22, sinceWrapUpMinutes: 12, waitingOn: null, ...over });
const past = () => new Date(Date.now() - 60_000).toISOString();
const future = () => new Date(Date.now() + 10 * 60_000).toISOString();
const off = { on: false as const, last: null };
const wrapOn = (over: Record<string, unknown> = {}) => ({ on: true, kind: "wrapup", reason: "asking agents to wrap up", since: past(), deadline: past(), runs: 1, companies: 1, chatOpen: true, minutes: 10, notRespondingAfter: 10, runsList: [run()], last: null, ...over });
const updateWaiting = (over: Record<string, unknown> = {}) => ({ on: true, kind: "update", reason: "runner update", since: past(), deadline: future(), runs: 2, companies: 1, chatOpen: true, last: null, ...over });
const wrapDuringUpdate = (over: Record<string, unknown> = {}) => updateWaiting({ wrapAsked: true, notRespondingAfter: 10, runsList: [run(), run({ runId: "r2", agent: "Kit" })], ...over });

const view = {
  enabled: true,
  pending: false,
  status: null,
  available: { tip: "aaaaaaa1", deployed: "aaaaaaa1", checkedAt: new Date().toISOString(), commits: [] },
  deployer: { reportedAt: new Date().toISOString(), late: false },
};

/** Mounts the Updates card with the given maintenance state, recording every request. */
function mount(maint: unknown) {
  const calls: string[] = [];
  const bodies: Record<string, unknown> = {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const key = `${init?.method ?? "GET"} ${url}`;
      calls.push(key);
      if (init?.body) bodies[key] = JSON.parse(String(init.body));
      if (url.endsWith("/api/self-deploy")) return json(view);
      if (url.endsWith("/api/maintenance")) return json(maint);
      if (url.includes("/api/self-deploy/wait")) return json({ on: false });
      if (url.includes("/api/self-deploy/history")) return json([]);
      if (url.endsWith("/api/runner-report")) return json({ live: [], update: null });
      return json({ ok: true });
    }),
  );
  render(<SelfDeploy go={() => {}} />);
  return { calls, bodies };
}

describe("Ask agents to wrap up in the Updates card", () => {
  it("shows a secondary button under Other actions when idle and posts to start a wrap-up", async () => {
    const { calls } = mount(off);
    fireEvent.click(await screen.findByRole("button", { name: "Ask agents to wrap up" }));
    await vi.waitFor(() => expect(calls).toContain("POST /api/maintenance/wrapup"));
  });

  it("while an update waits for agents, the one blue main button is Ask agents to wrap up (BOS-988)", async () => {
    const { calls } = mount(updateWaiting());
    const tag = await screen.findByText("Waiting for agents");
    expect(tag).toBeTruthy();
    expect(screen.getByTestId("update-say").textContent).toBe("The runner update is waiting for 2 agents to finish.");
    const main = await screen.findByTestId("update-main");
    expect(main.textContent).toBe("Ask agents to wrap up");
    fireEvent.click(main);
    await vi.waitFor(() => expect(calls).toContain("POST /api/maintenance/wrapup"));
  });

  it("shows the still-running list for a wrap-up asked during an update, and Cancel wrap-up takes back only the ask", async () => {
    const { calls } = mount(wrapDuringUpdate());
    expect(await screen.findByTestId("wrapup-runs")).toBeTruthy();
    expect(screen.getByTestId("wrapup-box").textContent).toContain("2 agents still running");
    fireEvent.click(screen.getByRole("button", { name: "Cancel wrap-up" }));
    await vi.waitFor(() => expect(calls).toContain("POST /api/maintenance/cancel-wrap"));
  });

  it("lists a run waiting on a card as waiting for an answer, not stuck, with a Stop for that one", async () => {
    const { calls } = mount(wrapOn({ runsList: [run({ waitingOn: { question: "May I run the tests?", tier: "ceo" } })] }));
    vi.stubGlobal("confirm", () => true);
    expect(await screen.findByTestId("wrapup-runs")).toBeTruthy();
    expect(screen.getByText("Waiting for an answer")).toBeTruthy();
    expect(screen.queryByText("Not responding")).toBeNull();
    expect(screen.getByTestId("wrapup-runs").textContent).toContain("APP-7");
    fireEvent.click(screen.getByRole("button", { name: "Stop this run" }));
    await vi.waitFor(() => expect(calls).toContain("POST /api/runs/r1/cancel"));
  });

  it("marks a run still going past the shown timeout as still going, with a Stop, never as not responding", async () => {
    mount(wrapOn());
    expect(await screen.findByText("Still going after 12 min")).toBeTruthy();
    expect(screen.getByText("Still going after 12 min").getAttribute("title")).toContain("10 minutes");
    expect(screen.queryByText(/not responding/i)).toBeNull();
    expect(screen.getByRole("button", { name: "Stop this run" })).toBeTruthy();
    const note = screen.getByTestId("wrapup-note").textContent ?? "";
    expect(note).toContain("anything it hasn't saved yet is lost");
    expect(note).toContain("wakes again after the update");
  });

  it("says a run in a long step will stop when the step ends, and one that has the message is finishing up, with a Stop on every run (BOS-1379)", async () => {
    mount(
      wrapOn({
        notRespondingAfter: 30,
        runsList: [
          run({ runId: "r1", agent: "Zippy", sinceWrapUpMinutes: 12, step: { title: "scripts/check-all.sh", sinceMinutes: 14 } }),
          run({ runId: "r2", agent: "Kit", sinceWrapUpMinutes: 12, gotMessage: true, step: { title: "pnpm build", sinceMinutes: 3 } }),
          run({ runId: "r3", agent: "Dylan", sinceWrapUpMinutes: 2 }),
        ],
      }),
    );
    const items = (await screen.findByTestId("wrapup-runs")).querySelectorAll("li");
    expect(items.length).toBe(3);
    expect(items[0]!.textContent).toContain("In a long step: it will stop when this step ends");
    expect(items[0]!.textContent).toContain("running scripts/check-all.sh for 14 min");
    expect(items[1]!.textContent).toContain("Finishing up");
    expect(items[1]!.textContent).not.toContain("In a long step");
    expect(items[2]!.textContent).toContain("Working");
    expect(screen.getAllByRole("button", { name: "Stop this run" }).length).toBe(3);
    expect(screen.queryByText(/not responding/i)).toBeNull();
    expect(items[0]!.querySelector(".tag")?.getAttribute("title")).toContain("use Stop this run");
  });

  it("an older server without step details still shows Working", async () => {
    mount(wrapOn({ notRespondingAfter: 30 }));
    expect((await screen.findByTestId("wrapup-runs")).textContent).toContain("Working");
  });
});

describe("Stop N and carry on with the update (BOS-1238)", () => {
  it("has no main button before the wrap-up deadline, and the per-run Stop stays", async () => {
    mount(wrapDuringUpdate({ deadline: future() }));
    await screen.findByTestId("wrapup-runs");
    expect(screen.queryByTestId("update-main")).toBeNull();
    expect(screen.queryByRole("button", { name: /carry on with the update/ })).toBeNull();
    expect(screen.getAllByRole("button", { name: "Stop this run" }).length).toBe(2);
  });

  it("after the deadline names each run and sends exactly the run ids shown", async () => {
    const { calls, bodies } = mount(wrapDuringUpdate({ deadline: past() }));
    vi.stubGlobal("confirm", () => true);
    const main = await screen.findByRole("button", { name: "Stop 2 and carry on with the update" });
    expect(main.className).toContain("primary");
    const next = screen.getByTestId("update-next").textContent ?? "";
    expect(next).toContain("Zippy (APP-7) and Kit (APP-7)");
    expect(next).toContain("anything they haven't saved is lost");
    fireEvent.click(main);
    await vi.waitFor(() => expect(calls).toContain("POST /api/maintenance/stop-stragglers"));
    expect(bodies["POST /api/maintenance/stop-stragglers"]).toEqual({ runIds: ["r1", "r2"] });
  });

  it("sends nothing when the owner declines the confirmation", async () => {
    const { calls } = mount(wrapDuringUpdate({ deadline: past() }));
    vi.stubGlobal("confirm", () => false);
    fireEvent.click(await screen.findByRole("button", { name: "Stop 2 and carry on with the update" }));
    await new Promise((r) => setTimeout(r, 50));
    expect(calls.some((c) => c.includes("stop-stragglers"))).toBe(false);
  });
});
