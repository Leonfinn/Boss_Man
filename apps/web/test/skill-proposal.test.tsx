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
const proposal = (over = {}) => ({
  id: "p1",
  name: "deploy-helper",
  source: "link",
  sourceUrl: "https://github.com/example/ops-skills/tree/main/deploy-helper",
  pinnedRef: "b81e07d" + "0".repeat(33),
  why: "Releases are manual",
  bundleHash: "a".repeat(64),
  reviewRequired: true,
  hasScripts: true,
  verdict: "advise_against",
  verdictSummary: "It sends your secrets away.",
  findings: [{ file: "scripts/deploy.sh", lineStart: 4, lineEnd: 6, title: "Posts env to a remote host", severity: "critical", confidence: "confirmed", behaviour: "Sends env.", harm: "Secrets leak.", fix: "Remove it.", blocks: true }],
  conditions: [],
  replacesSkillId: null,
  agents: [{ id: "a1", name: "Engineer" }],
  changes: null,
  files: [{ path: "SKILL.md", size: 10, hash: "h", script: false, text: "# Deploy" }, { path: "scripts/deploy.sh", size: 20, hash: "h2", script: true, text: "curl x" }],
  ...over,
});
const decision = (over: Partial<Decision> = {}): Decision => ({
  id: "d1",
  companyId: "c1",
  kind: "skill",
  question: "The CEO wants to add the skill deploy-helper.",
  options: ["Don't add it", "Add it anyway, against the advice"],
  recommendedOption: "Don't add it",
  tier: "owner",
  createdAt: new Date().toISOString(),
  companyName: "App Co",
  agentName: "CEO",
  blocks: [],
  score: 10,
  parts: { blocking: 0, urgency: 0, age: 1, liveRun: 0 },
  reasons: [],
  dueDate: null,
  context: { type: "skill", proposalId: "p1" },
  ...over,
} as Decision);

describe("skill decision", () => {
  it("shows the warning, the findings with file and lines, and offers only reject or add-anyway", async () => {
    const fetch = vi.fn(async (url: string) => new Response(JSON.stringify(url.includes("skill-proposals") ? proposal() : { ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    render(<Decisions decisions={[decision()]} companies={[company]} loaded agentsWorking={0} onAnswered={() => {}} />);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/advises against/));
    expect(screen.getByText("Posts env to a remote host")).toBeTruthy();
    expect(screen.getByText(/lines 4–6/)).toBeTruthy();
    expect(screen.getByText(/Releases are manual/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add the skill" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add it anyway, against the advice" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/decisions/d1/answer", expect.objectContaining({ body: JSON.stringify({ answer: "Add it anyway, against the advice" }) })));
  });

  it("never says no review was needed: a skill with no verdict shows the review as pending", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(proposal({ source: "draft", sourceUrl: null, pinnedRef: null, reviewRequired: true, hasScripts: false, verdict: null, findings: null })), { status: 200 })));
    render(<Decisions decisions={[decision({ options: ["Add the skill", "Don't add it"], recommendedOption: "Add the skill" })]} companies={[company]} loaded agentsWorking={0} onAnswered={() => {}} />);
    await waitFor(() => expect(screen.getByText("Security review pending")).toBeTruthy());
    expect(screen.queryByText("No review needed")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
