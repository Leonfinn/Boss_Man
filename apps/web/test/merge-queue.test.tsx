// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { MergeQueue, waitingLabel } from "../src/pages/MergeQueue";
import { Sidebar } from "../src/components/Sidebar";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const company: Company = { id: "c1", name: "App Co", mission: null, paused: false, agents: [] };

const data = {
  companyId: "c1",
  mode: "legacy",
  slots: 2,
  waitingCount: 2,
  running: [{ ticketId: "t0", ref: "APP-9", title: "Merging now", phase: "checking", startedAt: new Date(Date.now() - 12 * 60_000).toISOString(), startedBy: "Yaffle", minutes: 12, what: "merge_check", slot: 1, overLimit: false }],
  waiting: [
    { ticketId: "t1", ref: "APP-12", title: "Waiting a while", minutes: 72, state: "waiting_for_slot", label: "waiting for a check slot", stuck: true, next: "Boss Man checks and merges it by itself.", actor: "system", decisionId: null, risk: "low", urgent: false, failedCheck: false },
    { ticketId: "t2", ref: "APP-13", title: "Needs an answer", minutes: 5, state: "needs_you", label: "stopped: needs you", stuck: true, next: "Open the card to run the check again, send it back, or skip it.", actor: "owner", decisionId: "d1", risk: "low", urgent: false, failedCheck: true },
  ],
  recent: [{ ticketId: "t3", ref: "APP-8", title: "Just merged", result: "merged", detail: "merged as abcdef1", at: new Date().toISOString() }],
};

describe("merge queue screen (BOS-587)", () => {
  it("names the carried ticket on a carried-work row, using the typed carried field (BOS-819)", async () => {
    const carried = { ticketId: "t9", ref: "APP-9", title: `Fix the "login" bug and don't break the owner's links` };
    const held = { ticketId: "t8", ref: "APP-8", title: "Build the page", minutes: 72, state: "waiting_for_other_ticket", label: "waiting for APP-9 to merge first", stuck: true, next: "APP-9 has to be reviewed and merged first.", actor: "system", decisionId: null, risk: "low", urgent: false, failedCheck: false, carried: [carried] };
    vi.stubGlobal("fetch", vi.fn(async () => json({ ...data, waiting: [held], waitingCount: 1 })));
    render(<MergeQueue companies={[company]} companyId="c1" />);
    expect(await screen.findByText("Build the page")).toBeTruthy();
    const row = screen.getAllByRole("article")[1]!;
    expect(row.getAttribute("data-stuck")).toBe("true");
    // The carried row names the ticket it waits for, described from the typed list, and links to it.
    const carriedLine = row.querySelector('[data-carried="true"]');
    expect(carriedLine?.textContent).toContain("It needs APP-9 to merge first.");
    expect(within(carriedLine as HTMLElement).getByRole("link", { name: "APP-9" }).getAttribute("href")).toBe("#/tickets/t9");
    // The full title is kept on the link's hover text, quotes and all.
    expect(within(carriedLine as HTMLElement).getByRole("link", { name: "APP-9" }).getAttribute("title")).toBe(carried.title);
  });

  it("shows running, waiting in order (stuck highlighted) and recent, linking each ticket", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(data)));
    render(<MergeQueue companies={[company]} companyId="c1" />);
    expect(await screen.findByText("Merging now")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Merging now/ }).getAttribute("href")).toBe("#/tickets/t0");
    expect(screen.getByText(/Slot 1: running the check/)).toBeTruthy();

    const rows = screen.getAllByRole("article");
    expect(rows.length).toBe(4);
    const first = within(rows[1]!);
    expect(first.getByText("Waiting a while")).toBeTruthy();
    expect(rows[1]!.getAttribute("data-stuck")).toBe("true");
    // A stuck one says what happens next and who acts.
    expect(first.getByText(/Next: Boss Man checks and merges it by itself/)).toBeTruthy();

    // A card that needs the owner links straight to that card (BOS-1078), in plain grammar.
    expect(screen.getByRole("link", { name: "Needs you: open the card" }).getAttribute("href")).toBe("#/decisions/d1");
    expect(screen.getByText(/\(you're acting\)/)).toBeTruthy();
    expect(screen.queryByText(/you is acting/)).toBeNull();

    expect(screen.getByText("Recently finished")).toBeTruthy();
    expect(screen.getByText(/merged as abcdef1/)).toBeTruthy();
  });

  it("shows work held for another ticket's unapproved work as waiting for it, stuck, with what happens next (BOS-766, QA BOS-821)", async () => {
    const held = { ticketId: "t9", ref: "APP-20", title: "Build the page", minutes: 65, state: "waiting_for_other_ticket", label: "waiting for APP-19 to merge first", stuck: true, next: "APP-19 has to be reviewed and merged first.", actor: "system", decisionId: null, risk: "low", urgent: false, failedCheck: false, carried: [{ ticketId: "t8", ref: "APP-19", title: "Ship the API" }] };
    vi.stubGlobal("fetch", vi.fn(async () => json({ ...data, waiting: [held], waitingCount: 1 })));
    render(<MergeQueue companies={[company]} companyId="c1" />);
    expect(await screen.findByText("Build the page")).toBeTruthy();
    const row = screen.getAllByRole("article").find((r) => within(r).queryByText("Build the page"))!;
    expect(row.getAttribute("data-stuck")).toBe("true");
    expect(within(row).getByText(/waiting for APP-19 to merge first/)).toBeTruthy();
    expect(within(row).getByText(/Next: APP-19 has to be reviewed and merged first/)).toBeTruthy();
  });

  it("names the card holding a signed-off merge, who raised it, and links straight to it (BOS-1078)", async () => {
    const signedOffAt = new Date();
    signedOffAt.setHours(12, 55, 0, 0);
    const card = { id: "11111111-2222-4333-8444-555555555555", kind: "hold", question: "Rotate the deploy key before this goes in?", raisedBy: "Jane", raisedAt: new Date().toISOString(), staleHint: "It names APP-66, which is done now, so it may no longer be needed." };
    const held = { ticketId: "t5", ref: "APP-5", title: "Key rotation", minutes: 30, state: "waiting_for_decision", label: `held by Jane's card: "Rotate the deploy key before this goes in?"`, stuck: false, next: "Your sign-off is done; it merges once that card is answered.", actor: "owner", decisionId: card.id, risk: "high", urgent: false, failedCheck: false, card, signedOffAt: signedOffAt.toISOString() };
    vi.stubGlobal("fetch", vi.fn(async () => json({ ...data, waiting: [held], waitingCount: 1 })));
    render(<MergeQueue companies={[company]} companyId="c1" />);
    expect(await screen.findByText("Key rotation")).toBeTruthy();
    const line = document.querySelector('[data-held-by="card"]') as HTMLElement;
    expect(line.textContent).toMatch(/^You signed this off at 12.?55(\s?[AP]M)?\. It's held by a different card: /);
    expect(line.textContent).toContain("Rotate the deploy key before this goes in?");
    expect(line.textContent).toContain("raised by Jane");
    expect(within(line).getByRole("link", { name: "Open that card" }).getAttribute("href")).toBe(`#/decisions/${card.id}`);
    expect(line.querySelector('[data-stale="true"]')?.textContent).toBe("probably stale");
    // One link to the card, not a second generic "open the card" beside it.
    expect(screen.queryByRole("link", { name: "Needs you: open the card" })).toBeNull();
  });

  it("says a running merge is also waiting for GitHub CI, with the jobs left and the minutes so far (BOS-1070)", async () => {
    const running = [{ ...data.running[0], ci: { minutes: 12, waiting: ["images (arm64)", "check"] } }];
    vi.stubGlobal("fetch", vi.fn(async () => json({ ...data, running })));
    render(<MergeQueue companies={[company]} companyId="c1" />);
    expect(await screen.findByText("Merging now")).toBeTruthy();
    const row = screen.getAllByRole("article")[0]!;
    expect(row.querySelector("[data-ci-wait]")?.textContent).toBe("Waiting for GitHub CI: images (arm64), check, 12 min so far. It merges only once CI passes.");
    // The check line beside it still says the check is running: both go on at once.
    expect(row.textContent).toContain("running the check");
  });

  it("says plainly when nothing is waiting or running", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ ...data, waitingCount: 0, running: [], waiting: [], recent: [] })));
    render(<MergeQueue companies={[company]} companyId="c1" />);
    expect(await screen.findByText("Nothing is checking or merging right now.")).toBeTruthy();
    expect(screen.getByText("No approved work is waiting to merge.")).toBeTruthy();
    expect(screen.getByText("Nothing waiting to merge")).toBeTruthy();
  });

  it("shows the waiting count as the side menu's badge", () => {
    expect(waitingLabel(4)).toBe("4 waiting to merge");
    expect(waitingLabel(0)).toBeNull();
    const noop = () => {};
    render(<Sidebar active="merge-queue" companies={[company]} current={company} decisions={[]} unread={0} feedback={0} mergeWaiting={4} mergeStuck={0} notifications="unsupported" collapsed={false} narrow={false} onToggleCollapsed={noop} onPickCompany={noop} onCreateCompany={async () => {}} onEnableNotifications={noop} onLogout={noop} />);
    const link = screen.getByRole("link", { name: /Merge queue/ });
    expect(link.getAttribute("href")).toBe("#/merge-queue");
    expect(link.getAttribute("aria-current")).toBe("page");
    expect(within(link).getByLabelText("4 waiting to merge").textContent).toBe("4");
    expect(within(link).getByLabelText("4 waiting to merge").className).not.toContain("warn");
  });

  it("turns the badge into the stuck count in the warning colour when items are stuck (BOS-767)", () => {
    const noop = () => {};
    render(<Sidebar active="merge-queue" companies={[company]} current={company} decisions={[]} unread={0} feedback={0} mergeWaiting={5} mergeStuck={2} notifications="unsupported" collapsed={false} narrow={false} onToggleCollapsed={noop} onPickCompany={noop} onCreateCompany={async () => {}} onEnableNotifications={noop} onLogout={noop} />);
    const link = screen.getByRole("link", { name: /Merge queue/ });
    const badge = within(link).getByLabelText("2 stuck");
    expect(badge.textContent).toBe("2");
    expect(badge.className).toContain("warn");
    expect(link.querySelector(".count-dot")?.className).toContain("warn");
  });

  it("colors the collapsed strip dot amber when items are stuck (BOS-767)", () => {
    const noop = () => {};
    render(<Sidebar active="merge-queue" companies={[company]} current={company} decisions={[]} unread={0} feedback={0} mergeWaiting={5} mergeStuck={2} notifications="unsupported" collapsed narrow={false} onToggleCollapsed={noop} onPickCompany={noop} onCreateCompany={async () => {}} onEnableNotifications={noop} onLogout={noop} />);
    const dot = screen.getByRole("link", { name: /Merge queue/ }).querySelector(".count-dot");
    expect(dot?.className).toContain("warn");
  });
});

describe("merge queue screen in server mode (BOS-597)", () => {
  it("shows a ticket held back by the server queue as waiting for a check slot, with how many are ahead", async () => {
    const server = {
      ...data,
      mode: "server",
      slots: 1,
      waitingCount: 1,
      running: [],
      waiting: [{ ticketId: "t1", ref: "APP-12", title: "Behind the queue", minutes: 8, state: "waiting_for_check_capacity", label: "waiting for a check slot (2 ahead)", stuck: false, next: "Boss Man starts it as soon as a slot frees.", actor: "system", decisionId: null, risk: "low", urgent: false, failedCheck: false }],
      recent: [],
    };
    vi.stubGlobal("fetch", vi.fn(async () => json(server)));
    render(<MergeQueue companies={[company]} companyId="c1" />);
    expect(await screen.findByText("Behind the queue")).toBeTruthy();
    expect(screen.getByText("waiting for a check slot (2 ahead)")).toBeTruthy();
    expect(screen.getByText(/Next: Boss Man starts it as soon as a slot frees/)).toBeTruthy();
    expect(screen.getByText("One check slot runs at a time. A check that runs over an hour is flagged.")).toBeTruthy();
  });
});
