// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Agent, Company } from "../src/api";
import { Sidebar } from "../src/components/Sidebar";

afterEach(cleanup);

const agent = (id: string, name: string, starred: boolean): Agent => ({ id, companyId: "c1", name, role: "worker", agentKind: "claude", model: null, fundingSourceId: null, paused: false, starred, duty: null });
const show = (agents: Agent[], activeAgent?: string, projects: Company["projects"] = [], active = "chat", activeProject?: string) => {
  const company: Company = { id: "c1", name: "App Co", mission: null, paused: false, agents, projects };
  const noop = () => {};
  render(<Sidebar active={active} activeAgent={activeAgent} activeProject={activeProject} companies={[company]} current={company} decisions={[]} unread={0} feedback={0} mergeWaiting={0} mergeStuck={0} notifications="unsupported" collapsed={false} narrow={false} onToggleCollapsed={noop} onPickCompany={noop} onCreateCompany={async () => {}} onEnableNotifications={noop} onLogout={noop} />);
};

describe("starred agents in the sidebar", () => {
  it("lists them under Chat, linked to their thread, with the open one marked", () => {
    show([agent("a1", "Ada", true), agent("a2", "Bo", false)], "a1");
    const list = within(screen.getByRole("list", { name: "Starred agents" }));
    const link = list.getByRole("link", { name: "Ada" });
    expect(link.getAttribute("href")).toBe("#/chat/c1/a1");
    expect(link.getAttribute("aria-current")).toBe("page");
    expect(list.queryByRole("link", { name: "Bo" })).toBeNull();
  });

  it("shows nothing extra when no agent is starred", () => {
    show([agent("a1", "Ada", false)]);
    expect(screen.queryByRole("list", { name: "Starred agents" })).toBeNull();
  });
});

describe("starred projects in the sidebar", () => {
  it("lists them under Projects, linked to their Kanban, with the open one marked", () => {
    show([], undefined, [{ id: "p1", name: "Site", starred: true }, { id: "p2", name: "Docs", starred: false }], "board", "p1");
    const list = within(screen.getByRole("list", { name: "Starred projects" }));
    const link = list.getByRole("link", { name: "Site" });
    expect(link.getAttribute("href")).toBe("#/board/p1");
    expect(link.getAttribute("aria-current")).toBe("page");
    expect(list.queryByRole("link", { name: "Docs" })).toBeNull();
    // There is no separate Kanban item: a board is one project's, reached from Projects, which stays marked.
    expect(screen.queryByRole("link", { name: "Kanban" })).toBeNull();
    expect(screen.getByRole("link", { name: "Projects" }).getAttribute("aria-current")).toBe("page");
  });

  it("shows nothing extra when no project is starred", () => {
    show([], undefined, [{ id: "p2", name: "Docs", starred: false }]);
    expect(screen.queryByRole("list", { name: "Starred projects" })).toBeNull();
  });
});

describe("settings pages", () => {
  it("keeps Funding, Secrets and Permissions out of the side menu, inside Settings", async () => {
    show([], undefined, [], "settings");
    for (const name of ["Funding", "Permissions", "Secrets"]) expect(screen.queryByRole("link", { name })).toBeNull();
    expect(screen.getByRole("link", { name: "Settings" }).getAttribute("aria-current")).toBe("page");
    cleanup();
    const { Settings } = await import("../src/pages/Settings");
    const company: Company = { id: "c1", name: "App Co", mission: null, paused: false, agents: [], projects: [] };
    render(
      <Settings companies={[company]} companyId="c1" tab="secrets" go={() => {}} onChanged={() => {}}>
        <p>the secrets page</p>
      </Settings>,
    );
    // The menu is a list of links, each a page of its own (BOS-1019): the current one is marked aria-current.
    const menu = screen.getByRole("navigation", { name: "Settings" });
    expect(within(menu).getByRole("link", { name: /Secrets/ }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByText("the secrets page")).toBeTruthy();
    expect(within(menu).getByRole("link", { name: /Funding/ })).toBeTruthy();
  });
});

describe("the main menu groups (BOS-1506)", () => {
  it("keeps every page reachable at its old address, with Settings pinned and Log out beside it", () => {
    show([]);
    const pages: Record<string, string> = { Dashboard: "dashboard", Decisions: "decisions", Notifications: "notifications", Chat: "chat", Projects: "projects", Roadmap: "roadmap", Features: "features", Feedback: "feedback", Plan: "plan", "Merge queue": "merge-queue", Wiki: "wiki", Agents: "agents", Skills: "skills", Engagements: "engagements", Runs: "runs", "Scrum Master log": "scrum-master", "Workflow report": "workflow", Settings: "settings" };
    for (const [name, id] of Object.entries(pages)) expect(screen.getByRole("link", { name }).getAttribute("href"), name).toBe(`#/${id}`);
    const pinned = document.querySelector(".side-pinned")!;
    expect(within(pinned as HTMLElement).getByRole("link", { name: "Settings" })).toBeTruthy();
    expect(within(pinned as HTMLElement).getByRole("button", { name: "Log out" })).toBeTruthy();
  });

  it("has ten top-level rows, three of which are groups, and no section headings", () => {
    show([]);
    expect(document.querySelectorAll(".nav-scroll > section > ul > li").length).toBe(10);
    expect(document.querySelectorAll(".nav-scroll .nav-group-row").length).toBe(3);
    expect(document.querySelector(".side h2")).toBeNull();
  });

  it("marks the group of the open page and folds and unfolds on press", () => {
    localStorage.setItem("bm-side-groups", "[]");
    show([], undefined, [], "feedback");
    expect(screen.queryByRole("link", { name: "Feedback" })).toBeNull();
    const product = screen.getByRole("button", { name: /^Product/ });
    expect(within(product).getByText("Feedback")).toBeTruthy();
    fireEvent.click(product);
    expect(screen.getByRole("link", { name: "Feedback" }).getAttribute("aria-current")).toBe("page");
    expect(JSON.parse(localStorage.getItem("bm-side-groups")!)).toEqual(["product"]);
    localStorage.removeItem("bm-side-groups");
  });
});
