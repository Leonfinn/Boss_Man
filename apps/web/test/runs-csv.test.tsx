// @vitest-environment jsdom
// BOS-2239: the Runs page's "Download CSV" exports the finished runs shown, and the shared helper quotes properly.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Company, RunRow } from "../src/api";
import { buildCsv } from "../src/csv";
import { Runs, runsToCsv } from "../src/pages/Runs";

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const companies = [{ id: "co-1", name: "App Co", agents: [] }] as unknown as Company[];
const run = (over: Partial<RunRow>): RunRow => ({
  id: "r1",
  companyId: "co-1",
  agent: "Engineer",
  agentId: "a-1",
  ticketId: null,
  ticket: null,
  model: null,
  startedAt: "2026-11-08T10:00:00Z",
  endedAt: "2026-11-08T12:00:00Z",
  outcome: "end_turn",
  costMicros: 1_234_500,
  ...over,
});

describe("buildCsv", () => {
  it("quotes commas, quotes and newlines and defuses formulas", () => {
    expect(buildCsv(["a", "b"], [['x,"y"', "l1\nl2"], ["=SUM(A1)", 3]])).toBe('a,b\r\n"x,""y""","l1\nl2"\r\n\'=SUM(A1),3\r\n');
  });
});

describe("runsToCsv", () => {
  it("writes ISO times, a numeric cost and the failure reason, with a ticket title containing a comma quoted", () => {
    const csv = runsToCsv([run({ ticketId: "t1", ticket: "Fix a, b", outcome: "error: boom" })], companies);
    const [head, line] = csv.split("\r\n");
    expect(head).toBe("ended,company,agent,what_for,woken_by,model,paid_from,result,cost_usd,input_tokens,output_tokens");
    expect(line).toBe('2026-11-08T12:00:00.000Z,App Co,Engineer,"Fix a, b",,default,none,Failed: boom,1.2345,,');
  });
});

describe("Download CSV button", () => {
  it("downloads the rows shown", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(url.startsWith("/api/runs/recent") ? [run({})] : []), { status: 200 })));
    let saved: Blob | null = null;
    URL.createObjectURL = ((b: Blob) => ((saved = b), "blob:x")) as typeof URL.createObjectURL;
    URL.revokeObjectURL = () => {};
    render(<Runs companies={companies} />);
    await screen.findByText("Engineer");
    fireEvent.click(screen.getByRole("button", { name: "Download CSV" }));
    expect(saved).not.toBeNull();
    expect(await (saved as unknown as Blob).text()).toContain("2026-11-08T12:00:00.000Z,App Co,Engineer");
  });
});
