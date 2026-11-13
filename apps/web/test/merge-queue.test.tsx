// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
    // A stuck one says what happens next and who acts, as one plain sentence after its short state word.
    expect(first.getByText(/Waiting for a check slot\. Boss Man checks and merges it by itself\./)).toBeTruthy();
    expect(first.getByText("Stuck")).toBeTruthy();

    // A card that needs the owner links straight to that card (BOS-1078) from the Needs you card, in plain grammar.
    expect(screen.getByRole("link", { name: "Open the stopped check" }).getAttribute("href")).toBe("#/decisions/d1");
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
    expect(within(row).getByText(/Waiting for APP-19 to merge first\. APP-19 has to be reviewed and merged first\./)).toBeTruthy();
    expect(within(row).getByText("Stuck")).toBeTruthy();
  });

  it("names the card holding a signed-off merge, who raised it, and links straight to it (BOS-1078)", async () => {
    const signedOffAt = new Date();
    signedOffAt.setHours(12, 55, 0, 0);
    const card = { id: "11111111-2222-4333-8444-555555555555", kind: "hold", question: "Rotate the deploy key before this goes in?", raisedBy: "Jane", raisedAt: new Date().toISOString(), staleHint: "It names APP-66, which is done now, so it may no longer be needed." };
    const held = { ticketId: "t5", ref: "APP-5", title: "Key rotation", minutes: 30, state: "waiting_for_decision", label: `held by Jane's card: "Rotate the deploy key before this goes in?"`, stuck: false, next: "Your sign-off is done; it merges once that card is answered.", actor: "owner", decisionId: card.id, risk: "high", urgent: false, failedCheck: false, card, signedOffAt: signedOffAt.toISOString() };
    vi.stubGlobal("fetch", vi.fn(async () => json({ ...data, waiting: [held], waitingCount: 1 })));
    render(<MergeQueue companies={[company]} companyId="c1" />);
    // The owner's row shows in the Needs you card and, in merge order, in the list.
    expect((await screen.findAllByText("Key rotation")).length).toBe(2);
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
    expect(screen.getByText("Nothing needs you. Everything here is moving by itself.")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Needs you" })).toBeNull();
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
    expect(screen.getByText(/Waiting for a check slot \(2 ahead\)\. Boss Man starts it as soon as a slot frees/)).toBeTruthy();
    expect(screen.getByText("0 of 1 slot busy · flagged after an hour")).toBeTruthy();
  });
});

// The Merge queue's attention layout (BOS-1239, design BOS-1207).
const base = { risk: "low", urgent: false, failedCheck: false, decisionId: null, actor: "system" as const, stuck: false, minutes: 10, next: "Boss Man merges it.", signedOffAt: null };
const checkRow = (over: Record<string, unknown>) => ({ id: "j1", ticketId: "t1", ref: "APP-1", title: "A check", kind: "quick", requestedBy: "Bungle", state: "waiting", position: 1, minutes: 22, fixesMain: false, heldBy: null, ...over, heldByMain: String(over.heldBy ?? "").startsWith("main is red") });
function serve(merge: unknown, checks: unknown) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => (String(url).includes("/check-queue") ? json(checks) : json(merge))));
}
const noChecks = { mode: "server", slots: 2, running: 0, rows: [] };
const calm = { ...data, waitingCount: 0, running: [], waiting: [], recent: [] };
const goTo = (hash: string) => {
  window.location.hash = hash;
};

describe("merge queue attention layout (BOS-1239)", () => {
  afterEach(() => goTo(""));

  it("pills show only problems, most urgent first, and the calm line when there are none", async () => {
    serve(
      { ...data, waitingCount: 4, waiting: [
        { ...base, ticketId: "a", ref: "APP-1", title: "Sign me", state: "waiting_for_sign_off", label: "waiting for your sign-off", actor: "owner", decisionId: "d1", card: { id: "d1", kind: "sign_off", question: "Merge?", raisedBy: null, raisedAt: "", staleHint: null } },
        { ...base, ticketId: "b", ref: "APP-2", title: "Failed", state: "check_failed_retrying", label: "check failed", stuck: true },
        { ...base, ticketId: "c", ref: "APP-3", title: "Slow", state: "waiting_for_slot", label: "waiting for a check slot", stuck: true, minutes: 90 },
        { ...base, ticketId: "d", ref: "APP-4", title: "Fine", state: "waiting_for_slot", label: "waiting for a check slot" },
      ] },
      { mode: "server", slots: 2, running: 0, rows: [checkRow({ id: "j1", heldBy: "main is red", position: null }), checkRow({ id: "j2", heldBy: "main is red", position: null })] },
    );
    render(<MergeQueue companies={[company]} companyId="c1" />);
    const list = await screen.findByRole("list", { name: "What needs attention" });
    const pills = within(list).getAllByRole("link").map((a) => a.textContent);
    expect(pills).toEqual(["1 need you", "Main is red: 2 checks held", "1 check failed", "1 stuck over an hour"]);
    expect(within(list).getByRole("link", { name: /Main is red/ }).getAttribute("href")).toBe("#/merge-queue/c1/checks");
    expect(screen.queryByText(/Nothing needs you/)).toBeNull();
    // The right-hand "waiting to merge" sentence is gone; the Merges tab carries the count.
    expect(screen.queryByText("4 waiting to merge")).toBeNull();
  });

  it("14 checks queued for a busy slot are not 'held': no red banner, no pill (BOS-1262)", async () => {
    const queued = Array.from({ length: 14 }, (_, i) => checkRow({ id: `q${i}`, ticketId: `t${i}`, ref: `APP-${i}`, position: i + 1, heldBy: "all 3 check slots are busy" }));
    const running = [1, 2, 3].map((n) => checkRow({ id: `r${n}`, state: "running", position: null }));
    serve(calm, { mode: "server", slots: 3, running: 3, rows: [...running, ...queued] });
    goTo("#/merge-queue/c1/checks");
    const { container } = render(<MergeQueue companies={[company]} companyId="c1" />);
    await screen.findByText("APP-13");
    expect(container.querySelector("[data-main-red]")).toBeNull();
    expect(container.textContent).not.toMatch(/held|Main is red|failing its check/i);
  });

  it("main red: only the checks main holds are counted as held (BOS-1262)", async () => {
    const rows = [checkRow({ id: "a", position: 1, heldBy: "all 2 check slots are busy" }), checkRow({ id: "h1", ticketId: "t2", ref: "APP-2", position: null, heldBy: "main is red" }), checkRow({ id: "h2", ticketId: "t3", ref: "APP-3", position: null, heldBy: "main is red" })];
    serve(calm, { mode: "server", slots: 2, running: 0, rows });
    goTo("#/merge-queue/c1/checks");
    const { container } = render(<MergeQueue companies={[company]} companyId="c1" />);
    await screen.findByText("APP-3");
    expect(container.querySelector("[data-main-red]")!.textContent).toMatch(/2 checks are held/);
  });

  it("a pill on the Merges tab moves focus to its target", async () => {
    serve({ ...data, waitingCount: 1, waiting: [{ ...base, ticketId: "a", ref: "APP-1", title: "Sign me", state: "needs_you", label: "stopped: needs you", actor: "owner", decisionId: "d1" }] }, noChecks);
    render(<MergeQueue companies={[company]} companyId="c1" />);
    fireEvent.click(await screen.findByRole("link", { name: "1 need you" }));
    expect(document.activeElement?.id).toBe("mq-needs");
    expect(document.getElementById("mq-needs")?.getAttribute("tabindex")).toBe("-1");
  });

  it("Needs you lists only owner rows, with a button for each kind of card", async () => {
    const hold = { id: "d3", kind: "hold", question: "Rotate?", raisedBy: "Jane", raisedAt: "", staleHint: null };
    serve(
      { ...data, waitingCount: 4, waiting: [
        { ...base, ticketId: "a", ref: "APP-1", title: "Sign-off one", state: "waiting_for_sign_off", label: "waiting for your sign-off", actor: "owner", decisionId: "d1", minutes: 100, card: { id: "d1", kind: "sign_off", question: "Merge?", raisedBy: null, raisedAt: "", staleHint: null } },
        { ...base, ticketId: "b", ref: "APP-2", title: "Stopped one", state: "needs_you", label: "stopped: needs you", actor: "owner", decisionId: "d2" },
        { ...base, ticketId: "c", ref: "APP-3", title: "Held one", state: "waiting_for_decision", label: "held by Jane's card", actor: "owner", decisionId: "d3", card: hold },
        { ...base, ticketId: "e", ref: "APP-5", title: "CEO one", state: "needs_you", label: "stopped: the CEO decides", actor: "ceo", decisionId: "d4" },
      ] },
      noChecks,
    );
    render(<MergeQueue companies={[company]} companyId="c1" />);
    const card = await screen.findByRole("region", { name: "Needs you" });
    const items = within(card).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(within(card).queryByText("CEO one")).toBeNull();
    expect(within(items[0]!).getByRole("link", { name: "Open the sign-off" }).getAttribute("href")).toBe("#/decisions/d1");
    expect(within(items[0]!).getByText("waiting 1h 40m")).toBeTruthy();
    expect(within(items[1]!).getByRole("link", { name: "Open the stopped check" }).getAttribute("href")).toBe("#/decisions/d2");
    expect(within(items[2]!).getByRole("link", { name: "Open Jane's card" }).getAttribute("href")).toBe("#/decisions/d3");
    // The CEO's row keeps its place in the merge order, with its own state word.
    expect(screen.getByText("CEO one", { selector: "a" })).toBeTruthy();
  });

  it("waiting rows carry a place number and one state word", async () => {
    serve({ ...data, waitingCount: 2, waiting: [{ ...base, ticketId: "a", ref: "APP-1", title: "First", state: "waiting_for_slot", label: "waiting for a check slot" }, { ...base, ticketId: "b", ref: "APP-2", title: "Second", state: "waiting_host", label: "waiting for the host" }] }, noChecks);
    render(<MergeQueue companies={[company]} companyId="c1" />);
    await screen.findByText("First");
    const rows = document.querySelectorAll("article[data-state-word]");
    expect([...rows].map((r) => [r.querySelector(".mq-pos")?.textContent, r.getAttribute("data-state-word")])).toEqual([["1", "Waiting"], ["2", "Held"]]);
    expect(rows[0]!.textContent).toContain("waiting 10m");
  });

  it("tabs show counts, amber when something needs you or main is red", async () => {
    serve(
      { ...data, waitingCount: 3, waiting: [{ ...base, ticketId: "a", ref: "APP-1", title: "Sign me", state: "needs_you", label: "stopped: needs you", actor: "owner", decisionId: "d1" }] },
      { mode: "server", slots: 2, running: 1, rows: [checkRow({ state: "running", position: null }), checkRow({ id: "j2", heldBy: "main is red", position: null })] },
    );
    render(<MergeQueue companies={[company]} companyId="c1" />);
    const merges = await screen.findByRole("tab", { name: /Merges/ });
    await waitFor(() => expect(within(screen.getByRole("tab", { name: /Queued checks/ })).getByText("2")).toBeTruthy());
    // The badge counts every merge on the tab: 3 waiting + 1 running (BOS-1287).
    expect(within(merges).getByText("4").className).toContain("warn");
    expect(within(screen.getByRole("tab", { name: /Queued checks/ })).getByText("2").className).toContain("warn");
  });

  it("tab counts are not amber when all is calm", async () => {
    serve({ ...calm, waitingCount: 2 }, { mode: "server", slots: 2, running: 0, rows: [checkRow({})] });
    render(<MergeQueue companies={[company]} companyId="c1" />);
    const checks = await screen.findByRole("tab", { name: /Queued checks/ });
    await waitFor(() => expect(within(checks).getByText("1")).toBeTruthy());
    expect(within(checks).getByText("1").className).not.toContain("warn");
    expect(within(screen.getByRole("tab", { name: /Merges/ })).getByText("2").className).not.toContain("warn");
  });

  it("the Queued checks tab says main is red once, naming the fixing ticket, and rows don't repeat it", async () => {
    goTo("#/merge-queue/c1/checks");
    serve(calm, { mode: "server", slots: 2, running: 1, rows: [checkRow({ id: "j0", ticketId: "fx", ref: "FRN-232", title: "Fix main", state: "running", fixesMain: true, position: null }), checkRow({ id: "j1", heldBy: "main is red", position: null }), checkRow({ id: "j2", ticketId: "t2", ref: "APP-2", heldBy: "main is red", position: null })] });
    render(<MergeQueue companies={[company]} companyId="c1" />);
    const banner = await screen.findByText(/Main is failing its check, so new checks wait\./, { selector: "strong" });
    const box = banner.parentElement!;
    expect(box.textContent).toContain("2 checks are held until the fix (FRN-232) merges. Checks that fix main still run.");
    expect(within(box).getByRole("link", { name: "FRN-232" }).getAttribute("href")).toBe("#/tickets/fx");
    expect(screen.queryByText(/Held: main is red/)).toBeNull();
    expect(screen.getAllByText("fixes main")).toHaveLength(1);
    expect(screen.getAllByText("for 22m")).toHaveLength(3);
    expect(screen.getByRole("tabpanel").id).toBe("mq-panel-checks");
  });

  it("the banner ends 'until main is fixed' when no fixing check is queued", async () => {
    goTo("#/merge-queue/c1/checks");
    serve(calm, { mode: "server", slots: 2, running: 0, rows: [checkRow({ heldBy: "main is red", position: null })] });
    render(<MergeQueue companies={[company]} companyId="c1" />);
    const banner = await screen.findByText(/Main is failing its check/, { selector: "strong" });
    expect(banner.parentElement!.textContent).toContain("1 check is held until main is fixed. Checks that fix main still run.");
  });

  it("an empty Queued checks tab explains itself and counts free slots", async () => {
    goTo("#/merge-queue/c1/checks");
    serve(calm, noChecks);
    render(<MergeQueue companies={[company]} companyId="c1" />);
    const empty = await screen.findByText("No checks queued.");
    expect(empty.parentElement!.textContent).toBe("No checks queued. When an agent or the merge gate asks for a check, it shows here until it finishes. Both slots are free.");
    expect(screen.queryByText(/Main is failing/)).toBeNull();
  });

  it("free-slot wording names the count when there are three slots", async () => {
    goTo("#/merge-queue/c1/checks");
    const wording = async (slots: number, running: number) => {
      serve(calm, { mode: "server", slots, running, rows: [] });
      render(<MergeQueue companies={[company]} companyId="c1" />);
      const empty = await screen.findByText("No checks queued.");
      const text = empty.parentElement!.textContent!;
      cleanup();
      return text.replace(/^.*finishes\. /, "");
    };
    expect(await wording(3, 0)).toBe("All 3 slots are free.");
    expect(await wording(3, 2)).toBe("1 of 3 slots are free.");
    expect(await wording(3, 1)).toBe("2 of 3 slots are free.");
    expect(await wording(3, 3)).toBe("No slot is free.");
    expect(await wording(1, 0)).toBe("The slot is free.");
  });

  it("a Needs you row with no card gets an Open ticket button to the ticket", async () => {
    serve({ ...data, waitingCount: 1, waiting: [{ ...base, ticketId: "z", ref: "APP-7", title: "No card", state: "needs_you", label: "stopped: needs you", actor: "owner", decisionId: null }] }, noChecks);
    render(<MergeQueue companies={[company]} companyId="c1" />);
    const card = await screen.findByRole("region", { name: "Needs you" });
    expect(within(card).getByRole("link", { name: "Open ticket" }).getAttribute("href")).toBe("#/tickets/z");
  });

  it("arrow keys move between the tabs and keep the tab in the address", async () => {
    serve(calm, noChecks);
    render(<MergeQueue companies={[company]} companyId="c1" />);
    const merges = await screen.findByRole("tab", { name: /Merges/ });
    expect(merges.getAttribute("aria-selected")).toBe("true");
    expect(merges.getAttribute("aria-controls")).toBe("mq-panel-merges");
    expect(screen.getByRole("tab", { name: /Queued checks/ }).getAttribute("tabindex")).toBe("-1");
    fireEvent.keyDown(merges, { key: "ArrowRight" });
    await waitFor(() => expect(screen.getByRole("tab", { name: /Queued checks/ }).getAttribute("aria-selected")).toBe("true"));
    expect(window.location.hash).toBe("#/merge-queue/c1/checks");
    expect(document.activeElement?.id).toBe("mq-tab-checks");
    fireEvent.keyDown(screen.getByRole("tab", { name: /Queued checks/ }), { key: "ArrowLeft" });
    await waitFor(() => expect(screen.getByRole("tab", { name: /Merges/ }).getAttribute("aria-selected")).toBe("true"));
    expect(window.location.hash).toBe("#/merge-queue/c1");
  });

  it("recently finished folds after three, with a Show more button", async () => {
    const recent = [1, 2, 3, 4, 5].map((n) => ({ ticketId: `r${n}`, ref: `APP-${n}`, title: `Done ${n}`, result: "merged", detail: "merged", at: new Date().toISOString() }));
    serve({ ...calm, recent }, noChecks);
    render(<MergeQueue companies={[company]} companyId="c1" />);
    await screen.findByText("Done 1");
    expect(screen.queryByText("Done 4")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show 2 more" }));
    expect(screen.getByText("Done 5")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Show/ })).toBeNull();
  });

  it("draws the title and tabs before the data arrives", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    render(<MergeQueue companies={[company]} companyId="c1" />);
    expect(screen.getByRole("heading", { name: "Merge queue" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Merges" })).toBeTruthy();
    // The shared loader stays mounted (silent for the first second).
    expect(screen.getByRole("status")).toBeTruthy();
  });
});
