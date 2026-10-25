// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company, Decision } from "../src/api";
import { Decisions } from "../src/pages/Decisions";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const company: Company = { id: "c1", name: "App Co", mission: null, paused: false, agents: [] };
const decision = (over: Partial<Decision> = {}): Decision => ({
  id: "d1",
  companyId: "c1",
  kind: "budget",
  question: "App Co has used 92% of its $60 budget. Raise it?",
  options: ["Raise to $80", "Keep $60"],
  recommendedOption: "Raise to $80",
  tier: "owner",
  createdAt: new Date().toISOString(),
  companyName: "App Co",
  agentName: "CEO",
  blocks: [{ id: "t1", title: "Checkout error states" }],
  score: 52.4,
  parts: { blocking: 30, urgency: 12, age: 10.4, liveRun: 0 },
  reasons: ["Waiting 40 min"],
  dueDate: null,
  ...over,
});

describe("decision queue", () => {
  it("an instruction change shows the full new text from the decision, first lines until opened", async () => {
    const full = Array.from({ length: 30 }, (_, i) => `Line ${i + 1} of Radagast's instructions.`).join("\n");
    const d = decision({
      kind: "approval",
      question: `The CEO wants to change Radagast's instructions.\n\nWhy: migration.\n\nNew instructions:\n${full.slice(0, 200)}`,
      options: ["Apply the change", "Keep them as they are"],
      recommendedOption: "Apply the change",
      context: { type: "instructions", instructions: full },
    });
    render(<Decisions decisions={[d]} companies={[company]} loaded agentsWorking={0} onAnswered={() => {}} />);
    expect(screen.getByRole("heading", { name: /The CEO wants to change Radagast's instructions\.\s+Why: migration\.$/ })).toBeTruthy();
    expect(screen.getByText(/Line 8 of/)).toBeTruthy();
    expect(screen.queryByText(/Line 30 of/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show all (22 more lines)" }));
    expect(screen.getByText(/Line 30 of Radagast's instructions\./)).toBeTruthy();
  });

  it("a team plan: the owner unticks a hire and only the ticked ones are sent (docs/13)", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const plan = decision({
      kind: "approval",
      question: "Team plan for Site: the CEO proposes 2 hires.",
      options: ["Hire the ticked ones", "Not now"],
      recommendedOption: "Hire the ticked ones",
      context: { type: "team_plan", hires: [{ name: "Quinn", template: "qa", reason: "Checks releases.", skills: ["dogfood"] }, { name: "Rae", reason: "Writes the copy." }] },
    });
    render(<Decisions decisions={[plan]} companies={[company]} loaded agentsWorking={0} onAnswered={() => {}} />);
    expect(screen.getByText("Skills: dogfood.", { exact: false })).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: /Rae/ }));
    fireEvent.click(screen.getByRole("button", { name: "Hire the ticked ones" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/decisions/d1/answer", expect.objectContaining({ body: JSON.stringify({ answer: "Hire the ticked ones", picks: [0] }) })));
  });

  it("shows the score, what it blocks and the recommendation, and answers with one click", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const onAnswered = vi.fn();
    render(<Decisions decisions={[decision()]} companies={[company]} loaded agentsWorking={0} onAnswered={onAnswered} />);

    expect(screen.getByRole("heading", { name: "App Co has used 92% of its $60 budget. Raise it?" })).toBeTruthy();
    expect(screen.getByLabelText("Score 52")).toBeTruthy();
    expect(screen.getByText('Blocks "Checkout error states"')).toBeTruthy();
    expect(screen.getByText("Score 52: 30 for the tasks it blocks + 12 for being due soon + 10.4 for waiting.")).toBeTruthy();
    expect(screen.getByText(/what it holds up: tasks it blocks, or 5 when an agent is paused/)).toBeTruthy();
    expect(screen.getByText("1 decision waiting across all companies, ranked by what they unblock.", { exact: false })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Raise to $80" }));
    await waitFor(() => expect(screen.getByText("Answered: Raise to $80.")).toBeTruthy());
    expect(fetch).toHaveBeenCalledWith("/api/decisions/d1/answer", expect.objectContaining({ method: "POST", body: JSON.stringify({ answer: "Raise to $80" }) }));
    expect(onAnswered).toHaveBeenCalled();
  });

  it("explains a paused agent's score", () => {
    render(<Decisions decisions={[decision({ score: 5, parts: { blocking: 0, urgency: 0, age: 0, liveRun: 5 } })]} companies={[company]} loaded agentsWorking={0} onAnswered={() => {}} />);
    expect(screen.getByText("Score 5: 5 for a paused agent + 0 for waiting.")).toBeTruthy();
  });

  it("says why an answer was refused", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "invalid_answer", message: "That ticket is already done." }), { status: 422 })));
    render(<Decisions decisions={[decision()]} companies={[company]} loaded agentsWorking={0} onAnswered={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Keep $60" }));
    expect((await screen.findByRole("alert")).textContent).toBe("That ticket is already done.");
  });

  it("is empty with the right illustration: done when idle, busy while agents work", () => {
    const { rerender } = render(<Decisions decisions={[]} companies={[company]} loaded agentsWorking={0} onAnswered={() => {}} />);
    expect(screen.getByRole("img", { name: "Nothing needs you" })).toBeTruthy();
    rerender(<Decisions decisions={[]} companies={[company]} loaded agentsWorking={2} onAnswered={() => {}} />);
    expect(screen.getByRole("img", { name: "Agents at work, nothing needs you" })).toBeTruthy();
    expect(screen.getByText(/2 agents are working/)).toBeTruthy();
  });

  it("shows the evidence on a stalled run and what each button does", async () => {
    const ago = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
    const evidence = {
      runId: "r1",
      agent: "CEO",
      ticketId: "t1",
      ticket: "Checkout error states",
      startedAt: ago(40),
      lastEventAt: ago(14),
      lastStep: { seq: 3, type: "run.update", at: ago(14), event: { update: { kind: "tool_call", title: "Run npm test", status: "in_progress" } } },
      runner: { connected: false, lastSeenAt: ago(20) },
      waitingOnOwner: false,
    };
    const items = [1, 2, 3, 4, 5, 6].map((n) => ({ seq: n, type: "run.update", at: ago(30 - n), event: { update: { kind: "tool_call", title: `Step ${n}`, status: "done" } } }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ run: { id: "r1", endedAt: null }, items, next: 6, more: false }), { status: 200 })));
    render(
      <Decisions
        decisions={[decision({ kind: "stalled_run", question: "CEO has sent nothing for 14 minutes.", options: ["Keep waiting", "Cancel run"], recommendedOption: "Keep waiting", evidence })]}
        companies={[company]}
        loaded
        agentsWorking={0}
        onAnswered={() => {}}
      />,
    );
    expect(screen.getByRole("link", { name: "Checkout error states" }).getAttribute("href")).toBe("#/tickets/t1");
    expect(screen.getByText("Last activity 14 minutes ago: Run npm test in_progress")).toBeTruthy();
    expect(screen.getByText("Runner: offline since", { exact: false })).toBeTruthy();
    expect(screen.getByText("It is not waiting on you.")).toBeTruthy();
    expect(screen.getByText("Cancel run: stops it; message the agent on the task to start again.")).toBeTruthy();
    expect(screen.getByText("Keep waiting: you'll be asked again in 30 minutes if it stays quiet.")).toBeTruthy();
    expect((await screen.findByRole("link", { name: "See the whole run" })).getAttribute("href")).toBe("#/runs/r1");
    expect(screen.queryByText("Step 1")).toBeNull();
    expect(screen.getByText("Step 6")).toBeTruthy();
  });

  it("says when a stalled run never gave a sign of life", () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ run: { id: "r1", endedAt: null }, items: [], next: 0, more: false }), { status: 200 })));
    const evidence = { runId: "r1", agent: "CEO", ticketId: null, ticket: null, startedAt: new Date().toISOString(), lastEventAt: null, lastStep: null, runner: { connected: true, lastSeenAt: null }, waitingOnOwner: true };
    render(<Decisions decisions={[decision({ kind: "stalled_run", options: ["Cancel run"], evidence })]} companies={[company]} loaded agentsWorking={0} onAnswered={() => {}} />);
    expect(screen.getByText("No sign of life since it was sent to the runner.")).toBeTruthy();
    expect(screen.getByText("Runner: connected.")).toBeTruthy();
    expect(screen.getByText("It is waiting on you for a permission answer.")).toBeTruthy();
  });
});

describe("permission cards", () => {
  it("lead with plain words and keep the command behind a fold", () => {
    const explain = { title: "Wiki Maintainer wants to run a command", summary: "Only reads information (the machine's memory); it doesn't change anything.", effect: "reads" as const, command: "grep MemTotal /proc/meminfo", reason: "Check how much memory is available" };
    render(<Decisions decisions={[decision({ kind: "permission", question: "ignored", options: ["Allow once", "Deny"], recommendedOption: "Allow once", context: { type: "permission", explain } })]} companies={[company]} loaded agentsWorking={0} onAnswered={() => {}} />);
    expect(screen.getByRole("heading", { name: explain.title })).toBeTruthy();
    expect(screen.getByText("Reads only")).toBeTruthy();
    expect(screen.getByText(explain.summary, { exact: false })).toBeTruthy();
    expect(screen.getByText("What the agent says it's for: Check how much memory is available")).toBeTruthy();
    const details = screen.getByText("Show the exact command").closest("details")!;
    expect(details.hasAttribute("open")).toBe(false);
    expect(details.textContent).toContain("grep MemTotal /proc/meminfo");
    expect(document.body.textContent!.split("grep MemTotal").length).toBe(2);
    expect(screen.getByRole("button", { name: "Deny" })).toBeTruthy();
  });
});

describe("Allow always", () => {
  const explain = { title: "Researcher wants to use a tool", summary: "Uses the tool.", effect: "unknown" as const };
  it("offers the scopes as buttons and says where the rule went", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })));
    const always = [{ label: "Always allow crawl4ai's md tool" }, { label: "Always allow every crawl4ai tool" }];
    render(<Decisions decisions={[decision({ kind: "permission", options: ["Allow once", ...always.map((a) => a.label), "Deny"], context: { type: "permission", explain, always } })]} companies={[company]} loaded agentsWorking={0} onAnswered={() => {}} />);
    expect(screen.getByRole("button", { name: "Always allow every crawl4ai tool" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Always allow crawl4ai's md tool" }));
    await waitFor(() => expect(screen.getByText(/Saved as a rule in Settings → Rules\./)).toBeTruthy());
  });
  it("says why a command has no always option", () => {
    render(<Decisions decisions={[decision({ kind: "permission", options: ["Allow once", "Deny"], context: { type: "permission", explain: { ...explain, alwaysNote: "Boss Man doesn't offer 'always' for commands that change, delete, push or use the network." } } })]} companies={[company]} loaded agentsWorking={0} onAnswered={() => {}} />);
    expect(screen.getByText(/doesn't offer 'always'/)).toBeTruthy();
  });

  it("shows a proposed rule's explanation and folds the exact rule away", () => {
    const d = decision({
      kind: "question",
      question: "The CEO proposes a rule: Allow GitHub reads\n\nAgents can read from GitHub without asking you. It would not catch pushes.",
      options: ["Add this rule", "Don't add"],
      recommendedOption: "Add this rule",
      context: { type: "rule_proposal", rule: { name: "Allow GitHub reads", outcome: "allow", match: { titlePattern: "^mcp__github__(get|list)_", safeOnly: true } } },
    });
    render(<Decisions decisions={[d]} companies={[company]} loaded agentsWorking={0} onAnswered={() => {}} />);
    expect(screen.getByRole("heading", { name: "The CEO proposes a rule: Allow GitHub reads" })).toBeTruthy();
    expect(screen.getByText(/Agents can read from GitHub without asking you/)).toBeTruthy();
    const fold = screen.getByText("The exact rule").closest("details")!;
    expect(fold.open).toBe(false);
    expect(fold.textContent).toContain("^mcp__github__(get|list)_");
    expect(fold.textContent).toContain("Then: Allow");
    expect(screen.getByRole("button", { name: "Add this rule" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Write my own answer" })).toBeTruthy();
  });
});
