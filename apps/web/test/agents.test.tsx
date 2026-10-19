// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { Agents } from "../src/pages/Agents";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const company: Company = { id: "c1", name: "App Co", mission: null, paused: false, agents: [] };
const tpl = (id: string, title: string) => ({ id, title, role: "worker", modelTier: "standard", summary: "", instructions: `${title} instructions` });

describe("hire form", () => {
  it("swaps the default name with the template but keeps a typed one", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const body = url.includes("agent-templates") ? { templates: [tpl("engineer", "Engineer"), tpl("designer", "Designer")] } : url.includes("/models") ? { runner: {}, api: [] } : [];
        return new Response(JSON.stringify(body), { status: 200 });
      }),
    );
    render(<Agents company={company} onChanged={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: /hire/i }));
    fireEvent.click(await screen.findByLabelText(/Engineer/));
    expect(screen.getByRole("button", { name: "Hire Engineer" })).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/Designer/));
    expect(screen.getByRole("button", { name: "Hire Designer" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Ada" } });
    fireEvent.click(screen.getByLabelText(/Engineer/));
    await waitFor(() => expect(screen.getByRole("button", { name: "Hire Ada" })).toBeTruthy());
  });
});

describe("Refresh models", () => {
  it("asks the server to probe the runner and says what came back", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const body = url.includes("/models/refresh") ? { probed: { claude: { ok: true, count: 3 } } } : url.includes("agent-templates") ? { templates: [tpl("engineer", "Engineer")] } : url.includes("/models") ? { runner: {}, api: [] } : [];
      return new Response(JSON.stringify(body), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<Agents company={company} onChanged={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: /hire/i }));
    fireEvent.click(await screen.findByRole("button", { name: "Refresh models" }));
    expect(await screen.findByText("Updated.")).toBeTruthy();
    expect(fetchMock.mock.calls.some(([u, i]) => String(u) === "/api/companies/c1/models/refresh" && (i as RequestInit).method === "POST")).toBe(true);
  });
});
