// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company, Decision } from "../src/api";
import { Decisions } from "../src/pages/Decisions";
import { when } from "../src/pages/Runs";

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
  blocks: [{ ticketId: "t1", ref: "APP-3", title: "Checkout error states" }],
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
    fireEvent.click(screen.getByRole("button", { name: "▸ Show all (22 more lines)" }));
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
    expect(screen.getByRole("link", { name: "APP-3 Checkout error states" }).getAttribute("href")).toBe("#/tickets/t1");
    expect(screen.getByText("Score 52: 30 for the tasks it blocks + 12 for being due soon + 10.4 for waiting.")).toBeTruthy();
    // The legend folds away behind one line (BOS-245), so it opens before it can be read.
    fireEvent.click(screen.getByText("How the ranking works"));
    expect(screen.getByText(/what it holds up: tasks it blocks, or 5 when an agent is paused/)).toBeTruthy();
    // The list really is newest first, so the subtitle says so rather than "ranked by what they unblock".
    expect(screen.getByText(`1 decision waiting in ${company.name}, newest first.`, { exact: false })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Raise to $80" }));
    await waitFor(() => expect(screen.getByText("Answered: Raise to $80.")).toBeTruthy());
    expect(fetch).toHaveBeenCalledWith("/api/decisions/d1/answer", expect.objectContaining({ method: "POST", body: JSON.stringify({ answer: "Raise to $80" }) }));
    expect(onAnswered).toHaveBeenCalled();
  });

  it("a deploy card says what it touches, the file count and what else is needed (BOS-218)", () => {
    const d = decision({
      kind: "approval",
      question: "Main has moved to bbbbbbbb. This update has to be applied by hand on the machine that runs Boss Man.",
      options: ["Approve", "Not now"],
      recommendedOption: "Approve",
      blocks: [],
      context: {
        type: "self_deploy",
        update: {
          from: "a".repeat(40),
          to: "b".repeat(40),
          total: 2,
          files: 5,
          changes: [{ ticketId: "t1", ref: "APP-1", title: "Change one" }],
          more: 0,
          otherCommits: [],
          handBecause: "Needs applying by hand because this update changes scripts/host-deployer.sh.",
          handFiles: ["scripts/host-deployer.sh", "docker-compose.yml"],
          handEffect: "both",
          needsDeployerCopy: true,
          needsRunnerUpdate: false,
          risks: [],
        },
        handSteps: ["First step"],
      },
    });
    render(<Decisions decisions={[d]} companies={[company]} loaded agentsWorking={0} onAnswered={() => {}} />);
    expect(screen.getByText("This update brings 2 changes across 5 files since the live version (aaaaaaaa → bbbbbbbb).")).toBeTruthy();
    expect(screen.getByText(/This changes both the script that runs deploys/)).toBeTruthy();
    expect(screen.getByText("Deployer copy: needed.")).toBeTruthy();
    expect(screen.getByText("Runner update afterwards: not needed.")).toBeTruthy();
  });

  it("links the ticket it is about, the tickets it blocks, and known references in the text", () => {
    const d = decision({
      kind: "question",
      question: "The restore proof (APP-70) needs one run. Also see ZZZ-9.",
      about: [{ ticketId: "t70", ref: "APP-70", title: "Restore proof" }],
      blocks: [{ ticketId: "t70", ref: "APP-70", title: "Restore proof" }, { ticketId: "t71", ref: "APP-71", title: "Release" }],
      refs: { "APP-70": { ticketId: "t70", ref: "APP-70", title: "Restore proof" } },
    });
    render(<Decisions decisions={[d]} companies={[company]} loaded agentsWorking={0} onAnswered={() => {}} />);
    expect(screen.getByRole("link", { name: "APP-70" }).getAttribute("href")).toBe("#/tickets/t70");
    expect(screen.getByRole("link", { name: "APP-71 Release" }).getAttribute("href")).toBe("#/tickets/t71");
    expect(screen.queryByRole("link", { name: "ZZZ-9" })).toBeNull();
    expect(screen.getByRole("heading", { name: /ZZZ-9/ })).toBeTruthy();
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
    // Another company's decisions are named, one click from switching to it.
    const onPick = vi.fn();
    const other = render(<Decisions decisions={[]} companies={[company]} loaded agentsWorking={0} onAnswered={() => {}} elsewhere={[{ id: "c2", name: "HolidayHours", count: 9 }]} onPickCompany={onPick} />);
    fireEvent.click(screen.getByRole("button", { name: "9 in HolidayHours" }));
    expect(onPick).toHaveBeenCalledWith("c2");
    other.unmount();
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
  it("say first when everything happens in a temporary folder", () => {
    const explain = { title: "Saruman wants to run a command", summary: "Deletes files (/tmp/mut).", effect: "deletes" as const, command: "rm -rf /tmp/mut", scratch: { note: "Works only in a temporary folder (/tmp): every file it changes or deletes is there.", unchecked: [] } };
    render(<Decisions decisions={[decision({ kind: "permission", question: "ignored", options: ["Allow once", "Deny"], recommendedOption: "Allow once", context: { type: "permission", explain } })]} companies={[company]} loaded agentsWorking={0} onAnswered={() => {}} />);
    expect(screen.getByText("Temporary folder only")).toBeTruthy();
    expect(screen.getByText(/Works only in a temporary folder/)).toBeTruthy();
  });

  it("says where a push goes, links its ticket branch and shows danger in red", () => {
    const ticketId = "11111111-2222-4333-8444-555555555555";
    const explain = { title: "Dev wants to run a command", summary: "Pushes to its ticket branch. Pushes to main.", effect: "pushes" as const, command: "git push origin HEAD:main", push: { kind: "ticket" as const, headline: "Pushes to its ticket branch", ticketId, ref: "BOS-208", warnings: ["Pushes to main."], dangerous: true } };
    render(<Decisions decisions={[decision({ kind: "permission", question: "ignored", options: ["Allow once", "Deny"], recommendedOption: "Deny", context: { type: "permission", explain } })]} companies={[company]} loaded agentsWorking={0} onAnswered={() => {}} />);
    expect(screen.getByRole("link", { name: "BOS-208" }).getAttribute("href")).toBe(`#/tickets/${ticketId}`);
    expect(screen.getByText("Pushes to main.")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Pushes to main.");
    expect(screen.getByRole("button", { name: "Deny" }).className).toContain("primary");
  });

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

describe("owner asks with steps", () => {
  it("shows the steps as a numbered list and what the agent tried first, collapsed", () => {
    const d = decision({
      kind: "question",
      question: "Please update the runners.",
      options: ["Done"],
      recommendedOption: "Done",
      context: { type: "question", steps: ["Open Settings → Server and runner.", "Click Build and update runners."], triedFirst: "Tried from the run; no host access." },
    });
    const { container } = render(<Decisions decisions={[d]} companies={[company]} loaded agentsWorking={0} onAnswered={() => {}} />);
    const items = container.querySelectorAll("ol[data-steps] > li");
    expect(Array.from(items).map((li) => li.textContent)).toEqual(["Open Settings → Server and runner.", "Click Build and update runners."]);
    const tried = screen.getByText(/tried first/).closest("details")!;
    expect(tried.open).toBe(false);
    expect(tried.textContent).toMatch(/no host access/);
  });
});

describe("references in steps and folded text", () => {
  it("links a reference inside a step and inside the folded part of a long question", () => {
    const refs = { "BOS-70": { ticketId: "t70", title: "Restore proof", ref: "BOS-70" } };
    const long = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    const d = decision({
      kind: "question",
      question: `Run it.\n\n${long}\nSee BOS-70.`,
      options: ["Done"],
      recommendedOption: "Done",
      context: { type: "question", steps: ["Follow the steps on BOS-70."] },
      refs,
    } as never);
    const { container } = render(<Decisions decisions={[d]} companies={[company]} loaded agentsWorking={0} onAnswered={() => {}} />);
    expect(container.querySelector("ol[data-steps] a")?.getAttribute("href")).toBe("#/tickets/t70");
    fireEvent.click(screen.getByRole("button", { name: /Show all/ }));
    expect(Array.from(container.querySelectorAll("a")).filter((a) => a.getAttribute("href") === "#/tickets/t70").length).toBe(2);
  });
});

describe("raised time", () => {
  it("every card kind shows when it was raised, in the notifications format, from the original time", () => {
    const earlier = "2026-10-20T09:30:00.000Z";
    const now = new Date().toISOString();
    const kinds = ["budget", "question", "permission", "approval"];
    const ds = kinds.map((kind, i) => decision({ id: `d${i}`, kind, createdAt: i === 0 ? earlier : now, question: `Card ${kind}` }));
    render(<Decisions decisions={ds} companies={[company]} loaded agentsWorking={0} onAnswered={() => {}} />);
    const times = Array.from(document.querySelectorAll("time")).map((t) => t.textContent);
    expect(times).toHaveLength(4);
    expect(times[0]).toBe(when(earlier));
    expect(times[1]).toBe(when(now));
  });

  it("Reassign on a stale-blocker card opens a picker of that company's agents, and won't send without a pick", async () => {
    const fetch = vi.fn(async (url: string) => new Response(JSON.stringify(url.startsWith("/api/tickets/") ? { assigneeAgentId: "a1" } : { ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const co: Company = { ...company, agents: [{ id: "a1", name: "Celebrimbor", title: "Dev" }, { id: "a2", name: "Galadriel", title: "QA" }] as Company["agents"] };
    const other: Company = { id: "c2", name: "Other Co", mission: null, paused: false, agents: [{ id: "x1", name: "Elsewhere" }] as Company["agents"] };
    const d = decision({ kind: "stale_blocker", question: "A is stuck.", options: ["Chase", "Reassign", "Let the CEO decide", "Drop dependency"], recommendedOption: "Chase", context: { type: "stale_blocker", blockerTicketId: "t9" } });
    render(<Decisions decisions={[d]} companies={[co, other]} loaded agentsWorking={0} onAnswered={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Reassign" }));
    await waitFor(() => expect(screen.getByText("(has it now)")).toBeTruthy());
    expect(screen.getByRole("radio", { name: /Galadriel, QA/ })).toBeTruthy();
    expect(screen.queryByText(/Elsewhere/)).toBeNull();
    expect(fetch).not.toHaveBeenCalledWith("/api/decisions/d1/answer", expect.anything());

    fireEvent.click(screen.getByRole("button", { name: "Reassign to the one I picked" }));
    expect(screen.getByRole("alert").textContent).toBe("Pick who should take this ticket.");

    fireEvent.click(screen.getByRole("radio", { name: /Galadriel/ }));
    fireEvent.click(screen.getByRole("button", { name: "Reassign to the one I picked" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/decisions/d1/answer", expect.objectContaining({ body: JSON.stringify({ answer: "Reassign", assigneeAgentId: "a2" }) })));
  });
});

describe("model change cards (BOS-128)", () => {
  const modelChange = (over: Partial<Decision> = {}): Decision =>
    decision({
      kind: "approval",
      question: "The CEO wants to change Engineer's model setup.\n\nCurrent: Harness: Claude Code · Provider: Anthropic · Model: claude-opus-4-5 · Paid from: Claude Max\n\nProposed: Harness: OpenCode · Provider: Ollama · Model: qwen3:8b · Paid from: Ollama Cloud\n\nIt takes effect before their next run.",
      options: ["Approve", "Edit", "Reject"],
      recommendedOption: "Approve",
      context: {
        type: "model_change",
        before: { harness: "claude", provider: "anthropic", model: "claude-opus-4-5", fundingSourceId: "f1", fundingSourceName: "Claude Max" },
        proposed: { harness: "opencode", provider: "ollama", model: "qwen3:8b", fundingSourceId: "f2", fundingSourceName: "Ollama Cloud" },
      },
      ...over,
    });

  it("shows current vs proposed for all four fields and sends an edited setup through the same answer", async () => {
    const fetch = vi.fn(async (url: string, _init?: RequestInit) => {
      if (String(url) === "/api/funding-sources") return new Response(JSON.stringify([
        { id: "f1", name: "Claude Max", kind: "subscription", provider: "anthropic" },
        { id: "f2", name: "Ollama Cloud", kind: "subscription", provider: "ollama" },
      ]), { status: 200, headers: { "content-type": "application/json" } });
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetch);
    render(<Decisions decisions={[modelChange()]} companies={[company]} loaded agentsWorking={0} onAnswered={() => {}} />);
    for (const text of ["Harness", "Provider", "Paid from"]) expect(screen.getAllByText(text).length).toBeGreaterThan(0);
    expect(screen.getByText("Claude Code")).toBeTruthy();
    expect(screen.getByText("OpenCode")).toBeTruthy();
    expect(screen.getByText("Claude Max")).toBeTruthy();
    expect(screen.getByText("Ollama Cloud")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    await waitFor(() => expect(screen.getByLabelText("Harness")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "qwen3:14b" } });
    fireEvent.change(screen.getByLabelText("Paid from"), { target: { value: "f2" } });
    fireEvent.click(screen.getByRole("button", { name: "Save and approve" }));
    await waitFor(() => expect(fetch.mock.calls.some((c) => c[0] === "/api/decisions/d1/answer")).toBe(true));
    const call = fetch.mock.calls.find((c) => c[0] === "/api/decisions/d1/answer")!;
    expect(JSON.parse(String((call[1] as { body: string }).body))).toEqual({ answer: "Edit", modelConfig: { harness: "opencode", provider: "ollama", model: "qwen3:14b", fundingSourceId: "f2" } });
  });
});

describe("write my own answer", () => {
  const open = (over: Partial<Decision> = {}) => {
    const d = decision({ kind: "question", question: "Merge check failed.", options: ["Run the check again", "Skip"], recommendedOption: "Run the check again", ...over });
    render(<Decisions decisions={[d]} companies={[company]} loaded agentsWorking={0} onAnswered={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Write my own answer" }));
    return screen.getByRole("textbox") as HTMLTextAreaElement;
  };

  it("opens empty with the suggestion as placeholder and Send disabled", () => {
    const box = open();
    expect(box.value).toBe("");
    expect(box.placeholder).toBe("Run the check again");
    expect((screen.getByRole("button", { name: "Send my answer" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("Tab on the empty box accepts the suggestion", () => {
    const box = open();
    fireEvent.keyDown(box, { key: "Tab" });
    expect(box.value).toBe("Run the check again");
    expect((screen.getByRole("button", { name: "Send my answer" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("the Use suggestion link does the same and Tab does nothing once there is text", () => {
    const box = open();
    fireEvent.click(screen.getByRole("button", { name: "Use suggestion" }));
    expect(box.value).toBe("Run the check again");
    expect(screen.queryByRole("button", { name: "Use suggestion" })).toBeNull();
    fireEvent.change(box, { target: { value: "mine" } });
    expect(fireEvent.keyDown(box, { key: "Tab" })).toBe(true);
    expect(box.value).toBe("mine");
  });

  it("whitespace alone does not enable Send", () => {
    const box = open();
    fireEvent.change(box, { target: { value: "   " } });
    expect((screen.getByRole("button", { name: "Send my answer" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("approval card while the merge runs", () => {
  const approval = (over: Partial<Decision> = {}) =>
    decision({
      kind: "approval",
      question: "Ada approved \"Export CSV\", which is rated medium risk. Merge it, or send it back?",
      options: ["Approve and merge", "Send it back"],
      recommendedOption: "Approve and merge",
      context: { type: "risk_review", ticketId: "t9" },
      ...over,
    });

  it("says who is checking and merging, and offers no approve button", async () => {
    const startedAt = new Date(Date.now() - 4 * 60_000).toISOString();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/api/tickets/t9/landing") return new Response(JSON.stringify({ landing: { state: "running", startedAt, startedBy: "the owner" } }), { status: 200 });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
    );
    render(<Decisions decisions={[approval()]} companies={[company]} loaded agentsWorking={0} onAnswered={() => {}} />);
    expect(await screen.findByText(/Checking and merging since .*started by the owner/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve and merge" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Send it back" })).toBeNull();
  });

  it("turns an 'already being checked' refusal into a neutral notice and refreshes the card", async () => {
    let started = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/api/tickets/t9/landing") {
          return new Response(JSON.stringify({ landing: started ? { state: "running", startedAt: new Date().toISOString(), startedBy: "the owner" } : null }), { status: 200 });
        }
        if (url === "/api/decisions/d1/answer") {
          started = true;
          return new Response(JSON.stringify({ error: "review", message: "This ticket is already being checked and merged." }), { status: 409 });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
    );
    render(<Decisions decisions={[approval()]} companies={[company]} loaded agentsWorking={0} onAnswered={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Approve and merge" }));
    expect(await screen.findByText(/Already being checked and merged since .*nothing more to do\./)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: "Approve and merge" })).toBeNull();
  });
});
