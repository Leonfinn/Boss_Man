// @vitest-environment jsdom
import { figureText } from "@boss-man/shared";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company, Notice, NoticeFeed } from "../src/api";
import { NeedsYou, healthLines } from "../src/components/DashboardPanels";
import { inLineOf, MergesStuckBanner, slowSummary, type MergeLine } from "../src/components/MergesStuckBanner";
import { companyFigure, Sidebar } from "../src/components/Sidebar";
import { Decisions } from "../src/pages/Decisions";
import { Feedback } from "../src/pages/Feedback";
import { MergeQueue } from "../src/pages/MergeQueue";
import { Notifications } from "../src/pages/Notifications";

// R43 (BOS-1716): one agreement test per area. Each renders every place the owner sees a figure (sidebar badge,
// dashboard, banner, page heading or tab) from the same server read, and checks they all show the same number
// under the same label from @boss-man/shared owner-figures. On 17 Nov the badge said 31 and the banner "21 merge
// checks waiting": the same read, two filters, one word.

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const noop = () => {};
const company: Company = { id: "c1", name: "App Co", mission: null, paused: false, agents: [] };
const other: Company = { id: "c2", name: "Other Co", mission: null, paused: false, agents: [] };
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

type SidebarFigures = { mergeWaiting?: number; mergeStuck?: number; feedback?: number; unread?: number; decisionsTally?: { open: number; waiting: number }; companyTallies?: Record<string, { open: number; waiting: number }> };
const sidebar = (f: SidebarFigures) =>
  render(
    <Sidebar
      active="dashboard"
      companies={[company, other]}
      current={company}
      decisions={[]}
      decisionsTally={f.decisionsTally}
      companyTallies={f.companyTallies}
      unread={f.unread ?? 0}
      feedback={f.feedback ?? 0}
      mergeWaiting={f.mergeWaiting ?? 0}
      mergeStuck={f.mergeStuck ?? 0}
      notifications="unsupported"
      collapsed={false}
      narrow={false}
      onToggleCollapsed={noop}
      onPickCompany={noop}
      onCreateCompany={async () => {}}
      onEnableNotifications={noop}
      onLogout={noop}
    />,
  );
/** The badge on one menu item: its number and its label. */
const badgeOf = (name: RegExp) => {
  const el = screen.getByRole("link", { name }).querySelector(".count") as HTMLElement | null;
  return el ? { value: el.textContent, label: el.getAttribute("aria-label") } : null;
};

describe("merges: badge, Merges tab, Dashboard line and banner show one 'in the merge line' figure", () => {
  // 31 in the line (2 running, 29 waiting), 21 of them Boss Man's to merge: the 17 Nov shape.
  const row = (i: number, actor: "system" | "agent") => ({ ticketId: `w${i}`, ref: `APP-${i}`, title: `T${i}`, minutes: 90, state: actor === "system" ? "waiting_for_check_capacity" : "held", label: "next in line for a check", stuck: false, next: null, actor, decisionId: null, risk: "low", urgent: false, failedCheck: false });
  const running = [1, 2].map((n) => ({ ticketId: `r${n}`, ref: `APP-9${n}`, title: `R${n}`, phase: "checking", startedAt: new Date().toISOString(), startedBy: "Boss Man", minutes: 5, what: "merge_check", slot: n, overLimit: false }));
  const waiting = [...Array.from({ length: 21 }, (_, i) => row(i, "system")), ...Array.from({ length: 8 }, (_, i) => row(100 + i, "agent"))];
  const line: MergeLine = { state: "over_capacity", waiting: 21, inQueue: 31, etaMinutes: null, lastLandedAt: null, advice: null };
  const view = { companyId: "c1", mode: "server", slots: 2, running, waiting, recent: [], waitingCount: waiting.length, lineCount: waiting.length + running.length, stuckCount: 0, line };
  const inLine = figureText("mergeQueue.inLine", 31);

  it("all four places read 31 in the merge line, and the smaller figure has its own label", async () => {
    expect(inLineOf(view)).toBe(31);
    // Sidebar badge (App passes inLineOf of the same read).
    sidebar({ mergeWaiting: inLineOf(view) });
    expect(badgeOf(/Merge queue/)).toEqual({ value: "31", label: inLine });
    cleanup();

    // Dashboard Right now, Merges line.
    const lines = healthLines({ health: null, merges: view, stuck: null, slow: slowSummary(view), running: 0, companyId: "c1" });
    expect(lines[1]!.text).toContain(inLine);

    // Banner (Dashboard and Decisions).
    render(<MergesStuckBanner stuck={null} slow={slowSummary(view)} companyId="c1" />);
    const banner = screen.getByRole("status").textContent ?? "";
    expect(banner).toContain(inLine);
    // The 21 is a different figure under a different label, never a second "31 waiting".
    expect(banner).toContain(figureText("mergeQueue.forBossMan", 21));
    expect(banner).not.toMatch(/\bwaiting\b/);
    cleanup();

    // The Merge queue page's Merges tab.
    vi.stubGlobal("fetch", vi.fn(async (url: string) => ok(String(url).includes("check-queue") ? { mode: "server", slots: 2, running: 0, rows: [] } : view)));
    render(<MergeQueue companies={[company]} companyId="c1" />);
    const tab = await screen.findByRole("tab", { name: /Merges/ });
    await waitFor(() => expect(tab.querySelector(".tab-count")).not.toBeNull());
    const count = tab.querySelector(".tab-count")!;
    expect({ value: count.textContent, label: count.getAttribute("aria-label") }).toEqual({ value: "31", label: inLine });
  });

  it("the healthy Dashboard line uses the same label", () => {
    const calm = { ...view, line: { state: "healthy" } as MergeLine };
    expect(healthLines({ health: null, merges: calm, stuck: null, running: 0, companyId: "c1" })[1]!.text).toBe(`${inLine}, none stuck.`);
  });
});

describe("decisions: badge, company switcher, Dashboard Needs you and the Decisions heading show one 'need you' figure", () => {
  const tally = { open: 4, waiting: 2 };
  const elsewhereTally = { open: 3, waiting: 5 };
  const needYou = figureText("decisions.needYou", 4);
  const withTeam = figureText("decisions.withTeam", 2);

  it("all places read 4 need you and 2 with the team", async () => {
    sidebar({ decisionsTally: tally, companyTallies: { c1: tally, c2: elsewhereTally } });
    expect(badgeOf(/Decisions/)).toEqual({ value: "4", label: `${needYou}, ${withTeam}` });
    // The switcher's line for this company, and for the other one (the Decisions page's "Also" line below).
    const switcher = screen.getByRole("button", { name: /Switch company/ });
    expect(switcher.textContent).toContain(needYou);
    fireEvent.click(switcher);
    const otherLine = within(screen.getByRole("list", { name: "Companies" })).getByRole("button", { name: /Other Co/ }).textContent;
    expect(otherLine).toContain(figureText("decisions.needYou", 3));
    cleanup();

    render(<NeedsYou decisions={[]} tally={tally} />);
    expect(screen.getByLabelText(needYou).textContent).toBe("4");
    expect(screen.getByText(new RegExp(`${withTeam}, nothing to do yet`))).toBeTruthy();
    cleanup();

    vi.stubGlobal("fetch", vi.fn(async () => ok(tally)));
    render(<Decisions decisions={[]} companies={[company]} loaded agentsWorking={0} onAnswered={noop} tally={tally} elsewhere={[{ id: "c2", name: "Other Co", count: elsewhereTally.open }]} />);
    const head = screen.getByRole("heading", { name: "Decisions" }).parentElement!;
    expect(head.textContent).toContain(`${needYou} · ${withTeam}`);
    // The other company reads as its own switcher line does, not as every open card ("Also waiting: 8").
    expect(within(head).getByRole("button", { name: `${figureText("decisions.needYou", 3)} in Other Co` })).toBeTruthy();
  });
});

describe("feedback: badge and the Unprocessed tab show one 'to process' figure for the chosen company", () => {
  const unprocessed = { c1: 3, c2: 5 };

  it("both read 3 to process for App Co, not the 8 across companies", async () => {
    sidebar({ feedback: companyFigure(unprocessed, "c1") });
    expect(badgeOf(/Feedback/)).toEqual({ value: "3", label: figureText("feedback.toProcess", 3) });
    cleanup();

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const u = String(url);
        if (u.includes("/api/feedback/unprocessed")) return ok(unprocessed);
        if (u.includes("/features")) return ok({ features: [] });
        if (u.includes("/feedback?")) return ok([]);
        return ok({});
      }),
    );
    render(<Feedback companies={[company, other]} companyId="c1" noteId={undefined} go={noop} />);
    const tab = await screen.findByRole("tab", { name: /Unprocessed/ });
    await waitFor(() => expect(tab.querySelector(".tab-count")).not.toBeNull());
    const count = tab.querySelector(".tab-count")!;
    expect({ value: count.textContent, label: count.getAttribute("aria-label") }).toEqual({ value: "3", label: figureText("feedback.toProcess", 3) });
  });
});

describe("notifications: badge and the Unread chip show the server's one 'unread' figure", () => {
  it("both read 7 unread", () => {
    const item: Notice = { id: "n1", companyId: "c1", company: "App Co", agentId: "a1", requested: "note", level: "note", demotedBy: null, title: "A note", body: "Body", link: "#/tickets/t1", pushedAt: null, pushError: null, readAt: null, createdAt: new Date().toISOString() };
    const feed: NoticeFeed = { items: [item], unread: 7, counts: { level: { ask: 2, note: 5 }, company: { c1: 7 } } };
    sidebar({ unread: feed.unread });
    expect(badgeOf(/Notifications/)).toEqual({ value: "7", label: figureText("notifications.unread", 7) });
    cleanup();

    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    render(<Notifications feed={feed} onChanged={noop} companies={[company]} />);
    const chip = screen.getByRole("button", { name: /^Unread,/ });
    expect(chip.getAttribute("aria-label")).toBe(`Unread, ${figureText("notifications.unread", 7)}`);
    expect(chip.querySelector(".nf-count")?.textContent).toBe("7");
  });
});
