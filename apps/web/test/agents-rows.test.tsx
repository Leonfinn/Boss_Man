// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { Agents } from "../src/pages/Agents";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const company: Company = { id: "c1", name: "App Co", mission: null, paused: false, agents: [] };
const base = { companyId: "c1", role: "worker", agentKind: "claude", model: "opus", fundingSourceId: null, paused: false, starred: false, duty: null, title: "Engineer", template: null, instructions: "", funding: null, fundingKind: null, retiredAt: null, status: "idle", current: null, openTickets: 0, pa: null, month: { costMicros: 0, runs: 2, tokens: 10 } };

function stub(agents: object[], calls: { method: string; url: string }[] = []) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ method: init?.method ?? "GET", url });
      const body = url.includes("agent-templates") ? { templates: [] } : url.includes("/models") ? { runner: {}, api: [] } : url.includes("/history") ? [] : url.includes("/notes") ? { items: [], limits: { count: 20, title: 80, text: 500, why: 300 } } : url.includes("/agents") ? agents : [];
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
}

describe("agent rows (BOS-1256)", () => {
  it("shows Pause and ⋯ only, with Edit, Star and Retire inside the menu", async () => {
    stub([{ ...base, id: "a1", name: "Bramble" }]);
    render(<Agents company={company} onChanged={() => {}} />);
    await screen.findByRole("button", { name: "Bramble" });
    expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retire" })).toBeNull();
    const more = screen.getByRole("button", { name: "More for Bramble" });
    expect(more.getAttribute("aria-haspopup")).toBe("menu");
    fireEvent.keyDown(more, { key: "ArrowDown" });
    const menu = await screen.findByRole("menu");
    const items = within(menu).getAllByRole("menuitem").map((i) => i.textContent);
    expect(items[0]).toMatch(/^Edit Bramble/);
    expect(items[1]).toMatch(/^Star Bramble/);
    expect(items[2]).toMatch(/^Retire Bramble…/);
    await waitFor(() => expect(document.activeElement).toBe(within(menu).getAllByRole("menuitem")[0]));
    // Arrow keys move, End jumps, Esc closes and returns focus to the ⋯ button.
    fireEvent.keyDown(menu, { key: "End" });
    expect(document.activeElement).toBe(within(menu).getAllByRole("menuitem")[2]);
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(more);
  });

  it("opens the edit panel from the name and from the menu's Edit item", async () => {
    stub([{ ...base, id: "a1", name: "Bramble" }]);
    render(<Agents company={company} onChanged={() => {}} />);
    const name = await screen.findByRole("button", { name: "Bramble" });
    expect(name.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(name);
    expect(name.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(name);
    expect(name.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "More for Bramble" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Edit Bramble/ }));
    expect(name.getAttribute("aria-expanded")).toBe("true");
  });

  it("keeps the retire confirm text and gives the CEO no Retire item", async () => {
    const calls: { method: string; url: string }[] = [];
    stub([{ ...base, id: "a1", name: "Bramble" }, { ...base, id: "a2", name: "Boss", role: "ceo", title: null }], calls);
    const confirm = vi.fn(() => true);
    vi.stubGlobal("confirm", confirm);
    render(<Agents company={company} onChanged={() => {}} />);
    await screen.findByRole("button", { name: "Bramble" });
    fireEvent.click(screen.getByRole("button", { name: "More for Boss" }));
    expect(within(await screen.findByRole("menu")).queryByText(/Retire/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "More for Bramble" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Retire Bramble…/ }));
    expect(confirm).toHaveBeenCalledWith("Retire Bramble? They stop working, their open tasks go back to unassigned and they stop watching tasks. You can rehire them from their history.");
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/api/agents/a1/retire"))).toBe(true));
  });

  it("tapping the dimmed page closes the menu without toggling the edit panel", async () => {
    stub([{ ...base, id: "a1", name: "Bramble" }]);
    const { container } = render(<Agents company={company} onChanged={() => {}} />);
    const name = await screen.findByRole("button", { name: "Bramble" });
    fireEvent.click(screen.getByRole("button", { name: "More for Bramble" }));
    await screen.findByRole("menu");
    fireEvent.click(container.querySelector(".row-menu-dim")!);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(name.getAttribute("aria-expanded")).toBe("false");
  });

  it("says over the limit in words, shows Start when paused, and History alone when retired", async () => {
    stub([
      { ...base, id: "a1", name: "Rex", wipCount: 4, wipLimit: 3 },
      { ...base, id: "a2", name: "Moss", paused: true, status: "paused" },
      { ...base, id: "a3", name: "Old", retiredAt: "2026-11-01T00:00:00Z", status: "retired" },
    ]);
    render(<Agents company={company} onChanged={() => {}} />);
    expect(await screen.findByText("4 / 3 in progress, over the limit")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start" })).toBeTruthy();
    expect(screen.getByText("Paused")).toBeTruthy();
    expect(screen.getByRole("button", { name: "History" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "More for Old" })).toBeNull();
  });
});
