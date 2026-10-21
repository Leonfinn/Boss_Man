// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "../src/api";
import { CompanyReviews, ProjectReviews } from "../src/components/ReviewPolicy";
import { TicketReviews } from "../src/components/TicketReviews";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const agent = (id: string, name: string, title: string, role: Agent["role"] = "worker") => ({ id, companyId: "c1", name, role, agentKind: "claude", model: null, fundingSourceId: null, paused: false, starred: false, duty: null, title }) as Agent;
const AGENTS = [agent("a0", "Ada", "CEO", "ceo"), agent("a1", "Sam", "Senior Developer")];
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
    expect([...medium.options].map((o) => o.text)).toEqual(["CEO", "Senior Developer (when hired)", "Sam (Senior Developer)"]);
    // "None" and "Owner" are plan-only.
    expect([...(screen.getByLabelText("Low: plan approved by") as HTMLSelectElement).options].map((o) => o.value)).toEqual(["none", "owner", "ceo", "senior-dev", "a1"]);

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
    fireEvent.change(choice, { target: { value: "company" } });
    await waitFor(() => expect(screen.queryByLabelText("Medium: code reviewed by")).toBeNull());
    expect(calls.some((c) => c.method === "DELETE" && c.url === "/api/projects/p1/review-policy")).toBe(true);
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
    for (const k of ["Security review", "Infra review", "Adversarial review"]) expect(screen.getByText(k)).toBeTruthy();
    expect(sec.value).toBe("");
    expect([...sec.options].map((o) => o.text)).toEqual(["Off", "The agent marked as security reviewer", "CEO", "Senior Developer (when hired)", "Sam (Senior Developer)"]);
    fireEvent.change(sec, { target: { value: "marked" } });
    fireEvent.change(screen.getByLabelText("High: infra review by"), { target: { value: "a1" } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(calls.find((c) => c.method === "PUT")).toBeTruthy());
    expect(calls.find((c) => c.method === "PUT")!.body).toMatchObject({ high: { kinds: { security: "marked", infra: "a1" } }, low: {} });
    fireEvent.change(screen.getByLabelText("High: security review by"), { target: { value: "" } });
    expect(((screen.getByLabelText("High: security review by")) as HTMLSelectElement).value).toBe("");
  });

  it("shows the project's kinds when it customises", async () => {
    stub({ policy: { ...DEFAULTS, low: { ...DEFAULTS.low, kinds: { adversarial: "a1" } } } });
    render(<ProjectReviews projectId="p1" companyId="c1" agents={AGENTS} />);
    expect(((await screen.findByLabelText("Low: adversarial review by")) as HTMLSelectElement).value).toBe("a1");
  });
});

describe("ticket reviews", () => {
  it("lists each review with kind, reviewer, status, round, notes and the CEO's overrule reason", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify([
            { id: "r1", kind: "code", round: 2, seq: 0, status: "approved", reviewer: "Sam", notes: null, overruleReason: null },
            { id: "r2", kind: "security", round: 2, seq: 0, status: "overruled", reviewer: "Sec", notes: "Escape it.", overruleReason: "Out of scope." },
            { id: "r3", kind: "infra", round: 1, seq: 0, status: "changes_requested", reviewer: "Ivy", notes: "No rollback.", overruleReason: null },
          ]),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    render(<TicketReviews ticketId="t1" />);
    expect(await screen.findByText("Overruled by the CEO: Out of scope.")).toBeTruthy();
    expect(screen.getByText("Escape it.")).toBeTruthy();
    expect(screen.getByText("Changes requested")).toBeTruthy();
    expect(screen.getByText("Approved")).toBeTruthy();
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    expect(screen.getByText(/review by Sam · round 2/)).toBeTruthy();
  });

  it("renders nothing when the ticket has no reviews", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("[]", { status: 200, headers: { "content-type": "application/json" } })));
    const { container } = render(<TicketReviews ticketId="t2" />);
    await waitFor(() => expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0));
    expect(container.textContent).toBe("");
  });
});
