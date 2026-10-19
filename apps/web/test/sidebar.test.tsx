// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Agent, Company } from "../src/api";
import { Sidebar } from "../src/components/Sidebar";

afterEach(cleanup);

const agent = (id: string, name: string, starred: boolean): Agent => ({ id, companyId: "c1", name, role: "worker", agentKind: "claude", model: null, fundingSourceId: null, paused: false, starred, duty: null });
const show = (agents: Agent[], activeAgent?: string) => {
  const company: Company = { id: "c1", name: "App Co", mission: null, paused: false, agents };
  const noop = () => {};
  render(<Sidebar active="chat" activeAgent={activeAgent} companies={[company]} current={company} decisions={[]} unread={0} feedback={0} notifications="unsupported" onPickCompany={noop} onCreateCompany={async () => {}} onEnableNotifications={noop} onLogout={noop} />);
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
