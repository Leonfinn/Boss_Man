// @vitest-environment jsdom
// BOS-2819: a company with no code project (no project has a repo address) does not see the merge queue, merge lines
// or "Files changed"; a company with a code project, or one whose projects are not known yet, sees today's screens.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { Company } from "../src/api";
import { Sidebar } from "../src/components/Sidebar";
import { TicketRecord } from "../src/components/TicketRecord";
import { healthLines } from "../src/components/DashboardPanels";
import { HasCodeContext } from "../src/hooks";

const apiMock = vi.hoisted(() => vi.fn());
vi.mock("../src/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/api")>()), api: apiMock }));

afterEach(() => {
  cleanup();
  apiMock.mockReset();
});

const company: Company = { id: "c1", name: "App Co", mission: null, paused: false, agents: [], projects: [] };
const noop = () => {};
const sidebar = (hasCode?: boolean) =>
  render(<Sidebar active="dashboard" companies={[company]} current={company} decisions={[]} unread={0} feedback={0} mergeWaiting={0} mergeStuck={0} hasCode={hasCode} notifications="unsupported" collapsed={false} narrow={false} onToggleCollapsed={noop} onPickCompany={noop} onCreateCompany={async () => {}} onEnableNotifications={noop} onLogout={noop} />);

describe("menu", () => {
  it("hides Merge queue for a company with no code project", () => {
    sidebar(false);
    expect(screen.queryByRole("link", { name: /Merge queue/ })).toBeNull();
    expect(screen.getByRole("link", { name: "Wiki" })).toBeTruthy();
  });
  it("keeps Merge queue for a code company, and when nothing says otherwise", () => {
    sidebar(true);
    expect(screen.getByRole("link", { name: /Merge queue/ })).toBeTruthy();
    cleanup();
    sidebar();
    expect(screen.getByRole("link", { name: /Merge queue/ })).toBeTruthy();
  });
});

describe("Dashboard Right now", () => {
  const ok = { runner: { registered: true, connected: true, lastSeenAt: null }, usage: { agents: 0, accounts: [], firstResetAt: null }, update: { waiting: false, phase: null, deadline: null } };
  const merges = { waitingCount: 0, line: { state: "moving" } } as never;
  it("drops the Merges line when there is no code project", () => {
    expect(healthLines({ health: ok, merges, stuck: null, running: 0, companyId: "c1", hasCode: false }).map((l) => l.key)).toEqual(["runner", "usage", "update"]);
  });
  it("keeps it for a code company", () => {
    expect(healthLines({ health: ok, merges, stuck: null, running: 0, companyId: "c1", hasCode: true }).map((l) => l.key)).toContain("merges");
    expect(healthLines({ health: ok, merges, stuck: null, running: 0, companyId: "c1" }).map((l) => l.key)).toContain("merges");
  });
});

describe("task page record", () => {
  const record = { runs: { total: 1, errored: 0 }, spendMicros: 0, capMicros: null, lastCheck: null, filesChanged: null };
  it("hides Files changed for a company with no code project", async () => {
    apiMock.mockResolvedValue(record);
    render(<HasCodeContext.Provider value={false}><TicketRecord ticketId="t1" /></HasCodeContext.Provider>);
    await screen.findByTestId("record-runs");
    expect(screen.queryByTestId("record-files")).toBeNull();
  });
  it("shows it for a code company", async () => {
    apiMock.mockResolvedValue(record);
    render(<TicketRecord ticketId="t1" />);
    expect((await screen.findByTestId("record-files")).textContent).toContain("not available");
  });
});
