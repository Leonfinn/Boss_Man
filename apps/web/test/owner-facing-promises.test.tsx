// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Company, Decision } from "../src/api";
import { Decisions } from "../src/pages/Decisions";
import { Sidebar } from "../src/components/Sidebar";

// QA, BOS-800: web-side promises of three 8 Nov merges that no web test held.

afterEach(cleanup);

const company: Company = { id: "c1", name: "App Co", mission: null, paused: false, agents: [] };
const noop = () => {};
const sidebar = (mergeWaiting: number, mergeStuck: number, collapsed = false) =>
  render(<Sidebar active="decisions" companies={[company]} current={company} decisions={[]} unread={0} feedback={0} mergeWaiting={mergeWaiting} mergeStuck={mergeStuck} notifications="unsupported" collapsed={collapsed} narrow={false} onToggleCollapsed={noop} onPickCompany={noop} onCreateCompany={async () => {}} onEnableNotifications={noop} onLogout={noop} />);
const mergeLink = () => screen.getByRole("link", { name: /Merge queue/ });

describe("the Merge queue badge (BOS-767)", () => {
  it("shows no badge at all when nothing waits and nothing is stuck", () => {
    sidebar(0, 0);
    expect(mergeLink().querySelector(".count")).toBeNull();
    expect(mergeLink().querySelector(".count-dot")).toBeNull();
  });

  it("with three waiting and one stuck reads 1 stuck in the warning colour, not 3 waiting", () => {
    sidebar(3, 1);
    const badge = within(mergeLink()).getByLabelText("1 stuck");
    expect(badge.textContent).toBe("1");
    expect(badge.className).toContain("warn");
    expect(within(mergeLink()).queryByLabelText("3 waiting to merge")).toBeNull();
  });

  it("with waiting items but none stuck keeps the plain waiting count, and no warning class anywhere, even collapsed", () => {
    sidebar(3, 0);
    expect(within(mergeLink()).getByLabelText("3 waiting to merge").className).not.toContain("warn");
    cleanup();
    sidebar(3, 0, true);
    expect(mergeLink().querySelector(".count-dot")).not.toBeNull();
    expect(mergeLink().querySelector(".count-dot")!.className).not.toContain("warn");
  });
});

const decision = (over: Partial<Decision> = {}): Decision => ({
  id: "d1",
  companyId: "c1",
  kind: "permission",
  question: "Runs a command.",
  options: ["Allow once", "Deny"],
  recommendedOption: "Deny",
  tier: "owner",
  createdAt: new Date().toISOString(),
  companyName: "App Co",
  agentName: "Engineer",
  blocks: [],
  score: 10,
  parts: { blocking: 0, urgency: 0, age: 10, liveRun: 0 },
  reasons: [],
  ageReason: "",
  dueDate: null,
  ...over,
});
const explain = { title: "Runs a program", summary: "It deletes files.", effect: "deletes" as const, command: "rm -rf /tmp/../home" };

describe("the permission card's owner line (BOS-793)", () => {
  it("shows the line saying why the card is the owner's, and shows nothing extra without one", () => {
    const why = "Sent to you, not the CEO, because the destructive-command guard caught part of it (deletes files): rm -rf /tmp/../home.";
    render(<Decisions decisions={[decision({ context: { type: "permission", explain: { ...explain, ownerWhy: why } } })]} companies={[company]} loaded agentsWorking={0} onAnswered={noop} />);
    expect(screen.getByText(why)).toBeTruthy();
    cleanup();
    render(<Decisions decisions={[decision({ context: { type: "permission", explain } })]} companies={[company]} loaded agentsWorking={0} onAnswered={noop} />);
    expect(screen.queryByText(/Sent to you, not the CEO/)).toBeNull();
  });
});

describe("Settled or withdrawn (BOS-740)", () => {
  it("lists a card Boss Man closed by itself with its reason and its closed-card notice, and one the CEO cleared with just its note", () => {
    render(
      <Decisions
        decisions={[]}
        companies={[company]}
        loaded
        agentsWorking={0}
        onAnswered={noop}
        advised={[
          { id: "a1", companyId: "c1", question: "Set up the second plan", withdrawn: { by: "Boss Man", note: "Switched back: not running any more.", notice: "You can stop: there is nothing to finish." } },
          { id: "a2", companyId: "c1", question: "Old question", withdrawn: { by: "the CEO", note: "Stale." } },
        ]}
      />,
    );
    // BOS-804/805: closed cards fold into one "Closed (N)" list; each is a one-line summary that opens to its note.
    expect(screen.getByText("Closed in the last 30 days (2)")).toBeTruthy();
    expect(screen.getByText(/withdrawn by Boss Man/)).toBeTruthy();
    expect(screen.getByText("Switched back: not running any more. (You can stop: there is nothing to finish.)")).toBeTruthy();
    expect(screen.getByText(/withdrawn by the CEO/)).toBeTruthy();
    const ceoNote = screen.getByText("Stale.");
    expect(ceoNote.textContent).not.toContain("(");
  });
});
