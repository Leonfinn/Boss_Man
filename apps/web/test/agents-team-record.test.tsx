// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { Agents, readTeamSort, sortTeamRecords, type TeamRecordRow } from "../src/pages/Agents";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.location.hash = "";
});
beforeEach(() => {
  window.location.hash = "#/agents";
});

const company: Company = { id: "c-team", name: "App Co", mission: null, paused: false, agents: [] };
const base = { companyId: "c-team", role: "worker", agentKind: "claude", model: "opus", fundingSourceId: null, paused: false, starred: false, duty: null, title: "Engineer", template: null, instructions: "", funding: null, fundingKind: null, retiredAt: null, status: "idle", current: null, openTickets: 0, pa: null, month: { costMicros: 0, runs: 0, tokens: 0 } };
const rec = (agentId: string, name: string, o: Partial<TeamRecordRow> = {}): TeamRecordRow => ({ agentId, name, finished: 0, runs: 0, failedRuns: 0, passedFirstTime: 0, sendBacks: 0, medianMergeMs: null, costPerFinishedMicros: null, ...o });
const team = [
  rec("t1", "Alpha", { finished: 4, runs: 20, failedRuns: 1, passedFirstTime: 3, sendBacks: 1, medianMergeMs: 7_200_000, costPerFinishedMicros: 2_500_000 }),
  rec("t2", "Beta", { finished: 2, runs: 10, failedRuns: 5, sendBacks: 4, medianMergeMs: 3_600_000, costPerFinishedMicros: 9_000_000 }),
  rec("t3", "Gamma"),
];
const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });

function stub() {
  const fetchMock = vi.fn(async (url: string) => {
    if (url.includes("agent-records")) return json({ days: 30, agents: team });
    if (url.includes("agent-templates")) return json({ templates: [] });
    if (url.includes("/models")) return json({ runner: {}, api: [] });
    if (url.includes("/agents")) return json(team.map((t) => ({ ...base, id: t.agentId, name: t.name })));
    return json([]);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
const order = () => within(screen.getByTestId("team-record")).getAllByRole("link", { name: /^(Alpha|Beta|Gamma)$/ }).map((a) => a.textContent);

describe("sorting the team record (BOS-2504)", () => {
  it("puts agents with no figure last, whichever way it is sorted", () => {
    expect(sortTeamRecords(team, "failedShare", false).map((r) => r.name)).toEqual(["Beta", "Alpha", "Gamma"]);
    expect(sortTeamRecords(team, "failedShare", true).map((r) => r.name)).toEqual(["Alpha", "Beta", "Gamma"]);
    expect(sortTeamRecords(team, "costPerFinished", false).map((r) => r.name)).toEqual(["Beta", "Alpha", "Gamma"]);
    expect(sortTeamRecords(team, "name", true).map((r) => r.name)).toEqual(["Alpha", "Beta", "Gamma"]);
  });
  it("reads the sort from the link, names A to Z and figures highest first", () => {
    expect(readTeamSort(new URLSearchParams(""))).toEqual({ sort: "name", asc: true });
    expect(readTeamSort(new URLSearchParams("recordSort=failedShare"))).toEqual({ sort: "failedShare", asc: false });
    expect(readTeamSort(new URLSearchParams("recordSort=sendBacks&recordDir=asc"))).toEqual({ sort: "sendBacks", asc: true });
    expect(readTeamSort(new URLSearchParams("recordSort=bogus"))).toEqual({ sort: "name", asc: true });
  });
});

describe("Team record fold on the Agents page (BOS-2504)", () => {
  it("loads only when opened, then sorts by a header, reverses on a second click and keeps the sort in the link", async () => {
    const f = stub();
    render(<Agents company={company} onChanged={() => {}} />);
    await screen.findByRole("button", { name: "Alpha" });
    expect(f.mock.calls.some(([u]) => String(u).includes("agent-records"))).toBe(false);
    fireEvent.click(screen.getByText("Team record, last 30 days"));
    await screen.findByTestId("team-record");
    expect(order()).toEqual(["Alpha", "Beta", "Gamma"]);
    expect(within(screen.getByTestId("team-record")).getByText("20")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Send-backs" }));
    expect(order()).toEqual(["Beta", "Alpha", "Gamma"]);
    expect(window.location.hash).toContain("recordSort=sendBacks");
    fireEvent.click(screen.getByRole("button", { name: /Send-backs/ }));
    expect(order()).toEqual(["Gamma", "Alpha", "Beta"]);
    expect(window.location.hash).toContain("recordDir=asc");
  });

  it("shows 0s and dashes for an agent with no runs, and links Failed to the Runs page filter", async () => {
    stub();
    render(<Agents company={company} onChanged={() => {}} />);
    await screen.findByRole("button", { name: "Alpha" });
    fireEvent.click(screen.getByText("Team record, last 30 days"));
    const table = await screen.findByTestId("team-record");
    const gamma = within(table).getByRole("link", { name: "Gamma" }).closest("tr")!;
    expect(gamma.textContent).toContain("0 failed (0%)");
    expect(within(gamma).getAllByText("–")).toHaveLength(2);
    const failed = within(table).getByRole("link", { name: "5 failed" });
    expect(failed.getAttribute("href")).toBe("#/runs?result=failed");
    expect(within(table).getByRole("link", { name: "Beta" }).getAttribute("href")).toBe("#/agents/t2");
  });

  it("opens already sorted from a shared link", async () => {
    window.location.hash = "#/agents?recordSort=failedShare";
    stub();
    render(<Agents company={company} onChanged={() => {}} />);
    await screen.findByTestId("team-record");
    expect(order()).toEqual(["Beta", "Alpha", "Gamma"]);
  });
});
