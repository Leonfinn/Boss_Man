// @vitest-environment jsdom
// BOS-279: Synthetic's Infinite mode is visible on the Agents page (a badge and a labelled picker group) and the
// background run limit is editable in Settings.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { Agents } from "../src/pages/Agents";
import { RunLimits } from "../src/pages/Settings";

const INF = "synthetic/infinite:small:vision";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
const company: Company = { id: "c1", name: "App Co", mission: null, paused: false, agents: [] };
const baseAgent = { companyId: "c1", role: "worker", funding: null, fundingKind: null, retiredAt: null, status: "idle", current: null, openTickets: 0, pa: null, month: { costMicros: 0, runs: 0, tokens: 0 } };

describe("Agents page infinite-mode badge (BOS-279)", () => {
  it("marks an agent on an infinite model as free and slow, and leaves a normal one unmarked", async () => {
    const rows = [
      { ...baseAgent, id: "a1", name: "Backend", agentKind: "opencode", model: INF, funding: "Synthetic Big", fundingSourceId: "fs1", paused: false, starred: false, duty: null, title: "Engineer", template: null, instructions: "" },
      { ...baseAgent, id: "a2", name: "Frontend", agentKind: "opencode", model: "synthetic/hf:deepseek-ai/DeepSeek-V4.1-Flash-1017", funding: "Synthetic Big", fundingSourceId: "fs1", paused: false, starred: false, duty: null, title: "Engineer", template: null, instructions: "" },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => json(url.includes("agent-templates") ? { templates: [] } : url.includes("/models") ? { runner: {}, api: [], infinite: [] } : url.includes("/agents") ? rows : [])),
    );
    render(<Agents company={company} onChanged={() => {}} />);
    expect(await screen.findByText("Backend")).toBeTruthy();
    // Exactly one badge, on the infinite-mode agent only.
    expect(screen.getAllByText("Infinite mode · free, slow")).toHaveLength(1);
  });
});

describe("model picker infinite group (BOS-279)", () => {
  it("groups Infinite mode separately for an OpenCode agent on a Synthetic plan", async () => {
    const agent = { ...baseAgent, id: "a1", name: "Backend", agentKind: "opencode", model: null, funding: "Synthetic Big", fundingSourceId: "fs1", paused: false, starred: false, duty: null, title: "Engineer", template: null, instructions: "" };
    const models = {
      runner: { opencode: { models: [{ value: "synthetic/hf:deepseek-ai/DeepSeek-V4.1-Flash-1017", name: "DeepSeek" }] } },
      api: [],
      infinite: [{ fundingSourceId: "fs1", name: "Synthetic Big", model: { value: INF, name: "Infinite mode — free, slow (Synthetic Big plan)" } }],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => json(url.includes("agent-templates") ? { templates: [] } : url.includes("/models") ? models : url.includes("funding-sources") ? [{ id: "fs1", name: "Synthetic Big", kind: "subscription", provider: "synthetic" }] : url.includes("/history") ? [] : url.includes("/agents") ? [agent] : [])),
    );
    render(<Agents company={company} onChanged={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Backend" }));
    // The default model picker groups it under its own label, so it's never mistaken for a normal model.
    const option = await screen.findByRole("option", { name: "Infinite mode — free, slow (Synthetic Big plan)" });
    expect((option as HTMLOptionElement).value).toBe(INF);
    expect((option.closest("optgroup") as HTMLOptGroupElement | null)?.label).toBe("Synthetic Infinite mode (free, slow, background runs)");
  });
});

describe("background run limit in Settings (BOS-279)", () => {
  it("shows the background limit (default 2) and saves it with the other limits", async () => {
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        if (init?.method === "PUT") return json({ instance: 8, company: 4, background: 3, defaults: { instance: 8, company: 4, background: 2 } });
        return json({ instance: 8, company: 4, background: 2, defaults: { instance: 8, company: 4, background: 2 } });
      }),
    );
    render(<RunLimits />);
    const field = (await screen.findByLabelText(/Background \(infinite mode\) runs at once/)) as HTMLInputElement;
    expect(field.value).toBe("2");
    expect(screen.getByText(/default 2/)).toBeTruthy();
    fireEvent.change(field, { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: /Save/ }));
    await waitFor(() => expect(calls.find((c) => c.method === "PUT")).toBeTruthy());
    expect(calls.find((c) => c.method === "PUT")!.body).toMatchObject({ instance: 8, company: 4, background: 3 });
  });
});
