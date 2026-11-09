// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SelfDeploy } from "../src/pages/Settings";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });

const view = {
  enabled: true,
  pending: false,
  status: null,
  available: { tip: "aaaaaaa1", deployed: "aaaaaaa1", checkedAt: "2026-11-09T06:00:00.000Z", commits: [] },
  deployer: { reportedAt: "2026-11-09T06:00:00.000Z", late: false },
};

describe("Settings → Updates says Deploy latest is the server only (BOS-868)", () => {
  it("shows one line under the buttons saying runner changes need Build and update runners", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => (url.endsWith("/api/self-deploy") ? json(view) : json([]))));
    render(<SelfDeploy go={() => {}} />);
    const line = await screen.findByText(/Deploy latest updates the server only/);
    expect(line.textContent).toContain("If an update changed the runners, press Build and update runners afterwards.");
    expect(line.className).toContain("muted");
  });

  it("gives Deploy latest a tooltip saying the same", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => (url.endsWith("/api/self-deploy") ? json(view) : json([]))));
    render(<SelfDeploy go={() => {}} />);
    const button = await screen.findByRole("button", { name: "Deploy latest" });
    expect(button.getAttribute("title")).toBe("Updates the server only. If the update changed the runners, press Build and update runners afterwards.");
  });
});
