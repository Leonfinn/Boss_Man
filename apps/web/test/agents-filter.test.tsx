// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { Agents } from "../src/pages/Agents";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const company: Company = { id: "c-filter", name: "App Co", mission: null, paused: false, agents: [] };
const base = { companyId: "c-filter", role: "worker", agentKind: "claude", model: "opus", fundingSourceId: null, paused: false, starred: false, duty: null, title: "Engineer", template: null, instructions: "", funding: null, fundingKind: null, retiredAt: null, status: "idle", current: null, openTickets: 0, pa: null, month: { costMicros: 0, runs: 2, tokens: 10 } };
const agents = [
  { ...base, id: "f1", name: "Alpha" },
  { ...base, id: "f2", name: "Beta", title: "Designer", model: "sonnet" },
  { ...base, id: "f3", name: "Gamma" },
];
const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });

function stub() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("agent-templates")) return json({ templates: [] });
      if (url.includes("/models")) return json({ runner: {}, api: [] });
      if (url.includes("/agents")) return json(agents);
      return json([]);
    }),
  );
}

const names = () => ["Alpha", "Beta", "Gamma"].filter((n) => screen.queryByRole("button", { name: n }));

describe("Agents filter box (BOS-2310)", () => {
  it("narrows by name, role word and model, ignoring case", async () => {
    stub();
    render(<Agents company={company} onChanged={() => {}} />);
    const box = (await screen.findByRole("searchbox", { name: "Filter agents" })) as HTMLInputElement;
    await screen.findByRole("button", { name: "Alpha" });
    expect(names()).toEqual(["Alpha", "Beta", "Gamma"]);
    fireEvent.change(box, { target: { value: "bet" } });
    expect(names()).toEqual(["Beta"]);
    fireEvent.change(box, { target: { value: "DESIGNER" } });
    expect(names()).toEqual(["Beta"]);
    fireEvent.change(box, { target: { value: "sonnet" } });
    expect(names()).toEqual(["Beta"]);
    fireEvent.change(box, { target: { value: "worker opus" } });
    expect(names()).toEqual(["Alpha", "Gamma"]);
  });

  it("says nothing matches and Clear search brings the list back", async () => {
    stub();
    render(<Agents company={company} onChanged={() => {}} />);
    const box = (await screen.findByRole("searchbox", { name: "Filter agents" })) as HTMLInputElement;
    await screen.findByRole("button", { name: "Alpha" });
    fireEvent.change(box, { target: { value: "zzz" } });
    expect(screen.getByText(/No agents match "zzz"\./)).toBeTruthy();
    expect(names()).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(box.value).toBe("");
    expect(names()).toEqual(["Alpha", "Beta", "Gamma"]);
  });
});
