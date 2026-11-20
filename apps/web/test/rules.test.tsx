// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { Rules } from "../src/pages/Rules";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const company: Company = { id: "c1", name: "App Co", mission: null, paused: false, agents: [] };

describe("decision rules", () => {
  it("asks the CEO in plain words, with the manual form folded away", async () => {
    const fetch = vi.fn(async (url: string) => new Response(JSON.stringify(url.includes("rule-requests") ? { ceo: { name: "Ada" } } : { company: [], global: [], defaults: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    render(<Rules companies={[company]} companyId="c1" go={() => {}} />);

    const advanced = screen.getByText("Advanced: write the rule yourself").closest("details")!;
    expect(advanced.open).toBe(false);

    fireEvent.change(screen.getByLabelText("What should this rule do?"), { target: { value: "Let agents read GitHub freely" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask the CEO to draft it" }));
    await waitFor(() => expect(screen.getByText("Sent to Ada. Their proposal will appear in your Decisions queue.")).toBeTruthy());
    expect(fetch).toHaveBeenCalledWith("/api/companies/c1/rule-requests", expect.objectContaining({ method: "POST", body: JSON.stringify({ text: "Let agents read GitHub freely" }) }));
    expect((screen.getByLabelText("What should this rule do?") as HTMLTextAreaElement).value).toBe("");
  });

  it("names the agents a rule is for, and falls back for an unknown id", async () => {
    const agent = (id: string, name: string) => ({ id, companyId: "c1", name, role: "worker" as const, agentKind: "claude", model: null, fundingSourceId: null, paused: false, starred: false, duty: null });
    const co: Company = { ...company, agents: [agent("a1", "Kit"), agent("a2", "Zippy")] };
    const rule = (id: string, agentIds: string[]) => ({ id, companyId: "c1", name: `Rule ${id}`, match: { agentIds }, outcome: "allow", position: 0 });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ company: [rule("r1", ["a1"]), rule("r2", ["a1", "a2"]), rule("r3", ["zz"])], global: [], defaults: [] }), { status: 200 })));
    render(<Rules companies={[co]} companyId="c1" go={() => {}} />);
    expect(await screen.findByText("When the request is from Kit")).toBeTruthy();
    expect(screen.getByText("When the request is from Kit or Zippy")).toBeTruthy();
    expect(screen.getByText("When the request is from one named agent")).toBeTruthy();
  });

  // BOS-786: the built-in defaults line must say the CEO is asked first, as the code does.
  it("says an unmatched request goes to the CEO first, and what comes straight to the owner", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(url.includes("rule-requests") ? { ceo: { name: "Ada" } } : { company: [], global: [], defaults: [] }), { status: 200 })));
    render(<Rules companies={[company]} companyId="c1" go={() => {}} />);
    const line = screen.getByText(/Checked last, and can't be changed\./);
    expect(line.textContent).toContain("A request nothing matches goes to the CEO first, and to you if the CEO does not settle it.");
    expect(line.textContent).toContain("Deletes, moves and requests that name a path come straight to you.");
    expect(line.textContent).not.toContain("goes to you.");
  });
});
