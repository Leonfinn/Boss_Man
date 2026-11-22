// @vitest-environment jsdom
// BOS-2200: working hours on an agent's settings (off by default) and "Off until Mon 08:00" in the list.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { Agents } from "../src/pages/Agents";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const company: Company = { id: "c1", name: "App Co", mission: null, paused: false, agents: [] };
const base = { id: "a1", name: "Dylan", companyId: "c1", role: "worker", agentKind: "claude", model: "opus", fundingSourceId: null, paused: false, starred: false, duty: null, title: "Engineer", template: null, instructions: "", funding: null, fundingKind: null, retiredAt: null, status: "idle", current: null, openTickets: 0, pa: null, month: { costMicros: 0, runs: 0, tokens: 0 } };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });

function stub(agents: unknown, calls: Array<{ method: string; url: string; body: unknown }> = []) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.includes("agent-templates")) return json({ templates: [] });
      if (url.includes("/models")) return json({ runner: {}, api: [] });
      if (url.includes("/history")) return json([]);
      if (url.includes("/notes")) return json({ items: [], limits: { count: 20, title: 80, text: 500, why: 300 } });
      if (init?.method === "PATCH") return json({});
      if (url.includes("/agents")) return json(agents);
      return json([]);
    }),
  );
  return calls;
}

describe("agent working hours (BOS-2200)", () => {
  it("says when an agent outside its hours is back, and says nothing for one that is on", async () => {
    stub([{ ...base, workingHours: { days: [1], start: "08:00", end: "17:00", timeZone: "UTC" }, offUntil: { at: "2027-01-04T08:00:00Z", label: "Mon 08:00" } }, { ...base, id: "a2", name: "Basil" }]);
    render(<Agents company={company} onChanged={() => {}} />);
    expect((await screen.findByTestId("off-until-a1")).textContent).toBe("Off until Mon 08:00 (working hours)");
    expect(screen.queryByTestId("off-until-a2")).toBeNull();
  });

  it("is off by default, and saves days, times and zone when turned on", async () => {
    const calls = stub([base]);
    render(<Agents company={company} onChanged={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Dylan" }));
    const toggle = (await screen.findByLabelText(/Only start Dylan on new work during set hours/)) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    expect(screen.queryByLabelText("From")).toBeNull();
    fireEvent.click(toggle);
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "22:00" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "07:00" } });
    fireEvent.change(screen.getByLabelText(/Time zone/), { target: { value: "Europe/London" } });
    fireEvent.click(screen.getByLabelText("Sat"));
    fireEvent.click(screen.getByRole("button", { name: /Save/ }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const body = calls.find((c) => c.method === "PATCH")!.body as { workingHours: unknown };
    expect(body.workingHours).toEqual({ days: [1, 2, 3, 4, 5, 6], start: "22:00", end: "07:00", timeZone: "Europe/London" });
  });

  it("sends null when it stays off, and refuses to save with no day chosen", async () => {
    const calls = stub([{ ...base, workingHours: { days: [1], start: "08:00", end: "17:00", timeZone: "UTC" } }]);
    render(<Agents company={company} onChanged={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Dylan" }));
    expect(((await screen.findByLabelText(/Only start Dylan/)) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByLabelText("Mon"));
    fireEvent.click(screen.getByRole("button", { name: /Save/ }));
    expect(await screen.findByText("Choose at least one day for the working hours.")).toBeTruthy();
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    fireEvent.click(screen.getByLabelText(/Only start Dylan/));
    fireEvent.click(screen.getByRole("button", { name: /Save/ }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect((calls.find((c) => c.method === "PATCH")!.body as { workingHours: unknown }).workingHours).toBeNull();
  });
});
