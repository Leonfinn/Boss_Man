// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThisHost, deployerScriptLine } from "../src/pages/Settings";
import { when } from "../src/pages/Runs";

// BOS-1057: Settings → This host shows the "Deployer script" line for current, behind and unknown, and none when no report.
// BOS-2129: deployerScriptLine is also unit-tested directly here, with the clock fixed.

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
const view = (deployerScript: unknown) => ({
  hostName: "host01",
  reportedAt: "2026-11-10T09:00:00Z",
  ownerFacts: [],
  facts: { "paths.install": { value: "/srv/bm", source: "host", at: "2026-11-10T09:00:00Z" } },
  deployerScript,
});

describe("deployerScriptLine (BOS-2129)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-21T12:00:00Z"));
  });

  it("says current when the copy matches", () => {
    expect(deployerScriptLine({ state: "current" })).toBe("current");
  });

  it("says behind with the time it fell behind", () => {
    expect(deployerScriptLine({ state: "behind", since: "2026-11-10T08:00:00Z" })).toBe(
      `behind (since ${when("2026-11-10T08:00:00Z")}). A card in your queue has the copy steps.`,
    );
  });

  it("says behind with no time when the host gave none", () => {
    expect(deployerScriptLine({ state: "behind" })).toBe("behind. A card in your queue has the copy steps.");
  });

  it("says unknown when the host is too old to report its version", () => {
    expect(deployerScriptLine({ state: "unknown" })).toBe(
      "unknown: this host's deployer is too old to report its version. A card in your queue has the copy steps.",
    );
  });
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
