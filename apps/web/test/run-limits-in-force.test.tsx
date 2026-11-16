// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunLimits } from "../src/pages/Settings";

// BOS-1634: Settings → Agents at once never shows a saved number that differs silently from the one in force.

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
const base = { instance: 16, company: 12, background: 2, defaults: { instance: 8, company: 4, background: 2 } };

describe("Agents at once: saved and in force", () => {
  it("during a server update's hold it says saved 16, in force 3, why, and that nothing needs changing", async () => {
    const until = "2026-11-16T13:00:00.000Z";
    vi.stubGlobal("fetch", vi.fn(async () => json({ ...base, inForce: { limit: 3, saved: 16, because: "a server update is waiting for a quiet machine, so Boss Man starts at most 3 runs at once until it is done", until } })));
    render(<RunLimits />);
    const line = (await screen.findByTestId("run-limits-in-force")).textContent!;
    expect(line).toContain("Saved 16, in force 3");
    expect(line).toContain("a server update is waiting for a quiet machine");
    expect(line).toContain("Back to 16 by");
    expect(line).toContain("Nothing to change");
    expect((screen.getByLabelText(/Across all companies/) as HTMLInputElement).value).toBe("16");
  });

  it("shows no such line when the number in force is the saved one, or from an older server without inForce", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ ...base, inForce: { limit: 16, saved: 16, because: null, until: null } })));
    render(<RunLimits />);
    await screen.findByLabelText(/Across all companies/);
    expect(screen.queryByTestId("run-limits-in-force")).toBeNull();
    cleanup();
    vi.stubGlobal("fetch", vi.fn(async () => json(base)));
    render(<RunLimits />);
    await screen.findByLabelText(/Across all companies/);
    expect(screen.queryByTestId("run-limits-in-force")).toBeNull();
  });
});
