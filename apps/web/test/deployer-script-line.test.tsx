// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThisHost } from "../src/pages/Settings";

// BOS-1057: Settings → This host shows the "Deployer script" line for current, behind and unknown, and none when no report.

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
const view = (deployerScript: unknown) => ({
  hostName: "host01",
  reportedAt: "2026-11-10T09:00:00Z",
  ownerFacts: [],
  facts: { "paths.install": { value: "/srv/bm", source: "host", at: "2026-11-10T09:00:00Z" } },
  deployerScript,
});

describe("Deployer script line in Settings → This host", () => {
  it.each([
    [{ state: "current" }, "Deployer script: current"],
    [{ state: "behind", since: "2026-11-10T08:00:00Z" }, "Deployer script: behind"],
    [{ state: "unknown" }, "Deployer script: unknown"],
  ])("shows the line for %j", async (state, text) => {
    vi.stubGlobal("fetch", vi.fn(async () => json(view(state))));
    render(<ThisHost />);
    const line = await screen.findByTestId("deployer-script");
    expect(line.textContent).toContain(text);
  });

  it("shows no line when the host has not reported", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(view({ state: "none" }))));
    render(<ThisHost />);
    await screen.findByText("This host");
    expect(screen.queryByTestId("deployer-script")).toBeNull();
  });
});
