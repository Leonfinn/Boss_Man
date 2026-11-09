// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_WATCHDOG } from "@boss-man/shared";
import type { Agent, Company } from "../src/api";
import { Watchdog } from "../src/pages/Settings";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const agent = (id: string, name: string, over: Partial<Agent> = {}): Agent => ({ id, companyId: "c1", name, role: "worker", agentKind: "claude", model: null, fundingSourceId: null, paused: false, starred: false, duty: null, ...over });
const company: Company = { id: "c1", name: "Boss Man Co", mission: null, paused: false, agents: [agent("ceo", "CEO", { role: "ceo" }), agent("sm", "Scrum Master"), agent("wiki", "Wiki Maintainer", { duty: "wiki" })] };
const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
const status = (over: Record<string, unknown> = {}) => ({ settings: DEFAULT_WATCHDOG, scrumMaster: null, lastSweepAt: null, trippedAt: null, trippedReason: null, openFlags: 0, ...over });

function stub(first: unknown, backtest?: unknown) {
  const calls: Array<{ method: string; url: string; body?: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return json(url.includes("backtest") ? backtest : first);
    }),
  );
  return calls;
}

describe("watchdog settings (BOS-58)", () => {
  it("is off by default; picking a Scrum Master and switching on sends the limits too", async () => {
    // BOS-762 made it on for a new company; this test covers a company that has it switched off.
    const calls = stub(status({ settings: { ...DEFAULT_WATCHDOG, enabled: false } }));
    render(<Watchdog company={company} />);
    expect(await screen.findByText("Off.")).toBeTruthy();
    // The CEO and agents with another standing job can't be the Scrum Master.
    const options = [...(screen.getByLabelText("Scrum Master") as HTMLSelectElement).options].map((o) => o.textContent);
    expect(options).toEqual(["Nobody", "Scrum Master"]);
    fireEvent.change(screen.getByLabelText("Scrum Master"), { target: { value: "sm" } });
    fireEvent.change(screen.getByLabelText("No movement in progress"), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: "Switch on" }));
    await vi.waitFor(() => expect(calls.find((c) => c.method === "PATCH")).toBeTruthy());
    expect(calls.find((c) => c.method === "PATCH")).toMatchObject({ url: "/api/companies/c1/watchdog", body: { enabled: true, scrumMasterAgentId: "sm", inProgressHours: 3, reviewHours: 2, blockedHours: 8 } });
  });

  it("ticks record only in Settings and PATCHes just that setting (BOS-166)", async () => {
    const calls = stub(status({ settings: { ...DEFAULT_WATCHDOG, enabled: true }, scrumMaster: { id: "sm", name: "Scrum Master", paused: false } }));
    render(<Watchdog company={company} />);
    const box = (await screen.findByLabelText(/record only/i)) as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    await vi.waitFor(() => expect(calls.find((c) => c.method === "PATCH")).toBeTruthy());
    expect(calls.find((c) => c.method === "PATCH")!.body).toMatchObject({ recordOnly: true });
  });

  it("shows when it tripped its cap, and offers to switch it back on", async () => {
    stub(status({ settings: { ...DEFAULT_WATCHDOG, enabled: false }, scrumMaster: { id: "sm", name: "Scrum Master", paused: false }, trippedAt: "2026-10-26T10:00:00Z", trippedReason: "it would have woken the Scrum Master more than 4 times in an hour" }));
    render(<Watchdog company={company} />);
    expect(await screen.findByText(/Switched itself off .*more than 4 times in an hour/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Switch back on" })).toBeTruthy();
  });

  it("tests the rules on past days and lists what it would have flagged", async () => {
    stub(status({ settings: { ...DEFAULT_WATCHDOG, enabled: true }, scrumMaster: { id: "sm", name: "Scrum Master", paused: false }, lastSweepAt: "2026-10-26T10:00:00Z", openFlags: 2 }), {
      from: "2026-10-12T00:00:00Z",
      to: "2026-10-26T00:00:00Z",
      flags: [{ ticketId: "t1", ref: "BOS-26", title: "Design the filter bar", rule: "unassigned", firstAt: "2026-10-25T12:00:00Z", handOffs: 1, verdict: "cleared later" }],
      scrumMasterWakes: 1,
      busiestHourWakes: 1,
      wouldTripCap: false,
      caveats: ["History is approximate."],
    });
    render(<Watchdog company={company} />);
    expect(await screen.findByText(/On\. Last check .* 2 open issues\./)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Test on the past 48 hours" }));
    expect(await screen.findByText(/would have raised 1 flag and woken the Scrum Master 1 time/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "BOS-26" })).toBeTruthy();
    expect(screen.getByText("nobody is assigned")).toBeTruthy();
    expect(screen.getByText("History is approximate.")).toBeTruthy();
  });
});
