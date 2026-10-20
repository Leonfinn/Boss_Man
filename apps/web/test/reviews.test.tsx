// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "../src/api";
import { CompanyReviews, ProjectReviews } from "../src/components/ReviewPolicy";

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
