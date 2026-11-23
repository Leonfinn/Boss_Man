// @vitest-environment jsdom
// BOS-2311: the Agents page's "Download CSV" exports the agents listed (after the filter), funding by name only.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { Agents, agentsToCsv, type AgentRow } from "../src/pages/Agents";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const company: Company = { id: "c-csv", name: "App Co", mission: null, paused: false, agents: [] };
const base = { companyId: "c-csv", role: "worker", agentKind: "claude", model: "opus", thinking: null, fundingSourceId: "s1", paused: false, starred: false, duty: null, title: "Engineer", template: null, instructions: "", funding: "Team plan", fundingKind: "subscription", retiredAt: null, status: "idle", current: null, openTickets: 0, pa: null, month: { costMicros: 0, runs: 0, tokens: 0 } };
const agents = [
  { ...base, id: "a1", name: "Alpha", workingHours: { days: [1, 2], start: "09:00", end: "17:00", timeZone: "Europe/London" } },
  { ...base, id: "a2", name: "=Beta, Jr", title: "Designer", model: null, funding: null, status: "paused" },
] as unknown as AgentRow[];
const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });

describe("agentsToCsv", () => {
  it("writes one line per agent with funding by name and working hours", () => {
    const lines = agentsToCsv(agents).split("\r\n");
    expect(lines[0]).toBe("name,role,job_title,model,thinking,funding_source,state,working_days,working_from,working_to,working_time_zone");
    expect(lines[1]).toBe("Alpha,worker,Engineer,opus,,Team plan,idle,Mon Tue,09:00,17:00,Europe/London");
    expect(lines[2]).toBe('"\'=Beta, Jr",worker,Designer,default,,,paused,,,,');
  });
});

describe("Download CSV button", () => {
  it("downloads only the agents the filter shows", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("agent-templates")) return json({ templates: [] });
        if (url.includes("/models")) return json({ runner: {}, api: [] });
        if (url.includes("/agents")) return json(agents);
        return json([]);
      }),
    );
    const saved: Blob[] = [];
    URL.createObjectURL = ((b: Blob) => (saved.push(b), "blob:x")) as typeof URL.createObjectURL;
    URL.revokeObjectURL = () => {};
    render(<Agents company={company} onChanged={() => {}} />);
    const box = await screen.findByRole("searchbox", { name: "Filter agents" });
    fireEvent.change(box, { target: { value: "alpha" } });
    fireEvent.click(screen.getByRole("button", { name: "Download CSV" }));
    const text = await saved[0]!.text();
    expect(text).toContain("Alpha");
    expect(text).not.toContain("Beta");
  });
});
