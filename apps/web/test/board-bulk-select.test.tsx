// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { Board, bulkSummary } from "../src/pages/Board";

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const company = { id: "c1", name: "App Co", mission: null, paused: false, ticketPrefix: "APP", agents: [{ id: "a1", name: "Developer" }] } as Company;
const card = (over: Record<string, unknown>) => ({ systemState: "ready", outcome: null, assigneeAgentId: null, assignedToOwner: false, dueDate: null, blockedBy: [], branch: null, risk: null, planFirst: false, plan: null, planApprovedAt: null, ...over });

/** reply is what the bulk route answers; bodies collects what the page sent it. */
function stub(reply: unknown, bodies: unknown[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/tickets/bulk" && init?.method === "POST") {
        bodies.push(JSON.parse(String(init.body)));
        return json(reply);
      }
      if (url.endsWith("/projects")) return json([{ id: "p1", companyId: "c1", name: "App", repoUrl: null }]);
      if (url.endsWith("/board"))
        return json({
          project: { id: "p1", companyId: "c1", name: "App" },
          columns: [
            {
              id: "col1", name: "Ready", systemState: "ready", wipLimit: null,
              tickets: [1, 2, 3, 4].map((n) => card({ id: `t${n}`, number: n, title: `Task ${n}` })),
            },
          ],
        });
      if (url.endsWith("/features")) return json({ settings: { demandWeight: 1, ceoTriage: false }, drivers: [], maxDemand: 0, features: [] });
      return json([]);
    }),
  );
}
const open = () => render(<Board companies={[company]} projectId="p1" go={() => {}} onCompaniesChanged={() => {}} />);
const box = (n: number) => screen.getByRole("checkbox", { name: `Select APP-${n}` }) as HTMLInputElement;

describe("bulkSummary", () => {
  it("names each refused ticket with its reason", () => {
    expect(bulkSummary(8, [{ ref: "APP-12", reason: "Nope" }, { ref: null, reason: "No such ticket." }], "moved")).toBe("8 moved, 2 refused: APP-12 (Nope), a ticket (No such ticket.)");
    expect(bulkSummary(3, [], "changed")).toBe("3 changed");
  });
});

describe("Board: Select mode", () => {
  it("shows checkboxes only after Select, counts them, and Shift-click takes a range", async () => {
    stub({ done: [], refused: [] }, []);
    open();
    await screen.findByText("Task 1");
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.click(box(1));
    expect(screen.getByText("1 selected")).toBeTruthy();
    fireEvent.click(box(3), { shiftKey: true });
    expect(screen.getByText("3 selected")).toBeTruthy();
    expect(box(2).checked).toBe(true);
    expect(box(4).checked).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.getByText("0 selected")).toBeTruthy();
  });

  it("sends the chosen tickets and shows what was moved and refused; refused ones stay selected", async () => {
    const bodies: unknown[] = [];
    stub({ done: [{ id: "t1", ref: "APP-1" }], refused: [{ id: "t2", ref: "APP-2", reason: "Waiting on a decision" }] }, bodies);
    open();
    await screen.findByText("Task 1");
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.click(box(1));
    fireEvent.click(box(2));
    fireEvent.click(screen.getByRole("button", { name: "Backlog" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("1 moved, 1 refused: APP-2 (Waiting on a decision)"));
    expect(bodies).toEqual([{ ids: ["t1", "t2"], action: { type: "move", state: "backlog" } }]);
    expect(screen.getByText("1 selected")).toBeTruthy();
  });

  it("sends an assign and a Priority 1 action", async () => {
    const bodies: unknown[] = [];
    stub({ done: [{ id: "t1", ref: "APP-1" }], refused: [] }, bodies);
    open();
    await screen.findByText("Task 1");
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.click(box(1));
    fireEvent.change(screen.getByLabelText("Assign to"), { target: { value: "a1" } });
    fireEvent.click(screen.getByRole("button", { name: "Assign" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("1 changed"));
    fireEvent.click(box(1));
    fireEvent.click(screen.getByRole("button", { name: "Priority 1 on" }));
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[0]).toEqual({ ids: ["t1"], action: { type: "assign", assigneeAgentId: "a1" } });
    expect(bodies[1]).toEqual({ ids: ["t1"], action: { type: "priority", on: true } });
  });

  it("offers no move to In progress, Review or Done", async () => {
    stub({ done: [], refused: [] }, []);
    open();
    await screen.findByText("Task 1");
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    const group = screen.getByRole("group", { name: "Move to" });
    expect(Array.from(group.querySelectorAll("button")).map((b) => b.textContent)).toEqual(["Backlog", "Ready", "Blocked"]);
  });
});
