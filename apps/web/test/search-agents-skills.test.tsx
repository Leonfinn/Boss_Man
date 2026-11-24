// @vitest-environment jsdom
// BOS-2347: the search box also finds agents and skills, each in its own group after Runs, and picking one opens
// the Agents page with that agent's panel open or the Skills page showing that skill.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { SearchPalette, type SearchResults } from "../src/components/SearchPalette";
import { Agents, type AgentRow } from "../src/pages/Agents";
import { Skills } from "../src/pages/Skills";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
const company: Company = { id: "c1", name: "App Co", mission: null, paused: false, agents: [] };
const ctrlK = () => fireEvent.keyDown(window, { key: "k", ctrlKey: true });

describe("agents and skills in the search box (BOS-2347)", () => {
  const RESULTS: SearchResults = {
    q: "zippy",
    tickets: [{ id: "t1", title: "Zippy's ticket", ref: "BOS-7", snippet: "", link: "tickets/t1" }],
    wiki: [],
    chats: [],
    runs: [{ id: "r1", title: "Zippy on Zippy's ticket", snippet: "Finished", at: "2026-11-23T07:00:00.000Z", link: "runs/r1" }],
    agents: [{ id: "a1", title: "Zippy", snippet: "Senior Developer", link: "agents/a1" }],
    skills: [{ id: "s1", title: "zippy-tools", snippet: "Helps Zippy draw.", link: "skills/s1" }],
  };

  it("shows Agents and Skills after Runs, and arrows, Enter or a click open them", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(RESULTS)));
    render(<SearchPalette companyId="c1" go={() => {}} />);
    ctrlK();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "zippy" } });
    await screen.findByText("zippy-tools");
    expect(screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual(["Tickets", "Runs", "Agents", "Skills"]);
    expect(screen.getByRole("region", { name: "Agents" }).textContent).toContain("Senior Developer");
    cleanup();

    for (const [downs, link] of [[2, "agents/a1"], [3, "skills/s1"]] as const) {
      const go = vi.fn();
      render(<SearchPalette companyId="c1" go={go} />);
      ctrlK();
      const box = screen.getByRole("combobox");
      fireEvent.change(box, { target: { value: "zippy" } });
      await screen.findByText("zippy-tools");
      for (let i = 0; i < downs; i++) fireEvent.keyDown(box, { key: "ArrowDown" });
      fireEvent.keyDown(box, { key: "Enter" });
      expect(go).toHaveBeenCalledWith(link);
      cleanup();
    }
    const go = vi.fn();
    render(<SearchPalette companyId="c1" go={go} />);
    ctrlK();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "zippy" } });
    fireEvent.click(await screen.findByText("Zippy", { selector: ".search-title" }));
    expect(go).toHaveBeenCalledWith("agents/a1");
  });

  it("an older server's answer without agents or skills still shows the rest", async () => {
    const { agents: _a, skills: _s, ...old } = RESULTS;
    vi.stubGlobal("fetch", vi.fn(async () => json(old)));
    render(<SearchPalette companyId="c1" go={() => {}} />);
    ctrlK();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "zippy" } });
    await screen.findByText("Zippy's ticket");
    expect(screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual(["Tickets", "Runs"]);
  });
});

describe("opening a search result on the Agents and Skills pages (BOS-2347)", () => {
  const base = { companyId: "c1", role: "worker", agentKind: "claude", model: "opus", thinking: null, fundingSourceId: null, paused: false, starred: false, duty: null, title: "Engineer", template: null, instructions: "", funding: null, fundingKind: null, retiredAt: null, status: "idle", current: null, openTickets: 0, pa: null, month: { costMicros: 0, runs: 0, tokens: 0 } };
  const agentRows = [
    { ...base, id: "a1", name: "Alpha" },
    { ...base, id: "a2", name: "Zippy" },
  ] as unknown as AgentRow[];

  it("#/agents/<id> opens that agent's panel and scrolls to it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("agent-templates")) return json({ templates: [] });
        if (url.includes("/models")) return json({ runner: {}, api: [] });
        if (url.endsWith("/agents")) return json(agentRows);
        if (url.endsWith("/record")) return json({ finished: 0, passedFirstTime: 0, sendBacks: 0, medianMergeMs: null, costPerFinishedMicros: null, recent: [] });
        return json([]);
      }),
    );
    const seen: string[] = [];
    Element.prototype.scrollIntoView = () => {};
    vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(function (this: Element) {
      seen.push(this.querySelector("[id^=agent-panel-]")?.id ?? this.tagName);
    });
    render(<Agents company={company} agentId="a2" onChanged={() => {}} />);
    const zippy = await screen.findByRole("button", { name: "Zippy" });
    expect(zippy.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: "Alpha" }).getAttribute("aria-expanded")).toBe("false");
    await waitFor(() => expect(seen).toEqual(["agent-panel-a2"]));
  });

  it("#/skills/<id> shows that skill, its pack folded open", async () => {
    const mk = (id: string, name: string, pack: string | null) => ({ id, name, description: "d", source: "written", sourceUrl: null, sourceRef: null, pack, packUrl: null, sizeBytes: 100, fileCount: 1, updatedAt: "2026-10-21T14:26:00Z", agents: [] });
    const rows = [mk("s0", "web-fetch", null), mk("s1", "pdf-read", "docs")];
    // The skill's own read never answers: this test is about which skill is shown, not its detail.
    vi.stubGlobal("fetch", vi.fn((url: string) => (url.endsWith("/skills/s1") ? new Promise<Response>(() => {}) : Promise.resolve(url.endsWith("/skills") ? json(rows) : json([])))));
    Element.prototype.scrollIntoView = () => {};
    const scrolled = vi.spyOn(Element.prototype, "scrollIntoView");
    render(<Skills company={company} skillId="s1" />);
    const link = (await screen.findByText("pdf-read", { selector: "a span" })).closest("a")!;
    expect(link.getAttribute("aria-current")).toBe("page");
    expect(link.closest("details")!.open).toBe(true);
    expect(screen.queryByText("Pick a skill or a pack on the left, or add one.")).toBeNull();
    await waitFor(() => expect(scrolled.mock.contexts.map((el) => (el as Element).id)).toContain("skill-view"));
  });
});
