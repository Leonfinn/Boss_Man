// @vitest-environment jsdom
// BOS-1236: one card layout for every kind: the question, what it is about, "Your answer" with a line under each
// button saying what it does, the sign-off facts, the plan preview, the re-check strip and the closed list's verbs.
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { AdvisedDecision, Company, Decision } from "../src/api";
import { Decisions, effectOf, firstSentence } from "../src/pages/Decisions";

afterEach(cleanup);

const company: Company = { id: "c1", name: "App Co", mission: null, paused: false, agents: [] };
const decision = (over: Partial<Decision> = {}): Decision => ({
  id: "d1",
  companyId: "c1",
  kind: "approval",
  question: "Approve Moss's plan for \"Export CSV\"?",
  options: ["Approve plan", "Keep planning"],
  recommendedOption: "Approve plan",
  tier: "owner",
  createdAt: new Date().toISOString(),
  companyName: "App Co",
  agentName: "Moss",
  blocks: [],
  about: [{ ticketId: "t1", ref: "APP-3", title: "Export CSV" }],
  score: 0,
  parts: { blocking: 0, urgency: 0, age: 0, liveRun: 0 },
  reasons: [],
  ageReason: "",
  dueDate: null,
  ...over,
});
const show = (d: Decision, extra: Partial<Parameters<typeof Decisions>[0]> = {}) => render(<Decisions decisions={[d]} companies={[company]} loaded agentsWorking={0} onAnswered={() => {}} {...extra} />);

describe("the line under each button", () => {
  it("a plan card: what Approve plan and Keep planning set off, each tied to its button", () => {
    show(decision());
    expect(screen.getByText("Moss starts building now. Nothing merges until the reviewers pass it and you sign it off.")).toBeTruthy();
    expect(screen.getByText("Moss keeps planning and rewrites the plan, using your note. Nothing is built.")).toBeTruthy();
    const approve = screen.getByRole("button", { name: "Approve plan, recommended" });
    expect(document.getElementById(approve.getAttribute("aria-describedby")!)?.textContent).toContain("Moss starts building now.");
    expect(screen.getAllByText("Recommended")).toHaveLength(1);
    expect(screen.getByText("Your answer")).toBeTruthy();
  });

  it("a plan that amends an approved one says the earlier approval stays in force", () => {
    show(decision({ question: "Approve Moss's plan for \"Export CSV\"? This amends the approved plan of 2026-11-10T09:30:00.000Z; the approval stays in force." }));
    expect(screen.getByText(/Moss carries on with these changes\. Your earlier approval \(of .+\) stays in force either way\./)).toBeTruthy();
    expect(screen.queryByText(/starts building now/)).toBeNull();
  });

  it("a sign-off card says where each button goes, naming the builder", () => {
    show(decision({ options: ["Approve and merge", "Send it back"], recommendedOption: "Approve and merge", context: { type: "risk_review", ticketId: "t1", builder: "Parsley" } }));
    expect(screen.getByText("Boss Man runs the full check and merges it. If the check fails, it goes back to Parsley, not to you.")).toBeTruthy();
    expect(screen.getByText("It goes back to Parsley with your note. The reviews start again when it comes back.")).toBeTruthy();
    expect(screen.getByText("Sign-off")).toBeTruthy();
    // The note box names the builder and the button that sends it.
    expect(screen.getByLabelText('Note for Parsley, sent with "Send it back"')).toBeTruthy();
  });

  it("a lesson card has a note box for the reason or the corrected lesson, and a plain question has none", () => {
    show(decision({ kind: "question", question: "Add this lesson to App's brief?", options: ["Add", "Edit", "Don't add it"], recommendedOption: "Add", context: { type: "question" } }));
    expect(screen.getByLabelText("Your one-line reason, or the corrected lesson (needed for Edit)")).toBeTruthy();
    cleanup();
    show(decision({ kind: "question", question: "Which one?", options: ["Ship it now", "Wait for the review"], context: { type: "question" } }));
    expect(screen.queryByRole("textbox", { name: /note|reason/i })).toBeNull();
  });

  it("a permission card: Allow once and Deny, and an Always line beside its own button", () => {
    show(decision({ kind: "permission", options: ["Allow once", "Always allow npm test", "Deny"], recommendedOption: "Allow once", context: { type: "permission", always: [{ label: "Always allow npm test", what: "run npm test" }], alwaysAgent: { id: "a1", name: "Moss" } } }));
    expect(screen.getByText("The command runs this one time. Moss carries on.")).toBeTruthy();
    expect(screen.getByText("The command doesn't run. Moss is told and has to find another way or ask again.")).toBeTruthy();
    expect(screen.getByText("Always allow Moss to run npm test.")).toBeTruthy();
  });

  it("a question's own options get no line: the option is its own effect", () => {
    const d = decision({ kind: "question", question: "Which one?", options: ["Ship it now", "Wait for the review"], recommendedOption: "Wait for the review", context: { type: "question" } });
    expect(effectOf(d, "Ship it now")).toBeNull();
    const { container } = show(d);
    expect(container.querySelector(".actions.wide")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Wait for the review, recommended" }).className).toContain("primary");
    expect(container.querySelector(".effect")).toBeNull();
  });
});

describe("the sign-off facts", () => {
  const signoff = (context: NonNullable<Decision["context"]>) => decision({ options: ["Approve and merge", "Send it back"], recommendedOption: "Approve and merge", context: { type: "risk_review", ticketId: "t1", ...context } });

  it("lists each review in words, the quick check with its commit, the risk and a link to the ticket", () => {
    show(signoff({ risk: "high", builder: "Parsley", reviews: [{ name: "Rod", kind: "code", verdict: "passed" }, { name: "Freddy", kind: "adversarial", verdict: "changes" }], quickCheck: { result: "passed", sha: "0123456789abcdef", at: new Date().toISOString() } }));
    const facts = within(screen.getByLabelText("What was checked"));
    expect(facts.getByText("Rod: ✓ Passed")).toBeTruthy();
    expect(facts.getByText("Freddy: ✗ Changes asked")).toBeTruthy();
    expect(facts.getByText(/✓ Passed on 01234567/)).toBeTruthy();
    expect(facts.getByText("high risk")).toBeTruthy();
    expect(facts.getByRole("link", { name: "Open APP-3" }).getAttribute("href")).toBe("#/tickets/t1");
  });

  it("shows a review that is still open, and a check that has not run", () => {
    show(signoff({ reviews: [{ name: "Rod", kind: "code", verdict: "waiting" }], quickCheck: null }));
    expect(screen.getByText("Rod: Still open")).toBeTruthy();
    expect(screen.getByText("None recorded.")).toBeTruthy();
    expect(screen.queryByText("Change")).toBeNull();
  });
});

describe("the question, the plan and the strips", () => {
  it("cuts a long question after its first sentence; a short one stays whole", () => {
    const long = "Merge \"Export CSV\" now and run the live deploy straight after it? Ada approved it, and it is rated high risk. The full check has not run yet on this commit.";
    expect(firstSentence(long)[0]).toBe("Merge \"Export CSV\" now and run the live deploy straight after it?");
    expect(firstSentence(long)[1]).toMatch(/^Ada approved it/);
    expect(firstSentence("Raise it? Yes or no.")).toEqual(["Raise it? Yes or no.", ""]);
    show(decision({ question: long }));
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Merge \"Export CSV\" now and run the live deploy straight after it?");
    expect(screen.getByText(/^Ada approved it/).tagName).toBe("P");
  });

  it("previews about 240 characters of a plan and opens the rest in place", () => {
    const plan = Array.from({ length: 21 }, (_, i) => `Step ${i + 1}: do the thing that takes a good few words to say.`).join("\n");
    show(decision({ kind: "permission", context: { type: "permission", planText: plan } }));
    expect(screen.queryByText(/Step 21:/)).toBeNull();
    const open = screen.getByRole("button", { name: "▸ Show the whole plan (21 lines)" });
    fireEvent.click(open);
    expect(screen.getByText(/Step 21:/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "▾ Show less" })).toBeTruthy();
  });

  it("the re-check strip says 'you', and the lapsed one starts with 'Not re-checked.'", () => {
    show(decision({ rechecking: { by: "Ivy", stage: "author" }, staleReason: "the owner answered 'Ship APP-201?', 40 min ago" }));
    const strip = screen.getByTestId("rechecking-note");
    expect(strip.getAttribute("role")).toBe("status");
    expect(strip.textContent).toBe("Being re-checked. Ivy is confirming this is still needed, because you answered 'Ship APP-201?', 40 min ago. If it isn't, the card closes by itself. You can still answer now.");
    expect(strip.textContent).not.toMatch(/the owner/);
    cleanup();
    show(decision({ notRechecked: "Nobody confirmed it within the hour." }));
    expect(screen.getByTestId("not-rechecked-note").textContent).toBe("Not re-checked. Nobody confirmed it within the hour.");
  });
});

describe("the closed list", () => {
  const closed = (over: Partial<AdvisedDecision>): AdvisedDecision => ({ id: "x1", companyId: "c1", question: "Approve Moss's plan for \"Export CSV\"?", ...over });
  const at = "2026-11-11T23:52:00.000Z";

  it("starts each line with what happened", () => {
    render(
      <Decisions
        decisions={[]}
        companies={[company]}
        loaded
        agentsWorking={0}
        onAnswered={() => {}}
        advised={[
          closed({ id: "a", withdrawn: { by: "Boss Man", note: "no longer needed" } }),
          closed({ id: "b", settled: { by: "the CEO", answer: "Allow once", note: null, command: null, tempCleanup: false } }),
          closed({ id: "c", settled: { by: "the CEO", answer: "Deny", note: null, command: null, tempCleanup: false } }),
          closed({ id: "d", settled: { by: "the CEO", answer: "Ship it", note: null, command: null, tempCleanup: false } }),
        ]}
      />,
    );
    expect(screen.getByText("Closed in the last 30 days (4)")).toBeTruthy();
    const verbs = [...document.querySelectorAll("[data-closed-card] .covered-line .tag")].map((t) => t.textContent);
    expect(verbs).toEqual(["Withdrawn", "Allowed", "Denied", "Answered"]);
  });

  it("a replaced plan names the newer plan's author and links its card by id", () => {
    render(<Decisions decisions={[]} companies={[company]} loaded agentsWorking={0} onAnswered={() => {}} advised={[closed({ withdrawn: { by: "Boss Man", note: "Superseded by card n1 (newer plan from Moss, x)", newer: { id: "n1", author: "Moss", at } } })]} />);
    expect(document.querySelector(".covered-line .tag")?.textContent).toBe("Replaced");
    expect(screen.getByText(/by a newer plan from Moss at /)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open the newer card ›" }).getAttribute("href")).toBe("#/decisions/n1");
    expect(document.body.textContent).not.toMatch(/Superseded by card n1\b.*\n/);
  });

  it("with no author it still says it was replaced and still links by id", () => {
    render(<Decisions decisions={[]} companies={[company]} loaded agentsWorking={0} onAnswered={() => {}} advised={[closed({ withdrawn: { by: "Boss Man", note: "Superseded", newer: { id: "n2", author: null, at } } })]} />);
    expect(screen.getByText(/Replaced by a newer plan \(/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open the newer card ›" }).getAttribute("href")).toBe("#/decisions/n2");
  });

  it("a plain withdrawal has no link", () => {
    render(<Decisions decisions={[]} companies={[company]} loaded agentsWorking={0} onAnswered={() => {}} advised={[closed({ withdrawn: { by: "Boss Man", note: "gone" } })]} />);
    expect(screen.queryByRole("link", { name: /newer card/ })).toBeNull();
  });
});
