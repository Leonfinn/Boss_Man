// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import type { Company, Decision } from "../src/api";
import { NeedsYou, healthLines } from "../src/components/DashboardPanels";
import { StartBlockBar, missingText, notStartedReason, type StartBlock } from "../src/components/StartBlock";
import { Decisions } from "../src/pages/Decisions";

// BOS-2814: a first task is never left silently stuck. The bar, the task's "Not started" reason, and the calm
// lines that must not say "Nothing needs you" or "Every agent can start" while nothing can.

afterEach(cleanup);

const item = (id: "claude" | "funding" | "runner") => ({ id, label: { claude: "a Claude account", funding: "what pays for the CEO", runner: "a running workspace" }[id] });
const block = (...ids: Array<"claude" | "funding" | "runner">): StartBlock => ({ items: ids.map(item), noFunding: [] });

describe("the red bar", () => {
  it("names at most two missing items, then 'and 1 more', with a Finish setting up button and no way to dismiss", () => {
    render(<StartBlockBar block={block("claude", "funding", "runner")} />);
    const bar = screen.getByTestId("start-block-bar");
    expect(bar.textContent).toContain("Your agents can't start yet.");
    expect(bar.textContent).toContain("a Claude account and what pays for the CEO and 1 more");
    expect(screen.getByRole("link", { name: "Finish setting up" }).getAttribute("href")).toBe("#/setup");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("is gone when nothing is missing, or the read hasn't come", () => {
    const { container, rerender } = render(<StartBlockBar block={block()} />);
    expect(container.textContent).toBe("");
    rerender(<StartBlockBar block={null} />);
    expect(container.textContent).toBe("");
  });

  it("joins two items with 'and' only", () => {
    expect(missingText([item("claude"), item("runner")])).toBe("a Claude account and a running workspace");
  });
});

describe("a task's 'Not started' reason", () => {
  it("is the missing account for the CEO, then the workspace, each with its own fix link", () => {
    expect(notStartedReason(block("claude"), "ceo1", "the CEO", "c1")).toEqual({ text: "Not started: the CEO has no Claude account to run on yet.", link: "#/setup", linkText: "Connect one" });
    expect(notStartedReason(block("runner"), "ceo1", "the CEO", "c1")).toEqual({ text: "Not started: the agents' workspace isn't running.", link: "#/settings/c1/runner", linkText: "Start it" });
    // An agent that nothing pays for can't run even when the company has a Claude account.
    expect(notStartedReason({ items: [], noFunding: ["w1"] }, "w1", "Fern", "c1")?.linkText).toBe("Connect one");
  });

  it("is nothing when the assignee can run", () => {
    expect(notStartedReason(block(), "ceo1", "the CEO", "c1")).toBeNull();
    expect(notStartedReason(null, "ceo1", "the CEO", "c1")).toBeNull();
    expect(notStartedReason(block("claude"), null, null, "c1")).toBeNull();
  });
});

describe("the calm lines", () => {
  it("the Dashboard doesn't say 'Nothing needs you' while nothing can start", () => {
    render(<NeedsYou decisions={[] as Decision[]} tally={{ open: 0, waiting: 0 }} cantStart />);
    expect(screen.queryByText("Nothing needs you.")).toBeNull();
    expect(screen.getByText("No decisions yet. When an agent needs an answer, an approval or more budget, it appears here.")).toBeTruthy();
  });

  it("the usage line doesn't say every agent can start when none can", () => {
    const usage = (cantStart: boolean) => healthLines({ health: { usage: { agents: 0, accounts: [], firstResetAt: null } }, merges: null, stuck: null, running: 0, companyId: "c1", cantStart }).find((l) => l.key === "usage")!;
    expect(usage(false).text).toBe("Every agent can start when it has work.");
    expect(usage(true).text).not.toMatch(/Every agent can start/);
    expect(usage(true).href).toBe("#/setup");
  });
});

describe("the Decisions page while nothing can start (BOS-2814)", () => {
  const company: Company = { id: "c1", name: "Acme Co", mission: null, paused: false, agents: [] };
  const render = (decisions: Decision[], startBlock: StartBlock | null) =>
    renderToStaticMarkup(<Decisions decisions={decisions} companies={[company]} loaded agentsWorking={0} onAnswered={() => {}} startBlock={startBlock} />);

  it("shows the red bar and the calm empty state, with no 'Nothing needs you' and no celebration", () => {
    const html = render([], block("claude", "runner"));
    expect(html).toMatch(/Your agents can(?:'|&#x27;)t start yet\./);
    expect(html).toContain('data-testid="start-block-bar"');
    expect(html).toContain("No decisions yet. When an agent needs an answer, an approval or more budget, it appears here.");
    expect(html).not.toContain("Nothing needs you");
    // The celebration and the busy pictures are the empty state the bar replaces; neither is rendered.
    expect(html).not.toMatch(/state[\s\S]*?<img/);
    // The bar comes before the empty-state words.
    expect(html.indexOf('data-testid="start-block-bar"')).toBeLessThan(html.indexOf("No decisions yet."));
  });

  it("keeps the bar above real cards, so it isn't hidden while nothing can still start", () => {
    const card = { id: "d1", companyId: "c1", kind: "question", question: "Which colour?", options: ["Blue", "Green"], recommendedOption: "Blue", tier: "owner", createdAt: new Date().toISOString(), companyName: "Acme Co", agentName: null, blocks: [], score: 1, parts: { blocking: 0, urgency: 0, age: 0, liveRun: 0 }, reasons: [], ageReason: "", dueDate: null, context: null } as unknown as Decision;
    const html = render([card], block("claude"));
    expect(html).toContain('data-testid="start-block-bar"');
    expect(html.indexOf('data-testid="start-block-bar"')).toBeLessThan(html.indexOf("Which colour?"));
  });

  it("is the ordinary Decisions page when everything is set up", () => {
    const html = render([], block());
    expect(html).not.toContain("start-block-bar");
    expect(html).toContain("Nothing needs you");
  });
});
