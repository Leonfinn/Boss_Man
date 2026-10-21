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
});
