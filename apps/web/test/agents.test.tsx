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

describe("model search", () => {
  it("narrows the list to models whose name or ID matches", async () => {
    const models = { runner: { claude: { models: [{ value: "sonnet", name: "Sonnet" }, { value: "opus", name: "Opus" }] } }, api: [] };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => new Response(JSON.stringify(url.includes("agent-templates") ? { templates: [tpl("engineer", "Engineer")] } : url.includes("/models") ? models : []), { status: 200 })),
    );
    render(<Agents company={company} onChanged={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: /hire/i }));
    const search = await screen.findByLabelText("Search models");
    expect(screen.getByRole("option", { name: "Opus (opus)" })).toBeTruthy();
    fireEvent.change(search, { target: { value: "SON" } });
    expect(screen.queryByRole("option", { name: "Opus (opus)" })).toBeNull();
    expect(screen.getByRole("option", { name: "Sonnet (sonnet)" })).toBeTruthy();
    expect(screen.getByText(/1 of 2 models match/)).toBeTruthy();
  });
});

describe("instructions from the template", () => {
  it("offers to fill an empty box from the agent's template, and the CEO's from the CEO template", async () => {
    const row = (over: object) => ({ id: "a1", companyId: "c1", name: "Ada", role: "worker", agentKind: "claude", model: null, fundingSourceId: null, paused: false, starred: false, duty: null, title: "Engineer", template: "engineer", instructions: "", funding: null, fundingKind: null, retiredAt: null, status: "idle", current: null, openTickets: 0, pa: null, month: { costMicros: 0, runs: 0, tokens: 0 }, ...over });
    for (const [agent, label, text] of [
      [row({}), "Fill in from the Engineer template", "Engineer instructions"],
      [row({ id: "a2", name: "Boss", role: "ceo", title: null, template: null }), "Fill in from the CEO template", "CEO instructions"],
    ] as const) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          const body = url.includes("agent-templates") ? { templates: [tpl("engineer", "Engineer")], ceo: { ...tpl("ceo", "CEO"), role: undefined } } : url.includes("/models") ? { runner: {}, api: [] } : url.includes("/history") ? [] : url.includes("/agents") ? [agent] : [];
          return new Response(JSON.stringify(body), { status: 200 });
        }),
      );
      render(<Agents company={company} onChanged={() => {}} />);
      fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
      fireEvent.click(await screen.findByRole("button", { name: label }));
      expect((screen.getByLabelText("Instructions") as HTMLTextAreaElement).value).toBe(text);
      cleanup();
    }
  });
});

describe("reviews line (BOS-198)", () => {
  it("shows which reviews the agent does, read-only, with a link to Settings", async () => {
    const ada = { id: "a1", companyId: "c1", name: "Ada", role: "worker", agentKind: "claude", model: null, fundingSourceId: null, paused: false, starred: false, duty: null, title: "Engineer", template: "engineer", instructions: "", funding: null, fundingKind: null, retiredAt: null, status: "idle", current: null, openTickets: 0, pa: null, month: { costMicros: 0, runs: 0, tokens: 0 } };
    const r = (reviewer: unknown, kinds?: object) => ({ planApprover: "ceo", reviewer, ownerSignoff: false, ...(kinds ? { kinds } : {}) });
    const policy = { trivial: r("ceo"), low: r(["a1", "a9"]), medium: r(["a9", "a1"]), high: r("a1", { security: ["a9", "a1"] }), critical: r("a1", { security: "a1", infra: "a9" }) };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const body = url.includes("review-policy") ? policy : url.includes("agent-templates") ? { templates: [tpl("engineer", "Engineer")] } : url.includes("/models") ? { runner: {}, api: [] } : url.includes("/history") ? [] : url.includes("/agents") ? [ada] : [];
        return new Response(JSON.stringify(body), { status: 200 });
      }),
    );
    render(<Agents company={company} onChanged={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    expect(await screen.findByText(/Code \(Low\+\), Security \(High\+\)/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Change in Settings › Reviews" }).getAttribute("href")).toBe("#/settings/c1/workflow");
    // The old setting is gone: nothing on the agent page chooses reviews.
    expect(screen.queryByLabelText("Company's reviewer for")).toBeNull();
  });
});

describe("CEO notes", () => {
  it("lists the CEO's notes from chat and lets the owner edit and delete them", async () => {
    const ceo = { id: "a2", companyId: "c1", name: "Boss", role: "ceo", agentKind: "claude", model: null, fundingSourceId: null, paused: false, starred: false, duty: null, title: null, template: null, instructions: "", funding: null, fundingKind: null, retiredAt: null, status: "idle", current: null, openTickets: 0, pa: null, month: { costMicros: 0, runs: 0, tokens: 0 } };
    let items = [{ id: "n1", title: "Website tasks", text: "Never say the owner forbade splitting it.", why: "I never said that", source: "chat", requestedBy: null, ticketId: null, ticketRef: null, updatedAt: new Date().toISOString() }];
    const limits = { count: 20, title: 80, text: 500, why: 300 };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/agent-notes/n1" && init?.method === "PATCH") items = [{ ...items[0]!, ...JSON.parse(String(init.body)), source: "owner" }];
      if (url === "/api/agent-notes/n1" && init?.method === "DELETE") items = [];
      const body = url.includes("/notes") ? { items, limits } : url.includes("agent-templates") ? { templates: [] } : url.includes("/models") ? { runner: {}, api: [] } : url.includes("/agents") ? [ceo] : url.startsWith("/api/agent-notes") ? { ok: true } : [];
      return new Response(JSON.stringify(body), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("confirm", () => true);
    render(<Agents company={company} onChanged={() => {}} />);
    expect(await screen.findByText("CEO notes (1 of 20)")).toBeTruthy();
    expect(screen.getByText("Never say the owner forbade splitting it.")).toBeTruthy();
    expect(screen.getByText(/Why: “I never said that” · saved by the CEO from your chat/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Edit note: Website tasks" }));
    fireEvent.change(screen.getByLabelText("Note", { selector: "#note-n1-text" }), { target: { value: "Don't attribute the split to the owner." } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Don't attribute the split to the owner.")).toBeTruthy();
    expect(fetchMock.mock.calls.some(([u, i]) => u === "/api/agent-notes/n1" && (i as RequestInit).method === "PATCH")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Delete note: Website tasks" }));
    expect(await screen.findByText("CEO notes (0 of 20)")).toBeTruthy();
    expect(screen.getByText("No notes yet.")).toBeTruthy();
  });
});

describe("CEO note requests", () => {
  it("shows where a note came from, and waiting and declined requests from the team", async () => {
    const ceo = { id: "a2", companyId: "c1", name: "Boss", role: "ceo", agentKind: "claude", model: null, fundingSourceId: null, paused: false, starred: false, duty: null, title: null, template: null, instructions: "", funding: null, fundingKind: null, retiredAt: null, status: "idle", current: null, openTickets: 0, pa: null, month: { costMicros: 0, runs: 0, tokens: 0 } };
    const at = new Date().toISOString();
    const body = {
      items: [{ id: "n1", title: "Run the linter", text: "Lint before review.", why: "Review bounced twice.", source: "request", requestedBy: "Engineer", ticketId: "t1", ticketRef: "BOS-9", updatedAt: at }],
      requests: [
        { id: "r1", title: "Run the linter", text: "Lint before review.", why: "Review bounced twice.", from: "Engineer", ticketId: "t1", ticketRef: "BOS-9", status: "accepted", declineReason: null, createdAt: at },
        { id: "r2", title: "Skip tests", text: "Skip tests on docs tickets.", why: "Faster.", from: "Engineer", ticketId: "t1", ticketRef: "BOS-9", status: "declined", declineReason: "Tests always run.", createdAt: at },
        { id: "r3", title: "Tag releases", text: "Tag every release.", why: "Hard to find releases.", from: "QA", ticketId: "t2", ticketRef: "BOS-10", status: "pending", declineReason: null, createdAt: at },
      ],
      limits: { count: 20, title: 80, text: 500, why: 300 },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => new Response(JSON.stringify(url.includes("/notes") ? body : url.includes("agent-templates") ? { templates: [] } : url.includes("/models") ? { runner: {}, api: [] } : url.includes("/agents") ? [ceo] : []), { status: 200 })),
    );
    render(<Agents company={company} onChanged={() => {}} />);
    expect(await screen.findByText("CEO notes (1 of 20) · 1 request waiting")).toBeTruthy();
    expect(screen.getByText(/asked by Engineer/).textContent).toMatch(/asked by Engineer on BOS-9, accepted by the CEO/);
    // The accepted request shows as the note, not again as a request.
    expect(screen.getAllByText("Run the linter")).toHaveLength(1);
    expect(screen.getByText("Waiting for the CEO")).toBeTruthy();
    expect(screen.getByText(/Declined: Tests always run\./)).toBeTruthy();
  });
});
