// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SelfDeploy } from "../src/pages/Settings";

// BOS-2277: "Recent updates" shows the newest 5 and loads 10 older ones per "Show older" press. Only the newest
// page can be swapping or waiting (BOS-2056), and a history reply that is not a list must not crash the page.

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
const id = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
// Row 0 is the newest. Even rows are runner rebuilds that went in, odd rows are server updates that went live.
const row = (i: number) => ({ id: id(i), target: i % 2 === 0 ? "runner" : "server", commit: "abcdef0", changes: 1, result: "deployed", message: null, at: new Date(Date.UTC(2026, 10, 20) - i * 3_600_000).toISOString() });
const ALL = Array.from({ length: 20 }, (_, i) => row(i));

const view = {
  enabled: true,
  pending: false,
  status: null,
  available: { tip: "aaaaaaa1", deployed: "aaaaaaa1", checkedAt: new Date().toISOString(), commits: [] },
  deployer: { reportedAt: new Date().toISOString(), late: false },
};
// A runner update's hold is on: the newest runner row is mid-swap.
const swapping = { on: true, kind: "update", reason: "runner update", since: new Date().toISOString(), deadline: new Date(Date.now() + 600_000).toISOString(), runs: 1, companies: 1, chatOpen: true, last: null };

function mount(history: (url: URL) => unknown) {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const url = new URL(String(input), "http://x");
      if (url.pathname === "/api/self-deploy/history") {
        urls.push(url.pathname + url.search);
        return json(history(url));
      }
      if (url.pathname === "/api/self-deploy") return json(view);
      if (url.pathname === "/api/maintenance") return json(swapping);
      if (url.pathname === "/api/self-deploy/wait") return json({ on: false });
      if (url.pathname === "/api/runner-report") return json({ live: [], update: null });
      return json({ ok: true });
    }),
  );
  render(<SelfDeploy go={() => {}} />);
  return urls;
}
const rows = () => [...screen.getByTestId("recent-updates").querySelectorAll("li.upd-row")];

describe("Recent updates: Show older", () => {
  it("loads 10 older rows per press, hides the button on a short page, and keeps older runner rows out of Swapping", async () => {
    const urls = mount((url) => {
      const before = url.searchParams.get("before");
      const from = before ? ALL.findIndex((r) => r.id === before) + 1 : 0;
      return ALL.slice(from, from + Number(url.searchParams.get("limit")));
    });
    await vi.waitFor(() => expect(rows()).toHaveLength(5));
    expect(urls[0]).toBe("/api/self-deploy/history?limit=5");
    expect(rows()[0]!.textContent).toContain("Swapping");
    fireEvent.click(await screen.findByText("Show older"));
    await vi.waitFor(() => expect(rows()).toHaveLength(15));
    expect(urls.at(-1)).toBe(`/api/self-deploy/history?limit=10&before=${id(4)}`);
    // A full page of 10: the button stays. Rows 6, 8, 10... are older runner rows and must read Done.
    expect(screen.queryByText("Show older")).not.toBeNull();
    const text = rows().map((r) => r.textContent ?? "");
    expect(text.filter((t) => t.includes("Swapping"))).toHaveLength(1);
    expect(text.filter((t) => t.includes("Waiting"))).toHaveLength(0);
    expect(text.slice(5).filter((t) => t.includes("Runners, all companies") && t.includes("Done"))).toHaveLength(5);
    fireEvent.click(screen.getByText("Show older"));
    await vi.waitFor(() => expect(rows()).toHaveLength(20));
    expect(urls.at(-1)).toBe(`/api/self-deploy/history?limit=10&before=${id(14)}`);
    expect(screen.queryByText("Show older")).toBeNull();
  });

  it("offers no Show older when the first page is not full", async () => {
    mount(() => ALL.slice(0, 3));
    await vi.waitFor(() => expect(rows()).toHaveLength(3));
    expect(screen.queryByText("Show older")).toBeNull();
  });

  it("a history reply that is not a list leaves the page rendering", async () => {
    mount(() => ({ error: "nope" }));
    expect(await screen.findByText("Recent updates")).toBeTruthy();
    // The reply is read as "no rows yet": the panel stays up (still on "Checking…") with no rows and no button.
    await screen.findByText("Checking…");
    expect(rows()).toHaveLength(0);
    expect(screen.queryByText("Show older")).toBeNull();
  });
});
