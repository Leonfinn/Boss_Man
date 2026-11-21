// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { Board } from "../src/pages/Board";

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const company: Company = { id: "c1", name: "App Co", mission: null, paused: false, agents: [{ id: "a1", name: "Developer" }] } as Company;
const done = (n: number) => ({ id: `d${n}`, title: `Finished job ${n}`, systemState: "done", outcome: "merged", assigneeAgentId: null, assignedToOwner: false, dueDate: null, blockedBy: [], branch: null, risk: null, planFirst: false, plan: null, planApprovedAt: null, lastActivityAt: "2026-10-19T09:00:00Z", featureId: null, featureTitle: null });

// 120 done tickets exist; the plain request sends the newest 50, ?done=all sends all 120.
const TOTAL = 120;
function stub() {
  const boardUrls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith("/projects")) return json([{ id: "p1", companyId: "c1", name: "App", repoUrl: null }]);
      if (url.includes("/board")) {
        boardUrls.push(url);
        const all = url.includes("done=all");
        const rows = Array.from({ length: all ? TOTAL : 50 }, (_, i) => done(i + 1));
        return json({
          project: { id: "p1", companyId: "c1", name: "App" },
          doneTotal: TOTAL,
          columns: [{ id: "colD", name: "Done", systemState: "done", wipLimit: null, tickets: rows }],
        });
      }
      if (url.endsWith("/features")) return json({ settings: { demandWeight: 1, ceoTriage: false }, drivers: [], maxDemand: 0, features: [] });
      return json([]);
    }),
  );
  return boardUrls;
}
const open = () => render(<Board companies={[company]} projectId="p1" go={() => {}} onCompaniesChanged={() => {}} />);
const lastUrl = (urls: string[]) => urls[urls.length - 1]!;

describe("board done lane with a done count (BOS-2166)", () => {
  it("shows the full done count, and Show all done tasks asks for ?done=all and lists every one", async () => {
    const urls = stub();
    open();
    const button = await screen.findByRole("button", { name: `Show all done tasks (${TOTAL})` });
    expect(screen.getByRole("heading", { name: "Done" }).parentElement!.textContent).toContain(String(TOTAL));
    expect(urls.every((u) => !u.includes("done=all"))).toBe(true);
    fireEvent.click(button);
    await waitFor(() => expect(lastUrl(urls)).toContain("?done=all"));
    await screen.findByText("Finished job 120");
    expect(document.querySelectorAll(".done-list li").length).toBe(TOTAL);
    // Back to fewer: the plain request again.
    fireEvent.click(screen.getByRole("button", { name: "Show fewer" }));
    await waitFor(() => expect(lastUrl(urls)).not.toContain("done=all"));
  });

  it("searching asks for ?done=all so an old done ticket is found, and clearing drops back to the plain request", async () => {
    const urls = stub();
    open();
    await screen.findByRole("button", { name: `Show all done tasks (${TOTAL})` });
    expect(screen.queryByText("Finished job 120")).toBeNull();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search tasks" }), { target: { value: "Finished job 120" } });
    await waitFor(() => expect(lastUrl(urls)).toContain("?done=all"));
    await screen.findByText("Finished job 120");
    fireEvent.change(screen.getByRole("searchbox", { name: "Search tasks" }), { target: { value: "" } });
    await waitFor(() => expect(lastUrl(urls)).not.toContain("done=all"));
  });
});
