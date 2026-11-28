// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OWNER_MESSAGE_MAX } from "@boss-man/shared";
import type { Company } from "../src/api";
import { Board } from "../src/pages/Board";
import { Features } from "../src/pages/Features";

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  localStorage.clear();
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
          columns: [{ id: "col1", name: "Ready", systemState: "ready", wipLimit: null, tickets: [card({ id: "t1", title: "Build the toggle", featureId: "f1", featureTitle: "Dark mode", working: ["Developer working"] }), card({ id: "t3", title: "Need infra", parentTitle: "Build the toggle", blockedBy: [{ ticketId: "t1", ticketTitle: "Build the toggle", engagementId: null, decisionId: null }] })] }],
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
    expect(within(task).getByRole("status").textContent).toBe("Developer working");
    expect(task.className).toContain("live");
    // A blocked card links to the task it waits on.
    expect(within(screen.getByText("Need infra", { selector: "a" }).closest("article")!).getByRole("link", { name: "Build the toggle" }).getAttribute("href")).toBe("#/tickets/t1");
    // The chip names the feature in one line; its full title is the tooltip.
    expect(within(task).getByTitle("Dark mode")).toBeTruthy();
    // All shows the columns only: the feature cards would grow above them.
    expect(screen.queryByRole("progressbar")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Filter" }));
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

describe("feature state toggles", () => {
  it("shows every state but Declined at first, toggles each state, and keeps the choice", async () => {
    sessionStorage.clear();
    stub();
    const base = globalThis.fetch;
    const list = [feature(), feature({ id: "f2", title: "Export", status: "released" }), feature({ id: "f3", title: "Old idea", status: "declined" })];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => (url.endsWith("/features") ? json({ ...scored, features: list }) : base(url, init))));
    const { unmount } = render(<Board companies={[company]} projectId="p1" go={() => {}} onCompaniesChanged={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Filter" }));
    fireEvent.click(await screen.findByRole("button", { name: "Features" }));
    await screen.findByRole("article", { name: "Feature Dark mode" });
    expect(screen.getByRole("article", { name: "Feature Export" })).toBeTruthy();
    expect(screen.queryByRole("article", { name: "Feature Old idea" })).toBeNull();
    const released = screen.getByRole("button", { name: "Released (1)" });
    expect(released.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Declined (1)" }).getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(screen.getByRole("button", { name: "In progress (1)" }));
    expect(screen.queryByRole("article", { name: "Feature Dark mode" })).toBeNull();
    expect(screen.getByRole("article", { name: "Feature Export" })).toBeTruthy();
    fireEvent.click(released);
    expect(screen.getByText(/No features in the states you have switched on/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Declined (1)" }));
    expect(screen.getByRole("article", { name: "Feature Old idea" })).toBeTruthy();

    unmount();
    render(<Board companies={[company]} projectId="p1" go={() => {}} onCompaniesChanged={() => {}} />);
    // The view is now saved with the other filters, so the Features view is already on after a reload.
    expect(await screen.findByRole("article", { name: "Feature Old idea" })).toBeTruthy();
    expect(screen.queryByRole("article", { name: "Feature Export" })).toBeNull();
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

  it("splits review into awaiting review, approved and merging, and your review, and flags what waits on the owner", async () => {
    columns.push({ id: "c3", name: "Review", systemState: "review", wipLimit: null, tickets: [card({ id: "t5", title: "Agent still reviewing", risk: "low", reviewStage: "awaiting_review" }), card({ id: "t8", title: "Approved, in the merge line", reviewStage: "merging", mergeNote: "Waiting for a check slot." }), card({ id: "t6", title: "Needs your sign-off", risk: "high", waitingOnOwner: true, waitingDecisionId: "d1", approvedBy: "Senior Developer" }), card({ id: "t7", title: "Nobody else can review", waitingOnOwner: true, noReviewer: true })] });
    withColumns([]);
    render(<Board companies={[{ ...company, agents: [dev] } as unknown as Company]} projectId="p1" go={() => {}} onCompaniesChanged={() => {}} />);
    const strip = await screen.findByRole("link", { name: /2 tasks are waiting on you/ });
    expect(strip.textContent).toContain("Needs your sign-off");
    expect(strip.getAttribute("href")).toBe("#your-review");
    const agent = screen.getByRole("region", { name: "Awaiting review" });
    expect(within(agent).getByText("Agent still reviewing")).toBeTruthy();
    expect(within(agent).queryByText("Needs your sign-off")).toBeNull();
    // BOS-667: approved work only waiting to merge is in its own lane, not counted as awaiting review.
    expect(within(agent).queryByText("Approved, in the merge line")).toBeNull();
    const merging = screen.getByRole("region", { name: "Approved, merging" });
    expect(within(merging).getByText("Approved, in the merge line")).toBeTruthy();
    expect(within(merging).getByText("Waiting for a check slot.")).toBeTruthy();
    expect(within(merging).getByRole("link", { name: "See the merge queue" }).getAttribute("href")).toBe("#/merge-queue/c1");
    expect(within(merging).queryByText("Agent still reviewing")).toBeNull();
    const mine = screen.getByRole("region", { name: "Your review" });
    expect(mine.id).toBe("your-review");
    expect(within(mine).getByText("Senior Developer approved. Needs your sign-off to merge.")).toBeTruthy();
    expect(within(mine).getAllByRole("link", { name: "Review and approve" })[0]!.getAttribute("href")).toBe("#/tickets/t6");
    expect(within(mine).getByText("No agent can review this. Open it to approve or send it back.")).toBeTruthy();
    columns.pop();
  });

  // BOS-1565: approved tickets Boss Man holds until another ticket is live sat in a "Passed, held" lane off screen,
  // while "Approved, merging" said 0 and gave no pointer.
  it("says what held approved tickets wait for, and points to them from the empty merging lane", async () => {
    const hold = { id: "h1", system: true, reason: "x", reviewer: null, releaseAt: null, ready: false, label: "waits on BOS-1557", waits: [] };
    columns.push({ id: "c3", name: "Review", systemState: "review", wipLimit: null, tickets: [card({ id: "t10", title: "Held by Boss Man", reviewStage: "held", hold })] });
    withColumns([]);
    render(<Board companies={[{ ...company, agents: [dev] } as unknown as Company]} projectId="p1" go={() => {}} onCompaniesChanged={() => {}} />);
    const merging = await screen.findByRole("region", { name: "Approved, merging" });
    expect(within(merging).getByText(/Nothing is merging right now\. 1 approved task is held/)).toBeTruthy();
    const held = screen.getByRole("region", { name: "Passed, held" });
    expect(within(held).getByText(/the merge waits on another ticket to be merged and live/)).toBeTruthy();
    expect(within(held).getByTestId("board-held-note").textContent).toBe("Approved. Boss Man holds the merge: waits on BOS-1557. It merges by itself afterwards.");
    columns.pop();
  });

  // BOS-1636: merged work in Blocked that only waits for its live check has its own lane and says what it waits for.
  it("puts merged tickets waiting for a live check in their own Blocked sub-lane", async () => {
    columns.push({
      id: "c4",
      name: "Blocked",
      systemState: "blocked",
      wipLimit: null,
      tickets: [
        card({ id: "t20", title: "Really stuck", systemState: "blocked" }),
        card({ id: "t21", title: "Waits for server", systemState: "blocked", mergeCommit: "a".repeat(40), goLiveNote: { text: "Merged. Waiting to go live: the server update.", cardId: "d1" } }),
        card({ id: "t22", title: "Waits for report", systemState: "blocked", mergeCommit: "b".repeat(40) }),
        card({ id: "t23", title: "Waits for owner", systemState: "blocked", mergeCommit: "c".repeat(40), ownerQuestionId: "d9" }),
        // BOS-1907: a split-out check ticket joins through its parent; a recorded watch shows its line and end date.
        card({ id: "t24", title: "Check ticket", systemState: "blocked", checksParentMerged: true }),
        card({ id: "t25", title: "Watches a week", systemState: "blocked", mergeCommit: "d".repeat(40), watchingFor: "a week of real use", watchEndsAt: "2026-12-03T00:00:00.000Z", watchUntil: "2026-12-03T00:00:00.000Z" }),
      ],
    });
    // An older merged ticket still in In progress shows in the same lane, not in In progress (criterion 7).
    columns.push({ id: "c2", name: "In progress", systemState: "in_progress", wipLimit: null, tickets: [card({ id: "t26", title: "Old merged row", systemState: "in_progress", mergeCommit: "e".repeat(40), watchEndsAt: "2026-12-03T00:00:00.000Z" })] });
    withColumns([]);
    render(<Board companies={[{ ...company, agents: [dev] } as unknown as Company]} projectId="p1" go={() => {}} onCompaniesChanged={() => {}} />);
    const lane = await screen.findByRole("region", { name: "Merged, watching" });
    // BOS-1909: a parked lane shows 4 cards, then "Show N more" (6 cards here).
    fireEvent.click(within(lane).getByRole("button", { name: "Show 2 more" }));
    expect(within(lane).getByText("Check ticket")).toBeTruthy();
    expect(within(lane).getByText("Old merged row")).toBeTruthy();
    expect(within(lane).getByText(/Watching for: a week of real use · until /)).toBeTruthy();
    expect(within(lane).getByText("Waits for server")).toBeTruthy();
    expect(within(lane).getByText("Merged. Waiting to go live: the server update.")).toBeTruthy();
    expect(within(lane).getAllByText(/Waiting for the agent to report the after-merge check/).length).toBeGreaterThan(0);
    expect(within(lane).getAllByRole("link", { name: "Open the card" }).map((a) => a.getAttribute("href")).sort()).toEqual(["#/decisions/d1", "#/decisions/d9"]);
    expect(within(lane).queryByText("Really stuck")).toBeNull();
    const blocked = screen.getByRole("region", { name: "Blocked" });
    expect(within(blocked).getByText("Really stuck")).toBeTruthy();
    expect(within(blocked).queryByText("Waits for report")).toBeNull();
    columns.pop();
    columns.pop();
  });

  it("keeps the plain empty text when nothing is held or merging", async () => {
    columns.push({ id: "c3", name: "Review", systemState: "review", wipLimit: null, tickets: [] });
    withColumns([]);
    render(<Board companies={[{ ...company, agents: [dev] } as unknown as Company]} projectId="p1" go={() => {}} onCompaniesChanged={() => {}} />);
    const merging = await screen.findByRole("region", { name: "Approved, merging" });
    expect(within(merging).getByText("Nothing approved is waiting to merge.")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Passed, held" })).toBeNull();
    columns.pop();
  });

  it("finds tasks by reference, title or description words", async () => {
    (columns[0]!.tickets as unknown[]).push(card({ id: "t9", title: "Fix the header", number: 42, body: "The Safari menu overlaps." }));
    withColumns([]);
    render(<Board companies={[{ ...company, ticketPrefix: "HOL", agents: [dev] } as unknown as Company]} projectId="p1" go={() => {}} onCompaniesChanged={() => {}} />);
    await screen.findByText("Fix the header");
    const search = screen.getByRole("searchbox", { name: "Search tasks" });
    fireEvent.change(search, { target: { value: "hol-42" } });
    expect(screen.getByText("Fix the header")).toBeTruthy();
    expect(screen.queryByText("Mine to do")).toBeNull();
    fireEvent.change(search, { target: { value: "safari menu" } });
    expect(screen.getByText("Fix the header")).toBeTruthy();
    fireEvent.change(search, { target: { value: "agent" } });
    expect(screen.getByText("Agent job")).toBeTruthy();
    expect(screen.queryByText("Fix the header")).toBeNull();
    columns[0]!.tickets.pop();
  });

  it("filters cards by who they are assigned to", async () => {
    withColumns([]);
    render(<Board companies={[{ ...company, agents: [dev] } as unknown as Company]} projectId="p1" go={() => {}} onCompaniesChanged={() => {}} />);
    await screen.findByText("Mine to do");
    fireEvent.click(screen.getByRole("button", { name: "Filter" }));
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
  function record(go: (to: string) => void = () => {}) {
    const posts: { url: string; body: Record<string, unknown> }[] = [];
    stub();
    const base = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        posts.push({ url, body: JSON.parse(String(init.body)) });
        return json({ id: "f9", agentId: "a1" });
      }
      return base(url, init);
    }));
    render(<Board companies={[ceoCompany]} projectId="p1" go={go} onCompaniesChanged={() => {}} />);
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
    expect(posts[1]).toMatchObject({ url: "/api/features/f9/tickets", body: { projectId: "p1", title: "Plan: Export", assigneeAgentId: "a1", noCode: true } });
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

  it("sends the draft to the CEO's chat instead of creating it, and opens the chat", async () => {
    const go = vi.fn();
    const posts = record(go);
    fireEvent.click(await screen.findByRole("button", { name: "Add task" }));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Add SSO" } });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Acme needs it" } });
    fireEvent.click(screen.getByRole("button", { name: "Let the CEO question me first" }));
    await waitFor(() => expect(go).toHaveBeenCalledWith("chat/c1/a1"));
    expect(posts).toEqual([{ url: "/api/companies/c1/chat/grill", body: { kind: "task", title: "Add SSO", description: "Acme needs it", projectId: "p1" } }]);
  });

  it("takes a 200,000-character description whole, instead of cutting the paste (BOS-502)", async () => {
    const posts = record();
    fireEvent.click(await screen.findByRole("button", { name: "Add task" }));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Big paste" } });
    const box = screen.getByLabelText("Description") as HTMLTextAreaElement;
    expect(box.getAttribute("maxLength")).toBeNull();
    const big = "x".repeat(OWNER_MESSAGE_MAX);
    fireEvent.change(box, { target: { value: big } });
    expect(box.value).toHaveLength(OWNER_MESSAGE_MAX);
    fireEvent.click(screen.getByRole("button", { name: "Add to backlog" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.body.body).toHaveLength(OWNER_MESSAGE_MAX);
  });

  it("opens New task with the feature preselected from a feature card", async () => {
    const posts = record();
    fireEvent.click(await screen.findByRole("button", { name: "Filter" }));
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
    const arrow = await screen.findByRole("button", { name: "Show tasks of Dark mode" });
    fireEvent.click(arrow);
    const list = await screen.findByRole("list", { name: "Tasks of Dark mode" });
    expect(within(list).getByText("Build the toggle")).toBeTruthy();
    expect(within(list).getByText("Dev")).toBeTruthy();
    expect(within(list).getByText("unassigned")).toBeTruthy();
    expect(within(list).getByText("in progress")).toBeTruthy();
    expect(screen.getByText("1 of 2 done")).toBeTruthy();
  });

  it("loads with the tasks folded, the summary in the WORK column, and the arrow opens and closes them", async () => {
    stub();
    render(<Features companies={[company]} companyId="c1" featureId={undefined} go={() => {}} />);
    const arrow = await screen.findByRole("button", { name: "Show tasks of Dark mode" });
    expect(arrow.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("list", { name: "Tasks of Dark mode" })).toBeNull();
    const work = screen.getByRole("button", { name: "1 of 2 done" });
    expect(work.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(arrow);
    expect(screen.getByRole("button", { name: "Hide tasks of Dark mode" }).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("list", { name: "Tasks of Dark mode" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Hide tasks of Dark mode" }));
    expect(screen.queryByRole("list", { name: "Tasks of Dark mode" })).toBeNull();
  });

  it("counts cancelled tasks as neither done nor total, and names the blocked ones", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/features"))
          return json({
            ...scored,
            features: [
              feature({
                id: "f1",
                tickets: {
                  total: 4,
                  done: 1,
                  items: [
                    { id: "t1", title: "One", state: "done", outcome: "completed", assignee: null },
                    { id: "t2", title: "Two", state: "ready", outcome: null, assignee: null },
                    { id: "t3", title: "Three", state: "blocked", outcome: null, assignee: null },
                    { id: "t4", title: "Gone", state: "done", outcome: "cancelled", assignee: null },
                  ],
                },
              }),
              feature({ id: "f2", title: "No tasks yet", tickets: { total: 0, done: 0, items: [] } }),
            ],
          });
        if (url.includes("/feedback-settings")) return json({ demandWeight: 1, ceoTriage: false, portalEnabled: false, portalToken: null, portalTitle: null, portalIntro: null, hasLogo: false, drivers: [], areas: [] });
        return json([]);
      }),
    );
    render(<Features companies={[company]} companyId="c1" featureId={undefined} go={() => {}} />);
    expect(await screen.findByRole("button", { name: "1 of 3 done" })).toBeTruthy();
    // A blocked task is said on its own line, with a mark so it isn't colour alone.
    expect(screen.getByText("⚠ 1 blocked")).toBeTruthy();
    // A feature with no tasks shows a dash and no arrow.
    expect(screen.getByText("No tasks yet")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Show tasks of No tasks yet" })).toBeNull();
  });

  it("remembers which features are open in the browser across a reload", async () => {
    stub();
    const first = render(<Features companies={[company]} companyId="c1" featureId={undefined} go={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Show tasks of Dark mode" }));
    expect(JSON.parse(localStorage.getItem("bossman.features.open") ?? "")).toEqual({ ids: ["f1"] });
    first.unmount();

    render(<Features companies={[company]} companyId="c1" featureId={undefined} go={() => {}} />);
    expect((await screen.findByRole("button", { name: "Hide tasks of Dark mode" })).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("list", { name: "Tasks of Dark mode" })).toBeTruthy();
    localStorage.clear();
  });

  it("Expand all opens every feature's tasks and Collapse all folds them again", async () => {
    stub();
    render(<Features companies={[company]} companyId="c1" featureId={undefined} go={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Expand all" }));
    expect(screen.getByRole("list", { name: "Tasks of Dark mode" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Collapse all" }));
    expect(screen.queryByRole("list", { name: "Tasks of Dark mode" })).toBeNull();
    localStorage.clear();
  });

  it("after Expand all, a single feature's arrow still folds just that one and leaves the others open", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/features"))
          return json({
            ...scored,
            features: [
              feature(),
              feature({ id: "f2", title: "Export", tickets: { total: 1, done: 0, items: [{ id: "t3", title: "Build export", state: "ready", outcome: null, assignee: null }] } }),
            ],
          });
        if (url.includes("/feedback-settings")) return json({ demandWeight: 1, ceoTriage: false, portalEnabled: false, portalToken: null, portalTitle: null, portalIntro: null, hasLogo: false, drivers: [], areas: [] });
        return json([]);
      }),
    );
    render(<Features companies={[company]} companyId="c1" featureId={undefined} go={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Expand all" }));
    expect(screen.getByRole("list", { name: "Tasks of Dark mode" })).toBeTruthy();
    expect(screen.getByRole("list", { name: "Tasks of Export" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Hide tasks of Dark mode" }));
    expect(screen.queryByRole("list", { name: "Tasks of Dark mode" })).toBeNull();
    expect(screen.getByRole("list", { name: "Tasks of Export" })).toBeTruthy();
    // Not every feature is open now, so the link offers "Expand all" again.
    expect(screen.getByRole("button", { name: "Expand all" })).toBeTruthy();
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
    expect(await screen.findByText("Nothing waiting. Add a task to start, or ask the CEO in Chat to plan the work.")).toBeTruthy();
    expect(screen.queryByText(/Nothing ready/)).toBeNull();
  });
});
