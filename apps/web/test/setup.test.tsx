// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { Setup } from "../src/pages/Setup";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const company: Company = { id: "c1", name: "App Co", mission: "x", paused: false, agents: [] };
const project = { id: "p1", companyId: "c1", name: "Site", repoUrl: "https://github.com/a/b.git", defaultBranch: "main", verifyCommand: null, deepVerifyCommand: null, landing: "merge", gitHost: "github" };

function mock(step: number) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const body = url === "/api/setup-progress" ? { dismissed: false, step, companyId: "c1" } : url.endsWith("/projects") ? [project] : url.endsWith("/setup-checklist") ? [] : { standard: [], none: { id: "none", label: "Nothing", command: "", needs: [] }, detected: [], tools: null, error: null };
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
}

describe("setup wizard checks", () => {
  it("keeps the check pickers off the project step", async () => {
    mock(1);
    render(<Setup companies={[company]} go={() => {}} onChanged={() => {}} />);
    expect(await screen.findByLabelText("Git repo")).toBeTruthy();
    expect(screen.queryByText("Before merging, Boss Man will")).toBeNull();
    expect(vi.mocked(fetch).mock.calls.some(([u]) => String(u).includes("check-presets"))).toBe(false);
  });

  it("offers them on their own step, without the repo fields", async () => {
    mock(5);
    render(<Setup companies={[company]} go={() => {}} onChanged={() => {}} />);
    expect(await screen.findByText("Before merging, Boss Man will")).toBeTruthy();
    expect(screen.getByText("For high-risk work, also")).toBeTruthy();
    expect(screen.queryByLabelText("Git repo")).toBeNull();
  });
});
