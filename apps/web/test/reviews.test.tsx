// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "../src/api";
import { CompanyReviews, ProjectReviews } from "../src/components/ReviewPolicy";
import { reviewsSummary, TicketReviews } from "../src/components/TicketReviews";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const agent = (id: string, name: string, title: string, role: Agent["role"] = "worker") => ({ id, companyId: "c1", name, role, agentKind: "claude", model: null, fundingSourceId: null, paused: false, starred: false, duty: null, title }) as Agent;
const AGENTS = [agent("a0", "Ada", "CEO", "ceo"), agent("a1", "Sam", "Senior Developer"), agent("a2", "Kim", "Security Reviewer")];
const DEFAULTS = {
  trivial: { planApprover: "none", reviewer: "ceo", ownerSignoff: false },
  low: { planApprover: "ceo", reviewer: "ceo", ownerSignoff: false },
  medium: { planApprover: "ceo", reviewer: "senior-dev", ownerSignoff: false },
  high: { planApprover: "owner", reviewer: "senior-dev", ownerSignoff: true },
  critical: { planApprover: "owner", reviewer: "senior-dev", ownerSignoff: true },
};

function stub(project: unknown = { policy: null }) {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ method, url, body: init?.body ? JSON.parse(init.body as string) : undefined });
      const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
      return url.includes("/projects/") ? json(method === "GET" ? project : { policy: null }) : json(DEFAULTS);
    }),
  );
  return calls;
}

describe("Settings > Reviews", () => {
  it("shows the defaults, offers the team, saves a change and resets", async () => {
    const calls = stub();
    render(<CompanyReviews companyId="c1" agents={AGENTS} />);
    const medium = (await screen.findByLabelText("Medium: code reviewed by")) as HTMLSelectElement;
    expect(medium.value).toBe("senior-dev");
    expect((screen.getByLabelText("Trivial: plan approved by") as HTMLSelectElement).value).toBe("none");
    expect((screen.getByLabelText("High: you sign off") as HTMLInputElement).checked).toBe(true);
    expect([...medium.options].map((o) => o.text)).toEqual(["CEO", "Senior Developer (when hired)", "Sam (Senior Developer)", "Kim (Security Reviewer)"]);
    // "None" and "Owner" are plan-only.
    expect([...(screen.getByLabelText("Low: plan approved by") as HTMLSelectElement).options].map((o) => o.value)).toEqual(["none", "owner", "ceo", "senior-dev", "a1", "a2"]);

    fireEvent.change(medium, { target: { value: "a1" } });
    fireEvent.click(screen.getByLabelText("Medium: you sign off"));
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(calls.find((c) => c.method === "PUT")).toBeTruthy());
    expect(calls.find((c) => c.method === "PUT")).toMatchObject({ url: "/api/companies/c1/review-policy", body: { medium: { reviewer: "a1", ownerSignoff: true } } });

    fireEvent.click(screen.getByText("Reset to defaults"));
    expect((screen.getByLabelText("Medium: code reviewed by") as HTMLSelectElement).value).toBe("senior-dev");
  });
});

describe("project reviews", () => {
  it("uses the company's until Customise, then shows the table; going back deletes the override", async () => {
    const calls = stub();
    render(<ProjectReviews projectId="p1" companyId="c1" agents={AGENTS} />);
    const choice = (await screen.findByLabelText("Reviews for this project")) as HTMLSelectElement;
    expect(choice.value).toBe("company");
    expect(screen.queryByLabelText("Medium: code reviewed by")).toBeNull();
    fireEvent.change(choice, { target: { value: "custom" } });
    expect(await screen.findByLabelText("Medium: code reviewed by")).toBeTruthy();
    expect(calls.find((c) => c.method === "PUT")).toMatchObject({ url: "/api/projects/p1/review-policy", body: DEFAULTS });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.change(choice, { target: { value: "company" } });
    await waitFor(() => expect(screen.queryByLabelText("Medium: code reviewed by")).toBeNull());
    expect(confirm).toHaveBeenCalledWith("Use the company's reviews for this project? Its own review table will be deleted.");
    expect(calls.some((c) => c.method === "DELETE" && c.url === "/api/projects/p1/review-policy")).toBe(true);
    confirm.mockRestore();
  });

  it("keeps the project's own table and sends nothing when the owner says no to going back", async () => {
    const calls = stub({ policy: { ...DEFAULTS, low: { ...DEFAULTS.low, reviewer: "a1" } } });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<ProjectReviews projectId="p1" companyId="c1" agents={AGENTS} />);
    const choice = (await screen.findByLabelText("Reviews for this project")) as HTMLSelectElement;
    fireEvent.change(choice, { target: { value: "company" } });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(choice.value).toBe("custom");
    expect(screen.getByLabelText("Low: code reviewed by")).toBeTruthy();
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    confirm.mockRestore();
  });

  it("opens already customised when the project has its own", async () => {
    stub({ policy: { ...DEFAULTS, low: { ...DEFAULTS.low, reviewer: "a1" } } });
    render(<ProjectReviews projectId="p1" companyId="c1" agents={AGENTS} />);
    expect(((await screen.findByLabelText("Low: code reviewed by")) as HTMLSelectElement).value).toBe("a1");
  });
});

describe("review kinds", () => {
  it("shows a column per kind, off by default, and saves a choice (or Off again)", async () => {
    const calls = stub();
    render(<CompanyReviews companyId="c1" agents={AGENTS} />);
    const sec = (await screen.findByLabelText("High: security review by")) as HTMLSelectElement;
    for (const k of ["Security review", "Infrastructure review", "Adversarial review"]) expect(screen.getByText(k)).toBeTruthy();
    // Plain names on the owner's screen (BOS-1494): the adversarial column says what it means.
    expect(screen.getByText("a reviewer told to try to break it")).toBeTruthy();
    expect(sec.value).toBe("");
    // No "marked agent" choice any more: Settings names the reviewers itself (BOS-198).
    expect([...sec.options].map((o) => o.text)).toEqual(["Off", "CEO", "Senior Developer (when hired)", "Sam (Senior Developer)", "Kim (Security Reviewer)"]);
    fireEvent.change(sec, { target: { value: "ceo" } });
    fireEvent.change(screen.getByLabelText("High: infrastructure review by"), { target: { value: "a1" } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(calls.find((c) => c.method === "PUT")).toBeTruthy());
    expect(calls.find((c) => c.method === "PUT")!.body).toMatchObject({ high: { kinds: { security: "ceo", infra: "a1" } }, low: {} });
    fireEvent.change(screen.getByLabelText("High: security review by"), { target: { value: "" } });
    expect(((screen.getByLabelText("High: security review by")) as HTMLSelectElement).value).toBe("");
  });

  it("shows the project's kinds when it customises", async () => {
    stub({ policy: { ...DEFAULTS, low: { ...DEFAULTS.low, kinds: { adversarial: "a1" } } } });
    render(<ProjectReviews projectId="p1" companyId="c1" agents={AGENTS} />);
    expect(((await screen.findByLabelText("Low: adversarial review by")) as HTMLSelectElement).value).toBe("a1");
  });
});

describe("several reviewers per cell (BOS-198)", () => {
  it("adds agents to a cell, saves a list, and back to one saves a single id", async () => {
    const calls = stub();
    render(<CompanyReviews companyId="c1" agents={AGENTS} />);
    fireEvent.change(await screen.findByLabelText("High: security review by"), { target: { value: "a1" } });
    // Once an agent is chosen the rest of the team can share it; the only one ticked can't be unticked.
    expect((screen.getByLabelText("High: security review by: Sam") as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("High: security review by: Kim"));
    expect([...(screen.getByLabelText("High: security review by") as HTMLSelectElement).selectedOptions].map((o) => o.text)).toEqual(["Sam, Kim"]);
    fireEvent.click(screen.getByLabelText("Medium: code reviewed by"));
    fireEvent.change(screen.getByLabelText("Medium: code reviewed by"), { target: { value: "a2" } });
    fireEvent.click(screen.getByLabelText("Medium: code reviewed by: Sam"));
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(calls.find((c) => c.method === "PUT")).toBeTruthy());
    expect(calls.find((c) => c.method === "PUT")!.body).toMatchObject({ high: { kinds: { security: ["a1", "a2"] } }, medium: { reviewer: ["a2", "a1"] } });
    fireEvent.click(screen.getByLabelText("High: security review by: Sam"));
    expect((screen.getByLabelText("High: security review by") as HTMLSelectElement).value).toBe("a2");
    // Choosing the CEO (not an agent) replaces the list: the two never mix.
    fireEvent.change(screen.getByLabelText("Medium: code reviewed by"), { target: { value: "ceo" } });
    expect(screen.queryByLabelText("Medium: code reviewed by: Sam")).toBeNull();
  });

  it("shows a saved list back, and an old marked value until it is changed", async () => {
    stub({ policy: { ...DEFAULTS, low: { ...DEFAULTS.low, reviewer: ["a1", "a2"], kinds: { infra: "marked" } } } });
    render(<ProjectReviews projectId="p1" companyId="c1" agents={AGENTS} />);
    const code = (await screen.findByLabelText("Low: code reviewed by")) as HTMLSelectElement;
    expect(code.selectedOptions[0]!.text).toBe("Sam, Kim");
    expect((screen.getByLabelText("Low: code reviewed by: Kim") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("Low: infrastructure review by") as HTMLSelectElement).selectedOptions[0]!.text).toBe("Marked agent (old setting)");
    expect([...(screen.getByLabelText("High: infrastructure review by") as HTMLSelectElement).options].map((o) => o.value)).not.toContain("marked");
  });
});

describe("ticket reviews", () => {
  it("lists each review with kind, reviewer, status, round, notes and the CEO's overrule reason", async () => {
    const reviews = [
      { id: "r1", kind: "code", round: 2, seq: 0, status: "approved", reviewer: "Sam", notes: null, overruleReason: null },
      { id: "r2", kind: "security", round: 2, seq: 0, status: "overruled", reviewer: "Sec", notes: "Escape it.", overruleReason: "Out of scope." },
      { id: "r3", kind: "infra", round: 1, seq: 0, status: "changes_requested", reviewer: "Ivy", notes: "No rollback.", overruleReason: null },
    ];
    render(<TicketReviews reviews={reviews} />);
    expect(await screen.findByText("Overruled by the CEO: Out of scope.")).toBeTruthy();
    expect(screen.getByText("Escape it.")).toBeTruthy();
    expect(screen.getByText("Changes requested")).toBeTruthy();
    expect(screen.getByText("Approved")).toBeTruthy();
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    expect(screen.getByText(/review by Sam · round 2/)).toBeTruthy();
  });

  it("folds to a summary heading, opens one review on its own and opens them all from the heading", async () => {
    const reviews = [
      { id: "r1", kind: "code", round: 2, seq: 0, status: "approved", reviewer: "Sam", notes: "Looks fine.", overruleReason: null },
      { id: "r2", kind: "infra", round: 2, seq: 0, status: "changes_requested", reviewer: "Ivy", notes: "No rollback.", overruleReason: null },
    ];
    const { container } = render(<TicketReviews reviews={reviews} />);
    const open = () => [...container.querySelectorAll("details")].map((d) => d.open);
    expect(screen.getByText("2 reviews · round 2 · 1 asks for changes")).toBeTruthy();
    expect(open()).toEqual([false, false]);
    container.querySelector("details")!.open = true;
    expect(open()).toEqual([true, false]);
    fireEvent.click(screen.getByRole("button", { name: /Reviews/ }));
    expect(open()).toEqual([true, true]);
    fireEvent.click(screen.getByRole("button", { name: /Reviews/ }));
    expect(open()).toEqual([false, false]);
  });

  it("summarises one approved review in the singular", () => {
    expect(reviewsSummary([{ id: "r1", kind: "code", round: 1, seq: 0, status: "approved", reviewer: "Sam", notes: null, overruleReason: null }])).toBe("1 review · round 1 · all approved");
  });

  it("renders nothing when the ticket has no reviews", async () => {
    const { container } = render(<TicketReviews reviews={[]} />);
    expect(container.textContent).toBe("");
  });
});
