// @vitest-environment jsdom
// BOS-1888: the Runs page's Finished list can be filtered by company, agent and result (kept across a reload),
// and "Show more" loads runs older than the 50 shown.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Company, RunRow } from "../src/api";
import { Runs } from "../src/pages/Runs";

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const agent = (id: string, name: string, companyId: string) => ({ id, name, companyId });
const companies = [
  { id: "co-1", name: "App Co", agents: [agent("a-1", "Engineer", "co-1")] },
  { id: "co-2", name: "Shop Co", agents: [agent("a-2", "Packer", "co-2")] },
] as unknown as Company[];

const run = (n: number): RunRow => ({
  id: `run-${n}`,
  companyId: "co-1",
  agent: "Engineer",
  agentId: "a-1",
  ticketId: null,
  ticket: null,
  model: null,
  startedAt: "2026-11-08T10:00:00Z",
  endedAt: new Date(Date.UTC(2026, 10, 8, 12) - n * 60_000).toISOString(),
  outcome: "end_turn",
});

function stub(recent: (url: string) => RunRow[]) {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.startsWith("/api/runs/recent")) {
        urls.push(url);
        return json(recent(url));
      }
      return json([]);
    }),
  );
  return urls;
}

describe("Runs page filters and Show more (BOS-1888)", () => {
  it("asks the server for the chosen company, agent and result, and keeps them after a reload", async () => {
    const urls = stub(() => []);
    const first = render(<Runs companies={companies} />);
    fireEvent.click(await screen.findByRole("button", { name: "Shop Co" }));
    fireEvent.click(await screen.findByRole("button", { name: "Packer" }));
    fireEvent.click(screen.getByRole("button", { name: "Failed" }));
    await waitFor(() => expect(urls.at(-1)).toBe("/api/runs/recent?limit=50&companyId=co-2&agentId=a-2&result=failed"));
    expect(await screen.findByText("No finished runs match these filters.")).toBeTruthy();
    first.unmount();
    render(<Runs companies={companies} />);
    expect((await screen.findByRole("button", { name: "Failed" })).getAttribute("aria-pressed")).toBe("true");
    await waitFor(() => expect(urls.at(-1)).toBe("/api/runs/recent?limit=50&companyId=co-2&agentId=a-2&result=failed"));
  });

  it("Show more loads runs older than the oldest shown, and goes away when there are no more", async () => {
    const page1 = Array.from({ length: 50 }, (_, i) => run(i));
    const page2 = [run(50), run(51)];
    const urls = stub((url) => (url.includes("before=") ? page2 : page1));
    render(<Runs companies={companies} />);
    fireEvent.click(await screen.findByRole("button", { name: "Show more" }));
    await waitFor(() => expect(document.querySelectorAll("tbody tr").length).toBe(52));
    expect(urls.some((u) => u.includes(`before=${encodeURIComponent(page1[49]!.endedAt!)}`))).toBe(true);
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
  });

  it("shows no Show more when fewer than a page came back", async () => {
    stub(() => [run(1), run(2)]);
    render(<Runs companies={companies} />);
    await waitFor(() => expect(document.querySelectorAll("tbody tr").length).toBe(2));
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
  });
});
