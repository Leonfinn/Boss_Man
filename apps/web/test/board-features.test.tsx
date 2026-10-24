// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { Board } from "../src/pages/Board";
import { Features } from "../src/pages/Features";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const company: Company = { id: "c1", name: "App Co", mission: null, paused: false, agents: [] };
const card = (over: Record<string, unknown>) => ({ systemState: "ready", outcome: null, assigneeAgentId: null, assignedToOwner: false, dueDate: null, blockedBy: [], branch: null, risk: null, planFirst: false, plan: null, planApprovedAt: null, ...over });
const feature = (over: Record<string, unknown> = {}) => ({
  id: "f1", companyId: "c1", areaId: null, parentId: null, title: "Dark mode", description: null, status: "in_progress", effort: null, driverScores: {}, milestoneId: null, portalVisible: false,
  createdAt: "2026-10-19T09:00:00Z", updatedAt: "2026-10-19T09:00:00Z", releasedAt: null, demand: 0, insightCount: 0, customerCount: 0, value: 0, demandPart: 0, priority: 0,
  tickets: { total: 2, done: 1, items: [{ id: "t1", title: "Build the toggle", state: "done", outcome: "completed", assignee: "Dev" }, { id: "t2", title: "Persist the choice", state: "in_progress", outcome: null, assignee: null }] },
  ...over,
});
const scored = { settings: { demandWeight: 1, ceoTriage: false }, drivers: [], maxDemand: 0, features: [feature()] };

function stub() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith("/projects")) return json([{ id: "p1", companyId: "c1", name: "App", repoUrl: null }]);
      if (url.endsWith("/board"))
        return json({
          project: { id: "p1", companyId: "c1", name: "App" },
          columns: [{ id: "col1", name: "Ready", systemState: "ready", wipLimit: null, tickets: [card({ id: "t1", title: "Build the toggle", featureId: "f1", featureTitle: "Dark mode", working: ["Developer"] }), card({ id: "t3", title: "Need infra", parentTitle: "Build the toggle", blockedBy: [{ ticketId: "t1", ticketTitle: "Build the toggle", engagementId: null, decisionId: null }] })] }],
        });
      if (url.endsWith("/features")) return json(scored);
      if (url.endsWith("/objectives")) return json([{ id: "o1", title: "Complete alpha build", milestones: [{ id: "m1", title: "Beta", targetDate: null }] }]);
      if (url.includes("/feedback-settings")) return json({ demandWeight: 1, ceoTriage: false, portalEnabled: false, portalToken: null, portalTitle: null, portalIntro: null, hasLogo: false, drivers: [], areas: [] });
      return json([]);
    }),
  );
}

describe("board", () => {
  it("shows a feature chip and the parent of a sub-task, and the filter switches views", async () => {
    stub();
    render(<Board companies={[company]} projectId="p1" go={() => {}} onCompaniesChanged={() => {}} />);
    const task = (await screen.findByText("Build the toggle", { selector: "h3 a" })).closest("article")!;
    expect(within(task).getByText("Dark mode")).toBeTruthy();
    expect(screen.getByText("Sub-task of Build the toggle")).toBeTruthy();
    expect(within(task).getByText("Task")).toBeTruthy();
    expect(within(screen.getByText("Need infra", { selector: "a" }).closest("article")!).getByText("Sub-task")).toBeTruthy();
    // A card an agent is running on says so.
    expect(within(task).getByRole("status").textContent).toBe("Developer working now");
    expect(task.className).toContain("live");
    // A blocked card links to the task it waits on.
    expect(within(screen.getByText("Need infra", { selector: "a" }).closest("article")!).getByRole("link", { name: "Build the toggle" }).getAttribute("href")).toBe("#/tickets/t1");
    // The chip names the feature in one line; its full title is the tooltip.
    expect(within(task).getByTitle("Dark mode")).toBeTruthy();
    // All shows the columns only: the feature cards would grow above them.
    expect(screen.queryByRole("progressbar")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Features" }));
    expect(screen.queryByText("Need infra")).toBeNull();
    expect(within(await screen.findByRole("article", { name: "Feature Dark mode" })).getByText("Feature")).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "Dark mode progress" })).toBeTruthy();
    expect(screen.getByText("1 of 2 tasks done")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Tasks" }));
    expect(screen.getByText("Need infra")).toBeTruthy();
    expect(screen.queryByRole("progressbar")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "All" }));
    expect(screen.getByText("Need infra")).toBeTruthy();
    expect(screen.queryByRole("progressbar")).toBeNull();
  });
});

describe("board lanes", () => {
  const columns = [
    { id: "c1", name: "Up next", systemState: "ready", wipLimit: null, tickets: [card({ id: "t1", title: "Mine to do", assignedToOwner: true }), card({ id: "t2", title: "Agent job", assigneeAgentId: "a1" })] },
    { id: "c2", name: "In progress", systemState: "in_progress", wipLimit: 3, tickets: [] },
  ];
  const withColumns = (puts: unknown[]) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "PUT") return puts.push([url, JSON.parse(String(init.body))]), json([]);
        if (url.endsWith("/projects")) return json([{ id: "p1", companyId: "c1", name: "App", repoUrl: null }]);
        if (url.endsWith("/board")) return json({ project: { id: "p1", companyId: "c1", name: "App" }, columns });
        if (url.endsWith("/features")) return json({ ...scored, features: [] });
        return json([]);
      }),
    );
  const dev = { id: "a1", name: "Senior Developer", role: "worker", agentKind: "claude" };

  it("renames a column with its pencil by sending the whole column list, and Escape cancels", async () => {
    const puts: unknown[] = [];
    withColumns(puts);
    render(<Board companies={[{ ...company, agents: [dev] } as unknown as Company]} projectId="p1" go={() => {}} onCompaniesChanged={() => {}} />);
    expect(await screen.findByText("Agents see:")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Rename the Up next column" }));
    fireEvent.keyDown(screen.getByLabelText("Column name"), { key: "Escape" });
    expect(screen.queryByLabelText("Column name")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Rename the Up next column" }));
    fireEvent.change(screen.getByLabelText("Column name"), { target: { value: "Soon" } });
    expect(screen.getByText("Agents still see")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual(["/api/projects/p1/columns", [{ name: "Soon", systemState: "ready", wipLimit: null }, { name: "In progress", systemState: "in_progress", wipLimit: 3 }]]);
  });

  it("splits review into agent review and your review, and flags what waits on the owner", async () => {
    columns.push({ id: "c3", name: "Review", systemState: "review", wipLimit: null, tickets: [card({ id: "t5", title: "Agent still reviewing", risk: "low" }), card({ id: "t6", title: "Needs your sign-off", risk: "high", waitingOnOwner: true, waitingDecisionId: "d1", approvedBy: "Senior Developer" })] });
    withColumns([]);
    render(<Board companies={[{ ...company, agents: [dev] } as unknown as Company]} projectId="p1" go={() => {}} onCompaniesChanged={() => {}} />);
    const strip = await screen.findByRole("link", { name: /1 task is waiting on you/ });
    expect(strip.textContent).toContain("Needs your sign-off");
    expect(strip.getAttribute("href")).toBe("#your-review");
    const agent = screen.getByRole("region", { name: "Agent review" });
    expect(within(agent).getByText("Agent still reviewing")).toBeTruthy();
    expect(within(agent).queryByText("Needs your sign-off")).toBeNull();
    const mine = screen.getByRole("region", { name: "Your review" });
    expect(mine.id).toBe("your-review");
    expect(within(mine).getByText("Senior Developer approved. Needs your sign-off to merge.")).toBeTruthy();
    expect(within(mine).getByRole("link", { name: "Review and approve" }).getAttribute("href")).toBe("#/tickets/t6");
    columns.pop();
  });

  it("filters cards by who they are assigned to", async () => {
    withColumns([]);
    render(<Board companies={[{ ...company, agents: [dev] } as unknown as Company]} projectId="p1" go={() => {}} onCompaniesChanged={() => {}} />);
    await screen.findByText("Mine to do");
    fireEvent.change(screen.getByLabelText("Assigned to"), { target: { value: "owner" } });
    expect(screen.queryByText("Agent job")).toBeNull();
    expect(screen.getByText("Mine to do")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Assigned to"), { target: { value: "a1" } });
    expect(screen.queryByText("Mine to do")).toBeNull();
    expect(screen.getByText("Agent job")).toBeTruthy();
  });
});

describe("new task form", () => {
  it("leaves the risk for the CEO to rate by default and posts no risk", async () => {
    const posts: unknown[] = [];
    stub();
    const base = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST" && url.endsWith("/tickets")) {
        posts.push(JSON.parse(String(init.body)));
        return json({ id: "t9" });
      }
      return base(url, init);
    }));
    render(<Board companies={[company]} projectId="p1" go={() => {}} onCompaniesChanged={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Add task" }));
    expect((screen.getByLabelText("Risk") as HTMLSelectElement).selectedOptions[0]!.textContent).toBe("Let the CEO rate it");
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Fix login" } });
    fireEvent.click(screen.getByRole("button", { name: "Add to backlog" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect((posts[0] as { risk: unknown }).risk ?? null).toBeNull();
  });
});

describe("add feature or task", () => {
  const ceoCompany: Company = { ...company, agents: [{ id: "a1", companyId: "c1", name: "Ada", role: "ceo", agentKind: "claude", model: null, fundingSourceId: null, paused: false, starred: false, duty: null }] };
  function record() {
    const posts: { url: string; body: Record<string, unknown> }[] = [];
    stub();
    const base = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        posts.push({ url, body: JSON.parse(String(init.body)) });
        return json({ id: "f9" });
      }
      return base(url, init);
    }));
    render(<Board companies={[ceoCompany]} projectId="p1" go={() => {}} onCompaniesChanged={() => {}} />);
    return posts;
  }

  it("creates a feature and, when asked, a Plan task for the CEO", async () => {
    const posts = record();
    fireEvent.click(await screen.findByRole("button", { name: "Add task" }));
    expect(screen.getByRole("radio", { name: "New feature" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "New task" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("radio", { name: "New feature" }));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Export" } });
    fireEvent.change(screen.getByLabelText("What problem does it solve, and for whom?"), { target: { value: "Accountants need CSV" } });
    expect((screen.getByLabelText("Ask the CEO to plan it") as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Add feature" }));
    expect(await screen.findByText("Feature added. The CEO will plan it and break it into tasks.")).toBeTruthy();
    expect(posts[0]).toMatchObject({ url: "/api/companies/c1/features", body: { title: "Export", description: "Accountants need CSV", status: "planned" } });
    expect(posts[1]).toMatchObject({ url: "/api/features/f9/tickets", body: { projectId: "p1", title: "Plan: Export", assigneeAgentId: "a1" } });
    expect(posts[1]!.body.risk ?? null).toBeNull();
  });

  it("links a new feature to an objective or one of its milestones", async () => {
    const posts = record();
    fireEvent.click(await screen.findByRole("button", { name: "Add task" }));
    fireEvent.click(screen.getByRole("radio", { name: "New feature" }));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Export" } });
    fireEvent.click(screen.getByLabelText("Ask the CEO to plan it"));
    await screen.findByRole("option", { name: "Complete alpha build (the whole objective)" });
    fireEvent.change(screen.getByLabelText("Objective or milestone"), { target: { value: "o:o1" } });
    fireEvent.click(screen.getByRole("button", { name: "Add feature" }));
    await screen.findByText("Feature added.");
    expect(posts[0]!.body).toMatchObject({ title: "Export", objectiveId: "o1", milestoneId: null });
  });

  it("creates only the feature when the CEO is not asked", async () => {
    const posts = record();
    fireEvent.click(await screen.findByRole("button", { name: "Add task" }));
    fireEvent.click(screen.getByRole("radio", { name: "New feature" }));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Export" } });
    fireEvent.click(screen.getByLabelText("Ask the CEO to plan it"));
    fireEvent.click(screen.getByRole("button", { name: "Add feature" }));
    expect(await screen.findByText("Feature added.")).toBeTruthy();
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body.status).toBe("idea");
  });

  it("opens New task with the feature preselected from a feature card", async () => {
    const posts = record();
    fireEvent.click(await screen.findByRole("button", { name: "Features" }));
    fireEvent.click(await screen.findByRole("button", { name: "Add task to Dark mode" }));
    expect(screen.getByRole("radio", { name: "New task" }).getAttribute("aria-checked")).toBe("true");
    expect((screen.getByLabelText("Part of feature") as HTMLSelectElement).value).toBe("f1");
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Add switch" } });
    fireEvent.click(screen.getByRole("button", { name: "Add to backlog" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({ url: "/api/projects/p1/tickets", body: { featureId: "f1", title: "Add switch" } });
  });
});

describe("features page", () => {
  it("lists each feature's tasks with state and assignee, and the progress count", async () => {
    stub();
    render(<Features companies={[company]} companyId="c1" featureId={undefined} go={() => {}} />);
    const list = await screen.findByRole("list", { name: "Tasks of Dark mode" });
    expect(within(list).getByText("Build the toggle")).toBeTruthy();
    expect(within(list).getByText("Dev")).toBeTruthy();
    expect(within(list).getByText("unassigned")).toBeTruthy();
    expect(within(list).getByText("in progress")).toBeTruthy();
    expect(screen.getByText("1/2 tasks")).toBeTruthy();
  });
});

describe("empty board columns", () => {
  it("shows one line of guidance in a column with no tasks", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/projects")) return json([{ id: "p1", companyId: "c1", name: "App", repoUrl: null }]);
        if (url.endsWith("/board"))
          return json({
            project: { id: "p1", companyId: "c1", name: "App" },
            columns: [
              { id: "b", name: "Backlog", systemState: "backlog", wipLimit: null, tickets: [] },
              { id: "r", name: "Ready", systemState: "ready", wipLimit: null, tickets: [card({ id: "t1", title: "Do it" })] },
            ],
          });
        return json([]);
      }),
    );
    render(<Board companies={[company]} projectId="p1" go={() => {}} onCompaniesChanged={() => {}} />);
    expect(await screen.findByText("Nothing waiting. Add a task to start.")).toBeTruthy();
    expect(screen.queryByText(/Nothing ready/)).toBeNull();
  });
});
