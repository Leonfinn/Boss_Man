// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { Funding, Settings } from "../src/pages/Settings";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("funding source provider", () => {
  it("only offers plans for a subscription, and resets an invalid provider", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("[]", { status: 200 })));
    render(<Funding company={{ id: "c1", name: "Co", mission: null, paused: false, agents: [] } as Company} onChanged={() => {}} />);
    const provider = (await screen.findByLabelText("Provider")) as HTMLSelectElement;
    const options = () => [...provider.options].map((o) => o.value);
    expect(options()).toEqual(["anthropic", "openai", "ollama", "synthetic"]);
    fireEvent.change(screen.getByLabelText("Kind"), { target: { value: "api_payg" } });
    expect(options()).toContain("bedrock");
    fireEvent.change(provider, { target: { value: "bedrock" } });
    fireEvent.change(screen.getByLabelText("Kind"), { target: { value: "subscription" } });
    expect(provider.value).toBe("anthropic");
    expect(screen.getByText("What the provider controls")).toBeTruthy();
  });
});

describe("editing and deleting a funding source", () => {
  const source = { id: "f1", name: "Router", kind: "api_payg", provider: "openai", monthlyGrantMicros: null, cycleAnchor: null };
  const setup = (reply: (url: string, method: string) => Response) => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => (init?.method !== "GET" ? reply(url, init!.method!) : new Response(JSON.stringify([source]), { status: 200 })));
    vi.stubGlobal("fetch", fetchMock);
    render(<Funding company={{ id: "c1", name: "Co", mission: null, paused: false, agents: [] } as Company} onChanged={() => {}} />);
    return fetchMock;
  };

  it("pre-fills the form and sends a PATCH", async () => {
    const fetchMock = setup(() => new Response("{}", { status: 200 }));
    fireEvent.click(await screen.findByLabelText("Edit Router"));
    expect((screen.getByLabelText("Editing Router") as HTMLInputElement).value).toBe("Router");
    expect((screen.getByLabelText("Provider") as HTMLSelectElement).value).toBe("openai");
    fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "openrouter" } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/funding-sources/f1", expect.objectContaining({ method: "PATCH", body: expect.stringContaining('"provider":"openrouter"') })));
  });

  it("confirms before deleting and shows the server's refusal", async () => {
    const fetchMock = setup(() => new Response(JSON.stringify({ message: "It has spend. Edit it instead." }), { status: 409 }));
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    fireEvent.click(await screen.findByLabelText("Delete Router"));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('"Router"'));
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);

    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByLabelText("Delete Router"));
    expect((await screen.findByRole("alert")).textContent).toBe("It has spend. Edit it instead.");
    expect(fetchMock).toHaveBeenCalledWith("/api/funding-sources/f1", expect.objectContaining({ method: "DELETE" }));
  });
});

// BOS-1053: the Settings → Funding page lost its per-source status cards and spend tables once, and a heading check
// could not see it ("Budgets" is a heading on both versions). So assert the reads and the cards themselves.
describe("Settings → Funding page", () => {
  it("shows a status card per source and the budget-policy table, not just the sources list and project budgets", async () => {
    const source = { id: "f1", name: "Claude Max", kind: "subscription", provider: "anthropic", monthlyGrantMicros: null, cycleAnchor: null };
    const status = { source, credit: null, quota: [{ window: "five_hour", utilization: 0.42, resetsAt: null, status: null }], windowsSeen: ["five_hour"], forecasts: {}, daily: [], totalSpentMicros: 0, coverage: "all" };
    const budgets = [{ policy: { id: "b1", scopeKind: "instance", scopeId: "x", windowKind: "calendar_month", limitMicros: 5_000_000, onLimit: "pause" }, status: { usedMicros: 1_000_000, limitMicros: 5_000_000, fractionUsed: 0.2, state: "ok" } }];
    const fetchMock = vi.fn(async (url: string) => {
      const body = url.includes("/status") ? status : url.startsWith("/api/funding-sources") ? [source] : url === "/api/budgets" ? budgets : [];
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const company = { id: "c1", name: "Co", mission: null, paused: false, agents: [] } as unknown as Company;
    const { container } = render(<Settings companies={[company]} companyId="c1" tab="funding" go={() => {}} onChanged={() => {}} />);
    await waitFor(() => expect(container.querySelectorAll(".source-card").length).toBe(1));
    expect(container.querySelector(".source-card")!.textContent).toContain("42%");
    expect(await screen.findByText("Spending limits")).toBeTruthy();
    expect(screen.getByText("All companies")).toBeTruthy();
    const urls = fetchMock.mock.calls.map(([u]) => String(u));
    expect(urls.some((u) => /^\/api\/funding-sources\/f1\/status/.test(u))).toBe(true);
    expect(urls).toContain("/api/budgets");
  });
});
