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

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const company: Company = { id: "c1", name: "App Co", mission: null, paused: false, agents: [{ id: "a1", name: "Developer" }] } as Company;
const card = (over: Record<string, unknown>) => ({ systemState: "ready", outcome: null, assigneeAgentId: null, assignedToOwner: false, dueDate: null, blockedBy: [], branch: null, risk: null, planFirst: false, plan: null, planApprovedAt: null, ...over });

/** runNow decides what the run-now POST does; posts counts the requests that arrived. */
function stub(runNow: () => Promise<Response>, posts: string[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/tickets/t1/run-now" && init?.method === "POST") {
        posts.push(url);
        return runNow();
      }
      if (url.endsWith("/projects")) return json([{ id: "p1", companyId: "c1", name: "App", repoUrl: null }]);
      if (url.endsWith("/board"))
        return json({
          project: { id: "p1", companyId: "c1", name: "App" },
          columns: [
            {
              id: "col1", name: "Ready", systemState: "ready", wipLimit: null,
              tickets: [
                card({ id: "t1", title: "Held task", quotaHeldUntil: "2026-11-21T10:00:00.000Z", quotaHeldReason: "subscription 5-hour window nearly used up", assigneeAgentId: "a1" }),
                card({ id: "t2", title: "Other task" }),
              ],
            },
          ],
        });
      if (url.endsWith("/features")) return json({ settings: { demandWeight: 1, ceoTriage: false }, drivers: [], maxDemand: 0, features: [] });
      return json([]);
    }),
  );
}
const open = () => render(<Board companies={[company]} projectId="p1" go={() => {}} onCompaniesChanged={() => {}} />);

describe("Board: Run now on a held card", () => {
  it("is disabled while the request is out, so a second click sends nothing", async () => {
    const posts: string[] = [];
    let finish: (r: Response) => void = () => {};
    stub(() => new Promise<Response>((res) => (finish = res)), posts);
    open();
    const button = await screen.findByRole("button", { name: "Run now" });
    fireEvent.click(button);
    await waitFor(() => expect((screen.getByRole("button", { name: "Run now" }) as HTMLButtonElement).disabled).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Run now" }));
    expect(posts).toHaveLength(1);
    finish(json({ released: 1 }));
    await waitFor(() => expect((screen.getByRole("button", { name: "Run now" }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows a plain alert on the card when it fails, and the button works again", async () => {
    const posts: string[] = [];
    stub(async () => json({ error: "Nothing to release" }, 409), posts);
    open();
    fireEvent.click(await screen.findByRole("button", { name: "Run now" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/Couldn't start this now/);
    expect((screen.getByRole("button", { name: "Run now" }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("Board: view and Assigned to survive a reload", () => {
  it("saves both with the other filters and reads them back", async () => {
    stub(async () => json({}), []);
    open();
    await screen.findByText("Held task", { selector: "h3 a" });
    fireEvent.click(screen.getByRole("button", { name: "Filter" }));
    fireEvent.change(screen.getByLabelText("Assigned to"), { target: { value: "a1" } });
    cleanup();
    open();
    await screen.findByText("Held task", { selector: "h3 a" });
    expect(screen.queryByText("Other task", { selector: "h3 a" })).toBeNull();
    expect(screen.getByText("Assigned: Developer", { selector: ".filter-chip span" })).toBeTruthy();
    expect(JSON.parse(sessionStorage.getItem("board-filters")!)).toMatchObject({ assignee: "a1", view: "all" });
  });

  it("falls back to Show all and Anyone when the saved values are junk", async () => {
    sessionStorage.setItem("board-filters", JSON.stringify({ feature: "any", working: false, view: 7, assignee: "" }));
    stub(async () => json({}), []);
    open();
    await screen.findByText("Other task", { selector: "h3 a" });
    expect(screen.getByRole("button", { name: "Filter" })).toBeTruthy();
  });
});
